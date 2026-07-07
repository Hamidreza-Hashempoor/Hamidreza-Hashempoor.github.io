// Optional, experimental: add clickable link annotations to the original PDF at
// each matched measure, pointing to its dictionary permalink. Uses pdf-lib in
// the browser. Coordinate mapping is approximate (pdf.js text geometry → PDF
// user space), so this is fragile — the HTML reading view is the primary output.
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
  const { PDFDocument, PDFName, PDFString } = await loadPdfLib();
  // Load from a copy: guards against a detached buffer if the same bytes were
  // handed to pdf.js earlier (which transfers the buffer to its worker).
  const doc = await PDFDocument.load(bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes);
  const pdfPages = doc.getPages();
  const perPage = new Map(); // pageNum -> [{rect,url}]
  const seen = new Set();    // dedupe identical link rects
  const MAX_PER_PAGE = 300;

  for (const m of mentions) {
    if (!m.id) continue;
    for (const pg of pages) {
      const hits = pg.items.filter((it) => it.start < m.end && it.end > m.start);
      if (!hits.length) continue;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const it of hits) {
        x1 = Math.min(x1, it.x);
        y1 = Math.min(y1, it.y);
        x2 = Math.max(x2, it.x + it.w);
        y2 = Math.max(y2, it.y + it.h);
      }
      const url = permalink(m.id);
      const key = `${pg.page}:${Math.round(x1)}:${Math.round(y1)}:${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const arr = perPage.get(pg.page) || [];
      if (arr.length >= MAX_PER_PAGE) continue;
      arr.push({ rect: [x1, y1, x2, y2], url });
      perPage.set(pg.page, arr);
    }
  }

  for (const [pageNum, annots] of perPage) {
    const page = pdfPages[pageNum - 1];
    if (!page) continue;
    const refs = annots.map((a) =>
      doc.context.register(
        doc.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: a.rect,
          Border: [0, 0, 0],
          A: doc.context.obj({ Type: "Action", S: "URI", URI: PDFString.of(a.url) }),
        })
      )
    );
    page.node.set(PDFName.of("Annots"), doc.context.obj(refs));
  }

  return doc.save();
}
