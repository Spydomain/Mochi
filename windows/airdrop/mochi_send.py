#!/usr/bin/env python3
"""Exact-recipient OpenDrop sender with private, machine-readable progress."""
import argparse
from collections import deque
from http.client import HTTPConnection, HTTPException, IncompleteRead
import fcntl
import json
import ipaddress
import os
from pathlib import Path
import plistlib
import re
import socket
import sys
import struct
import termios
import threading
import time
import tempfile

from opendrop.client import AirDropClient, HTTPSConnectionAWDL
from opendrop.config import AirDropConfig


def tcp_acknowledged(sock):
    """Linux TCP_INFO's stable bytes_acked field (not TLS plaintext bytes)."""
    try:
        info = sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 256)
        return struct.unpack_from("=Q", info, 120)[0] if len(info) >= 128 else None
    except (OSError, TypeError, ValueError, AttributeError, struct.error):
        return None


def tcp_position(sock):
    # bytes_acked + SIOCOUTQ covers queued stream sequence bytes, without
    # guessing TLS overhead or including retransmissions twice. Retry if ACKs
    # changed between the two syscalls. The baseline excludes previous /Ask
    # data and upload headers that were already queued before the body.
    for _ in range(3):
        before = tcp_acknowledged(sock)
        if before is None:
            return None
        try:
            queued = struct.unpack("=I", fcntl.ioctl(sock.fileno(), termios.TIOCOUTQ, struct.pack("=I", 0)))[0]
        except (OSError, TypeError, ValueError, AttributeError, struct.error):
            return None
        after = tcp_acknowledged(sock)
        if before == after:
            return after, queued
    return None


class SenderConnection(HTTPSConnectionAWDL):
    TCP_RETRY_DELAYS = (.25, .5)

    def connect(self):
        # Route TCP using the original scoped address. Scope IDs are local
        # routing information, not DNS names, and must never appear in TLS SNI.
        previous_timeout = self.timeout
        budget = previous_timeout if isinstance(previous_timeout, (int, float)) else 30
        deadline = time.monotonic() + budget
        try:
            for attempt in range(len(self.TCP_RETRY_DELAYS) + 1):
                self.timeout = max(.001, deadline - time.monotonic())
                try:
                    HTTPConnection.connect(self)
                    break
                except ConnectionRefusedError:
                    # HTTPConnection may connect lazily from request(). Its
                    # pending request state must survive a TCP-only retry;
                    # close() would reset it and break getresponse().
                    if self.sock is not None:
                        self.sock.close()
                        self.sock = None
                    if attempt == len(self.TCP_RETRY_DELAYS):
                        raise
                    delay = self.TCP_RETRY_DELAYS[attempt]
                    if deadline - time.monotonic() <= delay:
                        raise
                    # A live iPhone service may briefly refuse a new TCP
                    # connection while its listener wakes. Retry only this
                    # exact endpoint, before TLS or any /Ask or file bytes.
                    # Never replay an ambiguous consent request or upload.
                    time.sleep(delay)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("AirDrop connection deadline exceeded")
            self.sock.settimeout(remaining)
            hostname = self._tunnel_host or self.host
            if "%" in hostname:
                address = hostname.split("%", 1)[0]
                try:
                    ipaddress.IPv6Address(address)
                except ValueError:
                    pass
                else:
                    hostname = address
            self.sock = self._context.wrap_socket(self.sock, server_hostname=hostname)
            self.sock.settimeout(previous_timeout if previous_timeout is None or isinstance(previous_timeout, (int, float))
                                 else socket.getdefaulttimeout())
        except BaseException:
            self.close()
            raise
        finally:
            self.timeout = previous_timeout


