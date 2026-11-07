"""Builds test zips and checks cleaned output independently of the app's own zip code."""

import io
import os
import shutil
import struct
import subprocess
import zipfile
import zlib

DOS = 0
UNIX = 3

DIR_ATTR = 0x10
FILE_ATTR = 0x20
HIDDEN_ATTR = 0x02


class Unseekable(io.RawIOBase):
    """Makes zipfile write data descriptors, like zips streamed out by servers and some tools."""

    def __init__(self, raw):
        self.raw = raw

    def writable(self):
        return True

    def write(self, b):
        return self.raw.write(b)


def info(name, system=DOS, attr=None, compress=zipfile.ZIP_DEFLATED, date=(2024, 5, 17, 9, 30, 0), comment=b'', extra=b''):
    i = zipfile.ZipInfo(name, date_time=date)
    i.create_system = system
    i.compress_type = compress
    if attr is not None:
        i.external_attr = attr
    elif system == DOS:
        i.external_attr = DIR_ATTR if name.endswith('/') else FILE_ATTR
    else:
        i.external_attr = ((0o40755 if name.endswith('/') else 0o100644) << 16) | (DIR_ATTR if name.endswith('/') else 0)
    i.comment = comment
    i.extra = extra
    return i


def add(z, name, data=b'hello', force_zip64=False, **kw):
    i = info(name, **kw)
    if name.endswith('/'):
        z.writestr(i, b'')
    elif force_zip64:
        with z.open(i, 'w', force_zip64=True) as f:
            f.write(data)
    else:
        z.writestr(i, data)


def patch_bytes(path, replacements):
    """Swaps same-length placeholder names for raw bytes, to make names zipfile won't write itself."""
    b = open(path, 'rb').read()
    for old, new in replacements.items():
        assert len(old) == len(new), (old, new)
        assert old in b, old
        b = b.replace(old, new)
    open(path, 'wb').write(b)


def have(tool):
    return shutil.which(tool) is not None


# --- independent checks -------------------------------------------------------------------------

def extra_fields(extra):
    i = 0
    while i + 4 <= len(extra):
        tag, size = struct.unpack('<HH', extra[i:i + 4])
        yield tag, extra[i:i + 4 + size]
        i += 4 + size


def strip_zip64(extra):
    """Central directory extra fields minus the zip64 field, whose offset is expected to change."""
    return b''.join(field for tag, field in extra_fields(extra) if tag != 0x0001)


def local_record(f, zi):
    """The local header, data and data descriptor of an entry, exactly as stored."""
    f.seek(zi.header_offset)
    head = f.read(30)
    assert head[:4] == b'PK\x03\x04', 'local header signature'
    name_len, extra_len = struct.unpack('<HH', head[26:30])
    local_extra = f.read(name_len + extra_len)[name_len:]
    length = 30 + name_len + extra_len + zi.compress_size
    if zi.flag_bits & 0x08:
        # the descriptor's sizes are 8 bytes each when the local header has a zip64 field
        zip64 = any(tag == 0x0001 for tag, _ in extra_fields(local_extra))
        f.seek(zi.header_offset + length)
        sig = f.read(4)
        length += (4 if sig == b'PK\x07\x08' else 0) + (20 if zip64 else 12)
    f.seek(zi.header_offset)
    return f.read(length)


def assert_clean_copy(original, output, kept, pwd=None, compare_data=True):
    """Checks output holds exactly the kept entries, each copied byte for byte from the original."""
    with zipfile.ZipFile(original) as zo, zipfile.ZipFile(output) as zc:
        if pwd:
            zc.setpassword(pwd)
        assert zc.testzip() is None, 'a CRC check failed'
        names = [zi.filename for zi in zc.infolist()]
        assert names == kept
        assert zc.comment == zo.comment
        # pair each output entry with the next original of the same name, so repeated names line up
        originals = iter(zo.infolist())
        with open(original, 'rb') as fo, open(output, 'rb') as fc:
            for zi in zc.infolist():
                oi = next(o for o in originals if o.filename == zi.filename)
                for field in ('orig_filename', 'flag_bits', 'compress_type', 'CRC', 'compress_size', 'file_size', 'date_time',
                              'external_attr', 'internal_attr', 'create_system', 'create_version', 'extract_version', 'comment'):
                    assert getattr(zi, field) == getattr(oi, field), (zi.filename, field)
                assert strip_zip64(zi.extra) == strip_zip64(oi.extra), (zi.filename, 'extra')
                if compare_data:
                    assert local_record(fc, zi) == local_record(fo, oi), (zi.filename, 'local record')
    if have('unzip'):
        # Info-ZIP is a second, independent reader. Some builds can't do every compression method (macOS's
        # can't do bzip2 or LZMA), so the cleaned zip has to do exactly as well as the original did
        def unzip_test(path):
            cmd = ['unzip', '-tqq'] + (['-P', pwd.decode()] if pwd else []) + [str(path)]
            result = subprocess.run(cmd, capture_output=True)
            # 1 is only a warning, such as a zip with no entries
            return 0 if result.returncode == 1 else result.returncode, result.stdout + result.stderr
        before, _ = unzip_test(original)
        after, message = unzip_test(output)
        assert after == before, message


# --- zips that are too big to write normally ----------------------------------------------------

def write_sparse_stored_zip(path, entries):
    """Writes a zip64 file whose large entries are runs of zeros, left as holes so they take no disk space.

    entries is a list of (name, size). Zeros are stored uncompressed, so the zip is as big as its contents.
    """
    ZERO_CHUNK = bytes(1 << 24)
    central = []
    with open(path, 'wb') as f:
        for name, size in entries:
            crc = 0
            left = size
            while left:
                n = min(left, len(ZERO_CHUNK))
                crc = zlib.crc32(ZERO_CHUNK[:n], crc)
                left -= n
            offset = f.tell()
            raw = name.encode()
            extra = struct.pack('<HHQQ', 0x0001, 16, size, size)
            f.write(struct.pack('<IHHHHHIIIHH', 0x04034B50, 45, 0, 0, 0, 0x21, crc, 0xFFFFFFFF, 0xFFFFFFFF, len(raw), len(extra)))
            f.write(raw + extra)
            # skipping ahead leaves a hole that reads back as zeros
            f.seek(size, os.SEEK_CUR)
            central.append((raw, size, crc, offset))
        cd_start = f.tell()
        for raw, size, crc, offset in central:
            extra = struct.pack('<HHQQQ', 0x0001, 24, size, size, offset)
            f.write(struct.pack('<IHHHHHHIIIHHHHHII', 0x02014B50, 45, 45, 0, 0, 0, 0x21, crc, 0xFFFFFFFF, 0xFFFFFFFF,
                                len(raw), len(extra), 0, 0, 0, FILE_ATTR, 0xFFFFFFFF))
            f.write(raw + extra)
        cd_size = f.tell() - cd_start
        zip64_eocd = f.tell()
        f.write(struct.pack('<IQHHIIQQQQ', 0x06064B50, 44, 45, 45, 0, 0, len(central), len(central), cd_size, cd_start))
        f.write(struct.pack('<IIQI', 0x07064B50, 0, zip64_eocd, 1))
        f.write(struct.pack('<IHHHHIIH', 0x06054B50, 0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0))


def assert_zero_entries(path, expected, any_order=False):
    """Checks the names and sizes in a big zip (assert_clean_copy checks the CRCs)."""
    with zipfile.ZipFile(path) as z:
        found = [(zi.filename, zi.file_size) for zi in z.infolist()]
    assert (sorted(found) if any_order else found) == (sorted(expected) if any_order else expected)
