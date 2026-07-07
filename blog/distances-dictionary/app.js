// Entry point: load data, wire the toolbar, route between views, manage the
// compare selection and the optional AI layers. No build step — plain ES module.

import { loadData } from "./modules/data.js";
import { parseHash, onRoute } from "./modules/router.js";
import { renderHome, renderDetail, renderCompare, renderNotFound, renderTypesView, renderContribute } from "./modules/render.js";
import {
  filterFromParams, filterToParams, emptyFilterState,
} from "./modules/filters.js";
import { answer, renderAnswer } from "./modules/assistant.js";
import { search } from "./modules/search.js";
import { renderChatPanel, askModel, hasToken, linkify } from "./modules/chat.js";
import { renderLinker } from "./modules/linkerView.js";
import { enableSemantic, ranker, prepareQuery, isReady, isLoading } from "./modules/embeddings.js";
import { typeset } from "./modules/mathjax.js";
import { el, debounce } from "./modules/util.js";

const appEl = document.getElementById("app");
const searchInput = document.getElementById("global-search");
const aiBtn = document.getElementById("ai-enable");
const aiStatus = document.getElementById("ai-status");

const app = {
  db: null,
  state: {
    query: "",
    filters: emptyFilterState(),
    compare: new Set(),
    semanticEnabled: false,
    aiReply: null, // { forQuery, status: 'loading'|'done'|'error', html, model, entries, error }
  },

  isHome() {
    return parseHash().parts.length === 0;
  },

  async setQuery(q) {
    if (q !== this.state.query) this.state.aiReply = null; // drop a stale generated answer
    this.state.query = q;
    if (searchInput && searchInput.value !== q) searchInput.value = q;
    if (this.state.semanticEnabled) {
      try { await prepareQuery(q); } catch (_) { /* ignore */ }
    }
    if (this.isHome()) route();
    else location.hash = "#/";
  },

  // Enter/submit: set the query, then (if AI on, a token is set, and the query is
  // on-topic) generate a full LLM answer grounded in our measures.
  async submitQuery(q) {
    await this.setQuery(q);
    if (!this.state.semanticEnabled || !hasToken() || !q.trim()) return;
    const sr = search(this.db, q, { semantic: this.semanticRanker() });
    if (!sr.relevant) return; // off-topic -> no model call
    this.state.aiReply = { forQuery: q, status: "loading" };
    if (this.isHome()) route(); else location.hash = "#/";
    try {
      const { text, entries, model } = await askModel(this.db, q, 5);
      if (this.state.query !== q) return; // query changed while waiting
      this.state.aiReply = { forQuery: q, status: "done", html: linkify(this.db, text), model, entries };
    } catch (err) {
      if (this.state.query !== q) return;
      this.state.aiReply = { forQuery: q, status: "error", error: String(err && err.message ? err.message : err) };
    }
    if (this.isHome()) route();
  },

  // Safety net: embed a query that reached render unembedded, then re-render once.
  ensureQueryEmbedded(q) {
    if (this._embedding === q) return;
    this._embedding = q;
    prepareQuery(q)
      .then(() => { this._embedding = null; if (this.isHome() && this.state.query === q) route(); })
      .catch(() => { this._embedding = null; });
  },

  currentFilters() {
    return filterFromParams(parseHash().params);
  },

  toggleFilter(facet, value) {
    const f = this.currentFilters();
    if (f[facet].has(value)) f[facet].delete(value);
    else f[facet].add(value);
    const qs = filterToParams(f).toString();
    location.hash = qs ? "#/?" + qs : "#/";
  },

  clearFilters() {
    location.hash = "#/";
  },

  inCompare(id) {
    return this.state.compare.has(id);
  },

  toggleCompare(id) {
    const set = this.state.compare;
    if (set.has(id)) set.delete(id);
    else {
      if (set.size >= 4) {
        flashCompare("You can compare up to 4 measures.");
        return;
      }
      set.add(id);
    }
    renderCompareBar();
    route(); // refresh buttons in the current view
  },

  semanticRanker() {
    return ranker();
  },

  // Load the in-browser embedding model and switch search into semantic mode.
  // Idempotent; reused by the toolbar button and the empty-state prompt.
  async enableSemanticSearch() {
    if (this.state.semanticEnabled || isLoading()) return;
    if (aiBtn) aiBtn.disabled = true;
    try {
      await enableSemantic(this.db, (info) => {
        if (!aiStatus) return;
        if (info.status === "ready") aiStatus.textContent = "";
        else if (info.progress) aiStatus.textContent = `${info.status} ${Math.round(info.progress)}%`;
        else aiStatus.textContent = info.status;
      });
      this.state.semanticEnabled = true;
      if (aiBtn) { aiBtn.textContent = "AI search on"; aiBtn.classList.add("on"); aiBtn.disabled = true; }
      if (aiStatus) aiStatus.textContent = "";
      if (this.state.query) { try { await prepareQuery(this.state.query); } catch (_) { /* ignore */ } }
      route();
    } catch (_) {
      if (aiBtn) aiBtn.disabled = false;
      if (aiStatus) aiStatus.textContent = "AI unavailable (offline?) — lexical search still works.";
    }
  },
};

