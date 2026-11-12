"""S8 Step 5: a coverage report's draft, exported to Word (python-docx) or PDF (ReportLab).

The export contains EXACTLY the mentor's edited draft, and a visible marker
that it is a draft the mentor reviewed. Both formats render one plan,
`plan(draft)`: an ordered list of blocks, each a fixed heading of this
template or a value taken from the draft. Nothing else is added, nothing is
summarised, nothing is looked up. Tests compare each exported file's text with
the plan, field for field.

Safety of what is rendered: every value is the mentor's or the student's text.
python-docx writes it as text; characters XML cannot hold are removed. ReportLab
parses Paragraph text as markup, so every value is escaped before it becomes a
Paragraph: a student's "<b>" or "<a href=...>" prints as those characters. Long
values are split across rows and paragraphs, so a long quote never makes a
table cell taller than a page. The font is DejaVu Sans (fonts/, with its
licence), so text beyond Latin-1 prints as itself.

This module reads nothing and calls nothing: the draft it is given is all it uses.
"""

from __future__ import annotations

import io
import re
from pathlib import Path
from xml.sax.saxutils import escape

MARKER = "Draft, reviewed by the mentor"
FONT_DIR = Path(__file__).resolve().parent / "fonts"
# Longest piece of text put in one table cell or paragraph before splitting.
CELL_CHARS = 1200

_XML_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


def clean(text) -> str:
    """A value as it can be written: a string, without characters XML cannot hold."""
    return _XML_ILLEGAL.sub("", "" if text is None else str(text))


# --------------------------------------------------------------------------
# The plan: the draft, in order, and nothing else
# --------------------------------------------------------------------------
def plan(draft: dict) -> list[tuple]:
    """Blocks in reading order: ("title"|"marker"|"heading"|"subheading"|"label"|"para"|"bullet", text)
    or ("table", header_row, rows). Headings and labels are this template's own words; every other
    text is a draft value."""
    out: list[tuple] = [("title", clean(draft.get("title"))), ("marker", MARKER)]
    h = draft.get("header") or {}
    out.append(("table", ["", ""], [
        ["Student", clean(h.get("student"))],
        ["Mentor", clean(h.get("mentor"))],
        ["Mentorship", clean(h.get("mentorship"))],
        ["Period", clean(h.get("period"))],
        ["Assignments", "; ".join(clean(a) for a in h.get("assignments") or [])],
    ]))
    for s in draft.get("sections") or []:
        out.append(("heading", clean(s.get("assignment"))))
        for label, key in (("Mode", "modeLabel"), ("Checklist", "checklist"), ("Status", "status"),
                           ("Brief", "brief"), ("Submitted", "submitted")):
            if s.get(key):
                out += [("label", label), ("para", clean(s.get(key)))]
        if s.get("files"):
            out.append(("label", "Files"))
            out += [("bullet", clean(f)) for f in s["files"]]
        if s.get("history"):
            out.append(("label", "History"))
            out += [("bullet", clean(e)) for e in s["history"]]
        if s.get("criteria"):
            rows = []
            for c in s["criteria"]:
                evidence = "\n".join(f"“{clean(e.get('quote'))}” ({clean(e.get('where'))})" for e in c.get("evidence") or [])
                rows.append([clean(c.get("criterion")), clean(c.get("label")),
                             "\n".join(x for x in (clean(c.get("present")), clean(c.get("absent")), clean(c.get("reason"))) if x),
                             evidence, clean(c.get("suggestedMarks")), clean(c.get("note"))])
            out.append(("subheading", "Criteria (suggestions for the mentor to confirm)"))
            out.append(("table", ["Criterion", "Suggested verdict", "What is there, and what is not", "Evidence",
                                  "Suggested marks", "Mentor's note"], rows))
        for title, key, fmt in (
            ("Summary", "points", lambda p: f"{clean(p.get('point'))} — “{clean((p.get('evidence') or {}).get('quote'))}” ({clean((p.get('evidence') or {}).get('where'))})"),
            ("Strengths", "strengths", lambda x: clean(x.get("text")) + "".join(
                f" — “{clean(e.get('quote'))}” ({clean(e.get('where'))})" for e in x.get("evidence") or [])),
            ("Gaps", "gaps", lambda x: clean(x.get("text"))),
            ("Where to look closely", "lookClosely", lambda x: f"{clean(x.get('where'))}: {clean(x.get('why'))}"),
            ("What could not be assessed", "notAssessed", lambda x: f"{clean(x.get('where'))}: {clean(x.get('reason'))}"),
        ):
            if s.get(key):
                out.append(("subheading", title))
                out += [("bullet", fmt(x)) for x in s[key]]
    if draft.get("trends"):
        out.append(("heading", "Trends across the period"))
        out += [("bullet", clean(t.get("text"))) for t in draft["trends"]]
    if draft.get("mentorNotes"):
        out += [("heading", "Mentor's notes"), ("para", clean(draft["mentorNotes"]))]
    return out


