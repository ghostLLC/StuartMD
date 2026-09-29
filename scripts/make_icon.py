from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os, struct, io

ROOT = str(Path(__file__).resolve().parent.parent)
OUT_DIR = os.path.join(ROOT, "assets")
ICO_DIR = os.path.join(ROOT, "tauri", "src-tauri", "icons")
os.makedirs(ICO_DIR, exist_ok=True)

BG_TOP = (52, 72, 120, 255)
BG_BOT = (28, 38, 68, 255)
ACCENT = (147, 197, 253, 255)
WHITE = (255, 255, 255, 255)


def load_font(px):
    for fp in [
        r"C:\Windows\Fonts\seguisb.ttf",  # Semibold — balanced
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
    ]:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, px)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_at(ss):
    """Draw design at supersampled size `ss` (square)."""
    radius = max(2, int(ss * 0.18))
    mask = Image.new("L", (ss, ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, ss - 1, ss - 1], radius=radius, fill=255)

    grad = Image.new("RGBA", (ss, ss), BG_BOT)
    gd = ImageDraw.Draw(grad)
    for y in range(ss):
        t = y / max(1, ss - 1)
        c = (
            int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t),
            int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t),
            int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t),
            255,
        )
        gd.line([(0, y), (ss - 1, y)], fill=c)

    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # Balanced Semibold S
    font = load_font(int(ss * 0.58))
    bbox = d.textbbox((0, 0), "S", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (ss - tw) // 2 - bbox[0]
    ty = (ss - th) // 2 - bbox[1] - int(ss * 0.07)
    d.text((tx, ty), "S", font=font, fill=WHITE)

    # accent bar
    bar_w = int(ss * 0.28)
    bar_h = max(2, int(ss * 0.055))
    bar_x = (ss - bar_w) // 2
    bar_y = int(ss * 0.78)
    d.rounded_rectangle(
        [bar_x, bar_y, bar_x + bar_w - 1, bar_y + bar_h - 1],
        radius=max(1, bar_h // 2),
        fill=ACCENT,
    )
    return img


def icon_at(size):
    """Crisp small sizes: supersample + BOX (not LANCZOS) + light sharpen."""
    if size <= 48:
        ss = size * 8
        return draw_at(ss).resize((size, size), Image.Resampling.BOX)
    # larger: smooth downscale is fine
    ss = 1024 if size >= 256 else size * 4
    im = draw_at(ss)
    return im.resize((size, size), Image.Resampling.LANCZOS)


def png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def bmp_entry(im):
    w, h = im.size
    pixels = im.convert("RGBA")
    raw = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = pixels.getpixel((x, y))
            raw += bytes((b, g, r, a))
    mask_row_bytes = ((w + 31) // 32) * 4
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = 0
        bits = 0
        row_bytes = bytearray()
        for x in range(w):
            a = pixels.getpixel((x, y))[3]
            bit = 0 if a >= 128 else 1
            row = (row << 1) | bit
            bits += 1
            if bits == 8:
                row_bytes.append(row)
                row = 0
                bits = 0
        if bits:
            row_bytes.append(row << (8 - bits))
        while len(row_bytes) < mask_row_bytes:
            row_bytes.append(0)
        mask += row_bytes
    header = struct.pack(
        "<IiiHHIIiiII",
        40,
        w,
        h * 2,
        1,
        32,
        0,
        len(raw) + len(mask),
        0,
        0,
        0,
        0,
    )
    return header + bytes(raw) + bytes(mask)


def write_ico(path, sizes):
    count = len(sizes)
    offset = 6 + 16 * count
    dir_entries = b""
    body = b""
    for sz in sizes:
        im = icon_at(sz)
        data = bmp_entry(im) if sz <= 48 else png_bytes(im)
        w = 0 if sz >= 256 else sz
        h = 0 if sz >= 256 else sz
        dir_entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset)
        body += data
        offset += len(data)
    out = struct.pack("<HHH", 0, 1, count) + dir_entries + body
    with open(path, "wb") as f:
        f.write(out)
    print("wrote", path, "bytes", len(out))


sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
write_ico(os.path.join(OUT_DIR, "app.ico"), sizes)
write_ico(os.path.join(ICO_DIR, "icon.ico"), sizes)

icon_at(256).save(os.path.join(OUT_DIR, "app-icon-256.png"))
icon_at(128).save(os.path.join(ICO_DIR, "128x128.png"))
icon_at(32).save(os.path.join(ICO_DIR, "32x32.png"))
icon_at(128).save(os.path.join(ICO_DIR, "icon.png"))
# QA previews at 4x nearest so we can judge 32px sharpness
icon_at(32).resize((160, 160), Image.Resampling.NEAREST).save(
    os.path.join(OUT_DIR, "_icon_preview_32up.png")
)
icon_at(24).resize((120, 120), Image.Resampling.NEAREST).save(
    os.path.join(OUT_DIR, "_icon_preview_24up.png")
)
print("OK")
