// Vision equation pass (Approach B): a vision-capable model transcribes each PDF
// page's math into LaTeX, which is then folded into the page's prose so the
// existing text detect/link pass (linker.js) can match formula-defined measures.
//
// pdf.js drops equation glyphs, so without this a formula-only measure is
// invisible. Everything stays client-side and BYOK: images go to the user's own
// provider (OpenRouter / Hugging Face — the only ones wired for image input).
//
// Model-agnostic: the user picks any vision model in AI settings; a per-page
// failure is non-fatal (recorded and skipped), so lexical + text results survive.

import { renderPageImage } from "./pdf.js";
import { callJSON, beginRun, endRun, pastDeadline } from "./llm.js";

// The global request pacer in llm.js spaces ALL calls (pages, text chunks, retries) to
// stay under the free-tier RPM, so no per-page gap is needed here. A failed-page sweep
// after the main loop rides out transient 503 "high demand" spikes.
const SWEEP_WAIT_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OCR_SYSTEM =
  "You are given an IMAGE of ONE page from an academic paper and its PAGE NUMBER. " +
  "Transcribe ALL mathematical content (displayed and inline) into LaTeX, preserving " +
  "the paper's equation labels such as (1), (6). Do not solve or explain anything. " +
  "For EACH equation also give its bounding box on the image as [x0,y0,x1,y1] in " +
  "FRACTIONS of the image size (0=left/top, 1=right/bottom), where (x0,y0) is the " +
  "top-left corner and (x1,y1) the bottom-right; use null if you cannot locate it. " +
  "Return ONLY a single JSON object, no prose, no markdown fences: " +
  "{\"page\":<PAGE_NUMBER>,\"equations\":[{\"eq_number\":\"<label or null>\",\"latex\":\"<LaTeX>\",\"bbox\":[x0,y0,x1,y1]}]}. " +
  "Rules: ESCAPE every backslash: write \"\\\\ln\", \"\\\\Gamma\", \"\\\\sum\", never \"\\ln\". " +
  "bbox values are numbers between 0 and 1. Transcribe faithfully; if unsure of a symbol, " +
  "give your best guess and continue. " +
  "If there is no math on the page, return {\"page\":<PAGE_NUMBER>,\"equations\":[]}.";

/** Validate a model-returned bbox → [x0,y0,x1,y1] in [0,1] with x1>x0,y1>y0, else null. */
function cleanBbox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  let [x0, y0, x1, y1] = b.map(Number);
  if (![x0, y0, x1, y1].every((n) => Number.isFinite(n))) return null;
  // tolerate swapped corners
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  const clamp = (n) => Math.min(1, Math.max(0, n));
  [x0, y0, x1, y1] = [clamp(x0), clamp(y0), clamp(x1), clamp(y1)];
  if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return null; // degenerate
  return [x0, y0, x1, y1];
}

/** OCR one already-rendered image (data URL) → {page, equations, error?}. Never throws. */
async function _ocrDataUrl(dataUrl, pageNumber) {
  try {
    const res = await callJSON({ system: OCR_SYSTEM, user: `PAGE_NUMBER: ${pageNumber}`, images: [dataUrl], maxTokens: 2000, temperature: 0 });
    const equations = (res && Array.isArray(res.equations) ? res.equations : [])
      .filter((e) => e && typeof e.latex === "string" && e.latex.trim())
      .map((e) => ({ eq_number: e.eq_number || null, latex: e.latex.trim(), bbox: cleanBbox(e.bbox) }));
    return { page: pageNumber, equations };
  } catch (e) {
    return { page: pageNumber, equations: [], error: String(e && e.message ? e.message : e) };
  }
}

/**
 * Give pages/images that errored in the main loop (typically transient 503 "high
 * demand" spikes that survived the in-call backoff) ONE more attempt after a pause,
 * replacing each result in place. Non-fatal: a still-failing entry keeps its error so
 * the UI still lists genuinely unreadable pages. No-op (and no wait) when nothing failed.
 * @param {Array} out       results array (mutated in place)
 * @param {(pageNum:number)=>Promise<object>} attempt  re-run one item by 1-based page number
 */
async function sweepFailed(out, attempt, onProgress) {
  if (pastDeadline()) return;                        // out of run budget — don't start a sweep
  const failed = out.map((o, idx) => ({ o, idx })).filter((x) => x.o && x.o.error);
  if (!failed.length) return;
  // Mass overload: if most failures are 503-ish, a retry seconds later won't help — skip
  // the whole sweep instead of running a second long cycle (this is the 10-min-hang case).
  const overloaded = failed.filter((x) => /503|high demand|overload|unavailable/i.test(x.o.error || ""));
  if (overloaded.length >= Math.ceil(failed.length * 0.6)) return;

  onProgress({ stage: "ocr", retry: true, page: 0, total: failed.length });
  await sleep(SWEEP_WAIT_MS);
  let done = 0;
  await Promise.all(failed.map(({ o, idx }) =>
    attempt(o.page).then((r) => { out[idx] = r; onProgress({ stage: "ocr", retry: true, page: ++done, total: failed.length }); })
  ));
}

/**
 * OCR the first `maxPages` pages of a PDF into LaTeX equations, one model call per
 * page. Never throws for a single page — errors are captured per page so the
 * caller can keep going.
 * @returns {Promise<Array<{page:number, equations:Array<{eq_number:?string, latex:string}>, error?:string}>>}
 */
