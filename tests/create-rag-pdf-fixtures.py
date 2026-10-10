import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import CIDEncoding, UnicodeCIDFont
from reportlab.lib.utils import ImageReader


workspace = Path(__file__).resolve().parents[1]
destination = workspace / "tests" / "fixtures" / "pdf"
destination.mkdir(parents=True, exist_ok=True)
artifacts = workspace / "tests" / "native-artifacts" / "rag-pdf-completion"
artifacts.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
traditional_font = UnicodeCIDFont("MSung-Light")
traditional_font.encodingName = "UniCNS-UCS2-H"
traditional_font.encoding = CIDEncoding(traditional_font.encodingName)
pdfmetrics.registerFont(traditional_font)
expected = []
source = io.BytesIO()
document = canvas.Canvas(source, pagesize=(595, 842), invariant=True)


def native_line(page, text, x, y, size=14):
    document.setFont("Helvetica", size)
    document.drawString(x, y, text)
    expected.append({
        "pageNumber": page,
        "text": text,
        "method": "native",
        "rect": [x, y - 0.25, x + pdfmetrics.stringWidth(text, "Helvetica", size), y + size * 0.73],
    })


native_line(1, "SINGLE COLUMN SOURCE ALPHA", 72, 700)
native_line(1, "SECOND LINE SOURCE ALPHA", 72, 675)
document.showPage()
native_line(2, "LEFT COLUMN FIRST", 54, 730, 12)
native_line(2, "LEFT COLUMN SECOND", 54, 708, 12)
native_line(2, "LEFT COLUMN THIRD", 54, 686, 12)
native_line(2, "RIGHT COLUMN FIRST", 330, 730, 12)
native_line(2, "RIGHT COLUMN SECOND", 330, 708, 12)
native_line(2, "RIGHT COLUMN THIRD", 330, 686, 12)
document.showPage()
document.setPageSize((842, 595))
native_line(3, "LANDSCAPE SOURCE BRAVO", 95, 480)
document.showPage()
document.setPageSize((595, 842))
native_line(4, "ROTATION SOURCE CHARLIE", 95, 650)
document.showPage()
native_line(5, "CROPBOX SOURCE DELTA", 95, 650)
document.showPage()
document.setFont("STSong-Light", 22)
document.drawString(72, 710, "简体中文 页面引用 来源坐标")
document.setFont("MSung-Light", 22)
document.drawString(72, 650, "繁體中文 頁面引用 來源座標")
expected.extend([
    {"pageNumber": 6, "text": "简体中文 页面引用 来源坐标", "method": "native"},
    {"pageNumber": 6, "text": "繁體中文 頁面引用 來源座標", "method": "native"},
])
document.showPage()


def text_image(lines, size=(2100, 1100), font_size=90):
    image = Image.new("RGB", size, "white")
    painter = ImageDraw.Draw(image)
    english = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", font_size)
    chinese = ImageFont.truetype("C:/Windows/Fonts/simsun.ttc", font_size)
    for index, text in enumerate(lines):
        font = chinese if any(ord(character) > 255 for character in text) else english
        painter.text((90, 110 + index * 180), text, font=font, fill="black")
    return image


scanned = text_image(["SCANNED PAGE SOURCE ECHO", "扫描页面包含真实文字", "繁體掃描頁面包含真實文字"])
document.drawImage(ImageReader(scanned), 45, 370, width=505, height=265)
expected.extend([
    {"pageNumber": 7, "text": "SCANNED PAGE SOURCE ECHO", "method": "ocr"},
    {"pageNumber": 7, "text": "扫描页面包含真实文字", "method": "ocr"},
])
document.showPage()
native_line(8, "MIXED NATIVE SOURCE FOXTROT", 72, 710)
mixed = text_image(["IMAGE REGION SOURCE GOLF"], size=(2100, 450))
document.drawImage(ImageReader(mixed), 45, 450, width=505, height=108)
expected.append({"pageNumber": 8, "text": "IMAGE REGION SOURCE GOLF", "method": "ocr"})
document.showPage()
document.save()
reader = PdfReader(io.BytesIO(source.getvalue()))
writer = PdfWriter()
for number, page in enumerate(reader.pages, start=1):
    if number == 4:
        page.rotate(90)
    if number == 5:
        page.cropbox = RectangleObject([40, 50, 550, 780])
    writer.add_page(page)
layout_path = destination / "layout-and-ocr.pdf"
with layout_path.open("wb") as output:
    writer.write(output)

encrypted = PdfWriter()
encrypted.add_page(reader.pages[0])
encrypted.encrypt("StuartMD-verification-password")
with (destination / "encrypted.pdf").open("wb") as output:
    encrypted.write(output)
(destination / "corrupt.pdf").write_bytes(layout_path.read_bytes()[:150])

degraded = text_image(["LOW CONFIDENCE SOURCE HOTEL", "lI1O0S5B8 Z2Q9 G6 rn m vv w"], size=(2100, 600), font_size=55)
degraded = degraded.resize((420, 120)).resize((2100, 600)).filter(ImageFilter.GaussianBlur(2.8))
low_source = io.BytesIO()
low_pdf = canvas.Canvas(low_source, pagesize=(595, 842), invariant=True)
low_pdf.drawImage(ImageReader(degraded), 45, 450, width=505, height=145)
low_pdf.showPage()
low_pdf.save()
(destination / "low-confidence.pdf").write_bytes(low_source.getvalue())
(destination / "expected.json").write_text(json.dumps({
    "pageCount": 8,
    "source": "Canvas中人工指定的语句、基线、字号及页面矩形",
    "minimumNativeIoU": 0.8,
    "anchors": expected,
    "columnOrder": ["LEFT COLUMN FIRST", "LEFT COLUMN SECOND", "LEFT COLUMN THIRD", "RIGHT COLUMN FIRST", "RIGHT COLUMN SECOND", "RIGHT COLUMN THIRD"],
    "rotationPage": 4,
    "cropBoxPage": 5,
    "cropBox": [40, 50, 550, 780],
}, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"fixtures": str(destination), "pages": 8, "anchors": len(expected)}, ensure_ascii=False))
