"""One-off script to generate PWA icon PNGs without external image libraries.
Draws a simple flat globe glyph on a solid background and writes raw PNGs
by hand (zlib-compressed scanlines). Not part of the app runtime.
"""
import struct
import zlib
import math
import os

BG = (15, 23, 42)        # slate-900, matches app dark background
GLOBE = (45, 212, 191)   # teal-400 accent
LINES = (13, 148, 136)   # teal-700, darker stroke for meridians/parallels

def make_icon(size, out_path):
    cx = cy = size / 2
    r = size * 0.34
    px = [[BG for _ in range(size)] for _ in range(size)]

    for y in range(size):
        for x in range(size):
            dx = (x + 0.5) - cx
            dy = (y + 0.5) - cy
            dist = math.sqrt(dx * dx + dy * dy)
            if dist <= r:
                px[y][x] = GLOBE

    # Equator
    band = max(1, size // 90)
    for y in range(size):
        for x in range(size):
            dx = (x + 0.5) - cx
            dy = (y + 0.5) - cy
            dist = math.sqrt(dx * dx + dy * dy)
            if dist <= r and abs(dy) <= band:
                px[y][x] = LINES

    # Meridians: a few vertical ellipses (different x-radius) stroked
    for factor in (0.35, 0.7, 1.0):
        rx = r * factor
        if rx < 1:
            continue
        for y in range(size):
            dy = (y + 0.5) - cy
            if abs(dy) > r:
                continue
            inside = 1 - (dy * dy) / (r * r)
            if inside < 0:
                continue
            half_w = rx * math.sqrt(inside)
            for side in (-1, 1):
                x = cx + side * half_w
                xi = int(round(x))
                for xx in range(xi - band, xi + band + 1):
                    if 0 <= xx < size:
                        ddx = xx - cx
                        ddy = dy
                        if math.sqrt(ddx * ddx + ddy * ddy) <= r + 0.5:
                            px[y][xx] = LINES

    # Latitude arcs (parallels) at two heights
    for frac in (-0.45, 0.45):
        yy = cy + frac * r
        inside = 1 - (frac * frac)
        if inside < 0:
            continue
        half_w = r * math.sqrt(inside)
        y0 = int(round(yy))
        for y in range(y0 - band, y0 + band + 1):
            if 0 <= y < size:
                for x in range(size):
                    dx = (x + 0.5) - cx
                    if abs(dx) <= half_w + 1:
                        dy2 = (y + 0.5) - cy
                        if math.sqrt(dx * dx + dy2 * dy2) <= r + 0.5:
                            px[y][x] = LINES

    write_png(px, size, size, out_path)


def write_png(pixels, width, height, path):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)

    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            r, g, b = pixels[y][x]
            raw += bytes((r, g, b))
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


if __name__ == "__main__":
    out_dir = os.path.join(os.path.dirname(__file__), "..", "icons")
    make_icon(192, os.path.join(out_dir, "icon-192.png"))
    make_icon(512, os.path.join(out_dir, "icon-512.png"))
    print("done")
