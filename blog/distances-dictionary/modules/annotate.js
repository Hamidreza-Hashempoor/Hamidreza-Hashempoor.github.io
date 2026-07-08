// Add translucent HIGHLIGHTS plus clickable LINKs to a PDF at each detected
// measure, pointing to its dictionary permalink. Two sources of geometry:
//   1. text-named measures → pdf.js text-item rectangles (from extractDocument);
//   2. equation measures    → normalized bounding boxes from the vision model,
//      mapped into PDF user space (best-effort; the model estimates the box).
// Also builds an annotated PDF from uploaded images (each image = one page).
//
// Coordinate mapping is approximate, so this is best-effort — the on-screen
// reading view / Equations section stay the reliable outputs. pdf-lib is imported
// lazily so the dictionary never pays the CDN cost unless a PDF is exported.

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

const HIGHLIGHT_EXACT = [1, 0.92, 0.23];   // yellow — exact match
const HIGHLIGHT_VARIANT = [0.55, 0.78, 1];  // blue — variant (related card)

/** Normalized bbox [x0,y0,x1,y1] (top-left origin, 0..1) → PDF rect [x1,y1,x2,y2] (bottom-left origin). */
function bboxToRect(bbox, width, height) {
  const [x0, y0, x1, y1] = bbox;
  return [x0 * width, height - y1 * height, x1 * width, height - y0 * height];
}

/** Draw a translucent highlight over a rect (optionally padded vertically). */
function drawHighlight(page, rgb, rect, pad = 0, color = HIGHLIGHT_EXACT) {
  const [x1, y1, x2, y2] = rect;
  page.drawRectangle({ x: x1, y: y1 - pad, width: x2 - x1, height: (y2 - y1) + 2 * pad, color: rgb(...color), opacity: 0.33 });
}

/** Build a URI Link annotation ref over a rect. */
function linkRef(doc, PDFString, rect, url, pad = 0) {
  const [x1, y1, x2, y2] = rect;
  return doc.context.register(doc.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [x1, y1 - pad, x2, y2 + pad], Border: [0, 0, 0],
    A: doc.context.obj({ Type: "Action", S: "URI", URI: PDFString.of(url) }),
  }));
}

/** Build a sticky-note (text) annotation at the box's top-right corner. */
function noteAnnot(doc, PDFString, rect, text) {
  const [, , x2, y2] = rect;
  return doc.context.register(doc.context.obj({
    Type: "Annot", Subtype: "Text", Name: "Comment", Open: false,
    Rect: [x2 - 12, y2 - 12, x2 + 12, y2 + 12],
    Contents: PDFString.of(String(text || "")),
  }));
}

/**
 * Annotate an existing PDF.
 * @param {ArrayBuffer} bytes  original PDF bytes
 * @param {Array} pages        pdf.js pages (items carry start/end + x/y/w/h) for text highlights
 * @param {Array} mentions     matched text mentions (id + global start/end)
 * @param {Array} boxes        equation boxes [{page, bbox:[x0,y0,x1,y1], id|null}]
 * @returns {Promise<Uint8Array>}
 */