/* ------------------------------- compare bar ------------------------------ */

let compareBar = null;
function ensureCompareBar() {
  if (compareBar) return compareBar;
  compareBar = el("div", { id: "compare-bar", class: "compare-bar", role: "region", "aria-label": "Comparison tray" });
  document.body.appendChild(compareBar);
  return compareBar;
}
function flashCompare(msg) {
  const bar = ensureCompareBar();
  bar.classList.add("show");
  bar.innerHTML = "";
  bar.appendChild(el("span", { class: "cmp-msg" }, [msg]));
  setTimeout(renderCompareBar, 1600);
}
function renderCompareBar() {
  const bar = ensureCompareBar();
  const ids = [...app.state.compare];
  if (ids.length === 0) { bar.classList.remove("show"); bar.innerHTML = ""; return; }
  bar.classList.add("show");
  bar.innerHTML = "";
  const names = ids.map((id) => app.db.byId.get(id)?.canonical_name).filter(Boolean);
  bar.appendChild(el("span", { class: "cmp-count" }, [`${ids.length} selected: `]));
  bar.appendChild(el("span", { class: "cmp-names" }, [names.join(" · ")]));
  const open = el("a", { class: "cmp-open", href: `#/compare?ids=${ids.join(",")}` }, ["Compare →"]);
  if (ids.length < 2) { open.classList.add("disabled"); open.removeAttribute("href"); open.title = "Select at least 2"; }
  const clear = el("button", { type: "button", class: "link-btn" }, ["Clear"]);
  clear.addEventListener("click", () => { app.state.compare.clear(); renderCompareBar(); route(); });
  bar.appendChild(open);
  bar.appendChild(clear);
}

/* --------------------------------- ask page ------------------------------- */

function renderAsk() {
  const root = el("div", { class: "ask" });
  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  root.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, ["Ask the dictionary"]));
  root.appendChild(el("p", { class: "detail-lead" }, [
    "Two ways to ask: an instant rule-based assistant (no model, always on), and an optional AI chat that uses your own HuggingFace token.",
  ]));

  // Layer 1: deterministic assistant.
  const l1 = el("section", { class: "assistant-panel" });
  l1.appendChild(el("h2", {}, ["Instant assistant (no model)"]));
  const input = el("input", { type: "text", class: "ask-input", placeholder: "e.g. I have covariance matrices. Which distance should I use?" });
  const askBtn = el("button", { type: "button", class: "chat-btn primary" }, ["Ask"]);
  const out = el("div", { class: "assistant-out" });
  const run = () => {
    const q = input.value.trim();
    if (!q) return;
    out.innerHTML = "";
    out.appendChild(renderAnswer(app.db, answer(app.db, q)));
    typeset(out);
  };
  askBtn.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  l1.appendChild(el("div", { class: "ask-row" }, [input, askBtn]));
  const examples = el("div", { class: "examples" }, [
    "I need a bounded metric for probability distributions",
    "What is the difference between Wasserstein and MMD?",
    "Is Jeffreys divergence bounded?",
    "Which distances compare metric spaces up to isometry?",
  ].map((q) => {
    const b = el("button", { type: "button", class: "example-chip" }, [q]);
    b.addEventListener("click", () => { input.value = q; run(); });
    return b;
  }));
  l1.appendChild(examples);
  l1.appendChild(out);
  root.appendChild(l1);

  // Layer 3: BYO-token chat (also benefits from Layer 2 if enabled).
  root.appendChild(renderChatPanel(app.db));
  return root;
}

