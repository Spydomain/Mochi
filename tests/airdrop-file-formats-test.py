#!/usr/bin/env python3
"""Exercise patched Ask/Upload with real sniffing/archive codecs, no network."""
import ast
from http.client import HTTPException
import importlib.util
import io
import logging
import mimetypes
import os
from pathlib import Path
import plistlib
import struct
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile
import zlib

import fleep
import libarchive
from PIL import Image
from opendrop.util import AbsArchiveWrite, AirDropUtil as InstalledUtil

client_path, util_path = map(Path, sys.argv[1:3])
del sys.argv[1:3]


def load_methods(path, classname, methods, scope):
    tree = ast.parse(path.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == classname)
    cls.body = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in methods]
    exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])), str(path), "exec"), scope)
    return scope[classname]


util = load_methods(util_path, "AirDropUtil", {"get_uti_type"}, {"os": os, "mimetypes": mimetypes})
util.generate_file_icon = staticmethod(InstalledUtil.generate_file_icon)
client_tree = ast.parse(client_path.read_text())
client_name = next(n.name for n in client_tree.body if isinstance(n, ast.ClassDef)
                   and any(isinstance(m, ast.FunctionDef) and m.name == "send_ask" for m in n.body))
Client = load_methods(client_path, client_name, {"send_ask", "send_upload", "_cpio_to_dvzip"},
                      dict(os=os, io=io, fleep=fleep, plistlib=plistlib, libarchive=libarchive,
                           AirDropUtil=util, AbsArchiveWrite=AbsArchiveWrite, struct=struct, zlib=zlib,
                           logger=logging.getLogger("test"), HTTPException=HTTPException, time=time))
repo = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("format_receive", repo / "windows/airdrop/mochi_receive.py")
receive = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = receive
spec.loader.exec_module(receive)


class FileFormatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.destination = self.root / "received"
        self.destination.mkdir()
        self.env = patch.dict(os.environ, XDG_CACHE_HOME=str(self.root / "cache"),
                              XDG_STATE_HOME=str(self.root / "state"), OPENDROP_UPLOAD_ARMS="reuse-chunked-dvzip-rawhdr")
        self.env.start()
        self.addCleanup(self.env.stop)
        self.posts = []
        self.client = Client.__new__(Client)
        self.client.config = SimpleNamespace(computer_name="Mochi", computer_model="test",
                                             service_id="000000000000", record_data=None)
        self.client._transfer_id = "test-transfer"
        self.client._pseudonym = "test"
        self.client._push_token = "test"
        self.client.http_conn = None
        def post(path, body, **kwargs):
            self.posts.append((path, body.read() if hasattr(body, "read") else body, kwargs))
            return True, b""
        self.client.send_POST = post

    def put(self, name, data):
        path = self.source / name
        path.write_bytes(data)
        return str(path)

    def office_fixture_batch(self):
        # These OLE signature fixtures exercise fleep's shared container match;
        # their payload is opaque to the sender, just like any uploaded file.
        ole = bytes.fromhex("d0cf11e0a1b11ae1") + bytes(range(256)) * 2
        paths = [self.put(name, ole) for name in ("legacy.doc", "legacy.xls", "legacy.ppt")]
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
        ooxml = bytearray(stream.getvalue())
        # Deflate option bits 1+2 produce the Office ZIP magic fleep ranks
        # ahead of application/zip. Keep local and central flags consistent.
        struct.pack_into("<H", ooxml, 6, 0x0006)
        struct.pack_into("<H", ooxml, ooxml.index(b"PK\x01\x02") + 8, 0x0006)
        self.assertEqual(ooxml[:8], bytes.fromhex("504b030414000600"))
        with zipfile.ZipFile(io.BytesIO(ooxml)) as archive:
            self.assertIsNone(archive.testzip())
        paths.extend(self.put(name, ooxml) for name in
                     ("ambiguous.docx", "ambiguous.xlsx", "ambiguous.pptx"))
        return paths

    def fixture_batch(self):
        paths = [self.put("report.pdf", b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"),
                 self.put("notes.txt", "Hello PDF and files!\nनमस्ते\n".encode()),
                 self.put("table.csv", b"one,two\n1,2\n"),
                 self.put("data.json", b'{"file":true}\n'),
                 self.put("unknown.mochi-unknown", bytes(range(256)) * 4),
                 self.put("no-extension", b"opaque\x00data\xff"),
                 self.put("empty", b"")]
        for name in ("bundle.zip", "document.docx", "book.xlsx", "slides.pptx"):
            path = self.source / name
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("[Content_Types].xml", "<Types/>")
            paths.append(str(path))
        for name, fmt, mode in (("image.png", "PNG", "RGBA"), ("image.jpg", "JPEG", "RGB"),
                                ("animation.gif", "GIF", "P"), ("image.tiff", "TIFF", "RGB"),
                                ("image.webp", "WEBP", "RGB")):
            path = self.source / name
            Image.new(mode, (4, 4)).save(path, format=fmt)
            paths.append(str(path))
        paths.extend([self.put("music.mp3", b"ID3" + bytes(125)),
                      self.put("movie.mp4", b"\x00\x00\x00\x18ftypmp42" + bytes(116)),
                      self.put("archive.gz", __import__("gzip").compress(b"archive data"))])
        paths.extend(self.office_fixture_batch())
        return paths

    def test_mixed_batch_announces_each_format_independently(self):
        paths = self.fixture_batch()
        self.assertTrue(self.client.send_ask(paths))
        body = plistlib.loads(self.posts[0][1])
        types = {row["FileName"]: row["FileType"] for row in body["Files"]}
        self.assertEqual(types, {
            "report.pdf": "com.adobe.pdf", "notes.txt": "public.plain-text",
            "table.csv": "public.comma-separated-values-text", "data.json": "public.json",
            "unknown.mochi-unknown": "public.data", "no-extension": "public.data", "empty": "public.data",
            "bundle.zip": "public.zip-archive", "document.docx": "org.openxmlformats.wordprocessingml.document",
            "book.xlsx": "org.openxmlformats.spreadsheetml.sheet", "slides.pptx": "org.openxmlformats.presentationml.presentation",
            "image.png": "public.png", "image.jpg": "public.jpeg", "animation.gif": "com.compuserve.gif",
            "image.tiff": "public.tiff", "image.webp": "org.webmproject.webp", "music.mp3": "public.mp3",
            "movie.mp4": "public.mpeg-4", "archive.gz": "org.gnu.gnu-zip-archive",
            "legacy.doc": "com.microsoft.word.doc", "legacy.xls": "com.microsoft.excel.xls",
            "legacy.ppt": "com.microsoft.powerpoint.ppt",
            "ambiguous.docx": "org.openxmlformats.wordprocessingml.document",
            "ambiguous.xlsx": "org.openxmlformats.spreadsheetml.sheet",
            "ambiguous.pptx": "org.openxmlformats.presentationml.presentation"})
        self.assertTrue(all(not row["FileIsDirectory"] for row in body["Files"]))
        self.assertFalse(body["ConvertMediaFormats"])
        self.assertNotIn("FileIcon", body, "PDF batches must not require an image thumbnail")

    def test_real_mixed_upload_roundtrips_every_name_and_byte(self):
        paths = self.fixture_batch()
        expected = {Path(p).name: Path(p).read_bytes() for p in paths}
        self.assertTrue(self.client.send_ask(paths))
        self.assertTrue(self.client.send_upload(paths))
        self.assertEqual([p[0] for p in self.posts], ["/Ask", "/Upload"])
        payload = self.posts[1][1]
        workspace = receive.ReceiveWorkspace(self.destination, "dvzip")
        try:
            workspace.raw_path.write_bytes(payload)
            workspace.decode_dvzip(workspace.raw_path)
            self.assertTrue(workspace.container_complete)
            workspace.extract_file(workspace.decoded_path)
            good = list(workspace.verified_files)
            self.assertEqual(len(good), len(expected))
            published = workspace.finish(True, good)
            self.assertEqual(len(published), len(expected))
            self.assertEqual({p.name: p.read_bytes() for p in self.destination.iterdir()}, expected)
        finally:
            if workspace.mapping is not None:
                workspace.mapping.close()

    def test_thumbnail_failure_never_blocks_original_image_or_pdf(self):
        image = self.source / "unsupported.png"
        Image.new("RGBA", (4, 4)).save(image)
        pdf = self.put("report.pdf", b"%PDF-1.7\n%%EOF\n")
        for error in (OSError("codec unavailable"), ValueError("unsupported mode")):
            with self.subTest(error=type(error).__name__), patch.object(util, "generate_file_icon", side_effect=error):
                self.assertTrue(self.client.send_ask([str(image), pdf]))
                body = plistlib.loads(self.posts[-1][1])
                self.assertNotIn("FileIcon", body)
                self.assertEqual([e["FileType"] for e in body["Files"]], ["public.png", "com.adobe.pdf"])

    def test_pdf_content_beats_a_misleading_extension(self):
        for extension in ("png", "doc", "xls", "ppt", "docx", "xlsx", "pptx"):
            with self.subTest(extension=extension):
                path = self.put("not-really." + extension, b"%PDF-1.4\n%%EOF\n")
                self.assertTrue(self.client.send_ask(path))
                body = plistlib.loads(self.posts[-1][1])
                self.assertEqual(body["Files"][0]["FileType"], "com.adobe.pdf")

    def test_ambiguous_office_signatures_use_case_insensitive_extensions(self):
        expected = {
            ".doc": "com.microsoft.word.doc", ".xls": "com.microsoft.excel.xls",
            ".ppt": "com.microsoft.powerpoint.ppt",
            ".docx": "org.openxmlformats.wordprocessingml.document",
            ".xlsx": "org.openxmlformats.spreadsheetml.sheet",
            ".pptx": "org.openxmlformats.presentationml.presentation",
        }
        for path in self.office_fixture_batch():
            with self.subTest(path=Path(path).name):
                flp = fleep.get(Path(path).read_bytes()[:128])
                self.assertEqual(flp.mime[0], "application/vnd.ms-excel",
                                 "fixture must reproduce fleep's ambiguous Office match")
                for extension in (Path(path).suffix, Path(path).suffix.upper()):
                    self.assertEqual(util.get_uti_type(flp, str(Path(path).with_suffix(extension))),
                                     expected[extension.lower()])

    def test_heic_and_unknown_types_do_not_require_local_decoder(self):
        self.assertEqual(util.get_uti_type(SimpleNamespace(mime=["image/heic"], type=["image"])), "public.heic")
        self.assertEqual(util.get_uti_type(SimpleNamespace(mime=[], type=[])), "public.data")


if __name__ == "__main__":
    unittest.main()
