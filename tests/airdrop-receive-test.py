#!/usr/bin/env python3
"""Test workspaces; optionally pass server.py for handler tests, --no-network for no sockets."""
import ast
import errno
import gzip
import importlib.util
import io
import json
import logging
import os
import platform
import plistlib
from email.message import Message
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import socket
import struct
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
import zlib

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("opendrop.mochi_receive", REPO / "windows/airdrop/mochi_receive.py")
receive = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = receive
spec.loader.exec_module(receive)
scope = {}
NO_NETWORK = "--no-network" in sys.argv
if NO_NETWORK:
    sys.argv.remove("--no-network")
if len(sys.argv) > 1 and sys.argv[1].endswith(".py"):
    tree = ast.parse(Path(sys.argv.pop(1)).read_text())
    assert any(isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
               and node.value.value is True and any(isinstance(target, ast.Attribute)
               and target.attr == "allow_reuse_address" for target in node.targets)
               for node in ast.walk(tree)), "receiver must permit safe socket reuse after restart"
    methods = {"handle_upload", "handle_ask", "handle_discover", "_read_request_body", "_reject_request",
               "_ask_user", "_set_response", "handle_expect_100", "do_POST"}
    selected = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name in methods]
    handler = ast.ClassDef(name="PatchedHandler", bases=[ast.Name(id="BaseHTTPRequestHandler", ctx=ast.Load())],
                           keywords=[], body=selected, decorator_list=[])
    url_helpers = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("safe_url", "ask_items", "open_url")]
    scope.update(__package__="opendrop", os=os, socket=socket, platform=platform, time=time, plistlib=plistlib, json=json,
                 logger=logging.getLogger("test"), BaseHTTPRequestHandler=BaseHTTPRequestHandler,
                 URL_SCHEMES=("http://", "https://"), open_url=lambda url: None,
                 AirDropUtil=SimpleNamespace(write_debug=lambda *args: None))
    exec(compile(ast.fix_missing_locations(ast.Module(body=url_helpers + [handler], type_ignores=[])), "receiver", "exec"), scope)
    scope["handle_upload"] = scope["PatchedHandler"].handle_upload
    init_server = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_init_server")
    exec(compile(ast.fix_missing_locations(ast.Module(body=[init_server], type_ignores=[])), "receiver", "exec"), scope)


def member(name, data=b"", mode=0o100644):
    name = name.encode()
    header = bytearray(b"0" * 76)
    header[:6] = b"070707"
    header[18:24] = f"{mode:06o}".encode()
    header[59:65] = f"{len(name) + 1:06o}".encode()
    header[65:76] = f"{len(data):011o}".encode()
    return bytes(header) + name + b"\0" + data


TRAILER = member("TRAILER!!!", mode=0)


def dvzip(data):
    output = bytearray()
    for offset in range(0, len(data), 131072):
        block = zlib.compress(data[offset:offset + 131072])
        output.extend(struct.pack(">I", len(block)) + block)
    return bytes(output)


class FakeHandler(scope.get("PatchedHandler", object)):
    UPLOAD_CONTENT_TYPES = ("application/x-cpio", "application/x-dvzip")
    def __init__(self, data, kind="dvzip", terminate=True, server=None, address=("fe80::1", 50000, 0, 2)):
        self.headers = Message()
        self.headers["content-type"] = f"application/x-{kind}"
        self.headers["transfer-encoding"] = "chunked"
        self.rfile = io.BytesIO(f"{len(data):x};extension=yes\r\n".encode() + data + (b"\r\n0\r\n\r\n" if terminate else b""))
        self.responses = []
        self.connection = self
        self.server = server or SimpleNamespace(mochi_upload_permissions=receive.UploadPermissions())
        self.client_address = address
        self.path = "/Upload"
        self.close_connection = False
        self.wfile = io.BytesIO()
        self.config = SimpleNamespace(computer_model="test", computer_name="Mochi", record_data=None)
    def settimeout(self, timeout):
        self.timeout = timeout
    def gettimeout(self):
        return getattr(self, 'timeout', None)
    def send_response(self, code):
        self.responses.append(code)
    def send_header(self, *_):
        pass
    def end_headers(self):
        pass


class FakeControl(FakeHandler):
    def __init__(self, path="/Ask", body=None, accept=True, **kwargs):
        super().__init__(b"", **kwargs)
        self.path = path
        if body is None:
            body = plistlib.dumps({"SenderComputerName": "Phone", "Files": [{"FileName": "photo.jpg"}]})
        self.rfile = io.BytesIO(body)
        self.headers = Message()
        self.headers["Content-Length"] = str(len(body))
        self.accept = accept
        self.prompt_count = 0

    def _ask_user(self, body):
        self.prompt_count += 1
        return self.accept


class WorkspaceTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.gallery = self.root / "gallery"
        self.gallery.mkdir()
        self.cwd = Path.cwd()
        os.chdir(self.gallery)
        self.env = patch.dict(os.environ, XDG_CACHE_HOME=str(self.root / "cache"), XDG_STATE_HOME=str(self.root / "state"), XDG_RUNTIME_DIR=str(self.root / "run"))
        self.env.start()
    def tearDown(self):
        self.env.stop()
        os.chdir(self.cwd)
        self.temp.cleanup()


