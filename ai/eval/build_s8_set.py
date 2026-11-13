"""Render the S8 evaluation set's case specs (ai/eval/s8-set/cases/*.json) to files.

Output: ai/eval/s8-set/files/<ID>/<file name> for the rubric and each submission
file. No AI or provider calls, no database. Deterministic text content: running
it twice gives the same extracted text (PDF metadata dates are fixed).

Formats
- pdf:  ReportLab, DejaVu fonts, with a text layer.
- docx: python-docx.
- scan: an image-only PDF. The text is rendered to a PDF, each page is rasterised
        (PyMuPDF, ~110 dpi) and the images are placed in a new PDF, so there is
        no text layer.
- A section's "image" caption becomes a rasterised PNG (no text layer) placed in
  the PDF or DOCX with nothing accompanying it.

Run: ai/.venv/Scripts/python.exe ai/eval/build_s8_set.py
"""

from __future__ import annotations

import datetime
import io
import json
import sys
from pathlib import Path
from xml.sax.saxutils import escape

import pymupdf as fitz
from docx import Document
from docx.shared import Inches
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import Image as RLImage
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

HERE = Path(__file__).resolve().parent
CASES_DIR = HERE / "s8-set" / "cases"
FILES_DIR = HERE / "s8-set" / "files"
FONT_DIR = HERE.parent / "fonts"
DPI = 110
FIXED_DATE = datetime.datetime(2026, 1, 1, 0, 0, 0)

pdfmetrics.registerFont(TTFont("DejaVu", str(FONT_DIR / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(FONT_DIR / "DejaVuSans-Bold.ttf")))

TITLE = ParagraphStyle("t", fontName="DejaVu-Bold", fontSize=16, leading=20, spaceAfter=10)
HEAD = ParagraphStyle("h", fontName="DejaVu-Bold", fontSize=12, leading=15, spaceBefore=10, spaceAfter=5)
BODY = ParagraphStyle("b", fontName="DejaVu", fontSize=10, leading=14, spaceAfter=6)


def _para(text: str, style) -> Paragraph:
    # Escape for ReportLab's mini-markup; keep line breaks inside a paragraph.
    return Paragraph(escape(text).replace("\n", "<br/>"), style)


def caption_png(caption: str) -> bytes:
    """A picture of the caption text: a rasterised box, no text layer."""
    w, h = 420, 230
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(w, h), invariant=1)
    c.setStrokeGray(0.3)
    c.rect(8, 8, w - 16, h - 16)
    c.setFont("DejaVu", 11)
    y = h - 30
    for line in simpleSplit(caption, "DejaVu", 11, w - 40):
        c.drawString(20, y, line)
        y -= 16
    c.showPage()
    c.save()
    doc = fitz.open(stream=buf.getvalue(), filetype="pdf")
    png = doc[0].get_pixmap(dpi=DPI).tobytes("png")
    doc.close()
    return png


def text_pdf_bytes(title: str | None, sections: list[dict]) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=22 * mm, rightMargin=22 * mm,
                            topMargin=20 * mm, bottomMargin=20 * mm, invariant=1,
                            title=title or "document")
    story = []
    if title:
        story.append(_para(title, TITLE))
    for s in sections:
        story.append(_para(s["heading"], HEAD))
        for p in s["paragraphs"]:
            story.append(_para(p, BODY))
        if s.get("image"):
            story.append(Spacer(1, 4))
            story.append(RLImage(io.BytesIO(caption_png(s["image"])), width=105 * mm, height=57.5 * mm))
    doc.build(story)
    return buf.getvalue()


def scan_pdf_bytes(sections: list[dict]) -> bytes:
    src = fitz.open(stream=text_pdf_bytes(None, sections), filetype="pdf")
    out = fitz.open()
    for page in src:
        png = page.get_pixmap(dpi=DPI).tobytes("png")
        new = out.new_page(width=page.rect.width, height=page.rect.height)
        new.insert_image(new.rect, stream=png)
    src.close()
    out.set_metadata({})
    data = out.tobytes(garbage=3, deflate=True)
    out.close()
    return data


def docx_bytes(title: str | None, sections: list[dict]) -> bytes:
    d = Document()
    d.core_properties.created = FIXED_DATE
    d.core_properties.modified = FIXED_DATE
    d.core_properties.author = "synthetic"
    d.core_properties.last_modified_by = "synthetic"
    if title:
        d.add_heading(title, level=0)
    for s in sections:
        d.add_heading(s["heading"], level=1)
        for p in s["paragraphs"]:
            d.add_paragraph(p)
        if s.get("image"):
            d.add_picture(io.BytesIO(caption_png(s["image"])), width=Inches(4.0))
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def render(fmt: str, title: str | None, sections: list[dict]) -> bytes:
    if fmt == "pdf":
        return text_pdf_bytes(title, sections)
    if fmt == "docx":
        return docx_bytes(title, sections)
    if fmt == "scan":
        return scan_pdf_bytes(sections)
    raise ValueError(f"unknown format {fmt!r}")


def build_case(path: Path) -> str:
    case = json.loads(path.read_text(encoding="utf-8"))
    out = FILES_DIR / path.stem
    out.mkdir(parents=True, exist_ok=True)
    written = []
    rub = case.get("rubric")
    if rub:
        (out / rub["name"]).write_bytes(render(rub["format"], rub["title"], rub["sections"]))
        written.append(rub["name"])
    for f in case["submission"]["files"]:
        (out / f["name"]).write_bytes(render(f["format"], None, f["sections"]))
        written.append(f["name"])
    return f"{path.stem}: mode={case['mode']} files={', '.join(written)} text_chars={len(case['submission']['text'])}"


def main() -> int:
    paths = sorted(CASES_DIR.glob("*.json"))
    if not paths:
        print("no case files found", file=sys.stderr)
        return 1
    for p in paths:
        print(build_case(p))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
