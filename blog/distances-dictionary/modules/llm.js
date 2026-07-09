// Unified bring-your-own-key (BYOK) LLM client for the dictionary.
//
// Users connect THEIR OWN provider account (Claude / OpenRouter / Gemini / HF).
// The key lives only in this browser (sessionStorage by default; optional
// localStorage), is sent directly to the provider, and is billed to the user.
// It is never logged, never committed, and never the site owner's key.

import { el } from "./util.js";

/* ------------------------------- providers -------------------------------- */

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    defaultModel: "claude-sonnet-4-6",
    keyHint: "sk-ant-…",
    corsNote: "Direct browser calls are enabled via Anthropic's browser-access header.",
    buildRequest({ key, model, system, user, maxTokens, temperature, images }) {
      if (images && images.length) throw new Error("Anthropic image input isn't wired in this app — pick OpenRouter or Hugging Face for the vision (equation) pass.");
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: { model, max_tokens: maxTokens, temperature, system, messages: [{ role: "user", content: user }] },
      };
    },
    parseText: (d) => (d.content || []).map((b) => b.text || "").join("\n"),
  },

  openrouter: {
    label: "OpenRouter",
    defaultModel: "openrouter/auto",
    keyHint: "sk-or-…",
    supportsImages: true,
    modelHint: "\":free\" models are genuinely free but rate-limited (~20/min). Pick a vision model for the equation reader.",
    corsNote: "One key fronts many models (Claude, GPT, Gemini, Llama…). Browser-friendly.",
    buildRequest({ key, model, system, user, maxTokens, temperature, json, images, reasoningOff }) {
      const content = (images && images.length)
        ? [{ type: "text", text: user }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
        : user;
      return {
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: {
          model, max_tokens: maxTokens, temperature,
          ...(json ? { response_format: { type: "json_object" } } : {}),
          // enabled:false turns reasoning off; exclude:true also strips any reasoning from the
          // response so it can't leak into and corrupt the JSON body.
          ...(reasoningOff ? { reasoning: { enabled: false, exclude: true } } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content }],
        },
      };
    },
    parseText: (d) => d.choices?.[0]?.message?.content || "",
  },

  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    keyHint: "AIza… (Google AI Studio key)",
    supportsImages: true,
    modelHint: "gemini-2.5-flash — free tier ≈ 1,500 requests/day, no card. (Newer Flash ids like gemini-3.5-flash also work.)",
    corsNote: "Google's OpenAI-compatible endpoint, callable from the browser with your key.",
    // OpenAI-compatible surface: same messages/image_url/response_format shape as
    // OpenRouter & HF, so Gemini shares the exact code path (incl. the vision pass).
    buildRequest({ key, model, system, user, maxTokens, temperature, json, images, reasoningOff }) {
      const content = (images && images.length)
        ? [{ type: "text", text: user }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
        : user;
      return {
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: {
          model, max_tokens: maxTokens, temperature,
          ...(json ? { response_format: { type: "json_object" } } : {}),
          ...(reasoningOff ? { reasoning_effort: "none" } : {}), // disable thinking on 2.5 Flash
          messages: [{ role: "system", content: system }, { role: "user", content }],
        },
      };
    },
    parseText: (d) => d.choices?.[0]?.message?.content || "",
  },

  huggingface: {
    label: "Hugging Face",
    defaultModel: "meta-llama/Llama-3.2-3B-Instruct",
    keyHint: "hf_…",
    supportsImages: true,
    modelHint: "Included credit is small; use a small VLM for the equation reader (e.g. Qwen/Qwen2.5-VL-7B-Instruct) and enable a provider in HF settings.",
    corsNote: "Free-tier friendly HF Inference router (OpenAI-compatible).",
    buildRequest({ key, model, system, user, maxTokens, temperature, json, images, reasoningOff }) {
      const content = (images && images.length)
        ? [{ type: "text", text: user }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
        : user;
      return {
        url: "https://router.huggingface.co/v1/chat/completions",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: {
          model, max_tokens: maxTokens, temperature,
          ...(json ? { response_format: { type: "json_object" } } : {}),
          ...(reasoningOff ? { chat_template_kwargs: { enable_thinking: false } } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content }],
        },
      };
    },
    parseText: (d) => d.choices?.[0]?.message?.content || "",
  },
};