class WorkspaceTests(WorkspaceTestCase):
    def workspace(self, kind="dvzip"):
        workspace = receive.ReceiveWorkspace(self.gallery, kind)
        self.addCleanup(workspace._close_decoded)
        self.addCleanup(lambda: workspace.mapping.close() if workspace.mapping is not None else None)
        return workspace

    def test_dvzip_intact_frames_with_optional_terminator(self):
        archive = member("photo.jpg", b"photo") + TRAILER
        for stored in (False, True):
            for terminated in (False, True):
                with self.subTest(stored=stored, terminated=terminated):
                    workspace = self.workspace()
                    payload = archive if stored else zlib.compress(archive)
                    wire = struct.pack(">I", len(payload) | (0x80000000 if stored else 0)) + payload
                    workspace.raw_path.write_bytes(wire + (b"\0" * 4 if terminated else b""))
                    decoded = workspace.decode_dvzip(workspace.raw_path)
                    self.assertIsInstance(decoded, receive.mmap.mmap)
                    self.assertEqual(decoded[:], archive)
                    self.assertTrue(workspace.container_complete)

    def test_dvzip_incomplete_frames_are_salvaged_but_not_complete(self):
        archive = member("photo.jpg", b"photo") + TRAILER
        compressed = zlib.compress(archive)[:-4]
        cases = {
            "missing checksum": struct.pack(">I", len(compressed)) + compressed,
            "missing checksum before terminator": struct.pack(">I", len(compressed)) + compressed + b"\0" * 4,
            "short stored frame": struct.pack(">I", 0x80000000 | (len(archive) + 1)) + archive,
            "partial header": dvzip(archive) + b"\0",
            "data after terminator": dvzip(archive) + b"\0" * 4 + b"tail",
            "data inside compressed frame": struct.pack(">I", len(zlib.compress(archive)) + 4) + zlib.compress(archive) + b"tail",
        }
        for label, wire in cases.items():
            with self.subTest(label=label):
                workspace = self.workspace()
                workspace.raw_path.write_bytes(wire)
                self.assertEqual(workspace.decode_dvzip(workspace.raw_path)[:], archive)
                self.assertFalse(workspace.container_complete)

    def test_dvzip_bad_checksum_never_marks_container_complete(self):
        workspace = self.workspace()
        wire = bytearray(dvzip(member("photo.jpg", b"photo") + TRAILER))
        wire[-1] ^= 1
        workspace.raw_path.write_bytes(wire)
        with self.assertRaises(zlib.error):
            workspace.decode_dvzip(workspace.raw_path)
        self.assertFalse(workspace.container_complete)

    def test_detector_rejects_data_after_zlib_stream_in_frame(self):
        payload = zlib.compress(TRAILER) + b"tail"
        detector = receive.DVZipEnd()
        self.assertFalse(detector.feed(struct.pack(">I", len(payload)) + payload))
        self.assertTrue(detector.invalid)

    def test_gzip_trailing_data_is_rejected_with_bounded_memory(self):
        workspace = self.workspace("cpio")
        with workspace.raw_path.open("wb") as raw:
            raw.write(gzip.compress(member("photo.jpg", b"photo") + TRAILER))
            for _ in range(128):
                raw.write(b"X" * 65536)
        tracemalloc.start()
        try:
            with self.assertRaisesRegex(ValueError, "trailing data"):
                workspace.decode_gzip(workspace.raw_path)
            self.assertLess(tracemalloc.get_traced_memory()[1], 4 * 1024 * 1024)
        finally:
            tracemalloc.stop()
        self.assertFalse(workspace.container_complete)

    def test_gzip_trailing_data_in_next_read_is_rejected(self):
        workspace = self.workspace("cpio")
        compressed = gzip.compress(member("photo.jpg", b"photo") + TRAILER)
        class BoundaryReader(io.BytesIO):
            def read(self, size=-1):
                if self.tell() == 0:
                    size = min(size, len(compressed))
                return super().read(size)
        with patch("builtins.open", return_value=BoundaryReader(compressed + b"tail")):
            with self.assertRaisesRegex(ValueError, "trailing data"):
                workspace.decode_gzip(workspace.raw_path)
        self.assertFalse(workspace.container_complete)

    def test_gzip_large_output_and_truncated_footer(self):
        archive = member("photo.jpg", b"X" * (3 * 1024 * 1024)) + TRAILER
        for cut in (0, 8):
            with self.subTest(cut=cut):
                workspace = self.workspace("cpio")
                wire = gzip.compress(archive)
                workspace.raw_path.write_bytes(wire[:-cut] if cut else wire)
                decoded, complete = workspace.decode_gzip(workspace.raw_path)
                self.assertEqual(decoded[:], archive)
                self.assertEqual(complete, not cut)
                self.assertEqual(workspace.container_complete, not cut)

    def test_success_keeps_only_aae_sidecars_privately(self):
        workspace = self.workspace("cpio")
        name = "NSIRD_AirDrop_abc/photo.AAE"
        workspace.raw_path.write_bytes(member(name, b"edit instructions") + member("photo.jpg", b"photo") + TRAILER)
        workspace.extract_file(workspace.raw_path)
        incoming = workspace.directory
        self.assertEqual(workspace.finish(True, [name, "photo.jpg"]), ["photo.jpg"])
        self.assertFalse(incoming.exists())
        self.assertEqual([p.name for p in self.gallery.iterdir()], ["photo.jpg"])
        recovery = self.root / "state/mochi/airdrop/recovery" / incoming.name
        self.assertEqual((recovery / "files" / name).read_bytes(), b"edit instructions")
        self.assertEqual(recovery.stat().st_mode & 0o777, 0o700)
        self.assertEqual([p.relative_to(recovery).as_posix() for p in recovery.rglob("*") if p.is_file()], ["files/" + name])

    def test_explicit_empty_user_directories_survive_wrapper_stripping(self):
        workspace = self.workspace("cpio")
        names = ["Containers", "Containers/tmp", "Containers/tmp/NSIRD_AirDrop_abc",
                 "Containers/tmp/NSIRD_AirDrop_abc/Notes", "Containers/tmp/NSIRD_AirDrop_abc/Notes/Empty",
                 "PHMediaFormatConversionRequest-abc", "asset.pvt", "__MACOSX"]
        workspace.raw_path.write_bytes(b"".join(member(name, mode=0o40755) for name in names) + TRAILER)
        workspace.extract_file(workspace.raw_path)
        self.assertTrue(workspace.has_user_directories)
        self.assertEqual(workspace.finish(True, []), ["Notes/Empty"])
        self.assertTrue((self.gallery / "Notes/Empty").is_dir())
        self.assertEqual([p.name for p in self.gallery.iterdir()], ["Notes"])

    def test_empty_wrappers_are_not_user_directories(self):
        workspace = self.workspace("cpio")
        names = ["Containers", "Containers/tmp", "Containers/tmp/NSIRD_AirDrop_abc"]
        workspace.raw_path.write_bytes(b"".join(member(name, mode=0o40755) for name in names) + TRAILER)
        workspace.extract_file(workspace.raw_path)
        self.assertFalse(workspace.has_user_directories)
        self.assertEqual(workspace.finish(True, []), [])
        self.assertEqual(list(self.gallery.iterdir()), [])

    def test_empty_directory_cannot_publish_through_output_symlink(self):
        workspace = self.workspace("cpio")
        outside = self.root / "outside"
        outside.mkdir()
        (self.gallery / "Notes").symlink_to(outside, target_is_directory=True)
        workspace.raw_path.write_bytes(member("Notes/Empty", mode=0o40755) + TRAILER)
        workspace.extract_file(workspace.raw_path)
        with self.assertRaisesRegex(ValueError, "symlink"):
            workspace.finish(True, [])
        self.assertFalse((outside / "Empty").exists())
        self.assertTrue(workspace.raw_path.exists())

    def test_mixed_file_and_empty_directory_transfer(self):
        workspace = self.workspace("cpio")
        workspace.raw_path.write_bytes(member("Notes/Empty", mode=0o40755) + member("photo.jpg", b"photo") + TRAILER)
        workspace.extract_file(workspace.raw_path)
        self.assertEqual(workspace.finish(True, ["photo.jpg"]), ["photo.jpg", "Notes/Empty"])
        self.assertEqual((self.gallery / "photo.jpg").read_bytes(), b"photo")
        self.assertTrue((self.gallery / "Notes/Empty").is_dir())

    def test_publication_rejects_replaced_or_modified_verified_source(self):
        for replace in (False, True):
            with self.subTest(replace=replace):
                workspace = self.workspace("cpio")
                workspace.raw_path.write_bytes(member("photo.jpg", b"GOOD") + TRAILER)
                workspace.extract_file(workspace.raw_path)
                source = workspace.root / "photo.jpg"
                if replace:
                    source.unlink()
                source.write_bytes(b"EVIL")  # same length cannot establish integrity
                with self.assertRaisesRegex(ValueError, "changed before publication"):
                    workspace.finish(True, ["photo.jpg"])
                self.assertEqual(list(self.gallery.iterdir()), [])
                self.assertTrue(workspace.raw_path.exists())

    def test_publication_rejects_unverified_whole_length_file(self):
        workspace = self.workspace("cpio")
        (workspace.root / "photo.jpg").write_bytes(b"photo")
        with self.assertRaisesRegex(ValueError, "changed before publication"):
            workspace.finish(True, ["photo.jpg"])
        self.assertEqual(list(self.gallery.iterdir()), [])

    def test_chunk_reader_does_not_buffer_entire_chunk(self):
        class Bounded(io.BytesIO):
            def read1(self, n):
                self.max_read = max(getattr(self, "max_read", 0), n)
                return super().read1(n)
        source = Bounded(b"100000\r\n" + b"A" * 1048576 + b"\r\n0\r\nTest: yes\r\n\r\n")
        reader = receive.HTTPChunkedReader(source)
        total = 0
        while data := reader.read(65536):
            total += len(data)
        self.assertEqual(total, 1048576)
        self.assertLessEqual(source.max_read, 65536)

    def test_detector_cannot_find_trailer_inside_file(self):
        detector = receive.DVZipEnd()
        self.assertFalse(detector.feed(dvzip(member("photo.jpg", TRAILER))))
        for byte in dvzip(TRAILER):
            ended = detector.feed(bytes([byte]))
        self.assertTrue(ended)

    def test_large_decode_has_bounded_python_memory(self):
        workspace = self.workspace()
        block = b"A" * 131072
        frame = struct.pack(">I", len(block) | 0x80000000) + block
        with workspace.raw_path.open("wb") as raw:
            for _ in range(512):
                raw.write(frame)
        tracemalloc.start()
        try:
            decoded = workspace.decode_dvzip(workspace.raw_path)
            self.assertEqual(len(decoded), 64 * 1024 * 1024)
            self.assertTrue(workspace.container_complete)
            self.assertLess(tracemalloc.get_traced_memory()[1], 24 * 1024 * 1024)
        finally:
            tracemalloc.stop()
            workspace.finish(True, [])

    def test_streamed_decode_reuses_validated_frames_without_decompressing_twice(self):
        data = os.urandom(256 * 1024)
        archive = member("document.pdf", data) + TRAILER
        wire = dvzip(archive)
        workspace = self.workspace()
        workspace.raw_path.write_bytes(wire)
        for offset in range(0, len(wire), 3333):
            ended = workspace.observe(wire[offset:offset + 3333])
        self.assertTrue(ended)
        with patch.object(receive.zlib, "decompressobj", side_effect=AssertionError("duplicate decode")):
            decoded = workspace.decode_dvzip(workspace.raw_path)
        self.assertEqual(decoded[:], archive)
        self.assertTrue(workspace.container_complete)
        workspace.extract_file(workspace.decoded_path)
        workspace.finish(True, list(workspace.verified_files))
        self.assertEqual((self.gallery / "document.pdf").read_bytes(), data)

    def test_streamed_decode_never_ignores_a_suspicious_tail(self):
        archive = member("document.pdf", b"test") + TRAILER
        workspace = self.workspace()
        wire = dvzip(archive) + b"BAD"
        workspace.raw_path.write_bytes(wire)
        self.assertTrue(workspace.observe(wire))
        with patch.object(receive.zlib, "decompressobj", wraps=zlib.decompressobj) as decode:
            self.assertEqual(workspace.decode_dvzip(workspace.raw_path)[:], archive)
            self.assertGreater(decode.call_count, 0, "suspicious tails must use the full salvage validator")
        self.assertFalse(workspace.container_complete)

    def marker(self):
        marker = self.root / "run/mochi-airdrop/transfer.json"
        marker.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        marker.write_text(json.dumps({"start": int(time.time()), "offset": 0, "directory": str(self.gallery)}))
        return marker

    def test_progress_reports_wire_and_decoded_counts_separately_without_fabricating_a_total(self):
        marker = self.marker()
        archive = member("document.pdf", b"A" * 65536) + TRAILER
        wire = dvzip(archive)
        workspace = self.workspace()
        workspace.raw_path.write_bytes(wire)
        self.assertTrue(workspace.observe(wire))
        progress = json.loads(marker.read_text())["progress"]
        self.assertEqual(progress["wireBytes"], len(wire))
        self.assertEqual(progress["decodedBytes"], len(archive))
        self.assertGreater(progress["decodedBytes"], progress["wireBytes"])
        self.assertIsNone(progress["totalBytes"])
        self.assertEqual(progress["phase"], "receiving")
        workspace.set_phase("verifying")
        self.assertEqual(json.loads(marker.read_text())["progress"]["phase"], "verifying")
        self.assertEqual(list(self.gallery.iterdir()), [], "progress never publishes unchecked files")
        self.assertEqual(marker.stat().st_mode & 0o777, 0o600)

    def test_older_workspace_cannot_replace_a_newly_accepted_transfers_marker(self):
        marker = self.marker()
        workspace = self.workspace()
        replacement = {"start": int(time.time()), "offset": 10, "directory": str(self.gallery)}
        marker.write_text(json.dumps(replacement))
        workspace.set_phase("verifying")
        self.assertEqual(json.loads(marker.read_text()), replacement)

    def test_workspace_without_initial_consent_marker_does_not_attach_to_a_later_request(self):
        workspace = self.workspace()
        marker = self.marker()
        before = marker.read_bytes()
        workspace.set_phase("verifying")
        self.assertEqual(marker.read_bytes(), before)

    def test_declared_total_is_bounded_and_gzip_bytes_are_not_treated_as_decoded_bytes(self):
        marker = self.marker()
        for value in ("-1", "nan", "१२", "1" * 100, "0"):
            workspace = receive.ReceiveWorkspace(self.gallery, "cpio", total_bytes=value)
            self.assertIsNone(workspace.total_bytes)
        workspace = receive.ReceiveWorkspace(self.gallery, "cpio", total_bytes="1000")
        wire = gzip.compress(member("notes.txt", b"test") + TRAILER)
        workspace.raw_path.write_bytes(wire)
        workspace.observe(wire)
        workspace.set_phase("verifying")
        progress = json.loads(marker.read_text())["progress"]
        self.assertEqual(progress["totalBytes"], 1000)
        self.assertIsNone(progress["decodedBytes"])
        self.assertEqual(progress["wireBytes"], len(wire))


