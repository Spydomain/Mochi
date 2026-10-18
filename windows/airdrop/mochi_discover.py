#!/usr/bin/env python3
"""One continuous, bounded AirDrop browser; no radio lifecycle or file sends."""
import concurrent.futures
import argparse
from http.client import HTTPConnection
import ipaddress
import json
import os
from pathlib import Path
import random
import signal
import socket
import stat
import struct
import sys
import tempfile
import threading
import time

from opendrop.client import AirDropBrowser, AirDropClient, HTTPSConnectionAWDL, DNSOutgoing, DNSQuestion, ServiceBrowser, const
from opendrop.config import AirDropConfig

LIMIT = 32
TTL = 180  # Display cache only; uploads always require a fresh named probe.
FRESH_TTL = 20
PROBE_INTERVAL = 4
WORKERS = 4
PROBE_TIMEOUT = 12


def query_interval(elapsed, uniform=random.uniform):
    # A small initial burst catches more AWDL listening windows. Jitter avoids
    # repeatedly landing in the same off-channel slot; later search stays quiet.
    return (.35 if elapsed < 3 else 1.0) * uniform(.8, 1.2)


class Directory:
    def __init__(self, own_address, clock=time.monotonic, wall=time.time):
        self.own_address = own_address.split("%", 1)[0]
        self.clock, self.wall = clock, wall
        self.lock = threading.Lock()
        self.services = {}
        self.peers = {}
        self.confirmed = set()
        self.pending = set()
        self.next_probe = {}
        self.version = 0
        self.observed = {}
        self.failures = {}
        self.focused = None
        self.focus_until = 0

    def add(self, info):
        if info is None:
            return
        identifier = info.name.split(".")[0].lower()
        addresses = info.parsed_addresses()
        try:
            address = next(str(ipaddress.IPv6Address(value.split("%", 1)[0]))
                           for value in addresses if ipaddress.ip_address(value.split("%", 1)[0]).is_link_local
                           and ipaddress.ip_address(value.split("%", 1)[0]).version == 6)
        except (StopIteration, ValueError, AttributeError):
            return
        if (len(identifier) != 12 or any(c not in "0123456789abcdef" for c in identifier)
                or address == self.own_address or not 1 <= int(info.port) <= 65535):
            return
        with self.lock:
            old = self.services.get(identifier)
            endpoint = (address, int(info.port))
            if old and old[:2] == endpoint:
                self.observed[identifier] = (self.wall(), self.clock())
                return
            # A phone can rotate its service ID while keeping the same
            # endpoint. Retire the old row rather than displaying two phones.
            duplicates = {key for key, value in self.services.items() if key != identifier and value[:2] == endpoint}
            duplicates.update(key for key, value in self.peers.items() if key != identifier
                              and (value[0]["address"], value[0]["port"]) == endpoint)
            for key in duplicates:
                self.services.pop(key, None)
                self.peers.pop(key, None)
                self.next_probe.pop(key, None)
                self.confirmed.discard(key)
                self.observed.pop(key, None)
                self.failures.pop(key, None)
            if len(self.services) >= LIMIT and identifier not in self.services:
                return
            self.version += 1
            self.services[identifier] = (*endpoint, self.version)
            self.observed[identifier] = (self.wall(), self.clock())
            self.failures.pop(identifier, None)
            self.confirmed.discard(identifier)
            cached = self.peers.get(identifier)
            if cached and (cached[0]["address"], cached[0]["port"]) != endpoint:
                self.peers.pop(identifier, None)
            self.next_probe[identifier] = 0

    def remove(self, name):
        identifier = name.split(".")[0].lower()
        with self.lock:
            self.services.pop(identifier, None)
            self.next_probe.pop(identifier, None)
            self.confirmed.discard(identifier)
            self.observed.pop(identifier, None)
            self.failures.pop(identifier, None)

    def restore(self, rows):
        # Restore names for display, NEVER mDNS services or probe eligibility.
        # A revalidation browser does not load this cache at all.
        with self.lock:
            for row in rows[:LIMIT]:
                try:
                    key = row["id"]
                    name = row["name"]
                    age = self.wall() - float(row["lastSeen"])
                    address = ipaddress.IPv6Address(row["address"].split("%", 1)[0])
                    if (len(key) == 12 and all(c in "0123456789abcdef" for c in key)
                            and isinstance(name, str) and 0 < len(name) <= 80 and not any(ord(c) < 32 for c in name)
                            and address.is_link_local and str(address) != self.own_address
                            and 1 <= int(row["port"]) <= 65535 and 0 <= age <= TTL):
                        self.peers[key] = ({"id": key, "name": name, "address": row["address"],
                            "port": int(row["port"]), "lastSeen": float(row["lastSeen"]),
                            "discoverable": True}, self.clock() - age)
                except (KeyError, TypeError, ValueError, AttributeError):
                    continue

    def due(self):
        with self.lock:
            now = self.clock()
            due = []
            for identifier, endpoint in sorted(self.services.items(),
                    key=lambda row: (0 if row[0] == self.focused and now < self.focus_until else 1,
                                     self.next_probe.get(row[0], 0), -self.observed[row[0]][1])):
                if len(self.pending) >= WORKERS:
                    break
                if identifier not in self.pending and now >= self.next_probe.get(identifier, 0):
                    self.pending.add(identifier)
                    # Schedule from completion, not the beginning of a slow
                    # probe. At most WORKERS jobs exist; no hidden executor queue
                    # lets unresponsive bystanders delay a newly seen phone.
                    self.next_probe[identifier] = float("inf")
                    due.append((identifier, endpoint))
            return due

    def focus(self, identifier):
        with self.lock:
            if identifier not in self.services:
                return False  # Cache-only or rotated IDs never start a probe.
            self.focused, self.focus_until = identifier, self.clock() + 15
            if identifier not in self.pending:
                self.next_probe[identifier] = 0
            return True

    def resolved(self, identifier, endpoint, name):
        with self.lock:
            self.pending.discard(identifier)
            if self.services.get(identifier) != endpoint:
                return  # A removed/rotated service cannot be resurrected by a slow probe.
            if isinstance(name, str) and name.strip() and len(name) <= 80 and not any(ord(c) < 32 for c in name):
                self.failures.pop(identifier, None)
                self.next_probe[identifier] = self.clock() + PROBE_INTERVAL
                if identifier not in self.peers and len(self.peers) >= LIMIT:
                    oldest = min(self.peers, key=lambda key: self.peers[key][1])
                    self.peers.pop(oldest, None)
                self.peers[identifier] = ({"id": identifier, "address": endpoint[0], "port": endpoint[1],
                    "name": name.strip(), "discoverable": True, "lastSeen": self.wall()}, self.clock())
                self.confirmed.add(identifier)
            else:
                failures = self.failures.get(identifier, 0) + 1
                self.failures[identifier] = failures
                self.next_probe[identifier] = self.clock() + min(8, 2 ** min(failures - 1, 3))

    def snapshot(self):
        with self.lock:
            now = self.clock()
            self.peers = {key: value for key, value in self.peers.items() if now - value[1] <= TTL}
            return [value[0] for _, value in sorted(self.peers.items())]

    def fresh_snapshot(self):
        with self.lock:
            now = self.clock()
            return [value[0] for key, value in sorted(self.peers.items())
                     if key in self.services and key in self.confirmed and now - value[1] <= FRESH_TTL]

    def send_snapshot(self):
        with self.lock:
            now = self.clock()
            rows = []
            for key, (row, verified) in sorted(self.peers.items()):
                if key not in self.services or key not in self.confirmed:
                    continue
                announced_wall, announced = self.observed[key]
                if now - verified <= FRESH_TTL or (now - verified <= TTL and now - announced <= 30):
                    # A successful name probe IN THIS SEARCH plus a current
                    # announcement of the SAME ID/endpoint is not a cache-only
                    # recipient. The sender can open its acceptance connection
                    # without another potentially blocked /Discover request.
                    rows.append({**row, "sessionVerified": True, "lastAnnounced": announced_wall})
            return rows

    def display_snapshot(self):
        rows = self.snapshot()
        with self.lock:
            known = {row["id"] for row in rows}
            for key, endpoint in self.services.items():
                if key not in known and self.clock() - self.observed[key][1] <= 30:
                    rows.append({"id": key, "name": None, "address": endpoint[0], "port": endpoint[1],
                        "discoverable": False, "lastSeen": self.observed[key][0],
                        "connection": "retrying" if self.failures.get(key) else "connecting"})
        return rows[:LIMIT]


