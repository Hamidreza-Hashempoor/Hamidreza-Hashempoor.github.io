// Layer 3 (optional): natural-language Q&A using a user-provided HuggingFace
// Inference token. The static site cannot hold secrets, so the token is BYO:
// entered in the browser, kept in memory by default, and only written to
// localStorage with explicit consent. Answers are grounded by retrieval (RAG)
// over the local database and link back to detail pages.

import { el, escapeHTML, normalize } from "./util.js";
import { search } from "./search.js";
import { isReady as semanticReady, nearest } from "./embeddings.js";

const ENDPOINT = "https://router.huggingface.co/v1/chat/completions";
const TOKEN_KEY = "dd_hf_token";
const MODEL_KEY = "dd_hf_model";
const DEFAULT_MODEL = "meta-llama/Llama-3.2-3B-Instruct";

let memToken = null;

/* ------------------------------ token storage ----------------------------- */

function safeLocal(get) {
  try { return get(localStorage); } catch (_) { return null; }
}
export function getToken() {
  return memToken || safeLocal((ls) => ls.getItem(TOKEN_KEY)) || "";
}
export function setToken(token, persist) {
  memToken = token || null;
  if (persist && token) safeLocal((ls) => ls.setItem(TOKEN_KEY, token));
  else safeLocal((ls) => ls.removeItem(TOKEN_KEY));
}
export function clearToken() {
  memToken = null;
  safeLocal((ls) => ls.removeItem(TOKEN_KEY));
}
function getModel() {
  return safeLocal((ls) => ls.getItem(MODEL_KEY)) || DEFAULT_MODEL;
}
function setModel(m) {
  if (m) safeLocal((ls) => ls.setItem(MODEL_KEY, m));
}

/* -------------------------------- retrieval ------------------------------- */

async function retrieve(db, question, k = 5) {
  if (semanticReady()) {
    const ms = await nearest(db, question, k);
    if (ms.length) return ms;
  }
  return search(db, question).results.slice(0, k).map((r) => r.measure);
}

function serializeEntry(db, m) {
  const props = Object.entries(m.properties || {})
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .join(", ");
  return [
    `### ${m.canonical_name} (id: ${m.id})`,
    m.aliases && m.aliases.length ? `Aliases: ${m.aliases.join(", ")}` : null,
    `Description: ${m.short_description || ""}`,
    m.formula_plaintext ? `Formula: ${m.formula_plaintext}` : null,
    props ? `Properties: ${props}` : null,
    m.range ? `Range: ${m.range}` : null,
    m.when_to_use ? `When to use: ${m.when_to_use}` : null,
    m.when_not_to_use ? `When not to use: ${m.when_not_to_use}` : null,
  ].filter(Boolean).join("\n");
}

function buildMessages(db, question, entries) {
  const context = entries.map((m) => serializeEntry(db, m)).join("\n\n");
  const system =
    "You are an assistant for an interactive dictionary of distances and divergences. " +
    "Answer using ONLY the provided dictionary entries unless the user explicitly asks for general intuition. " +
    "If the entries do not contain the answer, say which information is missing. " +
    "Refer to measures by their exact canonical name so they can be linked. " +
    "Structure your answer as: 1) direct recommendation, 2) reason, 3) caveats, 4) related measures.";
  const user = `User question:\n${question}\n\nRelevant dictionary entries:\n${context}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/* ---------------------------------- call ---------------------------------- */

async function callModel(messages, token, model) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: 700, temperature: 0.2, stream: false }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch (_) { detail = await res.text().catch(() => ""); }
    if (res.status === 401) throw new Error("Invalid or missing token (401). Check your HuggingFace access token.");
    if (res.status === 402 || res.status === 403) throw new Error(`Access denied for this model (${res.status}). Try a different model or check provider access. ${detail}`);
    throw new Error(`Request failed (${res.status}). ${detail}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "(empty response)";
}

/* ------------------------------- linkify ---------------------------------- */

function linkifyAnswer(db, text) {
  const map = new Map();
  const names = [];
  for (const m of db.measures) {
    const base = m.canonical_name.replace(/\s*\(.*?\)\s*/g, " ").trim();
    [base, ...(m.aliases || [])].forEach((n) => {
      if (n && n.length >= 4) {
        const esc = escapeHTML(n);
        map.set(esc.toLowerCase(), m.id);
        names.push(esc);
      }
    });
  }
  names.sort((a, b) => b.length - a.length);
  const pattern = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  let html = escapeHTML(text);
  if (pattern) {
    const re = new RegExp("(" + pattern + ")", "gi");
    html = html.replace(re, (match) => {
      const id = map.get(match.toLowerCase());
      return id ? `<a href="#/measure/${id}">${match}</a>` : match;
    });
  }
  return html.replace(/\n/g, "<br>");
}