@unittest.skipUnless(scope, "supply a patched server.py to run handler tests")
class ReceiveTests(WorkspaceTestCase):
    @unittest.skipIf(NO_NETWORK, 'networking disabled')
    def test_phone_can_finish_writing_before_receiving_http_success(self):
        class Handler(scope['PatchedHandler']):
            protocol_version = 'HTTP/1.1'
            UPLOAD_CONTENT_TYPES = ('application/x-cpio', 'application/x-dvzip')
            def log_message(self, *_):
                pass

        server = HTTPServer(('127.0.0.1', 0), Handler)
        server.mochi_upload_permissions = receive.UploadPermissions()
        peer = ('127.0.0.1', 0)
        ticket = server.mochi_upload_permissions.begin(peer)
        self.assertTrue(server.mochi_upload_permissions.accept(peer, ticket))
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        worker.start()
        try:
            with socket.create_connection(server.server_address, timeout=2) as phone:
                wire = dvzip(member('photo.jpg', b'whole photo') + TRAILER)
                phone.sendall(b'POST /Upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-dvzip\r\n'
                              b'Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n' +
                              f'{len(wire):x}\r\n'.encode() + wire + b'\r\n')
                phone.settimeout(.1)
                with self.assertRaises(TimeoutError, msg='do not reply/close while the phone is still sending the HTTP ending'):
                    phone.recv(1)
                phone.sendall(b'4\r\n' + b'\0' * 4 + b'\r\n0\r\n\r\n')
                phone.settimeout(2)
                response = bytearray()
                while block := phone.recv(65536):
                    response.extend(block)
                self.assertTrue(response.startswith(b'HTTP/1.1 200 '), response)
                self.assertEqual((self.gallery / 'photo.jpg').read_bytes(), b'whole photo')
        finally:
            server.shutdown()
            server.server_close()
            worker.join(2)
            self.assertFalse(worker.is_alive())

    def test_success_consumes_http_ending_before_replying_to_the_phone(self):
        wire = dvzip(member('photo.jpg', b'whole photo') + TRAILER)
        handler = FakeHandler(wire)
        # iOS may send the optional DVZip terminator in a separate HTTP chunk.
        handler.rfile = io.BytesIO(f'{len(wire):x}\r\n'.encode() + wire +
                                  b'\r\n4\r\n' + b'\0' * 4 + b'\r\n0\r\n\r\n')
        ask = FakeControl(server=handler.server)
        ask.handle_ask()
        handler.handle_upload()
        self.assertEqual(handler.responses[-1], 200)
        self.assertEqual(handler.rfile.read(), b'', 'unread upload bytes must not turn a successful receive into a reset')
        self.assertEqual((self.gallery / 'photo.jpg').read_bytes(), b'whole photo')

    def send(self, data, kind="dvzip", terminate=True):
        handler = FakeHandler(data, kind, terminate)
        ask = FakeControl(server=handler.server)
        ask.handle_ask()
        self.assertEqual(ask.responses, [200])
        scope["handle_upload"](handler)
        self.assertEqual(handler.timeout, 300)
        return handler.responses[-1]
    def test_separately_chunked_junk_after_archive_is_not_ignored(self):
        wire = dvzip(member('photo.jpg', b'whole photo') + TRAILER)
        handler = FakeHandler(wire)
        handler.rfile = io.BytesIO(f'{len(wire):x}\r\n'.encode() + wire + b'\r\n5\r\nJUNK!\r\n0\r\n\r\n')
        FakeControl(server=handler.server).handle_ask()
        handler.handle_upload()
        self.assertEqual(handler.responses[-1], 500)

    def test_missing_http_ending_uses_short_timeout_and_restores_upload_timeout(self):
        calls = []
        connection = SimpleNamespace(gettimeout=lambda: 300, settimeout=calls.append)
        def missing(_):
            raise TimeoutError('simulated lost HTTP ending')
        storage = SimpleNamespace(detector=SimpleNamespace(tail=b''))
        self.assertFalse(receive.finish_http_upload(SimpleNamespace(read=missing), io.BytesIO(), storage, connection))
        self.assertEqual(calls, [15, 300])
    def test_nested_photo_without_http_terminator(self):
        archive = member(".", mode=0o40755) + member("Containers/tmp/NSIRD_AirDrop_abc/photo.jpg", b"hello") + TRAILER
        self.assertEqual(self.send(dvzip(archive), terminate=False), 200)
        self.assertEqual([p.name for p in self.gallery.iterdir()], ["photo.jpg"])
        self.assertEqual((self.gallery / "photo.jpg").read_bytes(), b"hello")

    def test_approved_mixed_documents_archives_and_unknown_files_keep_names_and_bytes(self):
        files = {"report.pdf": b"%PDF-1.4\n%%EOF\n", "notes.txt": "नमस्ते\n".encode(),
                 "bundle.zip": b"PK\x03\x04archive", "document.docx": b"PK\x03\x04document",
                 "binary.unknown": bytes(range(256)), "no-extension": b"\x00\xffopaque",
                 "empty": b"", "script.sh": b"#!/bin/sh\nexit 0\n"}
        body = plistlib.dumps({"SenderComputerName": "Phone", "Files": [
            {"FileName": name, "FileType": "public.data"} for name in files]})
        archive = b"".join(member(name, data, mode=0o100755) for name, data in files.items()) + TRAILER
        handler = FakeHandler(dvzip(archive))
        ask = FakeControl(body=body, server=handler.server)
        ask.handle_ask()
        self.assertEqual(ask.prompt_count, 1)
        self.assertEqual(ask.responses, [200])
        scope["handle_upload"](handler)
        self.assertEqual(handler.responses[-1], 200)
        self.assertEqual({p.name: p.read_bytes() for p in self.gallery.iterdir()}, files)
        self.assertTrue(all(not (p.stat().st_mode & 0o111) for p in self.gallery.iterdir()),
                        "incoming executables must be stored without execute permissions")
    def test_incomplete_batch_only_publishes_whole_members(self):
        archive = member("PHMediaFormatConversionRequest-abc/photo.jpg", b"whole") + member("PHMediaFormatConversionRequest-abc/video.mov", b"X" * 5000)
        self.assertEqual(self.send(dvzip(archive[:-1000])), 500)
        self.assertEqual([p.name for p in self.gallery.iterdir()], ["photo.jpg"])
        recovery = list((self.root / "state/mochi/airdrop/recovery").glob("receive-*"))
        self.assertEqual(len(recovery), 1)
        self.assertEqual((recovery[0] / "partials/PHMediaFormatConversionRequest-abc/video.mov").stat().st_size, 4000)
        self.assertTrue(list(recovery[0].glob("*.dvzip")))
    def test_missing_archive_trailer_fails(self):
        self.assertEqual(self.send(dvzip(member("photo.jpg", b"whole"))), 500)
    def test_plain_and_gzip_cpio(self):
        archive = member("PHMediaFormatConversionRequest-abc/photo.jpg", b"hello") + TRAILER
        self.assertEqual(self.send(archive, "cpio"), 200)
        self.assertEqual(self.send(gzip.compress(archive), "cpio"), 200)
        self.assertEqual(len(list(self.gallery.iterdir())), 1)
    def test_cut_gzip_retains_recovery(self):
        archive = member("video.mov", b"X" * 5000) + TRAILER
        self.assertEqual(self.send(gzip.compress(archive)[:-8], "cpio"), 500)
    def test_dvzip_missing_checksum_retains_recovery(self):
        payload = zlib.compress(member("photo.jpg", b"photo") + TRAILER)[:-4]
        self.assertEqual(self.send(struct.pack(">I", len(payload)) + payload), 500)
        self.assertTrue(list((self.root / "state/mochi/airdrop/recovery").glob("receive-*/*.dvzip")))
    def test_disk_failure_never_publishes_short_member(self):
        def short_write(workspace, path):
            (workspace.root / "photo.jpg").write_bytes(b"ph")
            raise OSError(errno.ENOSPC, "simulated full disk")
        with patch.object(receive.ReceiveWorkspace, "extract_file", short_write):
            self.assertEqual(self.send(dvzip(member("photo.jpg", b"photo") + TRAILER)), 500)
        self.assertEqual(list(self.gallery.iterdir()), [])
        self.assertTrue(list((self.root / "state/mochi/airdrop/recovery").glob("receive-*/*.dvzip")))

    def test_complete_partial_named_member_survives_truncated_sibling(self):
        # Exact exploit: the legacy verifier replaced the complete member with
        # unfinished bytes and then published it using its stale `good` list.
        archive = member("video.mov.partial", b"COMPLETE ORIGINAL") + member("video.mov", b"BAD" + b"X" * 97)
        self.assertEqual(self.send(dvzip(archive[:-97])), 500)
        self.assertEqual((self.gallery / "video.mov.partial").read_bytes(), b"COMPLETE ORIGINAL")
        self.assertFalse((self.gallery / "video.mov").exists())
        recovery = next((self.root / "state/mochi/airdrop/recovery").glob("receive-*"))
        self.assertEqual((recovery / "partials/video.mov").read_bytes(), b"BAD")
        self.assertEqual((recovery / "files/video.mov.partial").read_bytes(), b"COMPLETE ORIGINAL")

    def test_duplicate_name_does_not_quarantine_an_earlier_verified_file(self):
        for duplicate in (b"other", b"a longer duplicate"):
            archive = member("photo.jpg", b"whole") + member("photo.jpg", duplicate) + TRAILER
            self.assertEqual(self.send(dvzip(archive)), 500)
            self.assertEqual((self.gallery / "photo.jpg").read_bytes(), b"whole")
    def test_directory_only_transfer_succeeds(self):
        archive = member("NSIRD_AirDrop_abc/Notes/Empty", mode=0o40755) + TRAILER
        self.assertEqual(self.send(dvzip(archive)), 200)
        self.assertTrue((self.gallery / "Notes/Empty").is_dir())
    def test_collision_deduplicates_without_overwrite(self):
        for data in (b"first", b"second", b"second"):
            self.assertEqual(self.send(dvzip(member("NSIRD_AirDrop_abc/photo.jpg", data) + TRAILER)), 200)
        self.assertEqual((self.gallery / "photo.jpg").read_bytes(), b"first")
        self.assertEqual((self.gallery / "photo-1.jpg").read_bytes(), b"second")
        self.assertEqual(len(list(self.gallery.iterdir())), 2)
    def test_metadata_not_published(self):
        archive = member("._photo.jpg", b"metadata") + member("photo.jpg", b"photo") + TRAILER
        self.assertEqual(self.send(dvzip(archive)), 200)
        self.assertEqual([p.name for p in self.gallery.iterdir()], ["photo.jpg"])
    def test_user_folders_preserved_not_flattened(self):
        self.assertEqual(self.send(dvzip(member("NSIRD_AirDrop_abc/Notes/daily.txt", b"notes") + TRAILER)), 200)
        self.assertEqual((self.gallery / "Notes/daily.txt").read_bytes(), b"notes")
    def test_output_symlink_cannot_redirect_file(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.gallery / "Notes").symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.send(dvzip(member("Notes/daily.txt", b"notes") + TRAILER)), 500)
        self.assertFalse((outside / "daily.txt").exists())
    def test_path_traversal_rejected(self):
        self.assertEqual(self.send(dvzip(member("../outside", b"bad") + TRAILER)), 500)
        self.assertFalse((self.root / "outside").exists())
        self.assertEqual(list(self.gallery.iterdir()), [])
    def test_links_rejected(self):
        archive = member("link", b"/tmp", 0o120777) + member("photo.jpg", b"ok") + TRAILER
        self.assertEqual(self.send(dvzip(archive)), 500)
        self.assertEqual(list(self.gallery.iterdir()), [])
    @unittest.skipIf(NO_NETWORK, "networking disabled")
    def test_listening_and_accepted_sockets_inherit_receive_buffer(self):
        fake = SimpleNamespace(
            ServerClass=HTTPServer, serveraddress=("127.0.0.1", 0), Handler=BaseHTTPRequestHandler,
            config=SimpleNamespace(interface="lo", get_ssl_context=lambda: SimpleNamespace(wrap_socket=lambda sock, **_: sock)))
        server = scope["_init_server"](fake)
        try:
            window = server.socket.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)
            self.assertGreaterEqual(window, 131072)
            with socket.create_connection(server.server_address) as client:
                accepted, _ = server.get_request()
                with accepted:
                    self.assertEqual(accepted.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF), window)
        finally:
            server.server_close()
        fake.serveraddress = server.server_address
        restarted = scope["_init_server"](fake)
        try:
            self.assertEqual(restarted.server_address, server.server_address)
        finally:
            restarted.server_close()

    def test_bind_failure_never_silently_changes_port(self):
        def unavailable(*_):
            raise OSError(errno.EADDRINUSE, "port already owned")
        fake = SimpleNamespace(ServerClass=unavailable, serveraddress=("127.0.0.1", 8771),
                               Handler=BaseHTTPRequestHandler, config=SimpleNamespace(port=8771))
        with self.assertRaises(OSError):
            scope["_init_server"](fake)
        self.assertEqual(fake.config.port, 8771)


