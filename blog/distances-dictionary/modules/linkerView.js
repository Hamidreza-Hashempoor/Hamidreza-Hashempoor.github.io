// The "#/linker" page: PDF/text -> BYOK LLM detect+link -> linkified reading
// view + detected-measures (with audited code) + unmatched (draft new entry).
// Everything runs client-side; the LLM is the user's own provider (llm.js).

import { el, escapeHTML } from "./util.js";
import { renderProviderSettings, callJSON, hasCreds } from "./llm.js";
import { extractDocument } from "./pdf.js";
import { detectAndLink, draftEntry } from "./linker.js";
import { verifyDraft } from "./verify.js";
import { renderMathpixSettings, hasMathpix, ocrDocument } from "./mathpix.js";
import { annotatePdf } from "./annotate.js";
import { renderCodePanel } from "./codegen.js";
import { typeset } from "./mathjax.js";

const call = ({ system, user }) => callJSON({ system, user, maxTokens: 2000, temperature: 0 });

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

/** Build the linkified reading-view HTML from full text + sorted mentions. */
function buildReadingHTML(text, mentions) {
  let html = "";
  let cursor = 0;
  for (const m of mentions) {
    if (m.start < cursor) continue;
    html += escapeHTML(text.slice(cursor, m.start));
    const surf = escapeHTML(text.slice(m.start, m.end));
    if (m.id) {
      const conf = Math.round(m.confidence * 100);
      const cls = "lk-hit" + (m.needs_review ? " review" : "");
      html += `<a class="${cls}" href="#/m/${m.id}" title="${escapeHTML(m.id)} · ${conf}%${m.needs_review ? " · review" : ""}">${surf}</a>`;
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
    "Upload a PDF (or paste text) and your own AI provider will detect the distances/divergences it uses — ",
    "even under different names — and link each to a dictionary entry with audited code. Missing measures can be drafted for review.",
  ]));
  root.appendChild(el("p", { class: "muted" }, [
    "Runs in your browser; the AI call uses your own key (below). Detection of unnamed formulas is the least reliable step — ",
    "low-confidence and unmatched items are flagged, never silently trusted.",
  ]));

  // Provider settings (shared component).
  const settings = renderProviderSettings();
  root.appendChild(settings);

  // Optional Mathpix equation OCR (experimental).
  const mathpixSettings = renderMathpixSettings();
  root.appendChild(mathpixSettings);

  // Input controls.
  const fileInput = el("input", { type: "file", accept: "application/pdf,.pdf", class: "lk-file" });
  const pasteArea = el("textarea", { class: "chat-question", rows: "5", placeholder: "…or paste text (e.g. an abstract or a methods section)" });
  const useMathpix = el("input", { type: "checkbox", id: "lk-use-mathpix" });
  const useMathpixLabel = el("label", { for: "lk-use-mathpix", class: "chat-consent" }, [useMathpix, el("span", {}, [" Use Mathpix for equations (first ~5 pages; experimental)"])]);
  const runBtn = el("button", { type: "button", class: "chat-btn primary" }, ["Detect & link"]);
  const progress = el("div", { class: "chat-status", "aria-live": "polite" });
  const output = el("div", { class: "lk-output" });

  // Holds the parsed pdf.js doc for the (experimental) annotated-PDF export.
  let pdfState = null; // { bytes, pages } when the pdf.js text path was used

  const setProgress = (t) => { progress.textContent = t || ""; };

  const renderResults = (text, res) => {
    output.innerHTML = "";
    const matched = res.mentions.filter((m) => m.id);
    const unmatched = res.mentions.filter((m) => !m.id);

    const summary = el("p", { class: "lk-summary" }, [
      `${matched.length} linked mention${matched.length === 1 ? "" : "s"}, ${unmatched.length} unmatched.`,
    ]);
    if (res.dropped > 0) summary.appendChild(el("span", { class: "muted" }, [` (only the first ${res.chunks - res.dropped} of ${res.chunks} chunks scanned)`]));
    output.appendChild(summary);
    if (res.errors && res.errors.length) {
      output.appendChild(el("p", { class: "chat-error" }, [`Some chunks failed: ${res.errors[0]}`]));
    }

    // Optional: annotated-PDF export (only on the pdf.js text path; experimental).
    if (pdfState && matched.length) {
      const annBtn = el("button", { type: "button", class: "chat-btn" }, ["Download annotated PDF (experimental)"]);
      const annStatus = el("span", { class: "chat-status" });
      annBtn.addEventListener("click", async () => {
        annBtn.disabled = true;
        annStatus.textContent = "Annotating…";
        try {
          const bytes = await annotatePdf(pdfState.bytes, pdfState.pages, matched);
          download(new Blob([bytes], { type: "application/pdf" }), "annotated.pdf");
          annStatus.textContent = "Downloaded.";
        } catch (e) {
          annStatus.textContent = "Failed: " + (e && e.message ? e.message : e);
        } finally {
          annBtn.disabled = false;
        }
      });
      output.appendChild(el("div", { class: "chat-actions" }, [annBtn, annStatus]));
    }

    // Reading view.
    const view = el("section", { class: "lk-section" });
    view.appendChild(el("h2", {}, ["Reading view"]));
    const reading = el("div", { class: "lk-reading" });
    reading.innerHTML = buildReadingHTML(text, res.mentions);
    view.appendChild(reading);
    output.appendChild(view);

    // Detected measures (unique) with audited code.
    const ids = [...new Set(matched.map((m) => m.id))];
    if (ids.length) {
      const sec = el("section", { class: "lk-section" });
      sec.appendChild(el("h2", {}, [`Detected measures (${ids.length})`]));
      ids.forEach((id) => {
        const meas = db.byId.get(id);
        if (!meas) return;
        const card = el("div", { class: "lk-measure" });
        card.appendChild(el("h3", {}, [el("a", { href: `#/m/${id}` }, [meas.canonical_name])]));
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

    // Unmatched -> draft new entries.
    if (unmatched.length) {
      const sec = el("section", { class: "lk-section" });
      sec.appendChild(el("h2", {}, [`Unmatched / possible new measures (${unmatched.length})`]));
      sec.appendChild(el("p", { class: "muted" }, ["These look like measures but aren't in the dictionary. Draft an entry (for your review — nothing is committed automatically)."]));
      unmatched.forEach((m) => {
        const row = el("div", { class: "lk-unmatched" });
        const head = el("div", {}, [
          el("strong", {}, [m.canonical_guess || m.surface]),
          el("span", { class: "muted" }, [` — “${m.surface}” · ${Math.round(m.confidence * 100)}%`]),
        ]);
        const draftBtn = el("button", { type: "button", class: "chat-btn" }, ["Draft entry"]);
        const out = el("div", { class: "lk-draft" });
        draftBtn.addEventListener("click", async () => {
          if (!hasCreds()) { out.textContent = "Set your AI provider key above first."; return; }
          draftBtn.disabled = true;
          out.textContent = "Drafting…";
          try {
            const entry = await draftEntry({ mention: m, context: contextAround(text, m), call });
            out.innerHTML = "";
            out.appendChild(el("pre", { class: "code-block" }, [el("code", {}, [JSON.stringify(entry, null, 2)])]));
            const dl = el("button", { type: "button", class: "chat-btn" }, ["Download JSON"]);
            dl.addEventListener("click", () => downloadJSON(entry, `${entry.id || "draft-entry"}.json`));
            // Optional: verify the drafted reference code in Pyodide (lazy).
            const verifyBtn = el("button", { type: "button", class: "chat-btn" }, ["Verify code"]);
            const verifyOut = el("div", { class: "lk-verify" });
            verifyBtn.addEventListener("click", async () => {
              verifyBtn.disabled = true;
              verifyOut.textContent = "Loading Python & running checks…";
              const res = await verifyDraft(entry, (p) => { if (p.status && p.status !== "ready") verifyOut.textContent = p.status; });
              verifyOut.innerHTML = "";
              if (res.error) {
                verifyOut.appendChild(el("p", { class: "chat-error" }, [`Verification error: ${res.error}`]));
              } else {
                verifyOut.appendChild(el("p", { class: res.ok ? "lk-pass" : "lk-fail" }, [
                  res.ok ? "✓ Passed checks" : "✗ Some checks failed",
                  res.value != null ? ` (value ${Number(res.value).toPrecision(4)})` : "",
                ]));
                const ul = el("ul", { class: "lk-checks" });
                (res.checks || []).forEach((c) => ul.appendChild(el("li", { class: c.pass ? "lk-pass" : "lk-fail" }, [`${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? " — " + c.detail : ""}`])));
                verifyOut.appendChild(ul);
              }
              verifyBtn.disabled = false;
            });
            out.appendChild(el("div", { class: "chat-actions" }, [dl, verifyBtn]));
            out.appendChild(verifyOut);
          } catch (e) {
            out.textContent = "Draft failed: " + (e && e.message ? e.message : e);
          } finally {
            draftBtn.disabled = false;
          }
        });
        row.appendChild(head);
        row.appendChild(draftBtn);
        row.appendChild(out);
        sec.appendChild(row);
      });
      output.appendChild(sec);
    }

    typeset(output);
  };

  const run = async () => {
    let text = pasteArea.value.trim();
    const file = fileInput.files && fileInput.files[0];
    pdfState = null;
    if (file) {
      let bytes;
      try { bytes = await file.arrayBuffer(); } catch (e) { setProgress("Could not read file."); return; }
      if (useMathpix.checked && hasMathpix()) {
        setProgress("Running Mathpix OCR…");
        try {
          text = await ocrDocument(bytes, { maxPages: 5, onProgress: (p) => setProgress(`Mathpix OCR page ${p.page}/${p.total}…`) });
        } catch (e) {
          setProgress("Mathpix OCR failed: " + (e && e.message ? e.message : e));
          return;
        }
      } else {
        setProgress("Parsing PDF…");
        try {
          const doc = await extractDocument(bytes, (p) => setProgress(`Parsing page ${p.page}/${p.total}…`));
          text = doc.fullText;
          pdfState = { bytes, pages: doc.pages }; // enables annotated-PDF export
        } catch (e) {
          setProgress("PDF parse failed: " + (e && e.message ? e.message : e));
          return;
        }
      }
    }
    if (!text) { setProgress("Upload a PDF or paste some text first."); return; }
    if (!hasCreds()) { setProgress("Add your AI provider key above first."); settings.open = true; return; }
    runBtn.disabled = true;
    output.innerHTML = "";
    try {
      const res = await detectAndLink({
        db, text, call,
        onProgress: (s) => { if (s.stage === "detect") setProgress(`Detecting & linking… chunk ${s.index}/${s.total}`); },
      });
      setProgress("");
      renderResults(text, res);
    } catch (e) {
      setProgress("Failed: " + (e && e.message ? e.message : e));
    } finally {
      runBtn.disabled = false;
    }
  };
  runBtn.addEventListener("click", run);

  const inputBox = el("section", { class: "lk-input" });
  inputBox.appendChild(el("label", { class: "field-label" }, ["PDF file"]));
  inputBox.appendChild(fileInput);
  inputBox.appendChild(useMathpixLabel);
  inputBox.appendChild(el("label", { class: "field-label" }, ["or paste text"]));
  inputBox.appendChild(pasteArea);
  inputBox.appendChild(el("div", { class: "chat-actions" }, [runBtn, progress]));
  root.appendChild(inputBox);
  root.appendChild(output);
  return root;
}