def plan_text(blocks: list[tuple]) -> list[str]:
    """Every piece of text the plan puts on the page, in order."""
    texts: list[str] = []
    for b in blocks:
        if b[0] == "table":
            texts += [t for t in b[1] if t]
            texts += [t for row in b[2] for t in row if t]
        elif b[1]:
            texts.append(b[1])
    return texts


def _pieces(text: str) -> list[str]:
    """A long value in parts of at most CELL_CHARS, split at a space where there is one."""
    parts = []
    while len(text) > CELL_CHARS:
        cut = text.rfind(" ", 0, CELL_CHARS)
        cut = cut if cut > CELL_CHARS // 2 else CELL_CHARS
        parts.append(text[:cut])
        text = text[cut:].lstrip(" ")
    return parts + [text]


# --------------------------------------------------------------------------
# Word
# --------------------------------------------------------------------------
def to_docx(draft: dict) -> bytes:
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    doc = Document()
    doc.styles["Normal"].font.name = "DejaVu Sans"
    doc.styles["Normal"].font.size = Pt(10)
    section = doc.sections[0]
    header = section.header.paragraphs[0]
    header.text = MARKER  # on every page
    for block in plan(draft):
        kind = block[0]
        if kind == "title":
            doc.add_heading(block[1], level=0)
        elif kind == "marker":
            run = doc.add_paragraph().add_run(block[1])
            run.bold = True
            run.font.color.rgb = RGBColor(0xB0, 0x30, 0x30)
        elif kind == "heading":
            doc.add_heading(block[1], level=1)
        elif kind == "subheading":
            doc.add_heading(block[1], level=2)
        elif kind == "label":
            doc.add_paragraph().add_run(block[1]).bold = True
        elif kind == "para":
            for piece in _pieces(block[1]):
                doc.add_paragraph(piece)
        elif kind == "bullet":
            doc.add_paragraph(block[1], style="List Bullet")
        elif kind == "table":
            head, rows = block[1], block[2]
            table = doc.add_table(rows=0, cols=len(rows[0]) if rows else len(head))
            table.style = "Table Grid"
            if any(head):
                cells = table.add_row().cells
                for cell, text in zip(cells, head):
                    cell.text = text
                    for run in cell.paragraphs[0].runs:
                        run.bold = True
                # Repeat the header row on each page.
                tr_pr = table.rows[0]._tr.get_or_add_trPr()
                repeat = OxmlElement("w:tblHeader")
                repeat.set(qn("w:val"), "true")
                tr_pr.append(repeat)
            for row in rows:
                cells = table.add_row().cells
                for cell, text in zip(cells, row):
                    parts = text.split("\n") if text else [""]
                    cell.text = parts[0]
                    for extra in parts[1:]:
                        cell.add_paragraph(extra)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


# --------------------------------------------------------------------------
# PDF
# --------------------------------------------------------------------------
_FONTS_READY = False