/* --------------------------------- panel ---------------------------------- */

export function renderChatPanel(db) {
  const panel = el("section", { class: "chat-panel", "aria-label": "Ask the dictionary (BYO token)" });
  panel.appendChild(el("h2", {}, ["Ask with AI (optional)"]));
  panel.appendChild(el("p", { class: "muted" }, [
    "Bring your own free HuggingFace token to ask in natural language. Answers are grounded in this dictionary and link to the relevant pages.",
  ]));

  // Settings (token).
  const settings = el("details", { class: "chat-settings" });
  settings.appendChild(el("summary", {}, [getToken() ? "AI settings (token saved)" : "AI settings — add token"]));
  const warn = el("p", { class: "chat-warn" }, [
    "⚠ A static site cannot protect secrets. Use a free, low-scope token, never a production key. ",
    "The token is kept only in this browser.",
  ]);
  const tokenInput = el("input", { type: "password", class: "chat-input-field", placeholder: "hf_… access token", autocomplete: "off" });
  tokenInput.value = getToken();
  const persist = el("input", { type: "checkbox", id: "chat-persist" });
  const persistLabel = el("label", { for: "chat-persist", class: "chat-consent" }, [persist, el("span", {}, [" Remember on this device (localStorage)"])]);
  const modelInput = el("input", { type: "text", class: "chat-input-field", placeholder: "model id" });
  modelInput.value = getModel();

  const saveBtn = el("button", { type: "button", class: "chat-btn" }, ["Save"]);
  const clearBtn = el("button", { type: "button", class: "link-btn" }, ["Clear token"]);
  const settingsStatus = el("span", { class: "chat-status" });
  saveBtn.addEventListener("click", () => {
    setToken(tokenInput.value.trim(), persist.checked);
    setModel(modelInput.value.trim() || DEFAULT_MODEL);
    settingsStatus.textContent = persist.checked ? "Saved (remembered on this device)." : "Saved for this session.";
    settings.querySelector("summary").textContent = "AI settings (token saved)";
  });
  clearBtn.addEventListener("click", () => {
    clearToken();
    tokenInput.value = "";
    settingsStatus.textContent = "Token cleared.";
  });

  settings.appendChild(warn);
  settings.appendChild(el("label", { class: "field-label" }, ["HuggingFace token"]));
  settings.appendChild(tokenInput);
  settings.appendChild(persistLabel);
  settings.appendChild(el("label", { class: "field-label" }, ["Model id (HF Inference)"]));
  settings.appendChild(modelInput);
  settings.appendChild(el("div", { class: "chat-actions" }, [saveBtn, clearBtn, settingsStatus]));
  panel.appendChild(settings);

  // Question box.
  const question = el("textarea", { class: "chat-question", rows: "3", placeholder: "e.g. What's the difference between Wasserstein and MMD?" });
  const askBtn = el("button", { type: "button", class: "chat-btn primary" }, ["Ask"]);
  const status = el("div", { class: "chat-status" });
  const answer = el("div", { class: "chat-answer" });

  const doAsk = async () => {
    const q = question.value.trim();
    if (!q) return;
    const token = getToken();
    if (!token) {
      status.textContent = "Add a HuggingFace token in AI settings first.";
      settings.open = true;
      return;
    }
    askBtn.disabled = true;
    answer.innerHTML = "";
    status.textContent = "Retrieving entries and querying the model…";
    try {
      const entries = await retrieve(db, q, 5);
      const messages = buildMessages(db, q, entries);
      const text = await callModel(messages, token, getModel());
      status.textContent = "";
      answer.innerHTML = linkifyAnswer(db, text);
      // Re-typeset any LaTeX the model produced.
      if (window.MathJax && window.MathJax.typesetPromise) {
        window.MathJax.typesetPromise([answer]).catch(() => {});
      }
      const src = el("p", { class: "chat-sources" }, [
        "Grounded in: ",
        ...entries.flatMap((m, i) => [
          i ? document.createTextNode(", ") : null,
          el("a", { href: `#/measure/${m.id}` }, [m.canonical_name]),
        ].filter(Boolean)),
      ]);
      answer.appendChild(src);
    } catch (err) {
      status.textContent = "";
      answer.appendChild(el("p", { class: "chat-error" }, [String(err.message || err)]));
    } finally {
      askBtn.disabled = false;
    }
  };

  askBtn.addEventListener("click", doAsk);
  question.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") doAsk();
  });

  panel.appendChild(question);
  panel.appendChild(el("div", { class: "chat-actions" }, [askBtn, status]));
  panel.appendChild(answer);
  return panel;
}
