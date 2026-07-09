// The "#/linker" page: PDF/text -> BYOK LLM detect+link -> linkified reading
// view + detected-measures (with audited code) + unmatched (draft new entry).
// Everything runs client-side; the LLM is the user's own provider (llm.js).

import { el, escapeHTML } from "./util.js";
import { renderProviderSettings, callJSON, hasFullCreds, providerSupportsImages } from "./llm.js";
import { extractDocument } from "./pdf.js";
import { detectAndLink, draftEntry } from "./linker.js";
import { verifyDraft } from "./verify.js";
import { ocrPagesToLatex, ocrImagesToLatex, augmentText, toOriginalMentions } from "./vision.js";
import { annotatePdf, annotateImagesToPdf } from "./annotate.js";
import { newCardIssueUrl } from "./config.js";
import { renderCodePanel } from "./codegen.js";
import { typeset } from "./mathjax.js";

// 4000 (was 2000) so the detect JSON has room now that every LINKED mention carries a
// mandatory note; prevents the truncation that showed up as "Model did not return valid
// JSON". Shared with draftEntry, which only benefits from the extra headroom.
const call = ({ system, user }) => callJSON({ system, user, maxTokens: 4000, temperature: 0 });

function contextAround(text, m, pad = 320) {
  return text.slice(Math.max(0, m.start - pad), Math.min(text.length, m.end + pad));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadJSON(obj, filename) {
  download(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }), filename || "draft-entry.json");
}

/** Read an uploaded image File into a data URL for the vision model. */
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("Could not read image."));
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Could not load image."));
    im.src = src;
  });
}

/**
 * Normalize an uploaded image to a downscaled JPEG data URL + pixel size. Doing
 * this (a) keeps the vision payload small and (b) guarantees a JPEG/PNG pdf-lib
 * can embed for the annotated-image export (webp/gif would otherwise fail).
 */
async function normalizeToJpeg(dataUrl, maxDim = 1600) {
  const im = await loadImage(dataUrl);
  let w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
  const long = Math.max(w, h) || 1;
  const s = long > maxDim ? maxDim / long : 1;
  w = Math.max(1, Math.round(w * s));
  h = Math.max(1, Math.round(h * s));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(im, 0, 0, w, h);
  return { dataUrl: c.toDataURL("image/jpeg", 0.85), width: w, height: h };
}