class DiscoveryConnection(HTTPSConnectionAWDL):
    """Abort only discovery sockets, including failures inside TLS wrapping.

    SSLContext.wrap_socket detaches the raw socket and closes its SSL socket
    internally when a handshake times out. HTTPConnection.sock then points at
    the already-detached raw object, too late for Probe.close to set SO_LINGER.
    Configure the owned TCP socket before wrapping, so failed probes cannot
    leave minutes of queued TLS retransmissions competing with the next send.
    No file uploads, receiver sockets or system TCP settings use this class.
    """
    def create_connection_awdl(self, *args, **kwargs):
        sock = super().create_connection_awdl(*args, **kwargs)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        except OSError:
            sock.close()
            raise
        return sock

    def connect(self):
        # Preserve IPv6 scope for routing, but not for TLS's server name.
        HTTPConnection.connect(self)
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


class Probe:
    """One owned, reusable /Discover connection. Never asks or uploads files."""
    def __init__(self, config, context, endpoint):
        self.config, self.context, self.endpoint = config, context, endpoint
        self.client = None

    def close(self, abort=False):
        client, self.client = self.client, None
        connection = client.http_conn if client is not None else None
        if connection is None:
            return
        if abort and connection.sock is not None:
            try:
                # Abandon only this failed discovery socket, not the receiver
                # or a sender. Otherwise queued TLS data can leave FIN-WAIT
                # retransmissions running for minutes after every timeout.
                connection.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            except OSError:
                pass
        try:
            connection.close()
        except OSError:
            pass

    def resolve(self):
        reused = self.client is not None
        # A keep-alive may have closed while idle. Retry a stale cached
        # connection once, discovery-only; this can never repeat an upload.
        for attempt in range(2 if reused else 1):
            try:
                if self.client is None:
                    self.client = AirDropClient(self.config, self.endpoint[:2])
                    self.client.http_conn = DiscoveryConnection(self.endpoint[0], self.endpoint[1],
                        interface_name=self.config.interface, context=self.context, timeout=PROBE_TIMEOUT)
                name = self.client.send_discover()
                if not isinstance(name, str) or not name.strip():
                    self.close()
                    return None
                return name
            except (ConnectionError, OSError, EOFError) as error:
                self.close(abort=True)
                # Do not immediately repeat another slow/timed-out handshake.
                if isinstance(error, TimeoutError) or attempt == (1 if reused else 0):
                    return None
            except Exception:
                self.close(abort=True)
                return None
        return None


