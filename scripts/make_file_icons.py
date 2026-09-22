# -*- coding: utf-8 -*-
"""Build shell-friendly multi-size ICO (BMP frames 16/32/48 + PNG 256)."""
from pathlib import Path
import struct
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、"
)
OUT = ROOT / "assets"


def load_font(size):
    for name in (
        "C:/Windows/Fonts/seguisb.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/msyhbd.ttc",
    ):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def draw_icon(kind, S=256):
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    if kind == "md":
        accent = (79, 70, 229, 255)
        badge = (59, 130, 246, 255)
        text = "MD"
    else:
        accent = (220, 38, 38, 255)
        badge = (185, 28, 28, 255)
        text = "PDF"
    m = int(S * 0.10)
    r = int(S * 0.10)
    d.rounded_rectangle(
        [m + S * 0.03, m + S * 0.05, S - m + S * 0.03, S - m + S * 0.05],
        radius=r,
        fill=(0, 0, 0, 28),
    )
    d.rounded_rectangle([m, m, S - m, S - m], radius=r, fill=(255, 255, 255, 255))
    bar_h = int(S * 0.06)
    d.rounded_rectangle([m, m, S - m, m + bar_h * 2], radius=int(r * 0.5), fill=accent)
    strip_w = int(S * 0.07)
    d.rectangle([m, m + bar_h, m + strip_w, S - m], fill=accent)
    x0 = m + strip_w + int(S * 0.08)
    y = m + int(S * 0.28)
    line_h = max(2, int(S * 0.045))
    gap = int(S * 0.03)
    for i, w in enumerate([0.52, 0.62, 0.44, 0.58, 0.36]):
        yy = y + i * (line_h + gap)
        d.rounded_rectangle(
            [x0, yy, x0 + int(S * w), yy + line_h],
            radius=max(1, line_h // 2),
            fill=(148, 163, 184, 200),
        )
    font = load_font(max(8, int(S * 0.14)))
    tw = d.textlength(text, font=font)
    th = int(S * 0.18)
    bx = S - m - tw - int(S * 0.08)
    by = S - m - th - int(S * 0.08)
    d.rounded_rectangle(
        [bx - int(S * 0.04), by - int(S * 0.02), bx + tw + int(S * 0.04), by + th + int(S * 0.02)],
        radius=max(2, th // 2),
        fill=badge,
    )
    d.text((bx, by + (th - font.size) / 2 - S * 0.01), text, font=font, fill=(255, 255, 255, 255))
    return base


def to_bmp_frame(img):
    """32-bit BMP without file header, with AND mask — classic ICO frame."""
    im = img.convert("RGBA")
    w, h = im.size
    pixels = list(im.getdata())
    # bottom-up BGRA
    rows = []
    for y in range(h - 1, -1, -1):
        row = []
        for x in range(w):
            r, g, b, a = pixels[y * w + x]
            row.append((b, g, r, a))
        rows.append(row)
    xor = bytearray()
    for row in rows:
        for b, g, r, a in row:
            xor.extend((b, g, r, a))
    # AND mask: 1 bit per pixel, padded; all 0 since alpha channel used
    and_row_bytes = ((w + 31) // 32) * 4
    and_mask = bytearray(and_row_bytes * h)
    header = struct.pack(
        "<IiiHHIIiiII",
        40,
        w,
        h * 2,  # includes mask
        1,
        32,
        0,
        len(xor) + len(and_mask),
        0,
        0,
        0,
        0,
    )
    return header + bytes(xor) + bytes(and_mask)


def write_ico(kind, path, base256):
    frames = []  # (size, data)
    for s in (16, 24, 32, 48, 64):
        im = base256.resize((s, s), Image.Resampling.LANCZOS)
        frames.append((s, to_bmp_frame(im), False))
    # 128/256 as PNG
    for s in (128, 256):
        im = base256.resize((s, s), Image.Resampling.LANCZOS)
        import io

        buf = io.BytesIO()
        im.save(buf, format="PNG")
        frames.append((s, buf.getvalue(), True))

    count = len(frames)
    # ICONDIR + ICONDIRENTRY*count + data
    entries = b""
    blobs = b""
    offset = 6 + 16 * count
    for s, data, is_png in frames:
        dim = 0 if s >= 256 else s
        entries += struct.pack(
            "<BBBBHHII",
            dim,
            dim,
            0,
            0,
            1,
            32,
            len(data),
            offset,
        )
        blobs += data
        offset += len(data)
    ico = struct.pack("<HHH", 0, 1, count) + entries + blobs
    path.write_bytes(ico)
    print("wrote", path, "bytes", len(ico), "frames", count)


for kind, name in (("md", "file-md.ico"), ("pdf", "file-pdf.ico")):
    base = draw_icon(kind, 256)
    png = OUT / name.replace(".ico", "-256.png")
    base.save(png, "PNG")
    write_ico(kind, OUT / name, base)

# validate with PIL
for n in ("file-md.ico", "file-pdf.ico"):
    im = Image.open(OUT / n)
    print("open ok", n, im.size, im.mode, getattr(im, "n_frames", 1))
print("done")