const isPdf = (f) => f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""));
const isImage = (f) => f && (/^image\//.test(f.type || "") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || ""));

// Human-readable phrase for each variant relation. Module-scoped so the equations list and
// the synthesized fallback note (eqFallbackNote) share one definition.
const relationPhrase = {
  reduces_to: "reduces to", generalization: "generalizes", special_case: "special case of",
  regularized: "regularized form of", bound: "bounds", variant: "variant of",
};

/** Display name for a card id, falling back to a prettified id when the card is missing. */
function cardLabel(db, id) {
  const c = db && db.byId && db.byId.get ? db.byId.get(id) : null;
  return (c && (c.canonical_name || c.name)) || String(id).replace(/_/g, " ");
}

/**
 * Synthesize a short, factual note for a LINKED equation when the model didn't return one,
 * so every boxed equation carries a sticky note. States only the relationship (card name +
 * relation) — no invented paper-specific detail. Grounded model notes are preferred upstream.
 */
function eqFallbackNote(db, m) {
  const id = m.id || m.related_id;
  const name = cardLabel(db, id);
  if (m.id) return `This equation is the ${name}.`;
  return `This equation relates to the ${name} (${relationPhrase[m.relation] || "variant"}).`;
}

/** Build the linkified reading-view HTML from full text + sorted mentions. */
function buildReadingHTML(text, mentions) {
  let html = "";
  let cursor = 0;
  for (const m of mentions) {
    if (m.start < cursor) continue;
    html += escapeHTML(text.slice(cursor, m.start));
    const surf = escapeHTML(text.slice(m.start, m.end));
    const cardId = m.id || m.related_id; // variants (related_id, no id) are links too
    if (cardId) {
      const isVariant = !m.id && !!m.related_id;
      const conf = Math.round(m.confidence * 100);
      const cls = "lk-hit" + (isVariant ? " variant" : "") + (m.needs_review ? " review" : "");
      const fallback = `${cardId}${isVariant ? " (" + (m.relation || "variant") + ")" : ""} · ${conf}%${m.needs_review ? " · review" : ""}`;
      const title = m.note ? `${m.note} — ${cardId}` : fallback;
      html += `<a class="${cls}" href="#/m/${cardId}" title="${escapeHTML(title)}">${surf}</a>`;
    } else {
      const g = m.canonical_guess ? escapeHTML(m.canonical_guess) : "possible new measure";
      html += `<mark class="lk-miss" title="${g} · not in dictionary">${surf}</mark>`;
    }
    cursor = m.end;
  }
  html += escapeHTML(text.slice(cursor));
  return html.replace(/\n/g, "<br>");
}

export function renderLinker(db) {
  const root = el("div", { class: "linker" });
  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  root.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, ["PDF → Dictionary Linker"]));
  root.appendChild(el("p", { class: "detail-lead" }, [
    "Upload a PDF or image(s) (or paste text) and your own AI provider will detect the distances/divergences it uses — ",
    "even under different names — and link each to a dictionary entry with audited code. Missing measures can be drafted for review.",
  ]));
  root.appendChild(el("p", { class: "muted" }, [
    "Runs entirely in your browser. Measures named in the dictionary are linked with no API key at all; ",
    "adding your own key (below) also detects measures that appear only as unnamed formulas. ",
    "For formula-defined measures, enable the equation reader (below the file picker): a vision-capable model ",
    "transcribes each page's math so equations can be linked too. Detection of unnamed formulas is the least ",
    "reliable step — low-confidence and unmatched items are flagged, never silently trusted.",
  ]));

  // Provider settings (shared component).
  const settings = renderProviderSettings();
  root.appendChild(settings);

  // Input controls.
  const fileInput = el("input", { type: "file", accept: "application/pdf,.pdf,image/*", multiple: "multiple", class: "lk-file" });
  const pasteArea = el("textarea", { class: "chat-question", rows: "5", placeholder: "…or paste text (e.g. an abstract or a methods section)" });
  const useVision = el("input", { type: "checkbox", id: "lk-use-vision" });
  const useVisionLabel = el("label", { for: "lk-use-vision", class: "chat-consent" }, [
    useVision,
    el("span", {}, [" Detect equations in a PDF with a vision model — sends each page image to your provider (your own account), one call per page. Requires a vision-capable model on OpenRouter or Hugging Face. (Uploaded images always use the vision reader.)"]),
  ]);
  const runBtn = el("button", { type: "button", class: "chat-btn primary" }, ["Detect & link"]);
  const progress = el("div", { class: "chat-status", "aria-live": "polite" });
  const output = el("div", { class: "lk-output" });

  // Holds the parsed pdf.js doc for the (experimental) annotated-PDF export.
  let pdfState = null; // { bytes, pages } when the pdf.js text path was used

  const setProgress = (t) => { progress.textContent = t || ""; };

  const renderResults = (text, res, usedLLM, extra = {}) => {
    const { toOriginal = null, ocrEquations = [], ocrErrors = [], showReading = true, equationSpans = [], images: annotatedImages = null } = extra;
    const usedVision = ocrEquations.length > 0 || ocrErrors.length > 0;
    output.innerHTML = "";
    // "Linked" = exact id OR variant related_id. textMentions (exact ids) carry pdf.js
    // text geometry; candidates are unlinked measure mentions in PROSE (not equations,
    // which are shown in their own section).
    const linkedMentions = res.mentions.filter((m) => m.id || m.related_id);
    const textMentions = res.mentions.filter((m) => m.id);
    const inEqSpan = (m) => equationSpans.some((s) => m.start < s.augEnd && m.end > s.augStart);
    const candidates = res.mentions.filter((m) => !m.id && !m.related_id && m.defines_measure !== false && !inEqSpan(m));

    // Equation highlight boxes for the annotated PDF: box ONLY equations that link to a
    // card (exact id or variant related_id), by offset overlap; variants get a color.
    const eqBoxes = [];
    for (const span of equationSpans) {
      if (!span.bbox) continue;
      const hit = res.mentions.find((m) => (m.id || m.related_id) && m.start < span.augEnd && m.end > span.augStart);
      if (!hit) continue; // unlinked equation → not boxed
      // Every linked (boxed) equation gets a sticky note: the model's grounded note when
      // present, else a synthesized fallback — so a highlighted equation is never noteless.
      eqBoxes.push({ page: span.page, bbox: span.bbox, id: hit.id || hit.related_id, variant: !hit.id && !!hit.related_id, note: hit.note || eqFallbackNote(db, hit) });
    }

    output.appendChild(el("p", { class: usedLLM ? "lk-mode ai" : "lk-mode light" }, [
      usedLLM
        ? (usedVision
            ? "AI mode — dictionary match + your LLM + vision equation reading"
            : "AI mode — dictionary match + your LLM (unnamed/formula detection)")
        : "Light mode — dictionary match only (no AI key)",
    ]));

    const dict = linkedMentions.filter((m) => m.source === "lexical").length;
    const ai = linkedMentions.length - dict;
    const srcParts = [];
    if (dict) srcParts.push(`${dict} from the dictionary`);
    if (ai) srcParts.push(`${ai} from AI`);
    const srcDetail = srcParts.length ? ` (${srcParts.join(", ")})` : "";
    const nVariant = linkedMentions.filter((m) => !m.id && m.related_id).length;
    const variantNote = nVariant ? `, ${nVariant} as variant${nVariant === 1 ? "" : "s"}` : "";
    const summary = el("p", { class: "lk-summary" }, [
      `${linkedMentions.length} linked mention${linkedMentions.length === 1 ? "" : "s"}${srcDetail}${variantNote}, ${candidates.length} unmatched.`,
    ]);
    if (res.dropped > 0) summary.appendChild(el("span", { class: "muted" }, [` (only the first ${res.chunks - res.dropped} of ${res.chunks} chunks scanned)`]));
    output.appendChild(summary);
    if (res.errors && res.errors.length) {
      output.appendChild(el("p", { class: "chat-error" }, [`Some chunks failed: ${res.errors[0]}`]));
    }
    if (ocrErrors.length) {
      output.appendChild(el("p", { class: "chat-error" }, [`Some pages' equations couldn't be read (${ocrErrors.length}): ${ocrErrors[0]}`]));
    }

    // Annotated-PDF export. For PDFs: text highlights (+ equation boxes when the
    // vision reader ran). For image uploads: a PDF built from the images with the
    // equation boxes drawn on. Each highlight links to its #/m/:id card.
    const canAnnotatePdf = pdfState && (textMentions.length || eqBoxes.length);
    const canAnnotateImages = annotatedImages && annotatedImages.length && eqBoxes.length;
    if (canAnnotatePdf || canAnnotateImages) {
      const annBtn = el("button", { type: "button", class: "chat-btn primary" }, ["Download annotated PDF"]);
      const annStatus = el("span", { class: "chat-status" });
      annBtn.addEventListener("click", async () => {
        annBtn.disabled = true;
        annStatus.textContent = "Annotating…";
        try {
          let bytes;
          if (pdfState) {
            // When the vision pass augmented the text, text-mention offsets are in
            // augmented coordinates; translate them back so pdf.js geometry lines up.
            const anno = toOriginal ? toOriginalMentions(textMentions, toOriginal) : textMentions;
            bytes = await annotatePdf(pdfState.bytes, pdfState.pages, anno, eqBoxes);
          } else {
            bytes = await annotateImagesToPdf(annotatedImages, eqBoxes);
          }
          download(new Blob([bytes], { type: "application/pdf" }), "annotated.pdf");
          annStatus.textContent = "Downloaded.";
        } catch (e) {
          annStatus.textContent = "Failed: " + (e && e.message ? e.message : e);
        } finally {
          annBtn.disabled = false;
        }
      });
      output.appendChild(el("div", { class: "chat-actions" }, [annBtn, annStatus]));
      output.appendChild(el("p", { class: "muted" }, [
        annotatedImages
          ? "Builds a PDF from your image(s) with each detected equation highlighted and linked to its card. Box placement is estimated by the vision model (best-effort)."
          : "Highlights measures named in the text and, when the equation reader is on, the detected equations too — each linked to its dictionary card. Placement is best-effort (approximate coordinates).",
      ]));
    }

    // Reading view (skipped for image uploads, which have no prose to read).
    if (showReading) {
      const view = el("section", { class: "lk-section" });
      view.appendChild(el("h2", {}, ["Reading view"]));
      const reading = el("div", { class: "lk-reading" });
      reading.innerHTML = buildReadingHTML(text, res.mentions);
      view.appendChild(reading);
      output.appendChild(view);
    }

    // Detected measures (unique) with audited code. A variant contributes its
    // related card, so e.g. the Shannon card shows up from the finite-sample eq.
    const ids = [...new Set(linkedMentions.map((m) => m.id || m.related_id))];
    if (ids.length) {
      const noteByCard = new Map(); // grounded note per card; else a synthesized variant-relation note
      for (const m of linkedMentions) { const cid = m.id || m.related_id; if (m.note && !noteByCard.has(cid)) noteByCard.set(cid, m.note); }
      // A card that surfaced only via a VARIANT (related_id, no grounded note) still gets an
      // informative relation note; an exact card with no note stays noteless (its title says it).
      for (const m of linkedMentions) {
        const cid = m.id || m.related_id;
        if (!noteByCard.has(cid) && !m.id && m.related_id) {
          const rel = String(m.relation || "variant").replace(/_/g, " ");
          noteByCard.set(cid, `A ${rel} of ${cardLabel(db, cid)} appears in this paper.`);
        }
      }
      const sec = el("section", { class: "lk-section" });
      sec.appendChild(el("h2", {}, [`Detected measures (${ids.length})`]));
      ids.forEach((id) => {
        const meas = db.byId.get(id);
        if (!meas) return;
        const card = el("div", { class: "lk-measure" });
        card.appendChild(el("h3", {}, [el("a", { href: `#/m/${id}` }, [meas.canonical_name])]));
        if (noteByCard.has(id)) card.appendChild(el("p", { class: "lk-eq-note muted" }, [noteByCard.get(id)]));
        if (meas.formula_latex) {
          const eq = el("div", { class: "eq" });
          eq.textContent = `$$${meas.formula_latex}$$`;
          card.appendChild(eq);
        }
        card.appendChild(renderCodePanel(db, meas));
        sec.appendChild(card);
      });
      output.appendChild(sec);
    }

    // Reusable "draft a new card" control (used by equation candidates and the prose
    // Unmatched section). Drafting requires the LLM.
    const makeDraftBlock = (m) => {
      const draftBtn = el("button", { type: "button", class: "chat-btn" }, ["Draft entry"]);
      const out = el("div", { class: "lk-draft" });
      draftBtn.addEventListener("click", async () => {
        if (!hasFullCreds()) { out.textContent = "Set your AI provider key and model above first."; return; }
        draftBtn.disabled = true;
        out.textContent = "Drafting…";
        try {
          const entry = await draftEntry({ mention: m, context: contextAround(text, m), call });
          out.innerHTML = "";
          out.appendChild(el("pre", { class: "code-block" }, [el("code", {}, [JSON.stringify(entry, null, 2)])]));
          const dl = el("button", { type: "button", class: "chat-btn" }, ["Download JSON"]);
          dl.addEventListener("click", () => downloadJSON(entry, `${entry.id || "draft-entry"}.json`));
          const propose = el("a", { class: "chat-btn", href: newCardIssueUrl(entry), target: "_blank", rel: "noopener" }, ["Propose via GitHub issue"]);
          const verifyBtn = el("button", { type: "button", class: "chat-btn" }, ["Verify code"]);
          const verifyOut = el("div", { class: "lk-verify" });
          verifyBtn.addEventListener("click", async () => {
            verifyBtn.disabled = true;
            verifyOut.textContent = "Loading Python & running checks…";
            const r = await verifyDraft(entry, (p) => { if (p.status && p.status !== "ready") verifyOut.textContent = p.status; });
            verifyOut.innerHTML = "";
            if (r.error) {
              verifyOut.appendChild(el("p", { class: "chat-error" }, [`Verification error: ${r.error}`]));
            } else {
              verifyOut.appendChild(el("p", { class: r.ok ? "lk-pass" : "lk-fail" }, [
                r.ok ? "✓ Passed checks" : "✗ Some checks failed",
                r.value != null ? ` (value ${Number(r.value).toPrecision(4)})` : "",
              ]));
              const ul = el("ul", { class: "lk-checks" });
              (r.checks || []).forEach((c) => ul.appendChild(el("li", { class: c.pass ? "lk-pass" : "lk-fail" }, [`${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? " — " + c.detail : ""}`])));
              verifyOut.appendChild(ul);
            }
            verifyBtn.disabled = false;
          });
          out.appendChild(el("div", { class: "chat-actions" }, [dl, propose, verifyBtn]));
          out.appendChild(verifyOut);
        } catch (e) {
          out.textContent = "Draft failed: " + (e && e.message ? e.message : e);
        } finally {
          draftBtn.disabled = false;
        }
      });
      return el("div", { class: "lk-draftblock" }, [draftBtn, out]);
    };

    // Equations detected by the vision reader, grouped by how they link. Only the
    // Linked group is highlighted on the annotated PDF.
    if (equationSpans.length) {
      const linkedEqs = [], newEqs = [], otherEqs = [];
      for (const span of equationSpans) {
        const hit = res.mentions.find((m) => m.start < span.augEnd && m.end > span.augStart);
        if (hit && (hit.id || hit.related_id)) linkedEqs.push({ span, hit });
        else if (hit && hit.defines_measure !== false && hit.canonical_guess) newEqs.push({ span, hit });
        else otherEqs.push({ span });
      }

      const sec = el("section", { class: "lk-section" });
      sec.appendChild(el("h2", {}, [`Equations detected (${equationSpans.length})`]));
      sec.appendChild(el("p", { class: "muted" }, ["Transcribed from the page image(s) by your vision model. Only equations that link to a card are highlighted on the PDF."]));

      const label = (span) => `p${span.page}${span.eq_number ? " · " + span.eq_number : ""}`;
      const eqNode = (span) => { const eq = el("div", { class: "eq" }); eq.textContent = `$$${String(span.latex).replace(/^\$+|\$+$/g, "")}$$`; return eq; };

      if (linkedEqs.length) {
        sec.appendChild(el("h3", { class: "lk-eq-group" }, [`Linked to a card (${linkedEqs.length})`]));
        linkedEqs.forEach(({ span, hit }) => {
          const cardId = hit.id || hit.related_id;
          const meas = db.byId.get(cardId);
          const name = meas ? meas.canonical_name : cardId;
          const rel = hit.id ? "= " : `${relationPhrase[hit.relation] || "variant of"} `;
          const row = el("div", { class: "lk-equation" + (hit.id ? "" : " variant") });
          row.appendChild(el("div", { class: "lk-eq-head" }, [
            el("span", { class: "muted" }, [label(span)]),
            el("a", { class: "lk-eq-link", href: `#/m/${cardId}` }, [`→ ${rel}${name}`]),
          ]));
          row.appendChild(eqNode(span));
          const noteText = hit.note || eqFallbackNote(db, hit);
          row.appendChild(el("p", { class: "lk-eq-note muted" }, [noteText]));
          sec.appendChild(row);
        });
      }

      if (newEqs.length) {
        sec.appendChild(el("h3", { class: "lk-eq-group" }, [`Possible new measures (${newEqs.length})`]));
        newEqs.forEach(({ span, hit }) => {
          const row = el("div", { class: "lk-equation" });
          row.appendChild(el("div", { class: "lk-eq-head" }, [
            el("span", { class: "muted" }, [label(span)]),
            el("strong", {}, [hit.canonical_guess || "possible new measure"]),
          ]));
          row.appendChild(eqNode(span));
          row.appendChild(makeDraftBlock(hit));
          sec.appendChild(row);
        });
      }

      if (otherEqs.length) {
        const det = el("details", { class: "lk-other-math" });
        det.appendChild(el("summary", {}, [`Other transcribed math (${otherEqs.length}) — not a measure`]));
        otherEqs.forEach(({ span }) => {
          const row = el("div", { class: "lk-equation" });
          row.appendChild(el("div", { class: "lk-eq-head" }, [el("span", { class: "muted" }, [label(span)])]));
          row.appendChild(eqNode(span));
          det.appendChild(row);
        });
        sec.appendChild(det);
      }

      output.appendChild(sec);
    }

    // Prose measures that look real but match no card → draft new entries. (Equation
    // candidates are shown in the Equations section above, not duplicated here.)
    if (candidates.length) {
      const sec = el("section", { class: "lk-section" });
      sec.appendChild(el("h2", {}, [`Unmatched / possible new measures (${candidates.length})`]));
      sec.appendChild(el("p", { class: "muted" }, ["Named in the text but not in the dictionary. Draft an entry (for your review — nothing is committed automatically)."]));
      candidates.forEach((m) => {
        const row = el("div", { class: "lk-unmatched" });
        row.appendChild(el("div", {}, [
          el("strong", {}, [m.canonical_guess || m.surface]),
          el("span", { class: "muted" }, [` — “${m.surface}” · ${Math.round(m.confidence * 100)}%`]),
        ]));
        row.appendChild(makeDraftBlock(m));
        sec.appendChild(row);
      });
      output.appendChild(sec);
    }

    typeset(output);
  };

  const run = async () => {
    let text = pasteArea.value.trim();
    const files = fileInput.files ? [...fileInput.files] : [];
    const pdf = files.find(isPdf);
    const images = files.filter(isImage);
    pdfState = null;
    let ocrEquations = [];
    let ocrErrors = [];
    let toOriginal = null; // augmented→original offset translator when vision augments text
    let truncated = 0;
    let showReading = true;
    let equationSpans = []; // {page, augStart, augEnd, bbox} per injected equation
    let annotatedImages = null; // [{dataUrl,width,height}] for the image annotated-PDF export

    // Guard: the vision pass (PDF equation toggle OR any image upload) needs a
    // provider that accepts images — catch it before spending a call.
    if ((useVision.checked || images.length) && !providerSupportsImages()) {
      setProgress("The selected provider can't read images. Choose Google Gemini, OpenRouter, or Hugging Face, and a vision-capable model.");
      return;
    }

    if (pdf) {
      let bytes;
      try { bytes = await pdf.arrayBuffer(); } catch (e) { setProgress("Could not read file."); return; }
      setProgress("Parsing PDF…");
      let doc;
      try {
        doc = await extractDocument(bytes, (p) => setProgress(`Parsing page ${p.page}/${p.total}…`));
      } catch (e) {
        setProgress("PDF parse failed: " + (e && e.message ? e.message : e));
        return;
      }
      text = doc.fullText;
      pdfState = { bytes, pages: doc.pages }; // enables annotated-PDF export

      // Optional vision pass: transcribe each page's equations to LaTeX and fold
      // them into the text so formula-defined measures can be detected + linked.
      if (useVision.checked) {
        if (!hasFullCreds()) {
          setProgress("Enable a provider key + a vision-capable model in AI settings to read equations.");
          return;
        }
        try {
          ocrEquations = await ocrPagesToLatex({
            bytes, numPages: doc.numPages, maxPages: 15,
            onProgress: (p) => setProgress(p.retry
              ? `High demand — retrying ${p.total} page(s) after a pause…`
              : `Reading equations… page ${p.page}/${p.total}`),
          });
          truncated = Math.max(0, doc.numPages - 15);
          const aug = augmentText(doc.pages, ocrEquations);
          text = aug.fullText;
          toOriginal = aug.toOriginalOffset;
          equationSpans = aug.equationSpans;
          ocrErrors = ocrEquations.filter((o) => o.error).map((o) => `p${o.page}: ${o.error}`);
        } catch (e) {
          setProgress("Equation reading failed: " + (e && e.message ? e.message : e));
          return;
        }
      }
    } else if (images.length) {
      // Image-upload path: each picture is a "page" read by the vision model. There
      // is no text layer, so this needs a vision-capable model + key.
      if (!hasFullCreds()) {
        setProgress("To analyze an image, set a vision-capable model + key in AI settings (OpenRouter or Hugging Face).");
        return;
      }
      let normImages;
      try {
        setProgress("Reading image(s)…");
        const raw = await Promise.all(images.map(fileToDataURL));
        normImages = await Promise.all(raw.map((u) => normalizeToJpeg(u)));
      } catch (e) {
        setProgress("Could not read image: " + (e && e.message ? e.message : e));
        return;
      }
      try {
        const capped = normImages.slice(0, 15);
        ocrEquations = await ocrImagesToLatex({
          images: capped.map((n) => n.dataUrl), maxPages: 15,
          onProgress: (p) => setProgress(p.retry
            ? `High demand — retrying ${p.total} image(s) after a pause…`
            : `Reading equations… image ${p.page}/${p.total}`),
        });
        truncated = Math.max(0, images.length - 15);
        ocrErrors = ocrEquations.filter((o) => o.error).map((o) => `img${o.page}: ${o.error}`);
        annotatedImages = capped; // one PDF page per image for the annotated export
        const anyEq = ocrEquations.some((o) => (o.equations || []).length);
        if (anyEq) {
          const synthetic = capped.map((_, i) => ({ page: i + 1, text: "", items: [] }));
          const aug = augmentText(synthetic, ocrEquations);
          text = aug.fullText;
          equationSpans = aug.equationSpans;
        } else {
          text = ""; // nothing read → fall through to the "no equations" message below
        }
        showReading = false; // no prose to read — the Equations section is the display
      } catch (e) {
        setProgress("Equation reading failed: " + (e && e.message ? e.message : e));
        return;
      }
    }

    if (!text) {
      setProgress(images.length
        ? "The vision reader found no equations in the image(s)."
        : "Upload a PDF or image, or paste some text first.");
      return;
    }
    const useLLM = hasFullCreds(); // LLM only when a key AND model are set; else light mode
    runBtn.disabled = true;
    output.innerHTML = "";
    try {
      const res = await detectAndLink({
        db, text, call: useLLM ? call : null,
        onProgress: (s) => {
          if (s.stage === "lexical") setProgress("Scanning for known measures…");
          else if (s.stage === "detect") setProgress(`Detecting with AI… chunk ${s.index}/${s.total}`);
        },
      });
      const notes = [];
      if (!useLLM) notes.push("Light mode: matched against the dictionary only — add an AI key + model above to also detect unnamed/formula measures.");
      if (pdf && images.length) notes.push("A PDF was uploaded; the image(s) were ignored.");
      if (truncated) notes.push(`Only the first 15 ${pdf ? "pages" : "images"} were read for equations; ${truncated} more were skipped.`);
      if (ocrEquations.length && !ocrEquations.some((o) => (o.equations || []).length)) notes.push("The vision reader found no equations.");
      setProgress(notes.join(" "));
      renderResults(text, res, useLLM, { toOriginal, ocrEquations, ocrErrors, showReading, equationSpans, images: annotatedImages });
    } catch (e) {
      setProgress("Failed: " + (e && e.message ? e.message : e));
    } finally {
      runBtn.disabled = false;
    }
  };
  runBtn.addEventListener("click", run);

  const inputBox = el("section", { class: "lk-input" });
  inputBox.appendChild(el("label", { class: "field-label" }, ["PDF or image(s)"]));
  inputBox.appendChild(fileInput);
  inputBox.appendChild(useVisionLabel);
  inputBox.appendChild(el("label", { class: "field-label" }, ["or paste text"]));
  inputBox.appendChild(pasteArea);
  inputBox.appendChild(el("div", { class: "chat-actions" }, [runBtn, progress]));
  root.appendChild(inputBox);
  root.appendChild(output);
  return root;
}
