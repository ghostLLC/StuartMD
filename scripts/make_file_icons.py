# -*- coding: utf-8 -*-
"""Designed MD/PDF file icons: paper card + brand rail + bold color wordmark."""
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
    ):
        try:
            return ImageFont.truetype(n, size)
        except Exception:
            pass
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def draw_icon(kind, S=256):
    """Paper document with brand rail and large colored wordmark."""
    paper = (248, 250, 252, 255)  # slate-50
    if kind == "md":
        brand = (79, 70, 229)  # indigo-600
        label = "MD"
    else:
        brand = (220, 38, 38)  # red-600
        label = "PDF"

    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    pad = int(S * 0.06)
    r = int(S * 0.14)
    # soft shadow
    d.rounded_rectangle(
        [pad + S * 0.015, pad + S * 0.03, S - pad + S * 0.015, S - pad + S * 0.03],
        radius=r,
        fill=(15, 23, 42, 45),
    )
    # paper card
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=r, fill=paper)
    # border
    d.rounded_rectangle(
        [pad, pad, S - pad, S - pad],
        radius=r,
        outline=(148, 163, 184, 200),
        width=max(1, S // 85),
    )
    # brand left rail (rounded left side)
    rail = int(S * 0.16)
    # draw rail as rounded rect clipped visually by overlapping paper
    d.rounded_rectangle([pad, pad, pad + rail + r // 2, S - pad], radius=r, fill=brand + (255,))
    # cover right side of rail radius so it looks like a flush stripe
    d.rectangle([pad + rail, pad, pad + rail + r // 2, S - pad], fill=paper)
    # re-stroke border top/bottom after rail
    d.line([pad + rail, pad + 1, S - pad - r // 2, pad + 1], fill=(148, 163, 184, 180), width=1)
    d.line(
        [pad + rail, S - pad - 1, S - pad - r // 2, S - pad - 1],
        fill=(148, 163, 184, 180),
        width=1,
    )

    # folded corner (top-right)
    fold = int(S * 0.12)
    fx, fy = S - pad - fold, pad
    d.polygon([(fx, fy), (S - pad - r // 3, fy), (fx + fold // 3, fy + fold)], fill=(226, 232, 240, 255))
    d.line([(fx, fy), (S - pad - r // 3, fy), (fx + fold // 3, fy + fold), (fx, fy)], fill=(148, 163, 184, 220), width=max(1, S // 100))

    # wordmark area (right of rail)
    area_x0 = pad + rail
    area_x1 = S - pad
    # large colored label — color on paper, high contrast
    fs = int(S * (0.36 if kind == "md" else 0.30))
    f = font(max(8, fs))
    bb = d.textbbox((0, 0), label, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    cx = (area_x0 + area_x1) / 2
    cy = (pad + S - pad) / 2 + int(S * 0.02)
    x = cx - tw / 2 - bb[0]
    y = cy - th / 2 - bb[1]
    # light shadow under text for depth
    d.text((x + max(1, S // 80), y + max(1, S // 80)), label, font=f, fill=(15, 23, 42, 35))
    d.text((x, y), label, font=f, fill=brand + (255,))

    # tiny "md" / "pdf" caption bar at bottom of paper (design flourish)
    if S >= 64:
        bar_w = int((area_x1 - area_x0) * 0.55)
        bar_x = cx - bar_w / 2
        bar_y = S - pad - int(S * 0.14)
        d.rounded_rectangle(
            [bar_x, bar_y, bar_x + bar_w, bar_y + max(2, int(S * 0.03))],
            radius=int(S * 0.015),
            fill=lerp(brand, (255, 255, 255), 0.35) + (180,),
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


def write_ico(path, base):
    frames = []
    for s in (16, 20, 24, 32, 48, 64):
        frames.append((s, bmp_frame(base.resize((s, s), Image.Resampling.LANCZOS))))
    for s in (128, 256):
        buf = io.BytesIO()
        base.resize((s, s), Image.Resampling.LANCZOS).save(buf, format="PNG")
        frames.append((s, buf.getvalue()))
    count = len(frames)
    entries, blobs, offset = b"", b"", 6 + 16 * count
    for s, data in frames:
        dim = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    path.write_bytes(struct.pack("<HHH", 0, 1, count) + entries + blobs)
    print("wrote", path.name, path.stat().st_size)


for kind in ("md", "pdf"):
    base = draw_icon(kind, 256)
    base.save(OUT / f"file-{kind}-256.png", "PNG")
    base.resize((32, 32), Image.Resampling.LANCZOS).save(OUT / f"file-{kind}-32.png", "PNG")
    base.resize((16, 16), Image.Resampling.LANCZOS).save(OUT / f"file-{kind}-16.png", "PNG")
    write_ico(OUT / f"file-{kind}.ico", base)
print("done")
