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
    buildRequest({ key, model, system, user, maxTokens, temperature }) {
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
    corsNote: "One key fronts many models (Claude, GPT, Gemini, Llama…). Browser-friendly.",
    buildRequest({ key, model, system, user, maxTokens, temperature, json }) {
      return {
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: {
          model, max_tokens: maxTokens, temperature,
          ...(json ? { response_format: { type: "json_object" } } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        },
      };
    },
    parseText: (d) => d.choices?.[0]?.message?.content || "",
  },

  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-2.0-flash",
    keyHint: "AIza… (Google AI Studio key)",
    corsNote: "Gemini REST API, callable from the browser with your key.",
    buildRequest({ key, model, system, user, maxTokens, temperature, json }) {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        headers: { "content-type": "application/json" },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature, ...(json ? { responseMimeType: "application/json" } : {}) },
        },
      };
    },
    parseText: (d) => (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""),
  },

  huggingface: {
    label: "Hugging Face",
    defaultModel: "meta-llama/Llama-3.2-3B-Instruct",
    keyHint: "hf_…",
    corsNote: "Free-tier friendly HF Inference router (OpenAI-compatible).",
    buildRequest({ key, model, system, user, maxTokens, temperature, json }) {
      return {
        url: "https://router.huggingface.co/v1/chat/completions",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: {
          model, max_tokens: maxTokens, temperature,
          ...(json ? { response_format: { type: "json_object" } } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
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

/* --------------------------------- calls ---------------------------------- */

/** Call the selected provider. Returns the assistant text. Throws on error. */
export async function callLLM({ system = "", user = "", maxTokens = 1500, temperature = 0.2, json = false, signal } = {}) {
  const pid = getProvider();
  const p = PROVIDERS[pid];
  if (!p) throw new Error(`Unknown provider: ${pid}`);
  const key = getKey(pid);
  if (!key) throw new Error(`No API key set for ${p.label}.`);
  const model = getModel(pid);

  const attempt = async (useJson) => {
    const { url, headers, body } = p.buildRequest({ key, model, system, user, maxTokens, temperature, json: useJson });
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = j.error?.message || (typeof j.error === "string" ? j.error : "") || JSON.stringify(j).slice(0, 300); }
      catch (_) { detail = await res.text().catch(() => ""); }
      let msg;
      if (res.status === 401 || res.status === 403) msg = `Auth failed (${res.status}) for ${p.label}. Check your API key / model access. ${detail}`;
      else if (res.status === 0) msg = `${p.label} call blocked (CORS or network). ${p.corsNote || ""}`;
      else msg = `${p.label} request failed (${res.status}). ${detail}`;
      const err = new Error(msg);
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return p.parseText(await res.json());
  };

  try {
    return await attempt(json);
  } catch (e) {
    // Defensive: if JSON mode is what the model/route rejected, retry without it.
    const d = `${e && e.detail || ""} ${e && e.message || ""}`.toLowerCase();
    if (json && e && e.status >= 400 && e.status < 500 && /response_format|json|unsupported|not support/.test(d)) {
      return attempt(false);
    }
    throw e;
  }
}

/** Strip code fences / surrounding prose and JSON.parse. */
export function parseJsonLoose(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* fall through */ } }
  throw new Error("Model did not return valid JSON.");
}

/** Call expecting strict JSON; requests JSON mode, one stronger retry on failure. */
export async function callJSON(opts, _retry = true) {
  const text = await callLLM({ json: true, ...opts });
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
  const status = el("span", { class: "chat-status" });

  function sync() {
    const pid = provSel.value;
    const p = PROVIDERS[pid];
    keyInput.value = getKey(pid);
    keyInput.placeholder = p.keyHint || "API key";
    modelInput.value = getModel(pid);
    corsNote.textContent = p.corsNote || "";
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
  wrap.appendChild(rememberLabel);
  wrap.appendChild(corsNote);
  wrap.appendChild(el("div", { class: "chat-actions" }, [saveBtn, clearBtn, status]));
  sync();
  return wrap;
}
