# -*- coding: utf-8 -*-
"""High-contrast MD/PDF type icons — solid color card + white bold label.

No top highlight (it washed out white glyphs). Optional dark stroke keeps
letters readable at Explorer 16-32px.
"""
from pathlib import Path
import struct
import io
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、"
)
OUT = ROOT / "assets"


def load_font(size):
    for n in (
        "C:/Windows/Fonts/seguisb.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/msyhbd.ttc",
    ):
        try:
            return ImageFont.truetype(n, size)
        except Exception:
            continue
    return ImageFont.load_default()


def draw(kind, S):
    if kind == "md":
        bg = (67, 56, 202, 255)  # indigo-700 solid
        label = "MD"
    else:
        bg = (185, 28, 28, 255)  # red-700 solid
        label = "PDF"
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    m = max(1, int(S * 0.05))
    r = max(2, int(S * 0.16))
    # shadow (outside only)
    d.rounded_rectangle(
        [m + 1, m + 3, S - m + 1, S - m + 3], radius=r, fill=(0, 0, 0, 50)
    )
    # solid card — no light overlay on top
    d.rounded_rectangle([m, m, S - m, S - m], radius=r, fill=bg)
    # thin light border for definition against white folders
    d.rounded_rectangle(
        [m, m, S - m, S - m], radius=r, outline=(255, 255, 255, 40), width=max(1, S // 64)
    )
    # huge centered white label
    fs = int(S * (0.48 if kind == "md" else 0.38))
    f = load_font(max(6, fs))
    bb = d.textbbox((0, 0), label, font=f, stroke_width=0)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    x = (S - tw) / 2 - bb[0]
    y = (S - th) / 2 - bb[1]
    stroke = max(1, int(S * 0.035))
    # stroke first (dark), then fill white — keeps glyphs off the card's light edges
    d.text(
        (x, y),
        label,
        font=f,
        fill=(255, 255, 255, 255),
        stroke_width=stroke,
        stroke_fill=(30, 20, 60, 220),
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
    header = struct.pack(
        "<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0
    )
    return header + bytes(xor) + bytes(and_mask)


def write_ico(path, base256):
    frames = []
    for s in (16, 20, 24, 32, 48, 64):
        frames.append((s, bmp_frame(base256.resize((s, s), Image.Resampling.LANCZOS))))
    for s in (128, 256):
        im = base256.resize((s, s), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        frames.append((s, buf.getvalue()))
    count = len(frames)
    entries = b""
    blobs = b""
    offset = 6 + 16 * count
    for s, data in frames:
        dim = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    path.write_bytes(struct.pack("<HHH", 0, 1, count) + entries + blobs)
    print("wrote", path.name, path.stat().st_size)


for kind, name in (("md", "file-md.ico"), ("pdf", "file-pdf.ico")):
    base = draw(kind, 256)
    base.save(OUT / name.replace(".ico", "-256.png"), "PNG")
    base.resize((32, 32), Image.Resampling.LANCZOS).save(
        OUT / name.replace(".ico", "-32.png"), "PNG"
    )
    base.resize((16, 16), Image.Resampling.LANCZOS).save(
        OUT / name.replace(".ico", "-16.png"), "PNG"
    )
    write_ico(OUT / name, base)
print("done")
