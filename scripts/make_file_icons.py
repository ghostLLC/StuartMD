# -*- coding: utf-8 -*-
"""Generate distinct .md / .pdf file-type icons (PNG + multi-size ICO)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、"
)
OUT = ROOT / "assets"
OUT.mkdir(parents=True, exist_ok=True)


def load_font(size):
    for name in (
        "C:/Windows/Fonts/seguisb.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/consolab.ttf",
    ):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def draw_page(draw, S, accent, badge_text, badge_bg):
    # soft shadow
    m = int(S * 0.10)
    r = int(S * 0.10)
    draw.rounded_rectangle(
        [m + S * 0.03, m + S * 0.05, S - m + S * 0.03, S - m + S * 0.05],
        radius=r,
        fill=(0, 0, 0, 28),
    )
    # page body
    draw.rounded_rectangle([m, m, S - m, S - m], radius=r, fill=(255, 255, 255, 255))
    # top accent bar
    bar_h = int(S * 0.06)
    draw.rounded_rectangle(
        [m, m, S - m, m + bar_h * 2], radius=int(r * 0.5), fill=accent
    )
    # cover left strip with page corner cut illusion: accent left edge
    strip_w = int(S * 0.07)
    draw.rectangle([m, m + bar_h, m + strip_w, S - m], fill=accent)
    # text lines
    x0 = m + strip_w + int(S * 0.08)
    y = m + int(S * 0.28)
    line_h = int(S * 0.045)
    gap = int(S * 0.03)
    widths = [0.52, 0.62, 0.44, 0.58, 0.36]
    for i, w in enumerate(widths):
        yy = y + i * (line_h + gap)
        draw.rounded_rectangle(
            [x0, yy, x0 + int(S * w), yy + line_h],
            radius=line_h // 2,
            fill=(148, 163, 184, 200),
        )
    # badge
    font = load_font(int(S * 0.14))
    tw = draw.textlength(badge_text, font=font)
    th = int(S * 0.18)
    bx = S - m - tw - int(S * 0.08)
    by = S - m - th - int(S * 0.08)
    draw.rounded_rectangle(
        [bx - int(S * 0.04), by - int(S * 0.02), bx + tw + int(S * 0.04), by + th + int(S * 0.02)],
        radius=th // 2,
        fill=badge_bg,
    )
    draw.text((bx, by + (th - font.size) / 2 - S * 0.01), badge_text, font=font, fill=(255, 255, 255, 255))


def make_icon(kind):
    base = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    if kind == "md":
        # slate blue accent, "MD" badge
        draw_page(d, 256, (79, 70, 229, 255), "MD", (59, 130, 246, 255))
    else:
        # red accent, "PDF" badge
        draw_page(d, 256, (220, 38, 38, 255), "PDF", (185, 28, 28, 255))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_path = OUT / ("file-md.ico" if kind == "md" else "file-pdf.ico")
    png_path = OUT / ("file-md-256.png" if kind == "md" else "file-pdf-256.png")
    base.save(png_path, "PNG")
    base.save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])
    print("wrote", ico_path, png_path)


make_icon("md")
make_icon("pdf")
print("done")
