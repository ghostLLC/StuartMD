# -*- coding: utf-8 -*-
"""Create a minimal PDF + simulate StuartMD annotation objects, then reload."""
from pathlib import Path
import sys

try:
    from pypdf import PdfWriter, PdfReader
    from pypdf.generic import (
        ArrayObject,
        DictionaryObject,
        FloatObject,
        NameObject,
        NumberObject,
        TextStringObject,
        DecodedStreamObject,
        StreamObject,
    )
except ImportError:
    print("SKIP: pypdf not available")
    sys.exit(0)

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("scripts/_annot_edge_test.pdf")
out.parent.mkdir(parents=True, exist_ok=True)

w = PdfWriter()
w.add_blank_page(width=595, height=842)
page = w.pages[0]

# Annotation with UTF-16BE-like text via pypdf TextStringObject (handles unicode)
annot = DictionaryObject()
annot[NameObject("/Type")] = NameObject("/Annot")
annot[NameObject("/Subtype")] = NameObject("/Highlight")
annot[NameObject("/Rect")] = ArrayObject(
    [FloatObject(72), FloatObject(700), FloatObject(300), FloatObject(720)]
)
annot[NameObject("/QuadPoints")] = ArrayObject(
    [
        FloatObject(72),
        FloatObject(720),
        FloatObject(300),
        FloatObject(720),
        FloatObject(72),
        FloatObject(700),
        FloatObject(300),
        FloatObject(700),
    ]
)
annot[NameObject("/C")] = ArrayObject([FloatObject(1), FloatObject(0.91), FloatObject(0.23)])
annot[NameObject("/CA")] = FloatObject(0.4)
annot[NameObject("/F")] = NumberObject(4)
annot[NameObject("/Contents")] = TextStringObject("中文评论测试 comment")
try:
    annot[NameObject("/P")] = page.indirect_reference
except Exception:
    pass

note = DictionaryObject()
note[NameObject("/Type")] = NameObject("/Annot")
note[NameObject("/Subtype")] = NameObject("/Text")
note[NameObject("/Rect")] = ArrayObject(
    [FloatObject(80), FloatObject(680), FloatObject(96), FloatObject(696)]
)
note[NameObject("/Contents")] = TextStringObject("中文便签")
note[NameObject("/Name")] = NameObject("/Comment")
note[NameObject("/F")] = NumberObject(4)

annots = ArrayObject()
ref1 = w._add_object(annot)
ref2 = w._add_object(note)
annots.append(ref1)
annots.append(ref2)
page[NameObject("/Annots")] = annots

with out.open("wb") as f:
    w.write(f)

# Reload check
r = PdfReader(str(out))
n = len(r.pages)
has = False
if "/Annots" in r.pages[0]:
    has = True
print(f"OK wrote {out} pages={n} annots={has} size={out.stat().st_size}")
if n < 1:
    print("FAIL: no pages on reload")
    sys.exit(1)
print("EDGE-SIM RELOAD PASS")