export const PROVIDER_LIST = Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label }));
const DEFAULT_PROVIDER = "anthropic";

/* ------------------------------ credential store -------------------------- */
// sessionStorage by default (cleared on tab close); localStorage only if the
// user opts to "remember". Read checks both so a remembered key survives.

function read(key) {
  try { return sessionStorage.getItem(key) ?? localStorage.getItem(key); } catch (_) { return null; }
}
function write(key, val, persist) {
  try {
    const store = persist ? localStorage : sessionStorage;
    const other = persist ? sessionStorage : localStorage;
    store.setItem(key, val);
    other.removeItem(key);
  } catch (_) { /* ignore */ }
}
function remove(key) {
  try { sessionStorage.removeItem(key); localStorage.removeItem(key); } catch (_) { /* ignore */ }
}

export function getProvider() {
  const p = read("dd_llm_provider");
  return p && PROVIDERS[p] ? p : DEFAULT_PROVIDER;
}
export function setProvider(id) {
  if (PROVIDERS[id]) write("dd_llm_provider", id, true); // remembering the choice (not the key) is fine
}
/** Rate tier drives request pacing only. Default "free" (safe for public free keys —
 *  10–15 RPM); "paid" (Gemini Tier 1+) uses a much smaller gap. Remembered on device. */
export function getRateTier() {
  return read("dd_llm_rate_tier") === "paid" ? "paid" : "free";
}
export function setRateTier(tier) {
  write("dd_llm_rate_tier", tier === "paid" ? "paid" : "free", true);
}
export function getKey(provider = getProvider()) {
  return read(`dd_llm_key_${provider}`) || "";
}
export function setKey(provider, key, persist) {
  if (key) write(`dd_llm_key_${provider}`, key, !!persist);
  else remove(`dd_llm_key_${provider}`);
}
export function clearKey(provider = getProvider()) {
  remove(`dd_llm_key_${provider}`);
}
export function getModel(provider = getProvider()) {
  return read(`dd_llm_model_${provider}`) || PROVIDERS[provider].defaultModel;
}
export function setModel(provider, model) {
  if (model) write(`dd_llm_model_${provider}`, model, true);
  else remove(`dd_llm_model_${provider}`);
}
export function hasCreds(provider = getProvider()) {
  return !!getKey(provider);
}
/** True only when BOTH a key and a model are configured — the gate for using
 *  the BYOK LLM. Without this, the app falls back to the light (no-key) path. */
export function hasFullCreds(provider = getProvider()) {
  return !!getKey(provider) && !!getModel(provider);
}
/** Does the selected provider accept image input (the vision equation pass)? */
export function providerSupportsImages(provider = getProvider()) {
  return !!(PROVIDERS[provider] && PROVIDERS[provider].supportsImages);
}

/* --------------------------------- calls ---------------------------------- */

const RETRYABLE = new Set([429, 500, 502, 503, 504]); // transient; back off and retry
const MAX_RETRIES = 5;      // for 429 / other transient
const MAX_503_RETRIES = 2;  // 503 = server overload; a small budget — don't grind on it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hard run budget: after the deadline, stop starting NEW retries so a persistently
// failing model (e.g. a 503-storming Gemini) can't hang the run for minutes. In-flight
// calls still finish; remaining pages are reported failed and the run completes.
let _runDeadline = 0;
export function beginRun(budgetMs = 75000) { _runDeadline = Date.now() + budgetMs; }
export function endRun() { _runDeadline = 0; }
export function pastDeadline() { return _runDeadline > 0 && Date.now() > _runDeadline; }

/* --- free-tier 429s: tell a per-DAY limit (RPD — no retry until it resets) from a
   per-MINUTE limit (RPM, rolling 60s window — wait and retry). --- */
function is429PerDay(detail) {
  return /per\s*day|perday|daily|requests per day|\bRPD\b|quota.*\bday\b/i.test(String(detail || ""));
}
function retryDelayFromBody(detail) {
  // Gemini often returns a RetryInfo delay like "retryDelay":"30s".
  const m = String(detail || "").match(/retry[_-]?delay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*s?/i);
  return m ? Math.ceil(parseFloat(m[1])) : 0;
}