class PermissionTests(unittest.TestCase):
    def test_expiry_new_ask_and_single_use(self):
        now = [100.0]
        permissions = receive.UploadPermissions(clock=lambda: now[0])
        peer = ("fe80::1", 12345, 0, 2)
        newer = ("fe80::1", 54321, 0, 2)
        ticket = permissions.begin(peer)
        self.assertFalse(permissions.consume(peer), "an unanswered Ask is not consent")
        self.assertTrue(permissions.accept(peer, ticket))
        self.assertFalse(permissions.consume(("fe80::1", 54321, 0, 3)), "IPv6 scopes differ")
        self.assertTrue(permissions.consume(newer), "TCP port changes are normal")
        self.assertFalse(permissions.consume(peer), "grant is single-use")
        ticket = permissions.begin(peer)
        permissions.accept(peer, ticket)
        now[0] += permissions.TTL
        self.assertFalse(permissions.consume(peer), "grant expires at the boundary")
        pending = permissions.begin(peer)
        now[0] += permissions.TTL
        self.assertFalse(permissions.accept(peer, pending), "expired prompts cannot create a new grant")
        old = permissions.begin(peer)
        self.assertIsNone(permissions.begin(peer), "overlapping pending Ask must preserve the first ticket")
        self.assertTrue(permissions.accept(peer, old))
        current = permissions.begin(peer)
        self.assertFalse(permissions.accept(peer, old), "a genuinely new Ask supersedes an accepted grant")
        permissions.cancel(peer, old)
        self.assertTrue(permissions.accept(peer, current))

    def test_parallel_uploads_cannot_replay_a_grant(self):
        permissions = receive.UploadPermissions()
        peer = ("fe80::1", 12345, 0, 2)
        permissions.accept(peer, permissions.begin(peer))
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: permissions.consume(peer), range(16)))
        self.assertEqual(sum(results), 1)

    def test_pending_peer_table_is_bounded_and_expired_entries_are_reaped(self):
        now = [0]
        permissions = receive.UploadPermissions(clock=lambda: now[0])
        for n in range(permissions.MAX_PEERS):
            self.assertIsNotNone(permissions.begin((f"2001:db8::{n}", 1000, 0, 0)))
        self.assertIsNone(permissions.begin(("2001:db8::extra", 1000, 0, 0)))
        now[0] += permissions.TTL
        self.assertIsNotNone(permissions.begin(("2001:db8::extra", 1000, 0, 0)))
        self.assertEqual(len(permissions.entries), 1)


