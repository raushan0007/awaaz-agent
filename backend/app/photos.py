"""Photo privacy and size: drop EXIF/GPS and text metadata before a photo is stored or sent anywhere."""

from __future__ import annotations

import struct

# JPEG segments that carry metadata: APP1 (EXIF, GPS, XMP), APP12/APP13 (Photoshop, IPTC), COM (comments).
# APP0 (JFIF), APP2 (ICC colour profile) and APP14 (Adobe colour transform) are kept, as they change how
# the image looks.
_JPEG_DROP = {0xE1, 0xEC, 0xED, 0xFE}
_PNG_DROP = {b"tEXt", b"iTXt", b"zTXt", b"eXIf", b"tIME"}
_JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


class PhotoError(ValueError):
    pass


def _clean_jpeg(data: bytes) -> tuple[bytes, int, int]:
    if data[:2] != b"\xff\xd8":
        raise PhotoError("Not a JPEG file.")
    out, pos, size = bytearray(b"\xff\xd8"), 2, None
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            raise PhotoError("Damaged JPEG file.")
        marker = data[pos + 1]
        if marker == 0xFF:  # fill byte
            pos += 1
            continue
        if marker == 0xDA:  # start of scan: the image data runs to the end
            out += data[pos:]
            break
        length = struct.unpack(">H", data[pos + 2:pos + 4])[0]
        segment = data[pos:pos + 2 + length]
        if marker in _JPEG_SOF and length >= 7:
            height, width = struct.unpack(">HH", data[pos + 5:pos + 9])
            size = (width, height)
        if marker not in _JPEG_DROP:
            out += segment
        pos += 2 + length
    if size is None:
        raise PhotoError("Damaged JPEG file.")
    return bytes(out), *size


def _clean_png(data: bytes) -> tuple[bytes, int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise PhotoError("Not a PNG file.")
    out, pos, size = bytearray(data[:8]), 8, None
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos:pos + 12 + length]
        if kind == b"IHDR":
            size = struct.unpack(">II", data[pos + 8:pos + 16])
        if kind not in _PNG_DROP:
            out += chunk
        pos += 12 + length
        if kind == b"IEND":
            break
    if size is None:
        raise PhotoError("Damaged PNG file.")
    return bytes(out), *size


def clean_photo(data: bytes, mime: str) -> tuple[bytes, int, int]:
    """Return (photo without metadata, width, height). WebP is rejected: the page always sends JPEG."""
    if mime == "image/jpeg":
        return _clean_jpeg(data)
    if mime == "image/png":
        return _clean_png(data)
    raise PhotoError("Photo must be JPEG or PNG.")