/* --- global request pacer: keep the whole run under the free-tier RPM ceiling (rolling
   60s window). EVERY provider call (vision + text + retries) goes through paced(), so a
   burst becomes a paced stream. Interval is derived from the selected model's RPM.
   Trade-off: a multi-page run is slower, but "instant 429" becomes "slow but succeeds." */
function paceIntervalMs() {
  if (getRateTier() === "paid") return 800;  // Tier 1+ (>100 RPM): a tiny gap just avoids an instant burst
  const m = (getModel() || "").toLowerCase();
  if (m.includes("2.5-flash")) return 4500;  // Gemini 2.5 Flash ≈ 15 RPM
  if (m.includes("flash")) return 6500;      // 3.x Flash / flash-latest ≈ 10 RPM (stay safe)
  return 5000;                               // other free tiers (OpenRouter ~20/min, HF)
}
// Concurrency pool: serial on free (protect 10–15 RPM), parallel on paid (Tier 1+).
// Starts are still staggered by paceIntervalMs() so N calls don't fire in one instant.
function _maxConcurrent() {
  return getRateTier() === "paid" ? 5 : 1;
}
let _inFlight = 0;
let _nextStart = 0;      // earliest timestamp the next call may start
const _queue = [];
function _pump() {
  while (_inFlight < _maxConcurrent() && _queue.length) {
    const { fn, resolve, reject } = _queue.shift();
    _inFlight++;
    const now = Date.now();
    const start = Math.max(now, _nextStart);
    _nextStart = start + paceIntervalMs();  // stagger starts by the pace interval
    const go = () => Promise.resolve().then(fn).then(resolve, reject).finally(() => { _inFlight--; _pump(); });
    const delay = start - now;
    if (delay > 0) setTimeout(go, delay); else go();
  }
}
function paced(fn) {
  return new Promise((resolve, reject) => { _queue.push({ fn, resolve, reject }); _pump(); });
}

/** Actionable, provider-aware error message so failures tell the user what to do. */
function describeError(status, providerLabel, detail = "") {
  const p = providerLabel;
  if (status === 401 || status === 403) return `Auth failed for ${p} (${status}). Check your key and that your key/plan can use this model.`;
  if (status === 402) return `${p}: included credits/quota are used up. Switch to a smaller/cheaper model, change provider, or add credits.`;
  if (status === 429) {
    if (is429PerDay(detail)) return `${p}: daily free quota reached (resets ~midnight Pacific). Try later, or switch model (e.g. gemini-2.5-flash) / provider.`;
    return `${p}: per-minute rate limit — pausing and retrying. If it persists, wait a moment or switch model/provider.`;
  }
  if (status === 503) return `${p} is overloaded right now ("high demand"). Try again shortly, or switch to a less-busy model like gemini-2.5-flash.`;
  if (status === 404) return `${p}: model not found (${status}). Check the model id.`;
  if (status === 400) return `${p}: bad request (400). ${String(detail).slice(0, 200)}`;
  if (status === 0)   return `${p}: blocked (CORS or network).`;
  return `${p} request failed (${status}). ${String(detail).slice(0, 200)}`;
}

/**
 * Call the selected provider. Returns the assistant text. Throws on error.
 * `images` (array of data URLs) is threaded to vision providers (OpenRouter / HF /
 * Gemini, OpenAI-style content); Anthropic rejects them. `reasoningOff` disables
 * thinking so JSON isn't corrupted/truncated. Transient failures (429/5xx) back off
 * and retry (honoring Retry-After); fatal ones (400/401/402/403/404) fail fast.
 */
