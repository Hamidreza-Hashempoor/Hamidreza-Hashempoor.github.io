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
  const doc = await PDFDocument.load(bytes);
  const pdfPages = doc.getPages();
  const perPage = new Map(); // pageNum -> [{rect,url}]

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
      const arr = perPage.get(pg.page) || [];
      arr.push({ rect: [x1, y1, x2, y2], url: permalink(m.id) });
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
