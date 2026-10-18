#!/usr/bin/env python3
"""Continuous discovery and measured sending; no radio or network access."""
import importlib.util
import ast
import io
import contextlib
import errno
from http.client import HTTPConnection, IncompleteRead
import json
import hashlib
import os
import plistlib
import random
from pathlib import Path
import socket
import ssl
import struct
import subprocess
import time
import threading
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


browse = load("mochi_test_browse", "windows/airdrop/mochi_discover.py")
send = load("mochi_test_send", "windows/airdrop/mochi_send.py")


def info(identifier="000000000000", address="fe80::2", port=8770):
    return SimpleNamespace(name=identifier + "._airdrop._tcp.local.", port=port,
                           parsed_addresses=lambda: [address])


class DirectoryTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.directory = browse.Directory("fe80::1", clock=lambda: self.now, wall=lambda: 1000 + self.now)

    def resolve(self, identifier="000000000000", name="My iPhone", address="fe80::2"):
        self.directory.add(info(identifier, address=address))
        due = self.directory.due()
        for key, endpoint in due:
            self.directory.resolved(key, endpoint, name)

    def test_self_and_invalid_ids_and_ports_are_never_probed(self):
        for service in (None, info(address="fe80::1"), info(address="fe80::1%awdl0"), info("not-an-id"), info(port=0), info(port=65536)):
            self.directory.add(service)
        self.assertEqual(self.directory.due(), [])

    def test_exact_numeric_id_deduplicates_without_accumulating_rows(self):
        self.resolve()
        for _ in range(20):
            self.directory.add(info())
        rows = self.directory.snapshot()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "000000000000")
        self.assertEqual(self.directory.due(), [], "no concurrent or hot-loop probe of the same service")
        self.now = browse.PROBE_INTERVAL
        due = self.directory.due()
        self.assertEqual(len(due), 1)
        self.assertEqual(self.directory.due(), [])

    def test_services_appear_after_first_resolution_while_browsing_continues(self):
        self.resolve()
        self.resolve("abcdef123456", "Second iPhone", "fe80::3")
        self.assertEqual({row["name"] for row in self.directory.snapshot()}, {"My iPhone", "Second iPhone"})

    def test_live_exact_announcement_does_not_require_repeating_name_probe_after_chooser(self):
        self.resolve()
        self.now = 25
        self.assertEqual(self.directory.fresh_snapshot(), [])
        self.directory.add(info())  # Same live ID and endpoint reannounced.
        row, = self.directory.send_snapshot()
        self.assertEqual(row["id"], "000000000000")
        self.assertTrue(row["sessionVerified"])
        self.assertEqual(row["lastSeen"], 1000)
        self.assertEqual(row["lastAnnounced"], 1025)
        self.now = 56
        self.assertEqual(self.directory.send_snapshot(), [], "an old announcement is not a live recipient")

    def test_cache_only_removed_rotated_and_changed_endpoints_cannot_bypass_probe(self):
        self.resolve()
        rows = self.directory.snapshot()
        restored = browse.Directory("fe80::1", clock=lambda: self.now, wall=lambda: 1000 + self.now)
        restored.restore(rows)
        self.assertEqual(restored.send_snapshot(), [])
        restored.add(info())
        self.assertEqual(restored.send_snapshot(), [], "a restored display name is not verified in this search")
        self.directory.remove("000000000000")
        self.assertEqual(self.directory.send_snapshot(), [])
        self.resolve()
        self.directory.add(info(address="fe80::9"))
        self.assertEqual(self.directory.send_snapshot(), [], "an endpoint change must be freshly named")
        self.resolve()
        self.directory.add(info("abcdef123456"))
        self.assertEqual(self.directory.send_snapshot(), [], "a rotated ID cannot inherit the selected name/grant")

    def test_missing_phone_expires_instead_of_remaining_sendable_forever(self):
        self.resolve()
        self.now = browse.FRESH_TTL + .01
        self.assertEqual(len(self.directory.snapshot()), 1, "brief dropouts retain the known phone")
        self.assertEqual(self.directory.fresh_snapshot(), [], "cached names never authorize an upload")
        self.now = browse.TTL + .01
        self.assertEqual(self.directory.snapshot(), [])

    def test_goodbye_retains_recent_name_but_cannot_authorize_a_send(self):
        self.resolve()
        self.assertEqual(len(self.directory.fresh_snapshot()), 1)
        self.directory.remove(info().name)
        self.assertEqual(len(self.directory.snapshot()), 1)
        self.assertEqual(self.directory.fresh_snapshot(), [])
        self.assertEqual(self.directory.due(), [])

    def test_cached_names_survive_restart_without_becoming_fresh_services(self):
        self.resolve()
        cached = self.directory.snapshot()
        self.now = 60
        restored = browse.Directory("fe80::1", clock=lambda: self.now, wall=lambda: 1000 + self.now)
        restored.restore(cached)
        self.assertEqual(restored.snapshot(), cached)
        self.assertEqual(restored.services, {})
        self.assertEqual(restored.due(), [])
        self.assertEqual(restored.fresh_snapshot(), [])
        restored.add(info())
        self.assertEqual(restored.fresh_snapshot(), [], "mDNS alone cannot authorize the cached name")
        key, endpoint = restored.due()[0]
        restored.resolved(key, endpoint, "My iPhone")
        self.assertEqual(len(restored.fresh_snapshot()), 1)
        self.now = 200
        restored = browse.Directory("fe80::1", clock=lambda: self.now, wall=lambda: 1000 + self.now)
        restored.restore(cached)
        self.assertEqual(restored.snapshot(), [], "restart must not extend last-seen expiry")

    def test_repeat_resolution_refreshes_expiry_and_updates_names_without_duplicate_rows(self):
        self.resolve()
        self.now = 150
        self.resolve(name="Renamed iPhone")
        self.now = 200
        self.assertEqual([row["name"] for row in self.directory.snapshot()], ["Renamed iPhone"])
        self.assertEqual(self.directory.snapshot()[0]["lastSeen"], 1150)

    def test_invalid_or_expired_cache_rows_are_ignored(self):
        self.resolve()
        row = self.directory.snapshot()[0]
        self.directory.peers.clear()
        self.directory.restore([None, {}, {**row, "id": "--bad-id"}, {**row, "lastSeen": 0},
                                {**row, "lastSeen": float("nan")}, {**row, "lastSeen": 9999},
                                {**row, "name": "bad\nname"}, {**row, "address": "::1"}])
        self.assertEqual(self.directory.snapshot(), [])

    def test_removed_or_readdressed_phone_cannot_be_resurrected_by_old_probe(self):
        self.directory.add(info())
        key, endpoint = self.directory.due()[0]
        self.directory.remove(info().name)
        self.directory.resolved(key, endpoint, "Old phone")
        self.assertEqual(self.directory.snapshot(), [])
        self.directory.add(info())
        key, endpoint = self.directory.due()[0]
        self.directory.add(info(address="fe80::3"))
        self.directory.resolved(key, endpoint, "Old address")
        self.assertEqual(self.directory.snapshot(), [])

    def test_untrusted_discovery_is_bounded_and_names_are_checked(self):
        for number in range(100):
            self.directory.add(info(f"{number:012x}", address=f"fe80::{number + 2:x}"))
        self.assertEqual(len(self.directory.services), browse.LIMIT)
        due = self.directory.due()
        self.assertLessEqual(len(due), browse.LIMIT)
        for key, endpoint in due:
            self.directory.resolved(key, endpoint, "unsafe\nname")
        self.assertEqual(self.directory.snapshot(), [])

    def test_rotating_service_ids_do_not_duplicate_a_phone_or_grow_the_probe_queue(self):
        self.resolve()
        self.directory.add(info("abcdef123456"))
        self.assertEqual(self.directory.snapshot(), [])
        self.assertEqual(list(self.directory.services), ["abcdef123456"])
        for number in range(100):
            self.directory.add(info(f"{number:012x}"))
            self.directory.due()
        self.assertLessEqual(len(self.directory.pending), browse.LIMIT)
        self.assertEqual(len(self.directory.services), 1)

    def test_reports_are_atomic_private_and_contain_only_current_rows(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "discovery.json"
            self.resolve()
            browse.write_report(str(path), self.directory.snapshot())
            self.assertEqual(json.loads(path.read_text())[0]["name"], "My iPhone")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            browse.write_report(str(path), [])
            self.assertEqual(json.loads(path.read_text()), [])
            self.assertEqual([p.name for p in path.parent.iterdir()], ["discovery.json"])

    def test_detected_service_is_visible_immediately_but_never_sendable_until_named(self):
        self.directory.add(info())
        row = self.directory.display_snapshot()[0]
        self.assertIsNone(row["name"])
        self.assertFalse(row["discoverable"])
        self.assertEqual(row["connection"], "connecting")
        self.assertEqual(self.directory.snapshot(), [], "unnamed rows must not enter the name cache")
        self.assertEqual(self.directory.fresh_snapshot(), [])
        key, endpoint = self.directory.due()[0]
        self.directory.resolved(key, endpoint, None)
        self.assertEqual(self.directory.display_snapshot()[0]["connection"], "retrying")
        self.now = 31
        self.assertEqual(self.directory.display_snapshot(), [])

    def test_probe_queue_is_bounded_by_workers_and_new_phone_does_not_wait_behind_queued_jobs(self):
        for number in range(12):
            self.directory.add(info(f"{number:012x}", address=f"fe80::{number + 2:x}"))
        due = self.directory.due()
        self.assertEqual(len(due), browse.WORKERS)
        self.assertEqual(self.directory.due(), [])
        self.now = 12
        self.directory.add(info("abcdef123456", address="fe80::abcd"))
        key, endpoint = due[0]
        self.directory.resolved(key, endpoint, None)
        next_due = self.directory.due()
        self.assertEqual(len(next_due), 1)
        self.assertNotEqual(next_due[0][0], key, "slow failures must not monopolize probe capacity")
        self.assertEqual(next_due[0][0], "abcdef123456", "new announcements are not buried behind old unresolved services")

    def test_retries_back_off_from_completion_instead_of_restarting_a_timed_out_socket_immediately(self):
        self.directory.add(info())
        key, endpoint = self.directory.due()[0]
        self.now = 12
        self.directory.resolved(key, endpoint, None)
        self.assertEqual(self.directory.due(), [])
        self.now = 13
        self.assertEqual(self.directory.due(), [(key, endpoint)])

    def test_query_burst_is_short_bounded_and_jittered(self):
        self.assertLess(browse.query_interval(0, lambda low, high: low), .5)
        self.assertGreater(browse.query_interval(10, lambda low, high: low), .5)
        self.assertNotEqual(browse.query_interval(0, lambda low, high: low), browse.query_interval(0, lambda low, high: high))

    def test_focus_prioritizes_only_a_current_exact_service_without_waiting_for_its_refresh_interval(self):
        self.resolve()
        self.now = 1
        self.assertEqual(self.directory.due(), [])
        self.assertFalse(self.directory.focus("abcdef123456"))
        self.assertTrue(self.directory.focus("000000000000"))
        self.assertEqual(self.directory.due()[0][0], "000000000000")
        cached = browse.Directory("fe80::1", clock=lambda: self.now, wall=lambda: 1000 + self.now)
        cached.restore(self.directory.snapshot())
        self.assertEqual(len(cached.snapshot()), 1)
        self.assertFalse(cached.focus("000000000000"), "a cached name is not an advertised service")

    def test_focus_requests_expire_and_are_private_and_exact(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = Path(temporary) / "focus.json"
            request.write_text(json.dumps({"id": "000000000000", "nonce": "request-1", "expires": 110}))
            request.chmod(0o600)
            self.assertEqual(browse.read_focus(request, now=lambda: 100), ("request-1", "000000000000"))
            self.assertIsNone(browse.read_focus(request, now=lambda: 111))
            request.chmod(0o644)
            self.assertIsNone(browse.read_focus(request, now=lambda: 100))
            request.chmod(0o600)
            link = Path(temporary) / "link.json"
            link.symlink_to(request)
            self.assertIsNone(browse.read_focus(link, now=lambda: 100))

    def test_discovery_pauses_only_for_a_current_real_receive_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "mochi/airdrop/incoming/receive-test/data.dvzip"
            raw.parent.mkdir(parents=True)
            raw.write_bytes(b"test")
            marker = root / "transfer.json"
            value = {"rawPath": str(raw), "progress": {"phase": "receiving", "updatedMs": 100000}}
            marker.write_text(json.dumps(value)); marker.chmod(0o600)
            with patch.dict(os.environ, XDG_CACHE_HOME=str(root)):
                self.assertTrue(browse.receiving_active(marker, now=lambda: 100))
                value["progress"]["phase"] = "complete"
                marker.write_text(json.dumps(value))
                self.assertFalse(browse.receiving_active(marker, now=lambda: 100))
                value["progress"]["phase"] = "verifying"
                marker.write_text(json.dumps(value))
                self.assertFalse(browse.receiving_active(marker, now=lambda: 500))
                raw.unlink()
                self.assertFalse(browse.receiving_active(marker, now=lambda: 100))

    def test_accepted_request_pauses_discovery_only_during_bounded_upload_setup(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "transfer.json"
            value = {"start": 100, "offset": 0, "directory": str(Path(temporary))}
            marker.write_text(json.dumps(value)); marker.chmod(0o600)
            for now in (100, 115, 190):
                self.assertTrue(browse.receiving_active(marker, now=lambda: now))
            for now in (99, 191):
                self.assertFalse(browse.receiving_active(marker, now=lambda: now))
            for invalid in ({**value, "start": True}, {**value, "offset": -1},
                            {**value, "directory": "relative"}, {**value, "progress": {"phase": "complete"}}):
                marker.write_text(json.dumps(invalid))
                self.assertFalse(browse.receiving_active(marker, now=lambda: 100))
            marker.write_text(json.dumps(value)); marker.chmod(0o644)
            self.assertFalse(browse.receiving_active(marker, now=lambda: 100))

    def test_consent_pause_requires_a_private_fresh_request_and_resumes_after_expiry(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = Path(temporary) / "request.json"
            request.write_text(json.dumps({"id": "a" * 32})); request.chmod(0o600)
            os.utime(request, (100, 100))
            self.assertTrue(browse.consent_pending(request, now=lambda: 100))
            self.assertTrue(browse.consent_pending(request, now=lambda: 135))
            self.assertFalse(browse.consent_pending(request, now=lambda: 136))
            self.assertFalse(browse.consent_pending(request, now=lambda: 99))
            request.chmod(0o644)
            self.assertFalse(browse.consent_pending(request, now=lambda: 100))
            request.chmod(0o600)
            link = Path(temporary) / "link.json"; link.symlink_to(request)
            self.assertFalse(browse.consent_pending(link, now=lambda: 100))
            for identifier in ("b" * 31, "g" * 32, None, 32):
                request.write_text(json.dumps({"id": identifier})); os.utime(request, (100, 100))
                self.assertFalse(browse.consent_pending(request, now=lambda: 100))

    def test_receive_pause_suspends_actual_service_queries_and_invalidates_inflight_service_results(self):
        tree = ast.parse((ROOT / "windows/airdrop/mochi_discover.py").read_text())
        node = next(node for node in ast.walk(tree) if isinstance(node, ast.ClassDef) and node.name == "Browser")
        service_browser = Mock()
        scope = {**vars(browse), "directory": self.directory, "ServiceBrowser": service_browser}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), "browser-test", "exec"), scope)
        browser = scope["Browser"].__new__(scope["Browser"])
        browser.browser = Mock()
        previous = browser.browser
        browser.zeroconf = Mock()
        browser._receive_paused = threading.Event()
        self.resolve()
        browser.pause_receiving(True)
        previous.cancel.assert_called_once()
        self.assertIsNone(browser.browser)
        self.assertTrue(browser._receive_paused.is_set())
        self.assertEqual(self.directory.fresh_snapshot(), [])
        self.assertEqual(len(self.directory.snapshot()), 1, "display cache survives the pause")
        browser.pause_receiving(False)
        service_browser.assert_called_once_with(browser.zeroconf, "_airdrop._tcp.local.", browser)
        self.assertFalse(browser._receive_paused.is_set())


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.config = SimpleNamespace(interface="awdl0")

    def test_successful_discovery_connection_is_reused_instead_of_repeating_tls_handshakes(self):
        client = Mock(send_discover=Mock(side_effect=["My iPhone", "My iPhone"]))
        connection = Mock()
        with patch.object(browse, "AirDropClient", return_value=client) as factory, patch.object(browse, "DiscoveryConnection", return_value=connection) as https:
            probe = browse.Probe(self.config, "context", ("fe80::2", 8770, 1))
            self.assertEqual(probe.resolve(), "My iPhone")
            self.assertEqual(probe.resolve(), "My iPhone")
            factory.assert_called_once()
            https.assert_called_once()
            self.assertGreater(https.call_args.kwargs["timeout"], 4, "do not abort high-RTT TLS handshakes at four seconds")
            connection.close.assert_not_called()
            client.send_ask.assert_not_called()
            client.send_upload.assert_not_called()
            probe.close()
            connection.close.assert_called_once()

    def test_stale_keepalive_is_replaced_once_without_ever_sending_files(self):
        first = Mock(send_discover=Mock(side_effect=["My iPhone", ConnectionResetError("closed")]))
        second = Mock(send_discover=Mock(return_value="My iPhone"))
        with patch.object(browse, "AirDropClient", side_effect=[first, second]) as factory, patch.object(browse, "DiscoveryConnection", side_effect=[Mock(), Mock()]):
            probe = browse.Probe(self.config, "context", ("fe80::2", 8770, 1))
            self.assertEqual(probe.resolve(), "My iPhone")
            self.assertEqual(probe.resolve(), "My iPhone")
            self.assertEqual(factory.call_count, 2)
            first.send_ask.assert_not_called()
            second.send_ask.assert_not_called()
            probe.close()

    def test_timeout_aborts_only_its_owned_probe_without_immediate_repeat(self):
        client = Mock(send_discover=Mock(side_effect=TimeoutError("slow link")))
        connection = Mock()
        with patch.object(browse, "AirDropClient", return_value=client) as factory, patch.object(browse, "DiscoveryConnection", return_value=connection):
            probe = browse.Probe(self.config, "context", ("fe80::2", 8770, 1))
            self.assertIsNone(probe.resolve())
            factory.assert_called_once()
            client.send_discover.assert_called_once()
            connection.close.assert_called_once()
            connection.sock.setsockopt.assert_called_once()
            self.assertIsNone(probe.client)

    def test_failed_tls_handshake_aborts_before_ssl_discards_its_socket(self):
        # Real loopback TCP, deliberately no TLS response. The upstream
        # connection leaves a graceful FIN here: its raw socket was detached
        # before Probe.close could set linger. The discovery-only class must
        # issue RST on the internal SSL failure path, with no upload involved.
        outcome, errors = [], []
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(3)
            def receive():
                try:
                    peer, _ = listener.accept()
                    with peer:
                        peer.settimeout(3)
                        self.assertTrue(peer.recv(65536), "TLS ClientHello must actually arrive")
                        try:
                            outcome.append("eof" if peer.recv(1) == b"" else "extra")
                        except ConnectionResetError:
                            outcome.append("reset")
                except BaseException as error:
                    errors.append(error)
            thread = threading.Thread(target=receive, daemon=True)
            thread.start()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            connection = browse.DiscoveryConnection("127.0.0.1", listener.getsockname()[1], context=context, timeout=.2)
            try:
                with self.assertRaises(TimeoutError):
                    connection.connect()
            finally:
                connection.close()
                thread.join(timeout=4)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(outcome, ["reset"])

    def test_abortive_close_is_scoped_to_discovery_not_sender_connections(self):
        raw = Mock()
        with patch.object(browse.HTTPSConnectionAWDL, "create_connection_awdl", return_value=raw):
            connection = browse.DiscoveryConnection("127.0.0.1", 8770)
            self.assertIs(connection.create_connection_awdl(("127.0.0.1", 8770)), raw)
        raw.setsockopt.assert_called_once_with(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        self.assertIs(send.HTTPSConnectionAWDL, browse.HTTPSConnectionAWDL)
        self.assertIsNot(send.HTTPSConnectionAWDL, browse.DiscoveryConnection)

    def test_successful_tls_responses_and_keepalive_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix="mochi-discovery-tls-") as temporary, socket.socket() as listener:
            root = Path(temporary)
            certificate, key = root / "cert.pem", root / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
                            "-out", str(certificate), "-subj", "/CN=localhost", "-days", "1"],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server_context.load_cert_chain(certificate, key)
            client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            client_context.check_hostname = False
            client_context.verify_mode = ssl.CERT_NONE
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(3)
            requests, errors = [], []
            payloads = [b"first response" * 1024, b"final response" * 1024]
            def serve():
                try:
                    raw, _ = listener.accept()
                    with raw:
                        raw.settimeout(3)
                        with server_context.wrap_socket(raw, server_side=True) as peer, peer.makefile("rb") as incoming:
                            for index, payload in enumerate(payloads):
                                requests.append(incoming.readline())
                                while incoming.readline() not in (b"\r\n", b""):
                                    pass
                                close = b"Connection: close\r\n" if index else b""
                                peer.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(payload)).encode() + b"\r\n" + close + b"\r\n" + payload)
                except BaseException as error:
                    errors.append(error)
            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            connection = browse.DiscoveryConnection("127.0.0.1", listener.getsockname()[1], context=client_context, timeout=2)
            try:
                first_socket = None
                for index, payload in enumerate(payloads):
                    connection.request("POST", "/Discover", body=b"")
                    if index == 0:
                        first_socket = connection.sock
                    else:
                        self.assertIs(connection.sock, first_socket, "reuse the established TLS socket")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.read(), payload, "never discard a successful response body")
            finally:
                connection.close()
                thread.join(timeout=4)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(len(requests), 2)


class ScopedTLSTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="mochi-scoped-tls-")
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        cls.certificate, cls.key = root / "cert.pem", root / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(cls.key),
                        "-out", str(cls.certificate), "-subj", "/CN=localhost", "-days", "1"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_tcp_routing_keeps_scope_while_tls_uses_the_plain_ipv6_literal(self):
        for connection_type in (send.SenderConnection, browse.DiscoveryConnection):
            for host, interface, expected in (("fe80::2", "awdl0", "fe80::2"),
                                               ("fe80::2%7", "awdl0", "fe80::2"),
                                               ("127.0.0.1", None, "127.0.0.1"),
                                               ("example.test", None, "example.test")):
                with self.subTest(connection=connection_type.__name__, host=host):
                    context, raw, wrapped = Mock(), Mock(), Mock()
                    context.wrap_socket.return_value = wrapped
                    connection = connection_type(host, 8770, interface_name=interface, context=context)
                    original_host = connection.host
                    routes = []
                    def connect(instance):
                        routes.append(instance.host)
                        instance.sock = raw
                    with patch.object(send.HTTPConnection, "connect", connect):
                        connection.connect()
                    self.assertEqual(routes, [original_host])
                    self.assertEqual(connection.host, original_host)
                    context.wrap_socket.assert_called_once_with(raw, server_hostname=expected)
                    self.assertIs(connection.sock, wrapped)

    def test_sender_retries_refused_tcp_only_before_tls_without_changing_recipient(self):
        context, raw, wrapped = Mock(), Mock(), Mock()
        context.wrap_socket.return_value = wrapped
        connection = send.SenderConnection("fe80::2", 8770, interface_name="awdl0", context=context, timeout=30)
        routes = []
        def connect(instance):
            routes.append((instance.host, instance.port))
            if len(routes) < 3:
                raise ConnectionRefusedError(errno.ECONNREFUSED, "listener waking")
            instance.sock = raw
        with patch.object(send.HTTPConnection, "connect", connect), patch.object(send.time, "sleep") as sleep:
            connection.connect()
        self.assertEqual(routes, [("fe80::2%awdl0", 8770)] * 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [.25, .5])
        context.wrap_socket.assert_called_once_with(raw, server_hostname="fe80::2")
        self.assertIs(connection.sock, wrapped)
        self.assertEqual(connection.timeout, 30)

    def test_sender_connection_refusal_is_bounded_and_never_sends_a_request(self):
        context = Mock()
        connection = send.SenderConnection("127.0.0.1", 8770, context=context, timeout=30)
        with patch.object(send.HTTPConnection, "connect", side_effect=ConnectionRefusedError(errno.ECONNREFUSED, "closed")) as connect, \
                patch.object(send.time, "sleep") as sleep:
            with self.assertRaises(ConnectionRefusedError):
                connection.connect()
        self.assertEqual(connect.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        context.wrap_socket.assert_not_called()
        self.assertIsNone(connection.sock)
        self.assertEqual(connection.timeout, 30)

    def test_sender_never_retries_tls_errors_or_other_transport_failures(self):
        for error in (socket.timeout("timeout"), OSError(errno.ENETUNREACH, "no route"), PermissionError(errno.EACCES, "denied")):
            with self.subTest(error=type(error).__name__):
                context = Mock()
                connection = send.SenderConnection("127.0.0.1", 8770, context=context, timeout=30)
                with patch.object(send.HTTPConnection, "connect", side_effect=error) as connect, patch.object(send.time, "sleep") as sleep:
                    with self.assertRaises(type(error)):
                        connection.connect()
                connect.assert_called_once()
                sleep.assert_not_called()
                context.wrap_socket.assert_not_called()
        context, raw = Mock(), Mock()
        context.wrap_socket.side_effect = ConnectionRefusedError(errno.ECONNREFUSED, "failure during TLS")
        connection = send.SenderConnection("127.0.0.1", 8770, context=context, timeout=30)
        def connected(instance):
            instance.sock = raw
        with patch.object(send.HTTPConnection, "connect", connected), patch.object(send.time, "sleep") as sleep:
            with self.assertRaises(ConnectionRefusedError):
                connection.connect()
        sleep.assert_not_called()
        context.wrap_socket.assert_called_once()

    def test_sender_retry_does_not_extend_connection_deadline(self):
        connection = send.SenderConnection("127.0.0.1", 8770, context=Mock(), timeout=30)
        clock = [0]
        def refused(instance):
            clock[0] += 29.9
            raise ConnectionRefusedError(errno.ECONNREFUSED, "closed")
        with patch.object(send.HTTPConnection, "connect", refused), patch.object(send.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(send.time, "sleep") as sleep:
            with self.assertRaises(ConnectionRefusedError):
                connection.connect()
        sleep.assert_not_called()
        self.assertEqual(clock[0], 29.9)

    def test_real_listener_waking_receives_exactly_one_ask_after_tcp_retry(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))  # Deliberately not listening yet.
            listener.settimeout(3)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(self.certificate, self.key)
            requests, routes, errors = [], [], []
            def serve():
                try:
                    raw, _ = listener.accept()
                    with raw:
                        raw.settimeout(3)
                        with context.wrap_socket(raw, server_side=True) as peer:
                            with peer.makefile("rb") as stream:
                                request = stream.readline()
                                headers = {}
                                while line := stream.readline():
                                    if line == b"\r\n":
                                        break
                                    key, value = line.decode().split(":", 1)
                                    headers[key.lower()] = value.strip()
                                requests.append((request, stream.read(int(headers["content-length"]))))
                                peer.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
                except Exception as error:
                    errors.append(type(error).__name__)
            thread = threading.Thread(target=serve, daemon=True)
            client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            client_context.check_hostname = False
            client_context.verify_mode = ssl.CERT_NONE
            connection = send.SenderConnection("fe80::2", 8770, interface_name="awdl0", context=client_context, timeout=2)
            def route(address, timeout=None, source_address=None):
                routes.append(address)
                try:
                    return socket.create_connection(listener.getsockname(), timeout=timeout)
                except ConnectionRefusedError:
                    if len(routes) == 1:
                        listener.listen(1)
                        thread.start()
                    raise
            connection._create_connection = route
            try:
                connection.request("POST", "/Ask", body=b"one consent request")
                response = connection.getresponse()
                self.assertEqual((response.status, response.read()), (200, b"OK"))
            finally:
                connection.close()
                if thread.ident is not None:
                    thread.join(4)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(routes, [("fe80::2%awdl0", 8770)] * 2)
            self.assertEqual(requests, [(b"POST /Ask HTTP/1.1\r\n", b"one consent request")])

    def test_strict_tls_server_rejects_original_scoped_sni_but_accepts_corrected_connections(self):
        for connection_type, accepted in ((send.HTTPSConnectionAWDL, False),
                                           (send.SenderConnection, True), (browse.DiscoveryConnection, True)):
            with self.subTest(connection=connection_type.__name__), socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                listener.settimeout(3)
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(self.certificate, self.key)
                names, routes, results = [], [], []
                def check_name(sock, name, ctx):
                    names.append(name)
                    if name is not None:
                        return ssl.ALERT_DESCRIPTION_UNRECOGNIZED_NAME
                context.set_servername_callback(check_name)
                def serve():
                    try:
                        raw, _ = listener.accept()
                        with raw:
                            raw.settimeout(3)
                            with context.wrap_socket(raw, server_side=True):
                                results.append("accepted")
                    except ssl.SSLError:
                        results.append("rejected")
                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                client_context.check_hostname = False
                client_context.verify_mode = ssl.CERT_NONE
                connection = connection_type("fe80::2", 8770, interface_name="awdl0", context=client_context, timeout=2)
                def route(address, timeout=None, source_address=None):
                    routes.append(address)
                    return socket.create_connection(listener.getsockname(), timeout=2)
                connection._create_connection = route
                try:
                    if accepted:
                        connection.connect()
                    else:
                        with self.assertRaises(ssl.SSLError):
                            connection.connect()
                finally:
                    connection.close()
                    thread.join(4)
                self.assertFalse(thread.is_alive())
                self.assertEqual(routes, [("fe80::2%awdl0", 8770)])
                self.assertEqual(names, [None if accepted else "fe80::2%awdl0"])
                self.assertEqual(results, ["accepted" if accepted else "rejected"])


class SenderTests(unittest.TestCase):
    def client(self):
        client = send.MeasuredClient.__new__(send.MeasuredClient)
        response = SimpleNamespace(status=200, length=0, chunked=False, read=Mock(return_value=b""), close=Mock())
        client.http_conn = SimpleNamespace(sock=Mock(gettimeout=Mock(return_value=7)), send=Mock(), timeout=7,
                                          putrequest=Mock(), putheader=Mock(), endheaders=Mock(),
                                          request=Mock(), getresponse=Mock(return_value=response))
        client.events = []
        client.report = lambda phase, sent=None, total=None: client.events.append((phase, sent, total))
        return client

    def test_restored_sender_matches_original_request_including_preview_and_all_transfer_fields(self):
        from PIL import Image, features
        if not features.check("jpg_2000"):
            self.skipTest("Pillow JPEG2000 codec unavailable; upstream preview fallback remains")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.png"
            image = Image.frombytes("RGB", (640, 480), random.Random(13).randbytes(640 * 480 * 3))
            image.save(path)
            image.close()
            original = hashlib.sha256(path.read_bytes()).hexdigest()
            config = SimpleNamespace(computer_name="Mochi", computer_model="test", service_id="000000000000", record_data=None, debug=False)
            client = send.MeasuredClient(config, ("fe80::2", 8770))
            requests = []
            def capture(url, body, **kwargs):
                self.assertEqual(url, "/Ask")
                requests.append(plistlib.loads(body))
                return True, b""
            client.send_POST = capture
            self.assertTrue(send.AirDropClient.send_ask(client, [str(path)]))
            self.assertTrue(client.send_ask([str(path)]))
            old, new = requests
            self.assertEqual(new, old, "restored request must match upstream exactly, including the icon")
            with Image.open(io.BytesIO(new["FileIcon"])) as preview:
                self.assertEqual(preview.format, "JPEG2000")
                self.assertLessEqual(max(preview.size), 540)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), original)

    def test_restored_sender_inherits_existing_icon_and_url_handling(self):
        self.assertIs(send.MeasuredClient.send_ask, send.AirDropClient.send_ask)

    def test_failure_metadata_records_transport_class_without_private_error_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "mochi-airdrop"
            directory.mkdir(mode=0o700)
            client = self.client()
            client._phase = "asking"
            error = ConnectionResetError(104, "secret file /private/photo.png sender-token-123")
            stderr = io.StringIO()
            with patch.dict(os.environ, XDG_RUNTIME_DIR=temporary), contextlib.redirect_stderr(stderr):
                client.report_failure(error)
            marker = directory / "send-error.json"
            data = json.loads(marker.read_text())
            self.assertEqual(data["exception"], "ConnectionResetError")
            self.assertEqual(data["errno"], 104)
            self.assertEqual(data["phase"], "asking")
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            for text in (marker.read_text(), stderr.getvalue()):
                self.assertNotIn("private", text)
                self.assertNotIn("photo", text)
                self.assertNotIn("sender-token", text)
            self.assertEqual(json.loads(stderr.getvalue().removeprefix("MOCHI_SEND_ERROR ")), data)

    def test_failure_metadata_never_writes_into_a_nonprivate_runtime_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "mochi-airdrop"
            directory.mkdir(mode=0o755)
            directory.chmod(0o755)
            client = self.client()
            with patch.dict(os.environ, XDG_RUNTIME_DIR=temporary), contextlib.redirect_stderr(io.StringIO()):
                client.report_failure(ValueError("private filename"))
            self.assertFalse((directory / "send-error.json").exists())

    def test_bytes_are_unmodified_and_full_write_waits_for_receiver_confirmation(self):
        client = self.client()
        data = bytes(range(256)) * 1024
        client._send_watched(data)
        actual = b"".join(bytes(call.args[0]) for call in client.http_conn.send.call_args_list)
        self.assertEqual(actual, data)
        self.assertEqual(client.events[0], ("sending", 0, len(data)))
        self.assertEqual(client.events[-1], ("confirming", len(data), len(data)))
        self.assertNotIn("complete", [event[0] for event in client.events])
        self.assertEqual(client.http_conn.sock.settimeout.call_args_list[-1].args, (7,))

    def test_stalled_write_restores_timeout_without_claiming_completion(self):
        client = self.client()
        client.http_conn.send.side_effect = socket.timeout("test stall")
        with self.assertRaises(socket.timeout):
            client._send_watched(b"test")
        self.assertEqual(client.events, [("sending", 0, 4)])
        self.assertEqual(client.http_conn.sock.settimeout.call_args_list[-1].args, (7,))

    def test_linux_ack_counter_tracks_only_this_body_over_a_real_loopback_connection(self):
        # Loopback only: exercise the actual TCP_INFO + output-queue ABI, not a
        # guessed struct offset or synthetic percentage. No radio is involved.
        with socket.socket() as listener, socket.socket() as sender:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            sender.settimeout(2)
            sender.connect(listener.getsockname())
            receiver, _ = listener.accept()
            with receiver:
                receiver.settimeout(2)
                baseline = send.tcp_position(sender)
                if baseline is None:
                    self.skipTest("kernel does not provide TCP ACK/output-queue counters")
                client = self.client()
                client.http_conn = SimpleNamespace(sock=sender, send=sender.sendall)
                data = bytes(range(256)) * 32
                client._send_watched(data)
                received = bytearray()
                while len(received) < len(data):
                    received.extend(receiver.recv(len(data) - len(received)))
                self.assertEqual(bytes(received), data)
                client._progress_thread.join(timeout=2)
                try:
                    self.assertFalse(client._progress_thread.is_alive())
                    self.assertEqual(client._measurement, "tcpAck")
                    self.assertEqual(client.events[0], ("sending", 0, len(data)))
                    self.assertEqual(client.events[-1], ("confirming", len(data), len(data)))
                    self.assertNotIn("complete", [event[0] for event in client.events])
                finally:
                    client._progress_stop.set()

    def test_ask_timing_is_separate_from_archive_and_wire_writes(self):
        client = self.client()
        self.assertEqual(client.send_POST("/Ask", b"request"), (True, b""))
        self.assertEqual([event[0] for event in client.events], ["asking", "accepted"])
        with patch.object(send.AirDropClient, "send_upload", return_value=True):
            self.assertTrue(client.send_upload(["/test.pdf"]))
        self.assertEqual(client.events[-1][0], "preparing")

    def test_ask_header_timeout_never_fakes_acceptance_or_retries(self):
        client = self.client()
        client.http_conn.getresponse.side_effect = TimeoutError("no response headers")
        with self.assertRaises(TimeoutError):
            client.send_POST("/Ask", b"request")
        self.assertEqual(client.events, [("asking", None, None)])
        client.http_conn.request.assert_called_once()
        self.assertIn((client.ASK_TIMEOUT,), [call.args for call in client.http_conn.sock.settimeout.call_args_list])
        self.assertEqual(client.http_conn.sock.settimeout.call_args_list[-1].args, (7,))

    def test_acceptance_response_body_is_bounded_separately_from_the_human_decision(self):
        client = self.client()
        response = client.http_conn.getresponse.return_value
        response.length = None
        response.read.side_effect = TimeoutError("missing HTTP ending")
        with self.assertRaises(TimeoutError):
            client.send_POST("/Ask", b"request")
        self.assertEqual([event[0] for event in client.events], ["asking", "accepted"])
        self.assertEqual(client._ask_httpStatus, 200)
        self.assertEqual(client._ask_responseFraming, "close")
        self.assertLess(client.ASK_BODY_TIMEOUT, client.ASK_TIMEOUT)
        self.assertIn((client.ASK_BODY_TIMEOUT,), [call.args for call in client.http_conn.sock.settimeout.call_args_list])
        client.http_conn.request.assert_called_once()
        response.close.assert_called_once()

    def test_ask_restores_confirmed_working_request_composition_and_preserves_plist(self):
        client = self.client()
        payload = b"response metadata"
        response = client.http_conn.getresponse.return_value
        response.length = len(payload)
        response.read.return_value = payload
        self.assertEqual(client.send_POST("/Ask", b"request"), (True, payload))
        client.http_conn.request.assert_called_once_with("POST", "/Ask", body=b"request", headers=client._get_headers())
        client.http_conn.putrequest.assert_not_called()
        self.assertEqual(client.http_conn.timeout, 7)

    def test_oversized_or_truncated_acceptance_body_cannot_start_upload(self):
        client = self.client()
        response = client.http_conn.getresponse.return_value
        response.length = client.ASK_RESPONSE_LIMIT + 1
        with self.assertRaises(ValueError):
            client.send_POST("/Ask", b"request")
        response.read.assert_not_called()
        client = self.client()
        response = client.http_conn.getresponse.return_value
        response.length = 10
        response.read.side_effect = [b"partial", b""]
        with self.assertRaises(IncompleteRead):
            client.send_POST("/Ask", b"request")
        self.assertNotIn("sending", [event[0] for event in client.events])

    def test_http_keepalive_without_response_length_cannot_hang_after_acceptance(self):
        client = self.client()
        client.ASK_BODY_TIMEOUT = .15
        client.ASK_TIMEOUT = 2
        release = threading.Event()
        errors = []
        local, remote = socket.socketpair()
        local.settimeout(None)  # Reproduce the installed sender's old wait.
        connection = HTTPConnection("localhost")
        connection.sock = local
        client.http_conn = connection
        def peer():
            try:
                remote.settimeout(2)
                with remote, remote.makefile("rb") as stream:
                    self.assertTrue(stream.readline().startswith(b"POST /Ask "))
                    while stream.readline() not in (b"\r\n", b""):
                        pass
                    remote.sendall(b"HTTP/1.1 200 OK\r\nConnection: keep-alive\r\n\r\naccepted metadata")
                    release.wait(2)
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=peer, daemon=True)
        thread.start()
        start = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                client.send_POST("/Ask", b"")
            self.assertLess(time.monotonic() - start, 1.5)
            self.assertEqual([event[0] for event in client.events], ["asking", "accepted"])
            self.assertEqual(client._ask_responseFraming, "close")
            self.assertNotIn("sending", [event[0] for event in client.events])
        finally:
            release.set()
            connection.close()
            local.close()
            thread.join(3)
        self.assertEqual(errors, [])

    def test_real_legacy_ask_exchanges_complete_metadata_and_keeps_socket_for_upload(self):
        client = self.client()
        local, remote = socket.socketpair()
        local.settimeout(2)
        connection = HTTPConnection("localhost")
        connection.sock = local
        client.http_conn = connection
        request = plistlib.dumps({"SenderComputerName": "Mochi", "Files": []}, fmt=plistlib.FMT_BINARY)
        reply = plistlib.dumps({"IDSSessionID": "synthetic-test-value"}, fmt=plistlib.FMT_BINARY)
        observed, errors = [], []
        release = threading.Event()
        def peer():
            try:
                remote.settimeout(2)
                with remote, remote.makefile("rb") as stream:
                    observed.append(stream.readline())
                    headers = []
                    while line := stream.readline():
                        if line == b"\r\n":
                            break
                        headers.append(line)
                    observed.append(headers)
                    values = dict(line.decode().strip().split(": ", 1) for line in headers)
                    size = int(values["Content-Length"])
                    observed.append(stream.read(size))
                    remote.sendall(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n"
                                   + b"%x\r\n" % len(reply) + reply + b"\r\n0\r\n\r\n")
                    release.wait(2)
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=peer, daemon=True)
        thread.start()
        try:
            self.assertEqual(client.send_POST("/Ask", request), (True, reply))
            self.assertIs(connection.sock, local, "the accepted TLS/TCP connection stays available for /Upload")
            self.assertEqual(local.gettimeout(), 2)
            self.assertTrue(client._ask_plist_complete)
            self.assertEqual(client._ask_responseBytes, len(reply))
        finally:
            release.set()
            connection.close()
            thread.join(3)
        self.assertEqual(errors, [])
        self.assertEqual(observed[0], b"POST /Ask HTTP/1.1\r\n")
        headers = dict(line.decode().strip().split(": ", 1) for line in observed[1])
        self.assertEqual(headers["Content-Length"], str(len(request)))
        self.assertNotIn("Transfer-Encoding", headers)
        for key, value in client._get_headers().items():
            self.assertEqual(headers[key], value)
        self.assertEqual(observed[2], request)

    def test_upload_failure_aborts_before_upstream_can_clear_the_connection(self):
        client = self.client()
        with patch.object(send.AirDropClient, "send_POST", side_effect=OSError("failed upload")):
            with self.assertRaises(OSError):
                client.send_POST("/Upload", b"test")
        client.http_conn.sock.setsockopt.assert_called_once_with(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))

    def test_tls_connection_time_is_not_misreported_as_waiting_for_phone_acceptance(self):
        client = self.client()
        client.http_conn = None
        client.receiver_host, client.receiver_port = "fe80::2", 8770
        client.config = Mock(interface="awdl0")
        connection = Mock()
        connection.sock.gettimeout.return_value = None
        connection.getresponse.return_value = SimpleNamespace(status=200, length=0, chunked=False, read=Mock(return_value=b""), close=Mock())
        with patch.object(send, "SenderConnection", return_value=connection) as factory:
            self.assertEqual(client.send_POST("/Ask", b"test"), (True, b""))
        connection.connect.assert_called_once()
        self.assertEqual(connection.sock.settimeout.call_args_list[0].args, (None,))
        self.assertEqual(connection.sock.settimeout.call_args_list[-1].args, (None,))
        self.assertEqual(factory.call_args.kwargs["timeout"], 30)
        self.assertEqual([event[0] for event in client.events], ["connecting", "asking", "accepted"])

    def test_refusal_during_ask_never_reconnects_or_replays_consent(self):
        client = self.client()
        client.http_conn.request.side_effect = ConnectionRefusedError(errno.ECONNREFUSED, "ambiguous request")
        with patch.object(send, "SenderConnection") as factory, patch.object(send.time, "sleep") as sleep:
            with self.assertRaises(ConnectionRefusedError):
                client.send_POST("/Ask", b"one consent request")
        client.http_conn.request.assert_called_once()
        client.http_conn.getresponse.assert_not_called()
        factory.assert_not_called()
        sleep.assert_not_called()

    def test_progress_updates_while_the_next_send_slice_is_blocked(self):
        client = self.client()
        blocked, release, progressed = threading.Event(), threading.Event(), threading.Event()
        acknowledged = [0]
        data = b"x" * (client.SEND_SLICE * 2)
        errors = []
        def write(part):
            if blocked.is_set():
                release.wait(3)
                acknowledged[0] = len(data)
            else:
                blocked.set()
                acknowledged[0] = client.SEND_SLICE
        def report(phase, sent=None, total=None):
            client.events.append((phase, sent, total))
            if sent == client.SEND_SLICE:
                progressed.set()
        client.report = report
        client.http_conn.send = write
        def upload():
            try:
                client._send_watched(data)
            except Exception as error:
                errors.append(error)
        with patch.object(send, "tcp_position", side_effect=[(0, 0), (0, client.SEND_SLICE), (len(data), 0)]), patch.object(send, "tcp_acknowledged", side_effect=lambda _: acknowledged[0]):
            thread = threading.Thread(target=upload)
            thread.start()
            try:
                self.assertTrue(progressed.wait(2), "ACK progress must arrive before the blocked write returns")
                self.assertTrue(thread.is_alive())
                self.assertEqual(client.events[-1], ("sending", client.SEND_SLICE, len(data)))
            finally:
                release.set()
                thread.join(timeout=3)
                client._progress_thread.join(timeout=2)
                client._progress_stop.set()
            self.assertEqual(errors, [])
            self.assertEqual(client.events[-1], ("confirming", len(data), len(data)))

    def test_missing_acknowledgements_are_reported_as_a_stall_not_fake_progress(self):
        client = self.client()
        release, progressed, stalled = threading.Event(), threading.Event(), threading.Event()
        acknowledged, clock = [0], [0.0]
        data = b"x" * (client.SEND_SLICE * 2)
        writes = [0]
        errors = []
        def write(part):
            writes[0] += 1
            if writes[0] == 2:
                release.wait(3)
                acknowledged[0] = len(data)
            else:
                acknowledged[0] = client.SEND_SLICE
        def report(phase, sent=None, total=None):
            client.events.append((phase, sent, total))
            if sent == client.SEND_SLICE and phase == "sending": progressed.set()
            if phase == "stalled": stalled.set()
        client.report = report
        client.http_conn.send = write
        def upload():
            try: client._send_watched(data)
            except Exception as error: errors.append(error)
        with patch.object(send, "tcp_position", side_effect=[(0, 0), (0, client.SEND_SLICE), (len(data), 0)]), patch.object(send, "tcp_acknowledged", side_effect=lambda _: acknowledged[0]), patch.object(send.time, "monotonic", side_effect=lambda: clock[0]):
            thread = threading.Thread(target=upload)
            thread.start()
            try:
                self.assertTrue(progressed.wait(2))
                clock[0] = 6
                self.assertTrue(stalled.wait(2))
                self.assertEqual(client.events[-1], ("stalled", client.SEND_SLICE, len(data)))
            finally:
                release.set(); thread.join(timeout=3)
                client._progress_thread.join(timeout=2); client._progress_stop.set()
            self.assertEqual(errors, [])
            self.assertEqual(client.events[-1], ("confirming", len(data), len(data)))

    def test_progress_is_bounded_json_without_filenames_or_tokens(self):
        client = self.client()
        stderr = io.StringIO()
        with patch.object(sys, "stderr", stderr):
            send.MeasuredClient.report(client, "sending", 12, 100)
        line = stderr.getvalue()
        self.assertTrue(line.startswith("MOCHI_SEND "))
        payload = json.loads(line.removeprefix("MOCHI_SEND "))
        self.assertEqual(set(payload), {"phase", "sentBytes", "totalBytes", "elapsedMs", "measurement", "bytesPerSecond"})
        self.assertEqual(payload["sentBytes"], 12)

    def test_cli_keeps_exact_recipient_multiple_files_and_single_upload_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = [root / "test.pdf", root / "test.txt"]
            for path in files:
                path.write_bytes(b"test")
            report = root / "report.json"
            report.write_text(json.dumps([
                {"id": "abcdef123456", "name": "Same name", "address": "fe80::3", "port": 8770, "discoverable": True},
                {"id": "000000000000", "name": "Same name", "address": "fe80::2", "port": 8770, "discoverable": True}]))
            client = Mock(send_ask=Mock(return_value=True), send_upload=Mock(return_value=True))
            args = ["mochi-send", "-r", "000000000000", "-f", str(files[0]), "-f", str(files[1])]
            with patch.object(sys, "argv", args), patch.object(send, "AirDropConfig", return_value=SimpleNamespace(discovery_report=str(report))), patch.object(send, "MeasuredClient", return_value=client) as factory, patch.dict(os.environ, OPENDROP_UPLOAD_ARMS="multiple,unsafe,attempts"):
                self.assertEqual(send.main(), 0)
                self.assertEqual(factory.call_args.args[1], ("fe80::2", 8770))
                client.send_ask.assert_called_once_with(list(map(str, files)))
                client.send_upload.assert_called_once_with(list(map(str, files)))
                self.assertEqual(os.environ["OPENDROP_UPLOAD_ARMS"], "reuse-chunked-dvzip-rawhdr")

    def test_measured_ask_and_upload_keep_real_archive_framing_and_file_bytes(self):
        receive = load("mochi_test_receive", "windows/airdrop/mochi_receive.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            destination = root / "destination"
            destination.mkdir()
            files = {"test.pdf": b"%PDF-1.4\n%%EOF\n", "unknown.mochi-test": bytes(range(256))}
            for name, content in files.items():
                (source / name).write_bytes(content)
            paths = [str(source / name) for name in files]
            config = SimpleNamespace(computer_name="Mochi", computer_model="test", service_id="000000000000", record_data=None, debug=False)
            client = send.MeasuredClient(config, ("fe80::2", 8770))
            connection = Mock()
            connection.sock.gettimeout.return_value = 7
            connection.getresponse.return_value = SimpleNamespace(status=200, length=0, chunked=False, read=lambda *_: b"", close=Mock())
            client.http_conn = connection
            with patch.dict(os.environ, XDG_CACHE_HOME=str(root / "cache"), XDG_STATE_HOME=str(root / "state"), OPENDROP_UPLOAD_ARMS="reuse-chunked-dvzip-rawhdr"), patch.object(sys, "stderr", io.StringIO()):
                self.assertTrue(client.send_ask(paths))
                # Isolate the archive /Upload from any control-request writes.
                connection.send.reset_mock()
                self.assertTrue(client.send_upload(paths))
                wire = b"".join(bytes(call.args[0]) for call in connection.send.call_args_list)
                header, body = wire.split(b"\r\n", 1)
                length = int(header, 16)
                self.assertEqual(body[length:], b"\r\n0\r\n\r\n")
                workspace = receive.ReceiveWorkspace(destination, "dvzip")
                try:
                    workspace.raw_path.write_bytes(body[:length])
                    workspace.decode_dvzip(workspace.raw_path)
                    self.assertTrue(workspace.container_complete)
                    workspace.extract_file(workspace.decoded_path)
                    workspace.finish(True, list(workspace.verified_files))
                    self.assertEqual({p.name: p.read_bytes() for p in destination.iterdir()}, files)
                finally:
                    if workspace.mapping is not None:
                        workspace.mapping.close()

    def test_failed_upload_aborts_only_its_own_queued_socket_and_never_retries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            selected = root / "test.pdf"
            selected.write_bytes(b"test")
            report = root / "report.json"
            report.write_text(json.dumps([{"id": "000000000000", "name": "My iPhone", "address": "fe80::2", "port": 8770, "discoverable": True}]))
            client = Mock(send_ask=Mock(return_value=True), send_upload=Mock(return_value=False))
            with patch.object(sys, "argv", ["mochi-send", "-r", "000000000000", "-f", str(selected)]), patch.object(send, "AirDropConfig", return_value=SimpleNamespace(discovery_report=str(report))), patch.object(send, "MeasuredClient", return_value=client), patch.dict(os.environ):
                self.assertEqual(send.main(), 1)
            client.send_ask.assert_called_once()
            client.send_upload.assert_called_once()
            client.http_conn.sock.setsockopt.assert_called_once_with(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            client.http_conn.close.assert_called_once()
            self.assertFalse(any(call.args and call.args[0] == "complete" for call in client.report.call_args_list))


if __name__ == "__main__":
    unittest.main()
