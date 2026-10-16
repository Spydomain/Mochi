#!/usr/bin/env python3
"""Run the pinned receiver's real ODC parser against complete and cut archives."""
import ast
import struct
import sys
import zlib
from pathlib import Path

source = ast.parse(Path(sys.argv[1]).read_text())
handler = next(n for n in ast.walk(source) if isinstance(n, ast.FunctionDef) and n.name == "handle_upload")
parser = next(n for n in handler.body if isinstance(n, ast.FunctionDef) and n.name == "odc_members")
assert sum(isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "complete" for t in n.targets)
           and "not bad and trailer" in ast.unparse(n.value) for n in ast.walk(handler)) >= 1
assert "self.send_response(200 if complete else 500)" in ast.unparse(handler)
scope = {}
exec(compile(ast.fix_missing_locations(ast.Module(body=[parser], type_ignores=[])), sys.argv[1], "exec"), scope)

def member(name, data=b"", mode=0o100644):
    header = bytearray(b"0" * 76)
    header[:6] = b"070707"
    header[18:24] = f"{mode:06o}".encode()
    header[59:65] = f"{len(name) + 1:06o}".encode()
    header[65:76] = f"{len(data):011o}".encode()
    return bytes(header) + name.encode() + b"\0" + data

file = member("photo.jpg", b"TRAILER!!!" + b"A" * 200)
trailer = member("TRAILER!!!", mode=0)
complete = file + trailer
assert len(zlib.compress(complete)) < len(complete), "wire size must be smaller than decoded total"
entries, ended = scope["odc_members"](complete)
assert ended and len(entries) == 1 and entries[0][1], "whole compressed archive is complete"
assert not scope["odc_members"](file)[1], "a whole photo without an archive trailer is incomplete"
entries, ended = scope["odc_members"](file[:-30])
assert not ended and not entries[0][1], "a truncated photo remains incomplete"
print("Complete compressed and truncated-archive regression checks passed.")
