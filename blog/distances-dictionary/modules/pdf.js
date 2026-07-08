// Client-side PDF ingest via pdf.js (pdfjs-dist ESM from CDN, lazy-loaded).
// Produces full text with running char offsets and per-item geometry so the
// linker can place links precisely and the (experimental) annotator can map
// matched spans back to page rectangles. No backend; math fidelity is limited
// (use the optional Mathpix path for equation-heavy PDFs).

const PDFJS_VERSION = "4.10.38";
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ PDFJS_URL).then((mod) => {
      const lib = mod.default || mod;
      try { lib.GlobalWorkerOptions.workerSrc = WORKER_URL; } catch (_) { /* ignore */ }
      return lib;
    });
  }
  return pdfjsPromise;
}

/**
 * Extract structured text from a PDF File/Blob/ArrayBuffer.
 * @returns {Promise<{ fullText:string, numPages:number, pages:Array<{
 *   page:number, text:string, width:number, height:number,
 *   items:Array<{ str:string, page:number, x:number, y:number, w:number, h:number, start:number, end:number }> }> }>}
 */
export async function extractDocument(input, onProgress = () => {}) {
  const pdfjs = await loadPdfjs();
  const src = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  // pdf.js transfers the buffer to its worker (detaching it), so hand it a fresh
  // COPY — this leaves the caller's original bytes intact for the annotated-PDF
  // export (pdf-lib would otherwise throw "detached ArrayBuffer").
  const doc = await pdfjs.getDocument({ data: new Uint8Array(src.slice(0)) }).promise;
  const pages = [];
  let fullText = "";

  for (let p = 1; p <= doc.numPages; p++) {
    onProgress({ stage: "parse", page: p, total: doc.numPages });
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const base = fullText.length; // global offset where this page's text begins
    const items = [];
    let pageText = "";
    let lastY = null;

    for (const it of content.items) {
      const str = it.str || "";
      const tr = it.transform || [1, 0, 0, 1, 0, 0];
      const x = tr[4];
      const y = tr[5];
      const h = it.height || Math.hypot(tr[2], tr[3]) || 10;
      const w = it.width || (str.length * h * 0.5);

      // Insert a newline when the baseline jumps to a new line.
      if (lastY !== null && Math.abs(y - lastY) > h * 0.6 && !pageText.endsWith("\n")) {
        pageText += "\n";
      }
      const startLocal = pageText.length;
      pageText += str;
      const endLocal = pageText.length;
      pageText += it.hasEOL ? "\n" : " ";

      items.push({ str, page: p, x, y, w, h, start: base + startLocal, end: base + endLocal });
      lastY = y;
    }

    fullText += pageText + "\n\n";
    pages.push({ page: p, text: pageText, width: viewport.width, height: viewport.height, items });
  }

  return { fullText, numPages: doc.numPages, pages };
}

/**
 * Render a page to an image data URL.
 * The 3rd arg is either a number (scale — legacy, renders PNG at that scale) or an
 * options object `{ scale, type, quality, maxDim }`. The vision (equation) pass
 * defaults to downscaled JPEG so base64 payloads stay within free-tier size
 * limits; a bare number preserves the old PNG behavior for existing callers.
 */
export async function renderPageImage(input, pageNumber = 1, opts = {}) {
  const legacyScale = typeof opts === "number";
  const scale = legacyScale ? opts : (opts.scale ?? 1.75);
  const type = legacyScale ? "image/png" : (opts.type || "image/jpeg");
  const quality = legacyScale ? undefined : (opts.quality ?? 0.8);
  const maxDim = legacyScale ? Infinity : (opts.maxDim ?? 1600);

  const pdfjs = await loadPdfjs();
  const src = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  // Copy so repeated calls (one render per page) don't detach the buffer.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(src.slice(0)) }).promise;
  const page = await doc.getPage(pageNumber);

  // If the long edge would exceed maxDim, reduce the scale so it fits.
  let s = scale;
  const base = page.getViewport({ scale: 1 });
  const longEdge = Math.max(base.width, base.height) * scale;
  if (longEdge > maxDim) s = scale * (maxDim / longEdge);

  const viewport = page.getViewport({ scale: s });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL(type, quality);
}