def _fonts() -> None:
    global _FONTS_READY
    if _FONTS_READY:
        return
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    pdfmetrics.registerFont(TTFont("DejaVu", str(FONT_DIR / "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(FONT_DIR / "DejaVuSans-Bold.ttf")))
    pdfmetrics.registerFontFamily("DejaVu", normal="DejaVu", bold="DejaVu-Bold", italic="DejaVu", boldItalic="DejaVu-Bold")
    _FONTS_READY = True


def _p(text: str) -> str:
    """Text as ReportLab Paragraph markup: escaped, so nothing in it is markup, with line breaks kept."""
    return escape(text).replace("\n", "<br/>")


def to_pdf(draft: dict) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, TableStyle

    _fonts()
    base = ParagraphStyle("base", fontName="DejaVu", fontSize=9.5, leading=12.5)
    styles = {
        "title": ParagraphStyle("title", parent=base, fontName="DejaVu-Bold", fontSize=17, leading=21, spaceAfter=4),
        "marker": ParagraphStyle("marker", parent=base, fontName="DejaVu-Bold", textColor=colors.HexColor("#B03030"), spaceAfter=8),
        "heading": ParagraphStyle("heading", parent=base, fontName="DejaVu-Bold", fontSize=13, leading=16, spaceBefore=12, spaceAfter=4),
        "subheading": ParagraphStyle("subheading", parent=base, fontName="DejaVu-Bold", fontSize=11, leading=14, spaceBefore=8, spaceAfter=3),
        "label": ParagraphStyle("label", parent=base, fontName="DejaVu-Bold", spaceBefore=4),
        "para": base,
        "bullet": ParagraphStyle("bullet", parent=base, leftIndent=10, bulletIndent=0),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8, leading=10),
        "cellhead": ParagraphStyle("cellhead", parent=base, fontName="DejaVu-Bold", fontSize=8, leading=10),
    }

    def stamp(canvas, document):
        canvas.saveState()
        canvas.setFont("DejaVu-Bold", 8)
        canvas.setFillColor(colors.HexColor("#B03030"))
        canvas.drawString(15 * mm, A4[1] - 10 * mm, MARKER)  # on every page
        canvas.restoreState()

    story = []
    width = A4[0] - 30 * mm
    for block in plan(draft):
        kind = block[0]
        if kind == "table":
            head, rows = block[1], block[2]
            cols = len(rows[0]) if rows else len(head)
            data = []
            if any(head):
                data.append([Paragraph(_p(t), styles["cellhead"]) for t in head])
            for row in rows:
                # A long value continues on further rows under the same column, never in one giant cell.
                split = [_pieces(t) if t else [""] for t in row]
                for i in range(max(len(p) for p in split)):
                    data.append([Paragraph(_p(p[i]) if i < len(p) else "", styles["cell"]) for p in split])
            widths = [width / cols] * cols if cols != 6 else [w * width for w in (0.2, 0.11, 0.22, 0.27, 0.08, 0.12)]
            table = LongTable(data, colWidths=widths, repeatRows=1 if any(head) else 0)
            table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
            story += [table, Spacer(1, 4)]
        elif kind in ("para",):
            story += [Paragraph(_p(piece), styles["para"]) for piece in _pieces(block[1])]
        elif kind == "bullet":
            story += [Paragraph(_p(piece), styles["bullet"], bulletText="•" if i == 0 else None)
                      for i, piece in enumerate(_pieces(block[1]))]
        else:
            story.append(Paragraph(_p(block[1]), styles[kind]))

    out = io.BytesIO()
    SimpleDocTemplate(out, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=16 * mm, bottomMargin=14 * mm,
                      title=clean(draft.get("title")) or "Coverage report").build(story, onFirstPage=stamp, onLaterPages=stamp)
    return out.getvalue()


def export(draft: dict, fmt: str) -> tuple[bytes, str]:
    """The file's bytes and content type."""
    if fmt == "docx":
        return to_docx(draft), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if fmt == "pdf":
        return to_pdf(draft), "application/pdf"
    raise ValueError(f"unknown format {fmt!r}")
