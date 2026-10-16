"""Private, bounded-memory AirDrop workspaces and verified-file publishing."""
import errno
import filecmp
import io
import json
import mmap
import os
from pathlib import Path, PurePosixPath
import shutil
import struct
import tempfile
import time
import zlib

class HTTPChunkedReader(io.RawIOBase):
    """Read chunk bodies incrementally, including chunk extensions/trailers."""
    def __init__(self, rfile):
        self.rfile = rfile
        self.remaining = 0
        self.separator = False
        self.finished = False
        self.total = 0

    def _line(self):
        line = self.rfile.readline(8193)
        if not line or len(line) > 8192 or not line.endswith(b"\r\n"):
            raise ValueError("truncated or oversized HTTP chunk header")
        return line

    def readinto(self, buf):
        if not buf or self.finished:
            return 0
        if not self.remaining:
            if self.separator and self._line() != b"\r\n":
                raise ValueError("invalid HTTP chunk separator")
            word = self._line().split(b";", 1)[0].strip()
            if not word or any(c not in b"0123456789abcdefABCDEF" for c in word):
                raise ValueError("invalid HTTP chunk length")
            self.remaining = int(word, 16)
            if not self.remaining:
                for _ in range(128):
                    if self._line() == b"\r\n":
                        self.finished = True
                        return 0
                raise ValueError("too many HTTP trailers")
        read = getattr(self.rfile, "read1", self.rfile.read)
        block = read(min(len(buf), self.remaining))
        if not block:
            raise ValueError("truncated HTTP chunk body")
        buf[:len(block)] = block
        self.remaining -= len(block)
        self.total += len(block)
        self.separator = True
        return len(block)


class DVZipEnd:
    """Recognize the ODC trailer at record boundaries, never inside file data."""
    LIMIT = 16 * 1024 * 1024

    def __init__(self):
        self.wire = bytearray()
        self.record = bytearray()
        self.need = 76
        self.stage = "header"
        self.remaining = 0
        self.invalid = False
        self.finished = False

    def feed(self, data):
        if self.invalid or self.finished:
            return self.finished
        self.wire.extend(data)
        try:
            while len(self.wire) >= 4:
                word = struct.unpack_from(">I", self.wire)[0]
                size = word & 0x7fffffff
                if size > self.LIMIT or size == 0:
                    raise ValueError("invalid dvzip block length")
                if len(self.wire) < size + 4:
                    break
                payload = bytes(self.wire[4:4 + size])
                del self.wire[:4 + size]
                if word & 0x80000000:
                    decoded = payload
                else:
                    decoder = zlib.decompressobj()
                    decoded = decoder.decompress(payload, self.LIMIT + 1)
                    if (len(decoded) > self.LIMIT or not decoder.eof
                            or decoder.unused_data or decoder.unconsumed_tail):
                        raise ValueError("oversized or incomplete dvzip block")
                self._odc(decoded)
                if self.finished:
                    self.wire.clear()
                    return True
        except (ValueError, zlib.error, struct.error):
            self.invalid = True
            self.wire.clear()
        return False

    def _odc(self, data):
        offset = 0
        while offset < len(data) and not self.finished:
            if self.stage == "data":
                take = min(self.remaining, len(data) - offset)
                offset += take
                self.remaining -= take
                if self.remaining == 0:
                    self.stage, self.need = "header", 76
                continue
            take = min(self.need - len(self.record), len(data) - offset)
            self.record.extend(data[offset:offset + take])
            offset += take
            if len(self.record) < self.need:
                continue
            record = bytes(self.record)
            self.record.clear()
            if self.stage == "header":
                if record[:6] != b"070707":
                    raise ValueError("invalid ODC header")
                namesize = int(record[59:65], 8)
                self.remaining = int(record[65:76], 8)
                if not 1 <= namesize <= 65536 or self.remaining < 0:
                    raise ValueError("invalid ODC lengths")
                self.stage, self.need = "name", namesize
            else:
                if not record.endswith(b"\0"):
                    raise ValueError("unterminated ODC name")
                if record == b"TRAILER!!!\0" and self.remaining == 0:
                    self.finished = True
                elif self.remaining:
                    self.stage = "data"
                else:
                    self.stage, self.need = "header", 76


def safe_member(root, name):
    name = str(name).replace("\\", "/")
    parts = PurePosixPath(name)
    if parts.is_absolute() or ".." in parts.parts or "\0" in name:
        raise ValueError("unsafe archive member")
    path = root.joinpath(*parts.parts)
    if not path.is_relative_to(root) or path == root:
        raise ValueError("unsafe archive member")
    return path