def private_json(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 2048:
                return None
            data = json.load(stream)
            return data if isinstance(data, dict) else None
    except (OSError, ValueError, TypeError):
        return None


def read_focus(path, now=time.time):
    data = private_json(path)
    if not data:
        return None
    identifier, nonce, expires = data.get("id"), data.get("nonce"), data.get("expires")
    if (isinstance(identifier, str) and len(identifier) == 12 and all(c in "0123456789abcdef" for c in identifier)
            and isinstance(nonce, str) and 0 < len(nonce) <= 80 and isinstance(expires, (int, float))
            and now() < expires <= now() + 30):
        return nonce, identifier
    return None


def receiving_active(path, now=time.time):
    data = private_json(path)
    if not data:
        return False
    if "progress" not in data and "rawPath" not in data:
        # /Ask has been explicitly accepted but /Upload may not have arrived.
        # Do not compete with that connection setup. The bounded pause cannot
        # keep discovery suspended forever if the phone goes away.
        start, offset, directory = data.get("start"), data.get("offset"), data.get("directory")
        return (isinstance(start, int) and not isinstance(start, bool) and 0 <= now() - start <= 90
                and isinstance(offset, int) and offset >= 0 and isinstance(directory, str)
                and Path(directory).is_absolute())
    if not isinstance(data.get("progress"), dict):
        return False
    progress = data["progress"]
    updated = progress.get("updatedMs")
    if (progress.get("phase") not in ("receiving", "verifying") or not isinstance(updated, (int, float))
            or not 0 <= now() * 1000 - updated <= 300000):
        return False
    try:
        raw = Path(data["rawPath"])
        incoming = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "mochi/airdrop/incoming"
        relative = raw.relative_to(incoming)
        return (raw.is_absolute() and raw.resolve() == raw and len(relative.parts) == 2
                and relative.parts[0].startswith("receive-") and raw.is_file())
    except (KeyError, TypeError, ValueError, OSError):
        return False


def consent_pending(path, now=time.time):
    data = private_json(path)
    identifier = data.get("id") if data else None
    if not isinstance(identifier, str) or len(identifier) != 32 or any(c not in "0123456789abcdef" for c in identifier):
        return False
    try:
        return 0 <= now() - Path(path).stat().st_mtime <= 35
    except OSError:
        return False


def write_report(path, rows):
    parent = os.path.dirname(path)
    os.makedirs(parent, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".mochi-discovery-", dir=parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(rows, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", action="store_true", help="Keep recently resolved names for display only")
    args = parser.parse_args()
    config = AirDropConfig(interface="awdl0", computer_name="Mochi")
    directory = None
    class Browser(AirDropBrowser):
        def pause_receiving(self, paused):
            if paused == self._receive_paused.is_set():
                return
            if paused:
                self._receive_paused.set()
                if self.browser is not None:
                    self.browser.cancel()
                    self.browser = None
                with directory.lock:
                    identifiers = list(directory.services)
                for identifier in identifiers:
                    directory.remove(identifier)
            else:
                self.browser = ServiceBrowser(self.zeroconf, "_airdrop._tcp.local.", self)
                self._burst_until = time.monotonic() + 3
                self._receive_paused.clear()

        def _start_repeat_query(self):
            stop = self._repeat_stop = threading.Event()
            started = time.monotonic()
            def repeat():
                while not stop.wait(query_interval(0 if time.monotonic() < getattr(self, "_burst_until", 0) else time.monotonic() - started)):
                    if self._receive_paused.is_set():
                        continue
                    try:
                        out = DNSOutgoing(const._FLAGS_QR_QUERY)
                        out.add_question(DNSQuestion("_airdrop._tcp.local.", const._TYPE_PTR, const._CLASS_IN))
                        self.zeroconf.send(out)
                    except Exception:
                        if stop.is_set():
                            return
            self._repeat_thread = threading.Thread(target=repeat, name="mochi-mdns-burst", daemon=True)
            self._repeat_thread.start()

        def remove_service(self, zeroconf, service_type, name):
            directory.remove(name)
    browser = Browser(config)
    browser._receive_paused = threading.Event()
    directory = Directory(str(browser.ip_addr))
    cache = os.path.join(os.environ["XDG_RUNTIME_DIR"], "mochi-airdrop", "devices-cache.json") if args.cache and os.environ.get("XDG_RUNTIME_DIR") else None
    if cache:
        try:
            fd = os.open(cache, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd) as stream:
                stat = os.fstat(stream.fileno())
                if stat.st_uid == os.getuid() and not stat.st_mode & 0o077 and stat.st_size <= 32768:
                    rows = json.load(stream)
                    if isinstance(rows, list):
                        directory.restore(rows)
        except (OSError, ValueError, TypeError):
            pass
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS)
    context = config.get_ssl_context()
    probes = {}
    probes_lock = threading.Lock()
    def probe(identifier, endpoint):
        with probes_lock:
            entry = probes.get(identifier)
            if entry is None or entry[0] != endpoint:
                if entry is not None:
                    entry[1].close()
                entry = (endpoint, Probe(config, context, endpoint))
                probes[identifier] = entry
        name = None
        try:
            name = entry[1].resolve()
        finally:
            directory.resolved(identifier, endpoint, name)
    previous = None
    previous_report = None
    previous_focus = None
    runtime = Path(os.environ["XDG_RUNTIME_DIR"]) / "mochi-airdrop" if os.environ.get("XDG_RUNTIME_DIR") else None
    try:
        write_report(config.discovery_report, [])
        browser.start(callback_add=directory.add)
        while not stop.is_set():
            paused = runtime is not None and (consent_pending(runtime / "active/request.json")
                                              or receiving_active(runtime / "transfer.json"))
            browser.pause_receiving(paused)
            focus = read_focus(runtime / "find-focus.json") if runtime is not None else None
            if focus and focus[0] != previous_focus:
                if directory.focus(focus[1]):
                    previous_focus = focus[0]
                    browser._burst_until = time.monotonic() + 3
            if not paused:
                for identifier, endpoint in directory.due():
                    pool.submit(probe, identifier, endpoint)
            rows = directory.snapshot()
            # Sender eligibility is separate from the display cache: a name
            # verified in this browser plus a current exact announcement can
            # proceed to the real acceptance connection without another probe.
            sendable = directory.send_snapshot()
            report = json.dumps(sendable, separators=(",", ":"))
            if report != previous_report:
                write_report(config.discovery_report, sendable)
                previous_report = report
            display = directory.display_snapshot()
            encoded = json.dumps(display, separators=(",", ":"))
            if encoded != previous:
                if cache:
                    write_report(cache, rows)
                print(encoded, flush=True)
                previous = encoded
            # Retire removed/rotated endpoint sockets after their in-flight
            # probe returns. Keep socket ownership bounded by the service list.
            with directory.lock:
                retained = set(directory.services) | directory.pending
            with probes_lock:
                for identifier in list(probes):
                    if identifier not in retained:
                        _, old = probes.pop(identifier)
                        old.close()
            stop.wait(.25)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        # AirDropBrowser.stop assumes a live ServiceBrowser, even when we
        # intentionally suspended it for an incoming transfer.
        if browser.browser is None:
            if browser._repeat_stop is not None:
                browser._repeat_stop.set()
            browser.zeroconf.close()
        else:
            browser.stop()


if __name__ == "__main__":
    main()