class MeasuredClient(AirDropClient):
    ASK_TIMEOUT = 120
    ASK_BODY_TIMEOUT = 15
    ASK_RESPONSE_LIMIT = 1024 * 1024
    def abort_failed_socket(self):
        connection = self.http_conn
        if connection is not None and connection.sock is not None:
            try:
                connection.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            except OSError:
                pass

    def report(self, phase, sent=None, total=None):
        self._phase = phase
        if not hasattr(self, "_clock"):
            self._clock = time.monotonic()
        elapsed = max(0, time.monotonic() - self._upload_started) if hasattr(self, "_upload_started") else 0
        rate = (0 if phase == "stalled" else sent / elapsed) if sent is not None and elapsed > 0 else None
        print("MOCHI_SEND " + json.dumps({"phase": phase, "sentBytes": sent,
              "totalBytes": total, "measurement": getattr(self, "_measurement", "tlsWritten"),
              "bytesPerSecond": rate,
              "elapsedMs": int((time.monotonic() - self._clock) * 1000)}),
              file=sys.stderr, flush=True)

    def report_failure(self, error):
        # Never persist str(error), request bodies, names, file paths, tokens
        # or traceback source lines. Keep just protocol/transport classification.
        def token(value):
            return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_]{1,80}", value) else None
        payload = {"phase": token(getattr(self, "_phase", "requestPreparation")),
                   "exception": token(type(error).__name__),
                   "reason": token(getattr(error, "reason", None)), "timeNs": time.time_ns()}
        errno = getattr(error, "errno", None)
        if isinstance(errno, int) and 0 < errno <= 4096:
            payload["errno"] = errno
        for key in ("httpStatus", "responseLength", "responseFraming", "responseBytes"):
            value = getattr(self, "_ask_" + key, None)
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10**12:
                payload[key] = value
            elif key == "responseFraming" and value in ("length", "chunked", "close"):
                payload[key] = value
        if hasattr(self, "_ask_plist_complete"):
            payload["responsePlistComplete"] = self._ask_plist_complete
        encoded = json.dumps(payload)
        print("MOCHI_SEND_ERROR " + encoded, file=sys.stderr, flush=True)
        runtime = os.environ.get("XDG_RUNTIME_DIR")
        if not runtime:
            return
        directory = Path(runtime) / "mochi-airdrop"
        try:
            info = directory.lstat()
            if (directory.is_symlink() or not directory.is_dir() or info.st_uid != os.getuid()
                    or info.st_mode & 0o077):
                return
            fd, temporary = tempfile.mkstemp(prefix=".send-error-", dir=directory)
            try:
                with os.fdopen(fd, "w") as stream:
                    stream.write(encoded + "\n")
                os.replace(temporary, directory / "send-error.json")
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        except OSError:
            pass

    def send_POST(self, url, body, **kwargs):
        if url == "/Ask":
            if self.http_conn is None:
                self.report("connecting")
                self.http_conn = SenderConnection(self.receiver_host, self.receiver_port,
                    interface_name=self.config.interface, context=self.config.get_ssl_context(), timeout=30)
                self.http_conn.connect()
                # The connection deadline must not cut short a person's
                # acceptance decision. Native owns the overall send deadline.
                self.http_conn.sock.settimeout(None)
                self.http_conn.timeout = None
            self.report("asking")
        try:
            # Upstream reads the whole response with timeout=None. The phone
            # can already have accepted while a missing/incomplete HTTP ending
            # leaves Mochi waiting forever instead of starting its upload.
            result = self._send_ask_request(body, **kwargs) if url == "/Ask" else super().send_POST(url, body, **kwargs)
        except (OSError, EOFError, HTTPException):
            if url == "/Upload":
                # Must happen before upstream send_upload closes the socket
                # and clears http_conn; main's finally is too late then.
                self.abort_failed_socket()
            raise
        finally:
            if url == "/Upload":
                stop = getattr(self, "_progress_stop", None)
                if stop is not None:
                    stop.set()
                    self._progress_thread.join(timeout=.3)
        if url == "/Upload" and result[0] and hasattr(self, "_upload_total"):
            self.report("confirming", self._upload_total, self._upload_total)
        return result

    def _send_ask_request(self, body, headers=None, **kwargs):
        if kwargs:
            raise ValueError("Unsupported AirDrop acceptance request options")
        connection = self.http_conn
        sock = connection.sock
        previous, previous_connection = sock.gettimeout(), connection.timeout
        response = None
        try:
            # Includes transmitting the optional preview and waiting for a
            # person's decision. No artificial acceptance or automatic re-Ask.
            sock.settimeout(self.ASK_TIMEOUT)
            connection.timeout = self.ASK_TIMEOUT
            # Restore the request composition used by confirmed successful
            # sends. Do not experiment with control-request framing while
            # repairing the discovery/acceptance handoff.
            request_headers = self._get_headers()
            if headers:
                request_headers.update(headers)
            connection.request("POST", "/Ask", body=body, headers=request_headers)
            response = connection.getresponse()
            self._ask_httpStatus = response.status
            self._ask_responseLength = response.length
            self._ask_responseFraming = "chunked" if response.chunked else "length" if response.length is not None else "close"
            if response.status == 200:
                self.report("accepted")
            # Once headers arrived, this wait no longer represents the user's
            # acceptance decision. Bound metadata reads and malformed responses.
            sock.settimeout(self.ASK_BODY_TIMEOUT)
            if response.length is not None and response.length > self.ASK_RESPONSE_LIMIT:
                raise ValueError("AirDrop acceptance response exceeds limit")
            declared = response.length
            response_bytes = bytearray()
            self._ask_responseBytes = 0
            deadline = time.monotonic() + self.ASK_BODY_TIMEOUT
            try:
                while declared is None or len(response_bytes) < declared:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("AirDrop acceptance response did not finish")
                    sock.settimeout(remaining)
                    size = min(65536, self.ASK_RESPONSE_LIMIT + 1 - len(response_bytes))
                    if declared is not None:
                        size = min(size, declared - len(response_bytes))
                    block = getattr(response, "read1", response.read)(size)
                    if not block:
                        break
                    response_bytes.extend(block)
                    self._ask_responseBytes = len(response_bytes)
                    if len(response_bytes) > self.ASK_RESPONSE_LIMIT:
                        raise ValueError("AirDrop acceptance response exceeds limit")
                if declared is not None and len(response_bytes) != declared:
                    raise IncompleteRead(bytes(response_bytes), declared - len(response_bytes))
                return response.status == 200, bytes(response_bytes)
            finally:
                try:
                    self._ask_plist_complete = isinstance(plistlib.loads(bytes(response_bytes)), dict)
                except Exception:
                    self._ask_plist_complete = False
        finally:
            try:
                if response is not None:
                    response.close()
            finally:
                connection.timeout = previous_connection
                try:
                    sock.settimeout(previous)
                except OSError:
                    pass

    def send_upload(self, files, **kwargs):
        self.report("preparing")
        return super().send_upload(files, **kwargs)

    def _send_watched(self, data):
        # Preserve upstream's per-write stall timeout. Where Linux exposes TCP
        # counters, keep measuring ACKs while the HTTP confirmation is pending.
        # An ACK still does NOT prove the phone saved/verified the file.
        stall = float(os.environ.get("AIRDROP_STALL_TIMEOUT", "30"))
        sock = self.http_conn.sock
        previous = sock.gettimeout()
        sock.settimeout(stall)
        view = memoryview(data)
        self._upload_started = time.monotonic()
        self._upload_total = len(view)
        baseline = tcp_position(sock)
        self._measurement = "tcpAck" if baseline is not None else "tlsWritten"
        sent = 0
        last = 0.0
        self.report("sending", 0, len(view))
        stop = None
        if baseline is not None:
            # Start BEFORE sendall can block on a full kernel queue. The old
            # monitor started after the entire file had been written, leaving
            # slow transfers with no progress at all during the actual upload.
            start = sum(baseline)
            ledger = deque()
            lock = threading.Lock()
            stop = self._progress_stop = threading.Event()
            def monitor():
                done = 0
                last_ack, advanced = None, time.monotonic()
                while not stop.is_set():
                    acknowledged = tcp_acknowledged(sock)
                    if acknowledged is None:
                        return
                    if acknowledged != last_ack:
                        last_ack, advanced = acknowledged, time.monotonic()
                    with lock:
                        # Count only complete ACKed slices: conservative
                        # plaintext progress, never guessed TLS overhead.
                        while ledger and ledger[0][0] <= acknowledged:
                            _, done = ledger.popleft()
                    phase = "confirming" if done == len(view) else "stalled" if time.monotonic() - advanced >= 5 else "sending"
                    self.report(phase, done, len(view))
                    if done == len(view) or stop.wait(.2):
                        return
            self._progress_thread = threading.Thread(target=monitor, name="mochi-tcp-progress", daemon=True)
            self._progress_thread.start()
        try:
            for off in range(0, len(view), self.SEND_SLICE):
                part = view[off:off + self.SEND_SLICE]
                self.http_conn.send(part)
                sent += len(part)
                if baseline is not None:
                    position = tcp_position(sock)
                    if position is not None and sum(position) > start:
                        with lock:
                            ledger.append((sum(position), sent))
                now = time.monotonic()
                if sent == len(view) or now - last >= .2:
                    if baseline is None:
                        self.report("sending", sent, len(view))
                    last = now
            if baseline is None:
                self.report("confirming", sent, len(view))
        except BaseException:
            if stop is not None:
                stop.set()
                self._progress_thread.join(timeout=.3)
            raise
        finally:
            try:
                sock.settimeout(previous)
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-n", "--name", default="Mochi")
    parser.add_argument("-i", "--interface", default="awdl0")
    parser.add_argument("-r", "--receiver", required=True)
    parser.add_argument("-f", "--file", action="append", required=True)
    parser.add_argument("--report", help="Private snapshot of the freshly selected exact service")
    args = parser.parse_args()
    identifier = args.receiver.lower()
    if len(identifier) != 12 or any(c not in "0123456789abcdef" for c in identifier):
        parser.error("Select an exact AirDrop service ID")
    config = AirDropConfig(computer_name=args.name, interface=args.interface)
    with open(args.report or config.discovery_report) as stream:
        peers = json.load(stream)
    selected = [peer for peer in peers if peer.get("id", "").lower() == identifier
                and peer.get("name") and peer.get("discoverable")]
    if not selected:
        raise RuntimeError("Selected AirDrop service no longer exists; scan again")
    peer = selected[-1]
    if not all(os.path.isabs(path) and os.path.isfile(path) for path in args.file):
        parser.error("Select regular local files")
    client = MeasuredClient(config, (peer["address"], int(peer["port"])))
    # Exactly one accepted upload attempt. Never re-Ask/retry an ambiguous
    # delivery automatically or inherit diagnostic multi-arm settings.
    os.environ["OPENDROP_UPLOAD_ARMS"] = "reuse-chunked-dvzip-rawhdr"
    confirmed = False
    try:
        if not client.send_ask(args.file):
            print("Receiver declined", file=sys.stderr)
            return 1
        if not client.send_upload(args.file):
            return 1
        confirmed = True
        client.report("complete")
        return 0
    except Exception as error:
        client.report_failure(error)
        return 1
    finally:
        if client.http_conn is not None:
            if not confirmed and client.http_conn.sock is not None:
                try:
                    # Do not leave queued failed uploads retransmitting for
                    # minutes on the shared radio after this helper exits.
                    # This is only our failed socket, never a successful send
                    # or the independent receiver. No automatic retry occurs.
                    client.http_conn.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                except OSError:
                    pass
            try:
                client.http_conn.close()
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
