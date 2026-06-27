// Optional, experimental equation OCR via the user's own Mathpix account.
// Better math fidelity for equation-heavy PDFs than pdf.js text. Credentials are
// BYO (session-first), sent directly to Mathpix. May require a proxy if the
// browser blocks the call (CORS). Fully degradable: if no keys, it is never used.

import { el } from "./util.js";
import { renderPageImage } from "./pdf.js";

const ID_KEY = "dd_mathpix_id";
const KEY_KEY = "dd_mathpix_key";

function read(k) { try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch (_) { return null; } }
function write(k, v, persist) {
  try { (persist ? localStorage : sessionStorage).setItem(k, v); (persist ? sessionStorage : localStorage).removeItem(k); } catch (_) { /* ignore */ }
}
function rm(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch (_) { /* ignore */ } }

export function getMathpix() { return { appId: read(ID_KEY) || "", appKey: read(KEY_KEY) || "" }; }
export function setMathpix(id, key, persist) {
  if (id) write(ID_KEY, id, persist); else rm(ID_KEY);
  if (key) write(KEY_KEY, key, persist); else rm(KEY_KEY);
}
export function hasMathpix() { const c = getMathpix(); return !!(c.appId && c.appKey); }

/** OCR a single page image (data URL) → text with $…$ / $$…$$ math. */
export async function ocrImage(dataUrl) {
  const { appId, appKey } = getMathpix();
  const res = await fetch("https://api.mathpix.com/v3/text", {
    method: "POST",
    headers: { app_id: appId, app_key: appKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      src: dataUrl,
      formats: ["text"],
      math_inline_delimiters: ["$", "$"],
      math_display_delimiters: ["$$", "$$"],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Mathpix ${res.status}. ${t.slice(0, 200)} (this may require a proxy due to CORS).`);
  }
  return (await res.json()).text || "";
}

/** OCR the first `maxPages` pages of a PDF (ArrayBuffer) → combined text. */
export async function ocrDocument(bytes, { maxPages = 5, onProgress = () => {} } = {}) {
  let text = "";
  for (let p = 1; p <= maxPages; p++) {
    onProgress({ stage: "mathpix", page: p, total: maxPages });
    let img;
    try { img = await renderPageImage(bytes, p, 2); } catch (_) { break; } // past last page
    text += (await ocrImage(img)) + "\n\n";
  }
  return text;
}

/** Settings panel for Mathpix credentials. */
export function renderMathpixSettings() {
  const wrap = el("details", { class: "llm-settings" });
  const summary = el("summary", {}, [hasMathpix() ? "Math OCR (Mathpix) — keys set" : "Math OCR (Mathpix, optional) — add keys"]);
  wrap.appendChild(summary);
  wrap.appendChild(el("p", { class: "muted" }, [
    "Optional & experimental: better equations for math-heavy PDFs using your own Mathpix account. May require a proxy (CORS).",
  ]));
  const idIn = el("input", { type: "text", class: "llm-field", placeholder: "app_id" });
  idIn.value = getMathpix().appId;
  const keyIn = el("input", { type: "password", class: "llm-field", placeholder: "app_key", autocomplete: "off" });
  keyIn.value = getMathpix().appKey;
  const remember = el("input", { type: "checkbox", id: "mathpix-remember" });
  const save = el("button", { type: "button", class: "chat-btn" }, ["Save"]);
  const status = el("span", { class: "chat-status" });
  save.addEventListener("click", () => {
    setMathpix(idIn.value.trim(), keyIn.value.trim(), remember.checked);
    status.textContent = "Saved.";
    summary.textContent = hasMathpix() ? "Math OCR (Mathpix) — keys set" : "Math OCR (Mathpix, optional) — add keys";
  });
  wrap.appendChild(el("label", { class: "field-label" }, ["Mathpix app_id"]));
  wrap.appendChild(idIn);
  wrap.appendChild(el("label", { class: "field-label" }, ["Mathpix app_key"]));
  wrap.appendChild(keyIn);
  wrap.appendChild(el("label", { for: "mathpix-remember", class: "chat-consent" }, [remember, el("span", {}, [" Remember on this device"])]));
  wrap.appendChild(el("div", { class: "chat-actions" }, [save, status]));
  return wrap;
}
