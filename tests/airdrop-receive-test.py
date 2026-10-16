#!/usr/bin/env python3
"""Test workspaces; optionally pass server.py for handler tests, --no-network for no sockets."""
import ast
import errno
import gzip
import importlib.util
import io
import logging
import os
import platform
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import socket
import struct
import sys
import tempfile
import time
import tracemalloc
import unittest
from types import SimpleNamespace
from unittest.mock import patch
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
    upload = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "handle_upload")
    scope.update(__package__="opendrop", os=os, socket=socket, platform=platform, time=time, logger=logging.getLogger("test"))
    exec(compile(ast.fix_missing_locations(ast.Module(body=[upload], type_ignores=[])), "receiver", "exec"), scope)
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


class FakeHandler:
    UPLOAD_CONTENT_TYPES = ("application/x-cpio", "application/x-dvzip")
    def __init__(self, data, kind="dvzip", terminate=True):
        self.headers = {"content-type": f"application/x-{kind}", "transfer-encoding": "chunked"}
        self.rfile = io.BytesIO(f"{len(data):x};extension=yes\r\n".encode() + data + (b"\r\n0\r\n\r\n" if terminate else b""))
        self.responses = []
        self.connection = self
    def settimeout(self, timeout):
        self.timeout = timeout
    def send_response(self, code):
        self.responses.append(code)
    def send_header(self, *_):
        pass
    def end_headers(self):
        pass


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


@unittest.skipUnless(scope, "supply a patched server.py to run handler tests")
class ReceiveTests(WorkspaceTestCase):
    def send(self, data, kind="dvzip", terminate=True):
        handler = FakeHandler(data, kind, terminate)
        scope["handle_upload"](handler)
        self.assertEqual(handler.timeout, 300)
        return handler.responses[-1]
    def test_nested_photo_without_http_terminator(self):
        archive = member(".", mode=0o40755) + member("Containers/tmp/NSIRD_AirDrop_abc/photo.jpg", b"hello") + TRAILER
        self.assertEqual(self.send(dvzip(archive), terminate=False), 200)
        self.assertEqual([p.name for p in self.gallery.iterdir()], ["photo.jpg"])
        self.assertEqual((self.gallery / "photo.jpg").read_bytes(), b"hello")
    def test_incomplete_batch_only_publishes_whole_members(self):
        archive = member("PHMediaFormatConversionRequest-abc/photo.jpg", b"whole") + member("PHMediaFormatConversionRequest-abc/video.mov", b"X" * 5000)
        self.assertEqual(self.send(dvzip(archive[:-1000])), 500)
        self.assertEqual([p.name for p in self.gallery.iterdir()], ["photo.jpg"])
        recovery = list((self.root / "state/mochi/airdrop/recovery").glob("receive-*"))
        self.assertEqual(len(recovery), 1)
        self.assertEqual((recovery[0] / "files/PHMediaFormatConversionRequest-abc/video.mov.partial").stat().st_size, 4000)
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


if __name__ == "__main__":
    unittest.main()
