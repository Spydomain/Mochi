#!/usr/bin/env python3
"""Recover complete members of old AirDrop archives; quarantine work files.

Dry-run by default. No raw archive, partial file or original wrapper is deleted.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time


def whole_members(cpio):
    offset = 0
    while offset + 76 <= len(cpio):
        header = cpio[offset:offset + 76]
        if header[:6] != b"070707":
            return
        try:
            mode = int(header[18:24], 8) & 0o170000
            namesize = int(header[59:65], 8)
            size = int(header[65:76], 8)
        except ValueError:
            return
        if not 1 <= namesize <= 65536 or size < 0:
            return
        start = offset + 76
        name = cpio[start:start + namesize]
        if len(name) != namesize or not name.endswith(b"\0") or b"\0" in name[:-1]:
            return
        name = name[:-1].decode("utf-8", "strict")
        if name == "TRAILER!!!":
            return
        offset = start + namesize + size
        if mode == 0o100000 and offset <= len(cpio):
            yield name, size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("save_directory", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    destination = args.save_directory.resolve(strict=True)
    if not destination.is_dir() or destination == Path.home() or destination == Path("/"):
        parser.error("choose a dedicated AirDrop save directory")
    archives, artifacts = [], []
    for path in destination.iterdir():
        if path.is_symlink():
            continue
        if path.is_file() and re.fullmatch(r"airdrop-received-[0-9]+\.(dvzip|cpio)", path.name):
            archives.append(path)
            artifacts.append(path)
        elif path.is_file() and path.name.endswith(".partial"):
            artifacts.append(path)
        elif path.is_dir() and (
                path.name.startswith(("PHMediaFormatConversionRequest-", "NSIRD_AirDrop_"))
                or (path.name == "Containers" and (path / "Data/PluginKitPlugin").is_dir())
                or (path.name == "Media" and (path / "PhotoData/OutgoingTemp").is_dir())):
            artifacts.append(path)
    print(f"Found {len(archives)} old archives and {len(artifacts)} total work artifacts.")
    if not args.apply:
        print("Use --apply to recover verified whole files and move originals into private recovery storage.")
        return
    sockets = subprocess.run(["ss", "-ltnH", "( sport = :8771 )"], capture_output=True, text=True, check=True)
    service = subprocess.run(["systemctl", "--user", "is-active", "--quiet", "mochi-airdrop.service"])
    if sockets.stdout.strip() or service.returncode == 0:
        parser.error("turn AirDrop off before recovering old files")
    spec = importlib.util.spec_from_file_location("mochi_receive", Path(__file__).resolve().parents[1] / "airdrop/mochi_receive.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    state = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    base = state / "mochi/airdrop/recovery"
    base.mkdir(parents=True, mode=0o700, exist_ok=True)
    recovery = Path(tempfile.mkdtemp(prefix=f"legacy-{int(time.time())}-", dir=base))
    manifest = {"saveDirectory": str(destination), "published": [], "preserved": [], "errors": []}
    # Recover from archive boundaries, NOT from filenames or libarchive's padded
    # output. A photo that happens to open is not evidence that all bytes arrived.
    for path in sorted(archives):
        workspace = module.ReceiveWorkspace(destination, path.suffix[1:])
        try:
            if path.suffix == ".dvzip":
                cpio = workspace.decode_dvzip(path)
                extract = workspace.decoded_path
            elif path.open("rb").read(2) == b"\x1f\x8b":
                cpio, _ = workspace.decode_gzip(path)
                extract = workspace.decoded_path
            else:
                cpio = workspace.map_cpio(path)
                extract = path
            try:
                workspace.extract_file(extract)
            except (ValueError, OSError):
                pass  # earlier, whole members can still be recovered
            good = []
            for name, expected in whole_members(cpio):
                source = module.safe_member(workspace.root, name)
                if source.is_file() and not source.is_symlink() and source.stat().st_size == expected:
                    good.append(name)
            published = workspace.finish(True, good)
            manifest["published"].append({"archive": path.name, "files": published})
            print(f"{path.name}: recovered {len(published)} complete files")
        except Exception as exc:
            manifest["errors"].append({"archive": path.name, "error": str(exc), "workspace": str(workspace.directory)})
            print(f"{path.name}: preserved for recovery ({exc})")
    for path in artifacts:
        target = recovery / path.name
        shutil.move(str(path), str(target))
        manifest["preserved"].append({"from": str(path), "to": str(target)})
    with (recovery / "manifest.json").open("w") as output:
        json.dump(manifest, output, indent=2)
    print(f"All original work artifacts preserved at {recovery}")


if __name__ == "__main__":
    main()