export async function annotatePdf(bytes, pages, mentions, boxes = []) {
  const { PDFDocument, PDFName, PDFString, rgb } = await loadPdfLib();
  // Load from a copy: guards against a detached buffer if the same bytes were
  // handed to pdf.js earlier (which transfers the buffer to its worker).
  const doc = await PDFDocument.load(bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes);
  const pdfPages = doc.getPages();

  const perPage = new Map(); // pageNum -> [{rect, url, pad, variant, note}]
  const add = (pageNum, rect, url, pad, variant, note) => {
    const arr = perPage.get(pageNum) || [];
    arr.push({ rect, url, pad, variant, note });
    perPage.set(pageNum, arr);
  };

  // (1) Text-named measures: one rect per overlapping pdf.js text item (tight,
  // per-word highlights that also handle a name split across lines).
  const seen = new Set();
  const MAX_PER_PAGE = 400;
  for (const m of mentions || []) {
    if (!m.id) continue;
    const url = permalink(m.id);
    for (const pg of pages || []) {
      for (const it of pg.items) {
        if (!(it.start < m.end && it.end > m.start)) continue;
        const x1 = it.x, y1 = it.y, x2 = it.x + it.w, y2 = it.y + it.h;
        if (!(x2 > x1 && y2 > y1)) continue; // skip degenerate geometry
        const key = `${pg.page}:${Math.round(x1)}:${Math.round(y1)}:${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cur = perPage.get(pg.page);
        if (cur && cur.length >= MAX_PER_PAGE) break;
        add(pg.page, [x1, y1, x2, y2], url, (y2 - y1) * 0.18, false);
      }
    }
  }

  // (2) Equation measures: normalized bbox → PDF user space (y-flipped). Variants
  // (a related card, not an exact id) get a distinct color.
  for (const b of boxes || []) {
    const page = pdfPages[b.page - 1];
    if (!page || !b.bbox) continue;
    const { width, height } = page.getSize();
    add(b.page, bboxToRect(b.bbox, width, height), b.id ? permalink(b.id) : null, 0, !!b.variant, b.note);
  }

  for (const [pageNum, entries] of perPage) {
    const page = pdfPages[pageNum - 1];
    if (!page) continue;
    const refs = [];
    for (const e of entries) {
      drawHighlight(page, rgb, e.rect, e.pad, e.variant ? HIGHLIGHT_VARIANT : HIGHLIGHT_EXACT);
      if (e.url) refs.push(linkRef(doc, PDFString, e.rect, e.url, e.pad));
      if (e.note) refs.push(noteAnnot(doc, PDFString, e.rect, e.note));
    }
    if (refs.length) page.node.set(PDFName.of("Annots"), doc.context.obj(refs));
  }

  return doc.save();
}

/**
 * Build an annotated PDF from uploaded images — one page per image, sized to it,
 * with equation highlights + card links drawn on top.
 * @param {Array} images  [{ dataUrl, width, height }] (dataUrl should be JPEG or PNG)
 * @param {Array} boxes   equation boxes [{page, bbox, id|null}] where page is the 1-based image index
 * @returns {Promise<Uint8Array>}
 */
export async function annotateImagesToPdf(images, boxes = []) {
  const { PDFDocument, PDFName, PDFString, rgb } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const pageForIndex = [];
  for (const im of images || []) {
    const embedded = /^data:image\/png/i.test(im.dataUrl) ? await doc.embedPng(im.dataUrl) : await doc.embedJpg(im.dataUrl);
    const w = im.width || embedded.width;
    const h = im.height || embedded.height;
    const page = doc.addPage([w, h]);
    page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
    pageForIndex.push(page);
  }

  const perPage = new Map(); // 1-based image index -> [{rect, url, variant}]
  for (const b of boxes || []) {
    const page = pageForIndex[b.page - 1];
    if (!page || !b.bbox) continue;
    const { width, height } = page.getSize();
    const arr = perPage.get(b.page) || [];
    arr.push({ rect: bboxToRect(b.bbox, width, height), url: b.id ? permalink(b.id) : null, variant: !!b.variant, note: b.note });
    perPage.set(b.page, arr);
  }
  for (const [idx, entries] of perPage) {
    const page = pageForIndex[idx - 1];
    const refs = [];
    for (const e of entries) {
      drawHighlight(page, rgb, e.rect, 0, e.variant ? HIGHLIGHT_VARIANT : HIGHLIGHT_EXACT);
      if (e.url) refs.push(linkRef(doc, PDFString, e.rect, e.url, 0));
      if (e.note) refs.push(noteAnnot(doc, PDFString, e.rect, e.note));
    }
    if (refs.length) page.node.set(PDFName.of("Annots"), doc.context.obj(refs));
  }

  return doc.save();
}