/* --------------------------------- routing -------------------------------- */

function updateNav(active) {
  document.querySelectorAll("[data-route]").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-route") === active);
  });
}

function route() {
  if (!app.db) return;
  const { parts, params } = parseHash();
  appEl.innerHTML = "";
  let view;
  let active = "home";

  if (parts.length === 0) {
    app.state.filters = filterFromParams(params);
    view = renderHome(app.db, app);
  } else if (parts[0] === "measure" || parts[0] === "m") {
    // "#/m/:id" is the stable permalink (used by the linker); "#/measure/:id" kept.
    const m = app.db.byId.get(parts[1]);
    view = m ? renderDetail(app.db, app, m) : renderNotFound(`No measure with id “${parts[1] || ""}”.`);
    active = "";
  } else if (parts[0] === "compare") {
    const ids = (params.get("ids") || "").split(",").filter(Boolean);
    ids.forEach((id) => app.state.compare.add(id));
    view = renderCompare(app.db, app, ids);
    active = "";
  } else if (parts[0] === "types") {
    view = renderTypesView(app.db, app);
    active = "types";
  } else if (parts[0] === "ask") {
    view = renderAsk();
    active = "ask";
  } else if (parts[0] === "linker") {
    view = renderLinker(app.db, app);
    active = "linker";
  } else if (parts[0] === "contribute") {
    view = renderContribute(app.db);
    active = "contribute";
  } else {
    view = renderNotFound();
    active = "";
  }

  appEl.appendChild(view);
  window.scrollTo(0, 0);
  updateNav(active);
  renderCompareBar();

  const heading = appEl.querySelector("#route-heading");
  if (heading && typeof heading.focus === "function") heading.focus({ preventScroll: true });

  typeset(appEl);
}

/* --------------------------------- AI button ------------------------------ */

function wireAiButton() {
  if (!aiBtn) return;
  aiBtn.addEventListener("click", () => app.enableSemanticSearch());
}

/* ----------------------------------- init --------------------------------- */

function showDataError(err) {
  appEl.innerHTML = "";
  const box = el("div", { class: "data-error" });
  box.appendChild(el("h2", {}, ["Could not load the dictionary data"]));
  box.appendChild(el("p", {}, [
    "If you opened this file directly (file://), the browser blocks loading the JSON data. ",
    "Run a local server from the repository root and open it over http:",
  ]));
  box.appendChild(el("pre", { class: "code-block" }, [
    el("code", {}, ["python3 -m http.server 8000\n# then open http://localhost:8000/blog/distances-dictionary/"]),
  ]));
  box.appendChild(el("p", { class: "muted" }, [String(err && err.message ? err.message : err)]));
  appEl.appendChild(box);
}

async function init() {
  if (searchInput) {
    searchInput.addEventListener("input", debounce(() => app.setQuery(searchInput.value), 160));
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") app.submitQuery(searchInput.value);
    });
  }
  wireAiButton();

  try {
    app.db = await loadData();
  } catch (err) {
    showDataError(err);
    return;
  }
  onRoute(route);
  route();
}

init();
