# -*- coding: utf-8 -*-
"""Large-label MD/PDF type icons — readable at Explorer 16-32px."""
from pathlib import Path
import struct
import io
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、"
)
OUT = ROOT / "assets"


def font(size):
    for n in (
        "C:/Windows/Fonts/seguisb.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/impact.ttf",
    ):
        try:
            return ImageFont.truetype(n, size)
        except Exception:
            pass
    return ImageFont.load_default()


def draw(kind, S):
    bg = (79, 70, 229, 255) if kind == "md" else (220, 38, 38, 255)
    label = "MD" if kind == "md" else "PDF"
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # rounded square card with soft shadow
    m = max(1, int(S * 0.04))
    r = max(2, int(S * 0.18))
    d.rounded_rectangle(
        [m + 1, m + 2, S - m + 1, S - m + 2],
        radius=r,
        fill=(0, 0, 0, 40),
    )
    d.rounded_rectangle([m, m, S - m, S - m], radius=r, fill=bg)
    # subtle top-left highlight
    d.rounded_rectangle(
        [m + 2, m + 2, S - m - 2, m + int(S * 0.35)],
        radius=max(1, r - 2),
        fill=(255, 255, 255, 28),
    )
    # huge centered label
    fs = int(S * (0.42 if kind == "md" else 0.34))
    f = font(max(6, fs))
    bb = d.textbbox((0, 0), label, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    x = (S - tw) / 2 - bb[0]
    y = (S - th) / 2 - bb[1]
    # stroke for readability on small sizes
    stroke = max(1, int(S * 0.02))
    d.text(
        (x, y),
        label,
        font=f,
        fill=(255, 255, 255, 255),
        stroke_width=stroke,
        stroke_fill=(0, 0, 0, 60),
    )
    return im


def bmp_frame(img):
    im = img.convert("RGBA")
    w, h = im.size
    px = im.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor.extend((b, g, r, a))
    and_row = ((w + 31) // 32) * 4
    and_mask = bytearray(and_row * h)
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0)
    return header + bytes(xor) + bytes(and_mask)


def write_ico(path, base256):
    frames = []
    for s in (16, 20, 24, 32, 48, 64):
        frames.append((s, bmp_frame(base256.resize((s, s), Image.Resampling.LANCZOS)), False))
    for s in (128, 256):
        im = base256.resize((s, s), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        frames.append((s, buf.getvalue(), True))
    count = len(frames)
    entries = b""
    blobs = b""
    offset = 6 + 16 * count
    for s, data, _p in frames:
        dim = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    path.write_bytes(struct.pack("<HHH", 0, 1, count) + entries + blobs)
    print("wrote", path, path.stat().st_size)


for kind, name in (("md", "file-md.ico"), ("pdf", "file-pdf.ico")):
    base = draw(kind, 256)
    base.save(OUT / name.replace(".ico", "-256.png"), "PNG")
    # also save 32px preview
    base.resize((32, 32), Image.Resampling.LANCZOS).save(OUT / name.replace(".ico", "-32.png"), "PNG")
    write_ico(OUT / name, base)

print("done")