class ControlBodyTests(unittest.TestCase):
    def test_fixed_body_limits_and_short_reads(self):
        class Short(io.BytesIO):
            def read(self, n):
                self.max_read = max(getattr(self, "max_read", 0), n)
                return super().read(min(n, 7))
        source = Short(b"A" * 80)
        self.assertEqual(receive.read_control_body(source, {"Content-Length": "80"}, limit=80), b"A" * 80)
        self.assertLessEqual(source.max_read, 65536)
        for length in ("81", str(1 << 40), "9" * 8192):
            source = io.BytesIO(b"unread")
            with self.assertRaises(receive.RequestBodyTooLarge):
                receive.read_control_body(source, {"Content-Length": length}, limit=80)
            self.assertEqual(source.tell(), 0)
        for length in ("-1", "+1", "no", "١"):
            with self.assertRaises(ValueError):
                receive.read_control_body(io.BytesIO(), {"Content-Length": length})
        with self.assertRaisesRegex(ValueError, "truncated"):
            receive.read_control_body(io.BytesIO(b"a"), {"Content-Length": "2"})

    def test_chunked_cumulative_limit_extensions_trailers_and_early_reject(self):
        headers = {"Transfer-Encoding": "chunked"}
        wire = b"3;ext=yes\r\nabc\r\n2\r\nde\r\n0\r\nX-Test: yes\r\n\r\n"
        self.assertEqual(receive.read_control_body(io.BytesIO(wire), headers, limit=5), b"abcde")
        stream = io.BytesIO(wire)
        with self.assertRaises(receive.RequestBodyTooLarge):
            receive.read_control_body(stream, headers, limit=4)
        self.assertEqual(stream.read(2), b"de", "over-limit chunk body is not read")
        stream = io.BytesIO(b"10000000000\r\nUNREAD")
        with self.assertRaises(receive.RequestBodyTooLarge):
            receive.read_control_body(stream, headers)
        self.assertEqual(stream.read(), b"UNREAD")
        for wire in (b"1\r\naBAD\r\n0\r\n\r\n", b"1\r\n", b"-1\r\n", b"0\n"):
            with self.assertRaises(ValueError):
                receive.read_control_body(io.BytesIO(wire), headers)
        with self.assertRaises(ValueError):
            receive.read_control_body(io.BytesIO(), {**headers, "Content-Length": "1"})