export async function ocrPagesToLatex({ bytes, numPages, maxPages = 15, onProgress = () => {} }) {
  const n = Math.min(numPages, maxPages);
  // Render + OCR one page (by 1-based number). Never throws — used by the main loop and
  // the failed-page sweep alike.
  const attemptPage = async (p) => {
    let img;
    try {
      img = await renderPageImage(bytes, p, { type: "image/jpeg", quality: 0.8, scale: 1.75, maxDim: 1600 });
    } catch (e) {
      return { page: p, equations: [], error: `render failed: ${e && e.message ? e.message : e}` };
    }
    return _ocrDataUrl(img, p);
  };

  // Fire pages concurrently; the pacer's pool throttles how many actually run at once
  // (serial on free, up to ~5 on paid). Promise.all preserves order, so out[i] is page i+1.
  // beginRun sets a hard budget so a persistently-503 model can't hang the run for minutes.
  beginRun(75000);
  try {
    let done = 0;
    const out = await Promise.all(
      Array.from({ length: n }, (_, i) => i + 1).map((p) =>
        attemptPage(p).then((r) => { onProgress({ stage: "ocr", page: ++done, total: n }); return r; })
      )
    );
    await sweepFailed(out, attemptPage, onProgress);
    return out;
  } finally {
    endRun();
  }
}

/**
 * OCR already-rendered images (user-uploaded pictures) into LaTeX equations — one
 * model call per image, each treated as its own "page". Capped at `maxPages` for
 * cost. Same return shape as ocrPagesToLatex, so augmentText/rendering are unchanged.
 */
export async function ocrImagesToLatex({ images, maxPages = 15, onProgress = () => {} }) {
  const list = (images || []).slice(0, maxPages);
  const attemptImage = (pageNum) => _ocrDataUrl(list[pageNum - 1], pageNum);
  beginRun(75000);
  try {
    let done = 0;
    const out = await Promise.all(
      list.map((_, i) => attemptImage(i + 1).then((r) => { onProgress({ stage: "ocr", page: ++done, total: list.length }); return r; }))
    );
    await sweepFailed(out, attemptImage, onProgress);
    return out;
  } finally {
    endRun();
  }
}

/**
 * Interleave each page's transcribed equations after that page's prose, so the
 * text pass sees them in local context. Because injecting text shifts later
 * pages' offsets (but pdf.js item geometry is in ORIGINAL-fullText coordinates),
 * we also return `toOriginalOffset`, which maps an augmented offset back to the
 * original for prose regions and returns null for injected equation regions.
 * The annotator uses it to keep highlights aligned; the reading view uses the
 * augmented text directly (so equations appear inline). `equationSpans` records the
 * augmented-text offset range of each injected equation + its bbox, so an equation
 * can be associated to a linked card by offset overlap (robust) and boxed on the PDF.
 * @returns {{ fullText:string, pageMap:Array, toOriginalOffset:(a:number)=>?number, hasEquations:boolean, equationSpans:Array }}
 */
export function augmentText(pdfPages, ocrPages) {
  const byPage = new Map((ocrPages || []).map((o) => [o.page, o.equations || []]));
  let aug = "";
  let origCursor = 0; // mirrors extractDocument: fullText += pageText + "\n\n"
  const pageMap = [];
  const equationSpans = [];
  let hasEquations = false;

  for (const pg of pdfPages) {
    const augProseStart = aug.length;
    aug += pg.text;
    pageMap.push({ page: pg.page, augProseStart, origProseStart: origCursor, proseLen: pg.text.length });
    origCursor += pg.text.length + 2; // the "\n\n" the original inserts between pages

    const eqs = byPage.get(pg.page) || [];
    if (eqs.length) {
      hasEquations = true;
      aug += `\n\n[[EQUATIONS p${pg.page}]]\n`;
      eqs.forEach((e, idx) => {
        aug += (e.eq_number ? e.eq_number + " " : "") + "$";
        const augStart = aug.length;
        aug += e.latex;
        const augEnd = aug.length;
        aug += "$";
        if (idx < eqs.length - 1) aug += "\n";
        equationSpans.push({ page: pg.page, augStart, augEnd, bbox: e.bbox || null, eq_number: e.eq_number || null, latex: e.latex });
      });
    }
    aug += "\n\n";
  }

  const toOriginalOffset = (a) => {
    for (const m of pageMap) {
      if (a >= m.augProseStart && a <= m.augProseStart + m.proseLen) {
        return m.origProseStart + (a - m.augProseStart);
      }
    }
    return null; // injected equation block or trailing separators — no geometry
  };

  return { fullText: aug, pageMap, toOriginalOffset, hasEquations, equationSpans };
}

/**
 * Translate matched mentions from augmented-text coordinates back to the
 * original-fullText coordinates the annotator expects. Mentions whose span falls
 * in an injected equation region (no pdf.js geometry) are dropped.
 */
export function toOriginalMentions(mentions, toOriginalOffset) {
  const out = [];
  for (const m of mentions) {
    const start = toOriginalOffset(m.start);
    const end = toOriginalOffset(m.end);
    if (start == null || end == null || end <= start) continue;
    out.push({ ...m, start, end });
  }
  return out;
}
