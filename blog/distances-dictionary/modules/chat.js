// Grounded natural-language Q&A using the user's own AI provider (see llm.js).
// The answer is grounded by retrieval (RAG) over the local dictionary and links
// back to detail pages. Shared by the Ask page and the home "Press Enter" reply.

import { el, escapeHTML } from "./util.js";
import { search } from "./search.js";
import { isReady as semanticReady, nearest } from "./embeddings.js";
import { callLLM, hasCreds, getModel, renderProviderSettings } from "./llm.js";

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

function buildPrompt(db, question, entries) {
  const context = entries.map((m) => serializeEntry(db, m)).join("\n\n");
  const system =
    "You are an assistant for an interactive dictionary of distances and divergences. " +
    "Answer using ONLY the provided dictionary entries unless the user explicitly asks for general intuition. " +
    "If the entries do not contain the answer, say which information is missing. " +
    "Refer to measures by their exact canonical name so they can be linked. " +
    "Structure your answer as: 1) direct recommendation, 2) reason, 3) caveats, 4) related measures.";
  const user = `User question:\n${question}\n\nRelevant dictionary entries:\n${context}`;
  return { system, user };
}

/* ----------------------- reusable generation (exported) ------------------- */

/** True if the selected provider has a key configured. */
export function hasToken() {
  return hasCreds();
}

/** The current model id of the selected provider. */
export function currentModel() {
  return getModel();
}

/**
 * Retrieve grounding entries, build the RAG prompt, and call the user's provider.
 * @returns {Promise<{text:string, entries:object[], model:string}>}
 */
export async function askModel(db, question, k = 5) {
  if (!hasCreds()) throw new Error("No API key set. Add your provider key in AI settings.");
  const entries = await retrieve(db, question, k);
  const { system, user } = buildPrompt(db, question, entries);
  const text = await callLLM({ system, user, maxTokens: 800, temperature: 0.2 });
  return { text, entries, model: getModel() };
}

/* ------------------------------- linkify ---------------------------------- */

export function linkify(db, text) {
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
      return id ? `<a href="#/m/${id}">${match}</a>` : match;
    });
  }
  return html.replace(/\n/g, "<br>");
}

/* --------------------------------- panel ---------------------------------- */

export function renderChatPanel(db) {
  const panel = el("section", { class: "chat-panel", "aria-label": "Ask the dictionary" });
  panel.appendChild(el("h2", {}, ["Ask with AI (optional)"]));
  panel.appendChild(el("p", { class: "muted" }, [
    "Connect your own AI provider (Claude, OpenRouter, Gemini, or Hugging Face). Answers are grounded in this dictionary and link to the relevant pages.",
  ]));

  panel.appendChild(renderProviderSettings());

  const question = el("textarea", { class: "chat-question", rows: "3", placeholder: "e.g. What's the difference between Wasserstein and MMD?" });
  const askBtn = el("button", { type: "button", class: "chat-btn primary" }, ["Ask"]);
  const status = el("div", { class: "chat-status" });
  const answer = el("div", { class: "chat-answer" });

  const doAsk = async () => {
    const q = question.value.trim();
    if (!q) return;
    if (!hasCreds()) { status.textContent = "Add your provider API key in AI settings above."; return; }
    askBtn.disabled = true;
    answer.innerHTML = "";
    status.textContent = "Querying your AI provider…";
    try {
      const { text, entries } = await askModel(db, q, 5);
      status.textContent = "";
      answer.innerHTML = linkify(db, text);
      if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise([answer]).catch(() => {});
      answer.appendChild(el("p", { class: "chat-sources" }, [
        "Grounded in: ",
        ...entries.flatMap((m, i) => [
          i ? document.createTextNode(", ") : null,
          el("a", { href: `#/m/${m.id}` }, [m.canonical_name]),
        ].filter(Boolean)),
      ]));
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