@unittest.skipUnless(scope, "supply a security-patched server.py to run handler tests")
class SecurityHandlerTests(WorkspaceTestCase):
    def assert_denied_before_io(self, handler):
        class Unreadable:
            def read(self, *args):
                raise AssertionError("unauthorized body read")
            def read1(self, *args):
                raise AssertionError("unauthorized body read")
            def readline(self, *args):
                raise AssertionError("unauthorized body read")
        handler.rfile = Unreadable()
        handler.headers["Expect"] = "100-continue"
        with patch.object(receive, "ReceiveWorkspace", side_effect=AssertionError("unauthorized workspace")):
            handler.handle_upload()
        self.assertEqual(handler.responses, [403])
        self.assertTrue(handler.close_connection)
        self.assertFalse((self.root / "cache/mochi/airdrop/incoming").exists())

    def test_unasked_and_unanswered_uploads_are_rejected_before_io(self):
        handler = FakeHandler(b"")
        self.assert_denied_before_io(handler)
        handler = FakeHandler(b"")
        handler.server.mochi_upload_permissions.begin(handler.client_address)
        self.assert_denied_before_io(handler)

    def test_declined_and_wrong_peer_uploads_are_rejected_before_io(self):
        ask = FakeControl(accept=False)
        ask.handle_ask()
        self.assertEqual(ask.responses, [403])
        self.assert_denied_before_io(FakeHandler(b"", server=ask.server))
        ask = FakeControl()
        ask.handle_ask()
        self.assertEqual(ask.responses, [200])
        self.assert_denied_before_io(FakeHandler(b"", server=ask.server, address=("fe80::2", 50000, 0, 2)))
        original = FakeHandler(dvzip(member("photo.jpg", b"photo") + TRAILER), server=ask.server)
        original.handle_upload()
        self.assertEqual(original.responses, [200], "wrong peer must not consume another peer's grant")

    def test_accepted_receive_and_replay(self):
        ask = FakeControl()
        ask.handle_ask()
        handler = FakeHandler(dvzip(member("photo.jpg", b"photo") + TRAILER), server=ask.server,
                              address=("fe80::1", 50001, 0, 2))
        handler.headers["Expect"] = "100-continue"
        handler.handle_upload()
        self.assertEqual(handler.responses, [100, 200])
        self.assertEqual((self.gallery / "photo.jpg").read_bytes(), b"photo")
        replay = FakeHandler(b"", server=ask.server)
        class Unreadable(io.BytesIO):
            def readinto(self, *args):
                raise AssertionError("replay read")
        replay.rfile = Unreadable()
        with patch.object(receive, "ReceiveWorkspace", side_effect=AssertionError("replayed workspace")):
            replay.handle_upload()
        self.assertEqual(replay.responses, [403])

    def test_expired_accepted_upload_is_rejected_before_io(self):
        now = [0]
        server = SimpleNamespace(mochi_upload_permissions=receive.UploadPermissions(clock=lambda: now[0]))
        ask = FakeControl(server=server)
        ask.handle_ask()
        now[0] = receive.UploadPermissions.TTL
        self.assert_denied_before_io(FakeHandler(b"", server=server))

    def test_declined_new_ask_revokes_previous_acceptance(self):
        first = FakeControl()
        first.handle_ask()
        second = FakeControl(server=first.server, accept=False)
        second.handle_ask()
        self.assert_denied_before_io(FakeHandler(b"", server=first.server))

    def test_malformed_new_ask_revokes_previous_acceptance(self):
        first = FakeControl()
        first.handle_ask()
        second = FakeControl(server=first.server, body=b"malformed")
        second.handle_ask()
        self.assertEqual(second.responses, [400])
        self.assert_denied_before_io(FakeHandler(b"", server=first.server))

    def test_overlapping_same_peer_prompt_preserves_first_explicit_acceptance(self):
        first = FakeControl()
        second = FakeControl(server=first.server, accept=False)
        def newer_request(body):
            second.handle_ask()
            return True
        first._ask_user = newer_request
        first.handle_ask()
        self.assertEqual(second.responses, [503])
        self.assertEqual(second.prompt_count, 0)
        self.assertEqual(first.responses, [200])
        handler = FakeHandler(dvzip(member("photo.jpg", b"photo") + TRAILER), server=first.server)
        handler.handle_upload()
        self.assertEqual(handler.responses, [200])
        self.assertEqual((self.gallery / "photo.jpg").read_bytes(), b"photo")

    def test_link_acceptance_does_not_authorize_files(self):
        ask = FakeControl(body=plistlib.dumps({"Items": ["https://example.invalid/"]}))
        with patch.dict(scope, open_url=lambda url: None):
            ask.handle_ask()
        self.assertEqual(ask.responses, [200])
        self.assert_denied_before_io(FakeHandler(b"", server=ask.server))

    def test_link_helpers_only_pass_safe_http_s_urls_to_the_opener(self):
        unsafe = ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "custom:run",
                  "--help", "https://", "http:///missing-host", "https://example.invalid/\nfile:///etc/passwd",
                  "https://example.invalid/\0bad", " https://example.invalid/", "https://[invalid/"]
        safe = ["https://example.invalid/path?q=yes", "http://example.invalid/", "HTTPS://example.invalid/"]
        items = scope["ask_items"]({"Items": unsafe + safe})
        self.assertEqual(items, safe)
        import subprocess
        with patch.object(subprocess, "Popen") as popen, patch.dict(os.environ, AIRDROP_URL_HOOK="/test/url-opener"):
            for url in unsafe:
                scope["open_url"](url)
            popen.assert_not_called()
            for url in safe:
                scope["open_url"](url)
            self.assertEqual([call.args[0] for call in popen.call_args_list], [["/test/url-opener", url] for url in safe])
        for url in unsafe:
            ask = FakeControl(body=plistlib.dumps({"Items": [url]}, fmt=plistlib.FMT_BINARY))
            ask.handle_ask()
            self.assertEqual(ask.responses, [400])
            self.assertEqual(ask.prompt_count, 0)

    def test_missing_hook_and_malformed_ask_do_not_autoaccept(self):
        ask = FakeControl()
        ask._ask_user = scope["PatchedHandler"]._ask_user.__get__(ask)
        with patch.dict(os.environ, {}, clear=True):
            ask.handle_ask()
        self.assertEqual(ask.responses, [403])
        self.assert_denied_before_io(FakeHandler(b"", server=ask.server))
        for body in (b"not a plist", plistlib.dumps([]), plistlib.dumps({"Files": "bad"}), plistlib.dumps({})):
            ask = FakeControl(body=body)
            ask.handle_ask()
            self.assertEqual(ask.responses, [400])
            self.assertEqual(ask.prompt_count, 0)
            self.assert_denied_before_io(FakeHandler(b"", server=ask.server))

    def test_ask_and_discover_return_413_for_fixed_and_chunked_oversize(self):
        for path in ("/Ask", "/Discover"):
            for chunked in (False, True):
                with self.subTest(path=path, chunked=chunked):
                    handler = FakeControl(path=path, body=b"UNREAD")
                    handler.headers = Message()
                    if chunked:
                        handler.headers["Transfer-Encoding"] = "chunked"
                        handler.rfile = io.BytesIO(f"{receive.CONTROL_BODY_LIMIT+1:x}\r\n".encode() + b"UNREAD")
                    else:
                        handler.headers["Content-Length"] = str(receive.CONTROL_BODY_LIMIT+1)
                    handler.do_POST()
                    self.assertEqual(handler.responses, [413])
                    self.assertTrue(handler.close_connection)
                    self.assertEqual(handler.prompt_count, 0)
                    self.assertEqual(handler.rfile.read(), b"UNREAD")

    def test_small_control_requests_and_duplicate_framing(self):
        handler = FakeControl(path="/Discover")
        handler.handle_discover()
        self.assertEqual(handler.responses, [200])
        for name in ("Content-Length", "Transfer-Encoding"):
            handler = FakeControl()
            handler.headers[name] = "1"
            if name == "Transfer-Encoding":
                handler.headers[name] = "chunked"
            handler.handle_ask()
            self.assertEqual(handler.responses, [400])
            self.assertEqual(handler.rfile.tell(), 0)

    def test_chunked_ask_acceptance_and_cumulative_413(self):
        ask = FakeControl()
        body = ask.rfile.read()
        ask.headers = Message()
        ask.headers["Transfer-Encoding"] = "chunked"
        ask.rfile = io.BytesIO(f"{len(body):x};ext=yes\r\n".encode() + body + b"\r\n0\r\nX-Test: yes\r\n\r\n")
        ask.handle_ask()
        self.assertEqual(ask.responses, [200])
        handler = FakeHandler(dvzip(member("photo.jpg", b"photo") + TRAILER), server=ask.server)
        handler.handle_upload()
        self.assertEqual(handler.responses, [200])
        for path in ("/Ask", "/Discover"):
            handler = FakeControl(path=path)
            handler.headers = Message()
            handler.headers["Transfer-Encoding"] = "chunked"
            first = b"A" * receive.CONTROL_BODY_LIMIT
            handler.rfile = io.BytesIO(f"{len(first):x}\r\n".encode() + first + b"\r\n1\r\nZ\r\n0\r\n\r\n")
            handler.do_POST()
            self.assertEqual(handler.responses, [413])
            self.assertEqual(handler.rfile.read(1), b"Z")
            self.assertEqual(handler.prompt_count, 0)


if __name__ == "__main__":
    unittest.main()