def metadata(name):
    path = PurePosixPath(str(name).replace("\\", "/"))
    return (any(p == "__MACOSX" or p.startswith("._") for p in path.parts)
            or path.name in {".DS_Store", ".com.apple.containermanagerd.metadata.plist"}
            or path.suffix.lower() == ".aae")


def publish_file(source, destination):
    """Publish a whole file atomically, deduplicating without overwriting."""
    destination = Path(destination)
    base = source.name
    staged = None
    try:
        for number in range(100000):
            name = base if number == 0 else f"{source.stem}-{number}{source.suffix}"
            target = destination / name
            if target.exists() or target.is_symlink():
                if (not target.is_symlink() and target.is_file()
                        and target.stat().st_size == source.stat().st_size
                        and filecmp.cmp(source, target, shallow=False)):
                    return target
                continue
            try:
                os.link(source, target, follow_symlinks=False)
                return target
            except FileExistsError:
                continue
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                if staged is None:
                    fd, staged = tempfile.mkstemp(prefix=".mochi-receive-", dir=destination)
                    with os.fdopen(fd, "wb") as out, source.open("rb") as incoming:
                        shutil.copyfileobj(incoming, out, 1024 * 1024)
                        out.flush()
                        os.fsync(out.fileno())
                try:
                    os.link(staged, target, follow_symlinks=False)
                    return target
                except FileExistsError:
                    continue
        raise FileExistsError("too many files with the same name")
    finally:
        if staged is not None:
            os.unlink(staged)


def publication_parts(name, *, directory=False):
    """Return user directory components after the last transport wrapper."""
    parts = PurePosixPath(str(name).replace("\\", "/")).parts
    parts = parts if directory else parts[:-1]
    for index in range(len(parts) - 1, -1, -1):
        part = parts[index]
        if part.startswith(("PHMediaFormatConversionRequest-", "NSIRD_AirDrop_")) or part.endswith(".pvt"):
            return parts[index + 1:]
    return parts


def publication_directory(destination, name, *, directory=False):
    """Strip iOS transport wrappers, but preserve folders the user sent."""
    parent = destination
    for part in publication_parts(name, directory=directory):
        if part in ("..", "/"):
            raise ValueError("unsafe output directory")
        parent = parent / part
        if parent.is_symlink():
            raise ValueError("output directory is a symlink")
        parent.mkdir(mode=0o700, exist_ok=True)
    return parent


