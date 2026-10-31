"""Brand watermark viewer and PDF template for R.M. Digital Centre."""
from __future__ import annotations

import base64
from html import escape
from io import BytesIO
from typing import Sequence

BRAND_NAME = "R.M. Digital Centre"
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# Tiled, rotated, semi-transparent text drawn as an SVG background so it covers the whole document.
_WATERMARK_SVG = (
    "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'>"
    "<text x='160' y='100' text-anchor='middle' transform='rotate(-30 160 100)' "
    "font-family='Arial,sans-serif' font-size='22' font-weight='bold' "
    "fill='%230f172a' fill-opacity='0.22'>" + BRAND_NAME + "</text></svg>"
)
_WATERMARK_URL = "data:image/svg+xml;utf8," + _WATERMARK_SVG.replace("<", "%3C").replace(">", "%3E").replace("#", "%23")

VIEWER_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"


def is_watermarkable(content_type: str) -> bool:
    return content_type in IMAGE_TYPES


def watermark_viewer_html(contents: bytes, content_type: str, filename: str) -> bytes:
    """Wrap an image in a viewer page with a non-interactive watermark overlay."""
    encoded = base64.b64encode(contents).decode("ascii")
    page = (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>" + escape(filename) + " - " + BRAND_NAME + "</title><style>"
        "html,body{margin:0;background:#e2e8f0}"
        ".doc{position:relative;display:inline-block;max-width:100%;user-select:none;-webkit-user-select:none}"
        ".doc img{display:block;max-width:100%;height:auto;-webkit-user-drag:none}"
        ".wm{position:absolute;inset:0;pointer-events:none;z-index:2147483647;"
        "background:url(\"" + _WATERMARK_URL + "\") repeat}"
        "</style></head><body oncontextmenu='return false'>"
        "<div class='doc'><img alt='" + escape(filename, quote=True) + "' src='data:" + content_type + ";base64," + encoded + "'>"
        "<div class='wm' aria-hidden='true'></div></div></body></html>"
    )
    return page.encode("utf-8")


def build_pdf(
    title: str,
    sections: Sequence[tuple[str, Sequence[Sequence[str]]]],
    reference: str = "",
) -> bytes:
    """Render a branded PDF. Each section is (heading, rows); the first row is the table header."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    navy = colors.HexColor("#0f172a")

    def decorate(canvas, doc):
        width, height = A4
        canvas.saveState()
        canvas.setFillColor(navy)
        canvas.rect(0, height - 22 * mm, width, 22 * mm, stroke=0, fill=1)
        canvas.setFillColor(colors.white)
        canvas.setFont("Helvetica-Bold", 16)
        canvas.drawString(15 * mm, height - 13 * mm, BRAND_NAME)
        canvas.setFont("Helvetica", 9)
        canvas.drawRightString(width - 15 * mm, height - 13 * mm, "Financial and digital services")
        canvas.setFillColor(colors.HexColor("#64748b"))
        canvas.drawString(15 * mm, 8 * mm, BRAND_NAME + " - Confidential")
        canvas.drawRightString(width - 15 * mm, 8 * mm, "Page %d" % doc.page)
        canvas.setFillColor(navy, alpha=0.08)
        canvas.setFont("Helvetica-Bold", 56)
        canvas.translate(width / 2, height / 2)
        canvas.rotate(35)
        canvas.drawCentredString(0, 0, BRAND_NAME)
        canvas.restoreState()

    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, topMargin=30 * mm, bottomMargin=18 * mm,
                            leftMargin=15 * mm, rightMargin=15 * mm, title=title, author=BRAND_NAME)
    styles = getSampleStyleSheet()
    story = [Paragraph(escape(title), styles["Title"])]
    if reference:
        story.append(Paragraph("Reference: " + escape(reference), styles["Normal"]))
    story.append(Spacer(1, 6 * mm))
    for heading, rows in sections:
        story.append(Paragraph(escape(heading), styles["Heading2"]))
        if rows:
            cells = [[Paragraph(escape(str(cell)), styles["BodyText"]) for cell in row] for row in rows]
            table = Table(cells, repeatRows=1)
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#94a3b8")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
            ]))
            story.append(table)
        story.append(Spacer(1, 5 * mm))
    doc.build(story, onFirstPage=decorate, onLaterPages=decorate)
    return buffer.getvalue()