export async function callLLM({ system = "", user = "", maxTokens = 1500, temperature = 0.2, json = false, images = null, reasoningOff = false, signal } = {}) {
  const pid = getProvider();
  const p = PROVIDERS[pid];
  if (!p) throw new Error(`Unknown provider: ${pid}`);
  const key = getKey(pid);
  if (!key) throw new Error(`No API key set for ${p.label}.`);
  const model = getModel(pid);

  const attempt = async (useJson, useReason) => {
    const { url, headers, body } = p.buildRequest({ key, model, system, user, maxTokens, temperature, json: useJson, images, reasoningOff: useReason });
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = j.error?.message || (typeof j.error === "string" ? j.error : "") || JSON.stringify(j).slice(0, 300); }
      catch (_) { detail = await res.text().catch(() => ""); }
      const err = new Error(describeError(res.status, p.label, detail));
      err.status = res.status;
      err.detail = detail;
      err.retryAfter = Number(res.headers.get("retry-after")) || 0;
      throw err;
    }
    return p.parseText(await res.json());
  };

  for (let i = 0; ; i++) {
    try {
      return await paced(() => attempt(json, reasoningOff));
    } catch (e) {
      const d = `${e && e.detail || ""} ${e && e.message || ""}`.toLowerCase();
      // If a param (JSON mode or the reasoning knob) was rejected, retry once without both.
      if ((json || reasoningOff) && e && e.status >= 400 && e.status < 500 &&
          /response_format|json|reasoning|effort|thinking|unsupported|not support/.test(d)) {
        return paced(() => attempt(false, false));
      }
      // Rate limit (429): a per-DAY quota can't be retried today (fail fast); a per-MINUTE
      // limit clears within the rolling window, so wait (server delay if given, else
      // ~15→30→60s) and retry.
      if (e && e.status === 429) {
        if (is429PerDay(e.detail || e.message)) throw e;
        if (i < MAX_RETRIES && !pastDeadline()) {
          const rd = e.retryAfter || retryDelayFromBody(e.detail || e.message);
          const wait = rd > 0 ? rd * 1000 : Math.min(60000, 15000 * 2 ** i) + Math.random() * 1000;
          await sleep(wait);
          continue;
        }
      }
      // Other transient (5xx capacity). 503 = server overload: a small retry budget and a
      // low ceiling — grinding on an overloaded server for a minute is counter-productive.
      if (e && RETRYABLE.has(e.status)) {
        const cap = e.status === 503 ? MAX_503_RETRIES : MAX_RETRIES;
        if (i < cap && !pastDeadline()) {
          const base = e.status === 503 ? 1500 : 1000;
          const ceil = e.status === 503 ? 6000 : 25000;
          const wait = e.retryAfter > 0 ? e.retryAfter * 1000 : Math.min(ceil, base * 2 ** i) + Math.random() * 400;
          await sleep(wait);
          continue;
        }
      }
      throw e; // fatal: 400/401/402/403/404, or retries exhausted / past deadline
    }
  }
}

/**
 * Strip code fences / surrounding prose, tolerate trailing commas, and parse.
 * Falls back to a balanced-bracket scan from the first `{`/`[` — but STRING-AWARE,
 * so braces inside LaTeX values ("\\frac{a}{b}", "\\sum_{i}") don't throw off the
 * depth count. This is what makes equation-heavy JSON (and reasoning models that
 * wrap JSON in prose / think-blocks) parse reliably.
 */
export function parseJsonLoose(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const strip = (s) => s.replace(/,\s*([}\]])/g, "$1"); // kill trailing commas
  try { return JSON.parse(strip(t)); } catch (_) { /* fall through */ }
  const i = t.search(/[{[]/);
  if (i >= 0) {
    const open = t[i], close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try { return JSON.parse(strip(t.slice(i, j + 1))); } catch (_) { /* fall through */ }
        break;
      }
    }
  }
  throw new Error("Model did not return valid JSON.");
}

/** Call expecting strict JSON; requests JSON mode + reasoning-off, one stronger retry. */
export async function callJSON(opts, _retry = true) {
  const text = await callLLM({ json: true, reasoningOff: true, ...opts });
  try {
    return parseJsonLoose(text);
  } catch (e) {
    if (_retry) {
      const user = (opts.user || "") +
        "\n\nYour previous reply was not valid JSON. Reply with ONLY a single JSON object, " +
        "starting with { and ending with }. No prose, no markdown, no code fences.";
      return callJSON({ ...opts, user, temperature: 0, json: true }, false);
    }
    throw e;
  }
}