class ReceiveWorkspace:
    def __init__(self, destination, extension):
        self.destination = Path(destination).resolve()
        cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
        self.base = cache / "mochi" / "airdrop"
        incoming = self.base / "incoming"
        incoming.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(self.base, 0o700)
        os.chmod(incoming, 0o700)
        self.directory = Path(tempfile.mkdtemp(prefix="receive-", dir=incoming))
        self.root = self.directory / "files"
        self.root.mkdir(mode=0o700)
        self.raw_path = self.directory / f"airdrop-received-{int(time.time())}.{extension}"
        self.decoded_path = self.directory / "decoded.cpio"
        self.mapping = None
        self.container_complete = False
        self.detector = DVZipEnd() if extension == "dvzip" else None
        self.directories = set()
        self.published = []
        self._progress()

    def _progress(self):
        runtime = os.environ.get("XDG_RUNTIME_DIR")
        if not runtime:
            return
        marker = Path(runtime) / "mochi-airdrop" / "transfer.json"
        try:
            if marker.is_symlink() or marker.stat().st_uid != os.getuid():
                return
            data = json.loads(marker.read_text())
            if Path(data.get("directory", "")).resolve() != self.destination:
                return
            data["rawPath"] = str(self.raw_path)
            fd, temporary = tempfile.mkstemp(prefix=".progress-", dir=marker.parent)
            with os.fdopen(fd, "w") as out:
                json.dump(data, out)
            os.replace(temporary, marker)
        except (OSError, ValueError, TypeError):
            pass

    def observe(self, data):
        return self.detector is not None and self.detector.feed(data)

    def decode_dvzip(self, path):
        # The CPIO verifier separately decides whether the archive has ended.
        # A missing container terminator is fine; a partial frame is not.
        self.container_complete = False
        intact = True
        frames = 0
        with open(path, "rb") as incoming, self.decoded_path.open("wb") as out:
            while header := incoming.read(4):
                if len(header) != 4:
                    intact = False
                    break
                word = struct.unpack(">I", header)[0]
                length = word & 0x7fffffff
                if length > DVZipEnd.LIMIT:
                    raise ValueError("oversized dvzip block")
                if not length:
                    intact = intact and word == 0 and not incoming.read(1)
                    break
                payload = incoming.read(length)
                frames += 1
                intact = intact and len(payload) == length
                if word & 0x80000000:
                    out.write(payload)
                else:
                    decoder = zlib.decompressobj()
                    decoded = decoder.decompress(payload, DVZipEnd.LIMIT + 1)
                    if len(decoded) > DVZipEnd.LIMIT or decoder.unconsumed_tail:
                        raise ValueError("oversized decoded block")
                    intact = intact and decoder.eof and not decoder.unused_data
                    out.write(decoded)
                if len(payload) != length:
                    break
        self.container_complete = bool(frames) and intact
        return self.map_cpio(self.decoded_path)

    def map_cpio(self, path):
        if self.mapping is not None:
            self.mapping.close()
        with open(path, "rb") as incoming:
            if os.fstat(incoming.fileno()).st_size == 0:
                return b""
            self.mapping = mmap.mmap(incoming.fileno(), 0, access=mmap.ACCESS_READ)
        return self.mapping

    def decode_gzip(self, path):
        self.container_complete = False
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        with open(path, "rb") as incoming, self.decoded_path.open("wb") as out:
            while block := incoming.read(65536):
                while block:
                    decoded = decoder.decompress(block, 1024 * 1024)
                    out.write(decoded)
                    if decoder.eof:
                        # Feeding an ended decoder accumulates unused_data
                        # without bound. Reject tails before another call.
                        if decoder.unused_data or incoming.read(1):
                            raise ValueError("trailing data after gzip stream")
                        break
                    block = decoder.unconsumed_tail
                if decoder.eof:
                    break
        self.container_complete = decoder.eof
        return self.map_cpio(self.decoded_path), decoder.eof

    def extract_file(self, path):
        # Stream ODC directly: libarchive can pad or withhold an incomplete
        # member. Preserve exactly the bytes that arrived, never synthetic zeros.
        with open(path, "rb") as archive:
            while True:
                header = archive.read(76)
                if len(header) != 76 or header[:6] != b"070707":
                    raise ValueError("missing ODC header/trailer")
                mode = int(header[18:24], 8) & 0o170000
                namesize = int(header[59:65], 8)
                remaining = int(header[65:76], 8)
                if not 1 <= namesize <= 65536 or remaining < 0:
                    raise ValueError("invalid ODC member length")
                name = archive.read(namesize)
                if len(name) != namesize or not name.endswith(b"\0") or b"\0" in name[:-1]:
                    raise ValueError("invalid ODC name")
                name = name[:-1].decode("utf-8", "strict")
                if name == "TRAILER!!!" and remaining == 0:
                    return
                if mode == 0o040000 and name in (".", "./") and remaining == 0:
                    continue
                target = safe_member(self.root, name)
                if mode == 0o040000 and remaining == 0:
                    target.mkdir(parents=True, exist_ok=True)
                    self.directories.add(name)
                elif mode == 0o100000:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, "wb") as out:
                        while remaining:
                            block = archive.read(min(remaining, 1024 * 1024))
                            if not block:
                                raise ValueError("truncated ODC file")
                            out.write(block)
                            remaining -= len(block)
                else:
                    raise ValueError("unsupported archive member type")

    @property
    def has_user_directories(self):
        """Allow the handler to accept a transfer containing only directories."""
        return next(self._empty_user_directories(), None) is not None

    def _empty_user_directories(self):
        for name in sorted(self.directories):
            source = safe_member(self.root, name)
            if (not metadata(name) and publication_parts(name, directory=True)
                    and not source.is_symlink() and source.is_dir()
                    and not any(source.iterdir())):
                yield name

    def _recovery_directory(self):
        state = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
        recovery = state / "mochi" / "airdrop" / "recovery"
        recovery.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(recovery, 0o700)
        return recovery / self.directory.name

    def finish(self, complete, good):
        sidecars = []
        for name in good:
            source = safe_member(self.root, name)
            if metadata(name):
                if (source.suffix.lower() == ".aae" and source.is_file()
                        and not source.is_symlink()):
                    sidecars.append(name)
                continue
            if source.is_file() and not source.is_symlink():
                target = publish_file(source, publication_directory(self.destination, name))
                self.published.append(str(target.relative_to(self.destination)))
        if complete:
            for name in self._empty_user_directories():
                target = publication_directory(self.destination, name, directory=True)
                self.published.append(str(target.relative_to(self.destination)))
        if self.mapping is not None:
            self.mapping.close()
            self.mapping = None
        if complete:
            if sidecars:
                recovery = self._recovery_directory()
                recovery.mkdir(mode=0o700)
                for name in sidecars:
                    target = safe_member(recovery / "files", name)
                    target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                    shutil.move(str(safe_member(self.root, name)), str(target))
            shutil.rmtree(self.directory)
            if sidecars:
                self.directory = recovery
        else:
            target = self._recovery_directory()
            shutil.move(str(self.directory), str(target))
            self.directory = target
        return self.published
