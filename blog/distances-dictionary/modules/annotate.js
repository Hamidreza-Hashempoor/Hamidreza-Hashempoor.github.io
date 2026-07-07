// Add a translucent HIGHLIGHT plus a clickable LINK to the original PDF at each
// matched measure, pointing to its dictionary permalink. Uses pdf-lib in the
// browser. Coordinate mapping is approximate (pdf.js text geometry → PDF user
// space), so this is best-effort — the HTML reading view is the primary output.
// Only usable on the pdf.js text path (Mathpix text has no geometry).
//
// pdf-lib is imported lazily (inside annotatePdf) so the dictionary never pays
// the CDN cost unless a user actually exports an annotated PDF.

const PDFLIB_URL = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.js";
let pdflibPromise = null;
function loadPdfLib() {
  if (!pdflibPromise) pdflibPromise = import(/* @vite-ignore */ PDFLIB_URL);
  return pdflibPromise;
}

function permalink(id) {
  const base = location.href.split("#")[0];
  return `${base}#/m/${id}`;
}

/**
 * @param {ArrayBuffer} bytes   original PDF bytes
 * @param {Array} pages         pdf.js pages from extractDocument (items carry start/end + x/y/w/h)
 * @param {Array} mentions      matched mentions (with id + global start/end)
 * @returns {Promise<Uint8Array>} annotated PDF bytes
 */
export async function annotatePdf(bytes, pages, mentions) {
  const { PDFDocument, PDFName, PDFString, rgb } = await loadPdfLib();
  // Load from a copy: guards against a detached buffer if the same bytes were
  // handed to pdf.js earlier (which transfers the buffer to its worker).
  const doc = await PDFDocument.load(bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes);
  const pdfPages = doc.getPages();
  const perPage = new Map(); // pageNum -> [{rect,url}]
  const seen = new Set();    // dedupe identical rects
  const MAX_PER_PAGE = 400;

  // One rect PER overlapping text item (tight, per-word highlights that also
  // handle a name split across lines), rather than one big merged box.
  for (const m of mentions) {
    if (!m.id) continue;
    const url = permalink(m.id);
    for (const pg of pages) {
      const arr = perPage.get(pg.page) || [];
      for (const it of pg.items) {
        if (!(it.start < m.end && it.end > m.start)) continue;
        const x1 = it.x, y1 = it.y, x2 = it.x + it.w, y2 = it.y + it.h;
        if (!(x2 > x1 && y2 > y1)) continue; // skip degenerate geometry
        const key = `${pg.page}:${Math.round(x1)}:${Math.round(y1)}:${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (arr.length >= MAX_PER_PAGE) break;
        arr.push({ rect: [x1, y1, x2, y2], url });
      }
      if (arr.length) perPage.set(pg.page, arr);
    }
  }

  for (const [pageNum, annots] of perPage) {
    const page = pdfPages[pageNum - 1];
    if (!page) continue;
    const refs = [];
    for (const a of annots) {
      const [x1, y1, x2, y2] = a.rect;
      const h = y2 - y1;
      const pad = h * 0.18; // extend a touch below the baseline / above cap height
      // (a) Visible translucent highlight (drawn over the text, highlighter-style).
      page.drawRectangle({
        x: x1,
        y: y1 - pad,
        width: x2 - x1,
        height: h + 2 * pad,
        color: rgb(1, 0.92, 0.23),
        opacity: 0.33,
      });
      // (b) Clickable link to the measure's dictionary card, on the same span.
      refs.push(
        doc.context.register(
          doc.context.obj({
            Type: "Annot",
            Subtype: "Link",
            Rect: [x1, y1 - pad, x2, y2 + pad],
            Border: [0, 0, 0],
            A: doc.context.obj({ Type: "Action", S: "URI", URI: PDFString.of(a.url) }),
          })
        )
      );
    }
    page.node.set(PDFName.of("Annots"), doc.context.obj(refs));
  }

  return doc.save();
}