/* ------------------------------ settings UI ------------------------------- */

/**
 * Reusable provider/key/model settings panel (a <details>). Shared by the Ask
 * page and the linker. `onChange` fires after save/clear/provider switch.
 */
export function renderProviderSettings(onChange = () => {}) {
  const wrap = el("details", { class: "llm-settings" });
  const summary = el("summary", {});
  wrap.appendChild(summary);

  wrap.appendChild(el("p", { class: "chat-warn" }, [
    "⚠ Your API key stays in THIS browser and is sent directly to the provider, billed to your account. ",
    "A static site cannot hide secrets — use your own key on a site you trust, never a shared/production key.",
  ]));

  const provSel = el("select", { class: "llm-field" });
  PROVIDER_LIST.forEach((p) => provSel.appendChild(el("option", { value: p.id }, [p.label])));
  provSel.value = getProvider();

  const keyInput = el("input", { type: "password", class: "llm-field", autocomplete: "off" });
  const modelInput = el("input", { type: "text", class: "llm-field" });
  const remember = el("input", { type: "checkbox", id: "llm-remember" });
  const rememberLabel = el("label", { for: "llm-remember", class: "chat-consent" }, [remember, el("span", {}, [" Remember on this device (less safe than session-only)"])]);
  const corsNote = el("p", { class: "muted llm-cors" }, []);
  const modelHint = el("p", { class: "muted llm-hint" }, []);
  const tierSel = el("select", { class: "llm-field" });
  tierSel.appendChild(el("option", { value: "free" }, ["Free key — safe pacing"]));
  tierSel.appendChild(el("option", { value: "paid" }, ["Paid tier — fast"]));
  tierSel.value = getRateTier();
  tierSel.addEventListener("change", () => setRateTier(tierSel.value));
  const status = el("span", { class: "chat-status" });

  function sync() {
    const pid = provSel.value;
    const p = PROVIDERS[pid];
    keyInput.value = getKey(pid);
    keyInput.placeholder = p.keyHint || "API key";
    modelInput.value = getModel(pid);
    corsNote.textContent = p.corsNote || "";
    modelHint.textContent = p.modelHint || "";
    summary.textContent = hasCreds(pid) ? `AI provider: ${p.label} (key set)` : `AI provider: ${p.label} — add your key`;
  }
  provSel.addEventListener("change", () => { setProvider(provSel.value); sync(); onChange(); });

  const saveBtn = el("button", { type: "button", class: "chat-btn" }, ["Save"]);
  saveBtn.addEventListener("click", () => {
    const pid = provSel.value;
    setProvider(pid);
    setKey(pid, keyInput.value.trim(), remember.checked);
    setModel(pid, modelInput.value.trim());
    sync();
    status.textContent = remember.checked ? "Saved on this device." : "Saved for this session.";
    onChange();
  });
  const clearBtn = el("button", { type: "button", class: "link-btn" }, ["Clear key"]);
  clearBtn.addEventListener("click", () => { clearKey(provSel.value); keyInput.value = ""; sync(); status.textContent = "Key cleared."; onChange(); });

  wrap.appendChild(el("label", { class: "field-label" }, ["Provider"]));
  wrap.appendChild(provSel);
  wrap.appendChild(el("label", { class: "field-label" }, ["API key (your own)"]));
  wrap.appendChild(keyInput);
  wrap.appendChild(el("label", { class: "field-label" }, ["Model"]));
  wrap.appendChild(modelInput);
  wrap.appendChild(modelHint);
  wrap.appendChild(el("label", { class: "field-label" }, ["Rate tier (request pacing)"]));
  wrap.appendChild(tierSel);
  wrap.appendChild(el("p", { class: "muted llm-hint" }, [
    "Free = paced for free-tier limits (~10–15 req/min). Paid = Gemini Tier 1+ (fast). Affects only request spacing.",
  ]));
  wrap.appendChild(rememberLabel);
  wrap.appendChild(corsNote);
  wrap.appendChild(el("div", { class: "chat-actions" }, [saveBtn, clearBtn, status]));
  sync();
  return wrap;
}
