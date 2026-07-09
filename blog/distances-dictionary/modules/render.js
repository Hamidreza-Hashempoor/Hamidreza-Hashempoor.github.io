// DOM builders for every route: home (search + filters + results), measure
// detail, comparison table, and the result card / filter rail components.
// Render functions receive the `app` controller (app.js) for callbacks.

import { el, chip, escapeHTML } from "./util.js";
import {
  PROPERTY_LABELS, OBJECT_TYPE_LABELS, APPLICATION_LABELS, familyLabel,
} from "./data.js";
import { search } from "./search.js";
import { converse, renderAnswer } from "./assistant.js";
import { hasToken } from "./chat.js";
import { applyFilters, isFilterActive, filterCount } from "./filters.js";
import { renderCodePanel } from "./codegen.js";
import { renderGraph, svg } from "./graph.js";
import { editUrl, editCardIssueUrl, newCardIssueUrl, blobUrl } from "./config.js";
import { parseHash, buildHash } from "./router.js";

const KEY_PROPERTIES = ["symmetric", "bounded", "metric", "nonnegative"];

export const EXAMPLE_QUERIES = [
  "What is EMD also called?",
  "symmetric bounded divergence",
  "I have SPD covariance matrices",
  "probability vector metric",
  "WGAN distance",
  "MCMC diagnostic",
];

/* ------------------------------- shared bits ------------------------------ */

function aliasChips(measure, max = 4) {
  const aliases = (measure.aliases || []).slice(0, max);
  if (!aliases.length) return null;
  return el("div", { class: "chips" }, aliases.map((a) => chip(a, { variant: "alias" })));
}

function familyChips(db, measure) {
  const fams = measure.family || [];
  if (!fams.length) return null;
  return el("div", { class: "chips" }, fams.map((f) =>
    chip(familyLabel(db, f), { variant: "family", href: `#/?families=${encodeURIComponent(f)}` })
  ));
}

function typeChips(measure) {
  const types = measure.input_types || [];
  if (!types.length) return null;
  return el("div", { class: "chips" }, types.map((t) =>
    chip(OBJECT_TYPE_LABELS[t] || t, { variant: "type" })
  ));
}

function propertyBadges(measure) {
  const props = measure.properties || {};
  const badges = [];
  for (const key of KEY_PROPERTIES) {
    if (!(key in props)) continue;
    const yes = props[key] === true;
    badges.push(el("span", {
      class: "badge " + (yes ? "badge-yes" : "badge-no"),
      title: PROPERTY_LABELS[key],
    }, [(yes ? "✓ " : "✗ ") + PROPERTY_LABELS[key]]));
  }
  if (props.sqrt_metric === true && props.metric !== true) {
    badges.push(el("span", { class: "badge badge-soft", title: PROPERTY_LABELS.sqrt_metric }, ["√ is a metric"]));
  }
  return badges.length ? el("div", { class: "badges" }, badges) : null;
}

/* -------------------------------- result card ----------------------------- */

export function renderResultCard(db, app, measure) {
  const card = el("article", { class: "card" });
  const head = el("div", { class: "card-head" }, [
    el("a", { class: "card-title", href: `#/measure/${measure.id}` }, [measure.canonical_name]),
  ]);

  const cmp = el("button", {
    type: "button",
    class: "cmp-toggle" + (app.inCompare(measure.id) ? " on" : ""),
    title: "Add to comparison",
    "aria-pressed": app.inCompare(measure.id) ? "true" : "false",
  }, [app.inCompare(measure.id) ? "✓ Compare" : "+ Compare"]);
  cmp.addEventListener("click", () => app.toggleCompare(measure.id));
  head.appendChild(cmp);

  card.appendChild(head);
  if (measure.aliases && measure.aliases.length) {
    card.appendChild(el("div", { class: "card-aliases" }, ["a.k.a. " + measure.aliases.slice(0, 3).join(", ")]));
  }
  card.appendChild(el("p", { class: "card-desc" }, [measure.short_description || ""]));
  const meta = el("div", { class: "card-meta" });
  const fam = familyChips(db, measure);
  if (fam) meta.appendChild(fam);
  const badges = propertyBadges(measure);
  if (badges) meta.appendChild(badges);
  card.appendChild(meta);
  return card;
}

/* --------------------------------- home ----------------------------------- */

function renderFilterRail(db, app) {
  const rail = el("aside", { class: "filter-rail", "aria-label": "Filters" });
  const header = el("div", { class: "filter-head" }, [el("h2", {}, ["Filters"])]);
  if (isFilterActive(app.state.filters)) {
    const clear = el("button", { type: "button", class: "link-btn" }, [`Clear (${filterCount(app.state.filters)})`]);
    clear.addEventListener("click", () => app.clearFilters());
    header.appendChild(clear);
  }
  rail.appendChild(header);

  const group = (title, facet, values, labelFn) => {
    if (!values.length) return;
    const box = el("details", { class: "filter-group", open: "" });
    box.appendChild(el("summary", {}, [title]));
    const list = el("div", { class: "filter-options" });
    values.forEach((v) => {
      const id = `f-${facet}-${v}`;
      const checked = app.state.filters[facet].has(v);
      const input = el("input", { type: "checkbox", id });
      input.checked = checked;
      input.addEventListener("change", () => app.toggleFilter(facet, v));
      const label = el("label", { for: id, class: "filter-opt" }, [input, el("span", {}, [labelFn(v)])]);
      list.appendChild(label);
    });
    box.appendChild(list);
    rail.appendChild(box);
  };

  group("Object type", "inputTypes", db.allInputTypes, (v) => OBJECT_TYPE_LABELS[v] || v);
  group("Property", "properties", db.allProperties, (v) => PROPERTY_LABELS[v] || v);
  group("Family", "families", db.allFamilies, (v) => familyLabel(db, v));
  group("Application", "applications", db.allApplications, (v) => APPLICATION_LABELS[v] || v);
  return rail;
}

function renderEmptyState(app) {
  const wrap = el("div", { class: "empty empty-state" });
  const hasQuery = !!app.state.query;
  const filtered = isFilterActive(app.state.filters);
  if (hasQuery && !app.state.semanticEnabled) {
    wrap.appendChild(el("p", {}, [`No keyword match for “${app.state.query}”.`]));
    wrap.appendChild(el("p", { class: "muted" }, [
      "Turn on AI search to find measures by meaning — it understands natural-language questions, not just keywords.",
    ]));
    const btn = el("button", { type: "button", class: "ai-btn" }, ["Enable AI search"]);
    btn.addEventListener("click", () => app.enableSemanticSearch());
    wrap.appendChild(btn);
  } else if (filtered) {
    wrap.appendChild(el("p", {}, ["No measures match the current filters. Try removing some."]));
  } else {
    wrap.appendChild(el("p", {}, ["No measures match. Try a different term."]));
  }
  return wrap;
}

function exampleChips(app, queries) {
  return el("div", { class: "examples" }, queries.map((q) => {
    const b = el("button", { type: "button", class: "example-chip" }, [q]);
    b.addEventListener("click", () => app.setQuery(q));
    return b;
  }));
}

/**
 * Conversational reply shown under the search bar (only when AI search is on).
 * Returns { panel, offTopic }. When offTopic, the caller hides results.
 */
function renderConversation(db, app, query, sr) {
  const panel = el("section", { class: "ai-reply", "aria-label": "Assistant reply" });
  const conv = converse(db, query, { retrieved: sr.results.map((r) => r.measure), relevant: sr.relevant });

  if (conv.mode === "greeting") {
    panel.classList.add("greeting");
    panel.appendChild(el("p", { class: "ai-reply-text" }, [conv.text]));
    panel.appendChild(exampleChips(app, ["What is EMD also called?", "distance for covariance matrices", "bounded symmetric divergence"]));
    return { panel, offTopic: true };
  }

  const ai = app.state.aiReply;
  const matches = ai && ai.forQuery === query;
  if (matches && ai.status === "done" && ai.html) {
    const gen = el("div", { class: "ai-reply-generated" });
    gen.innerHTML = ai.html; // already escaped + linkified in app.js
    panel.appendChild(gen);
    if (ai.entries && ai.entries.length) {
      panel.appendChild(el("p", { class: "chat-sources" }, [
        "Grounded in: ",
        ...ai.entries.flatMap((m, i) => [
          i ? document.createTextNode(", ") : null,
          el("a", { href: `#/measure/${m.id}` }, [m.canonical_name]),
        ].filter(Boolean)),
      ]));
    }
    panel.appendChild(el("p", { class: "ai-reply-meta muted" }, [`Generated by ${ai.model || "your model"}, grounded in this dictionary.`]));
  } else {
    panel.appendChild(renderAnswer(db, conv.ans));
    if (hasToken()) {
      if (matches && ai.status === "loading") {
        panel.appendChild(el("p", { class: "ai-reply-loading" }, ["Generating a fuller answer…"]));
      } else if (matches && ai.status === "error") {
        panel.appendChild(el("p", { class: "chat-error" }, [ai.error || "AI generation failed."]));
      } else {
        panel.appendChild(el("p", { class: "ai-reply-hint muted" }, ["Press Enter for a full AI-written answer."]));
      }
    } else {
      panel.appendChild(el("p", { class: "ai-reply-hint muted" }, [
        "Want an answer written by an AI model? Add a free token on the ",
        el("a", { href: "#/ask" }, ["Ask AI"]),
        " page.",
      ]));
    }
  }
  return { panel, offTopic: false };
}

export function renderHome(db, app) {
  const root = el("div", { class: "home" });
  const hasQuery = !!app.state.query;

  // Run search once.
  const { exact, results, semantic, relevant } = search(db, app.state.query, {
    semantic: app.state.semanticEnabled ? app.semanticRanker() : null,
  });

  // Conversational reply (AI on + a query that is embedded). Off-topic greeting
  // hides everything else.
  if (app.state.semanticEnabled && hasQuery) {
    if (semantic) {
      const conv = renderConversation(db, app, app.state.query, { exact, results, relevant });
      root.appendChild(conv.panel);
      if (conv.offTopic) return root;
    } else if (app.ensureQueryEmbedded) {
      app.ensureQueryEmbedded(app.state.query); // embed then re-render; skip panel this pass
    }
  }

  // Hero (lead + examples) only when browsing (no query).
  if (!hasQuery) {
    const hero = el("section", { class: "hero-block" });
    hero.appendChild(el("p", { class: "hero-lead" }, [
      "Search by name, alias, formula idea, object type, property, or application. ",
      "Open a measure for its formula, properties, code, and related measures.",
    ]));
    hero.appendChild(exampleChips(app, EXAMPLE_QUERIES));
    hero.appendChild(el("p", { class: "hero-contribute" }, [
      "Missing a measure or spotted an error? ",
      el("a", { href: "#/contribute" }, ["Contribute →"]),
    ]));
    root.appendChild(hero);
  }

  // Body: filter rail + results.
  const body = el("div", { class: "home-body" });
  body.appendChild(renderFilterRail(db, app));

  const main = el("section", { class: "results-col", "aria-label": "Results" });

  let measures = results.map((r) => r.measure);
  measures = applyFilters(measures, app.state.filters);

  // Status line.
  const status = el("div", { class: "results-status" });
  if (app.state.query) {
    status.appendChild(el("span", {}, [`${measures.length} result${measures.length === 1 ? "" : "s"} for “${app.state.query}”`]));
    if (exact) {
      const m = db.byId.get(exact.id);
      status.appendChild(el("span", { class: "exact-note" }, [
        " · exact match: ",
        el("a", { href: `#/measure/${m.id}` }, [m.canonical_name]),
      ]));
    }
  } else {
    status.appendChild(el("span", {}, [`${measures.length} measures`]));
  }
  if (semantic) {
    status.appendChild(el("span", { class: "ai-on" }, [" · ranked by meaning (AI)"]));
  } else if (app.state.semanticEnabled) {
    status.appendChild(el("span", { class: "ai-on" }, [" · AI search on"]));
  }
  main.appendChild(status);

  if (measures.length === 0) {
    main.appendChild(renderEmptyState(app));
  } else {
    const grid = el("div", { class: "card-grid" });
    measures.forEach((m) => grid.appendChild(renderResultCard(db, app, m)));
    main.appendChild(grid);
  }

  body.appendChild(main);
  root.appendChild(body);
  return root;
}

/* -------------------------------- detail ---------------------------------- */

function section(title, node) {
  if (!node) return null;
  const s = el("section", { class: "detail-section" });
  if (title) s.appendChild(el("h2", {}, [title]));
  s.appendChild(node);
  return s;
}

function mathDiv(latex) {
  // textContent so MathJax (typeset later) reads raw LaTeX safely.
  const d = el("div", { class: "eq" });
  d.textContent = `$$${latex}$$`;
  return d;
}

function inlineMath(text) {
  const span = el("span", {});
  span.textContent = text; // may contain $...$ inline math
  return span;
}

function propertyTable(measure) {
  const props = measure.properties || {};
  const keys = Object.keys(props);
  if (!keys.length) return null;
  const table = el("table", { class: "prop-table" });
  const tbody = el("tbody");
  keys.forEach((k) => {
    const v = props[k];
    const val = v === true ? "Yes" : v === false ? "No" : String(v);
    tbody.appendChild(el("tr", {}, [
      el("td", { class: "prop-name" }, [PROPERTY_LABELS[k] || k]),
      el("td", { class: "prop-val " + (v === true ? "is-yes" : v === false ? "is-no" : "") }, [val]),
    ]));
  });
  table.appendChild(tbody);
  return table;
}

/** Identities / inequalities: LaTeX blocks with a note and cross-link chips. */
function renderRelations(db, title, items) {
  if (!items || !items.length) return null;
  const wrap = el("div", { class: "relations" });
  items.forEach((it) => {
    if (!it || !it.latex) return;
    const block = el("div", { class: "relation" });
    const eq = el("div", { class: "eq" });
    eq.textContent = `$$${it.latex}$$`;
    block.appendChild(eq);
    const meta = el("div", { class: "relation-meta" });
    if (it.note) meta.appendChild(el("span", { class: "relation-note" }, [it.note]));
    (it.refs || []).forEach((rid) => {
      const m = db.byId.get(rid);
      if (m) meta.appendChild(chip(m.canonical_name, { variant: "related", href: `#/m/${rid}` }));
    });
    if (meta.childNodes.length) block.appendChild(meta);
    wrap.appendChild(block);
  });
  return section(title, wrap);
}

export function renderDetail(db, app, measure) {
  const root = el("article", { class: "detail" });

  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  const head = el("header", { class: "detail-head" });
  head.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, [measure.canonical_name]));

  const cmp = el("button", {
    type: "button",
    class: "cmp-toggle" + (app.inCompare(measure.id) ? " on" : ""),
  }, [app.inCompare(measure.id) ? "✓ In comparison" : "+ Add to comparison"]);
  cmp.addEventListener("click", () => app.toggleCompare(measure.id));
  head.appendChild(cmp);
  root.appendChild(head);

  const ac = aliasChips(measure, 8);
  if (ac) root.appendChild(ac);
  const fc = familyChips(db, measure);
  if (fc) root.appendChild(fc);
  const tc = typeChips(measure);
  if (tc) root.appendChild(tc);

  if (measure.short_description) {
    root.appendChild(el("p", { class: "detail-lead" }, [measure.short_description]));
  }

  if (measure.formula_latex) root.appendChild(section("Formula", mathDiv(measure.formula_latex)));

  if (measure.worked_example) {
    root.appendChild(section("Worked example", el("div", { class: "worked" }, [inlineMath(measure.worked_example)])));
  }

  const badges = propertyBadges(measure);
  const propsTable = propertyTable(measure);
  if (propsTable) {
    const wrap = el("div", {}, [badges, propsTable].filter(Boolean));
    root.appendChild(section("Properties", wrap));
  }

  if (measure.range) {
    root.appendChild(section("Range", el("div", { class: "worked" }, [inlineMath(measure.range)])));
  }

  if ((measure.parameters || []).length) {
    const ul = el("ul", {});
    measure.parameters.forEach((p) => {
      const parts = [el("strong", {}, [p.name])];
      if (p.description) parts.push(document.createTextNode(" — " + p.description));
      if (p.default != null) parts.push(document.createTextNode(` (default ${p.default})`));
      if (p.constraints) parts.push(document.createTextNode(`; ${p.constraints}`));
      ul.appendChild(el("li", {}, parts));
    });
    root.appendChild(section("Parameters", ul));
  }

  {
    const idSec = renderRelations(db, "Identities", measure.identities);
    if (idSec) root.appendChild(idSec);
    const ineqSec = renderRelations(db, "Inequalities", measure.inequalities);
    if (ineqSec) root.appendChild(ineqSec);
  }

  if ((measure.assumptions || []).length) {
    const ul = el("ul", {});
    measure.assumptions.forEach((a) => ul.appendChild(el("li", {}, [inlineMath(a)])));
    root.appendChild(section("Assumptions", ul));
  }

  if ((measure.practical_use_cases || []).length) {
    const ul = el("ul", {});
    measure.practical_use_cases.forEach((u) => ul.appendChild(el("li", {}, [u])));
    root.appendChild(section("Applications", ul));
  }

  if (measure.when_to_use || measure.when_not_to_use) {
    const box = el("div", { class: "when-grid" });
    if (measure.when_to_use) box.appendChild(el("div", { class: "when-use" }, [el("h3", {}, ["When to use"]), el("p", {}, [measure.when_to_use])]));
    if (measure.when_not_to_use) box.appendChild(el("div", { class: "when-not" }, [el("h3", {}, ["When not to use"]), el("p", {}, [measure.when_not_to_use])]));
    root.appendChild(section(null, box));
  }

  if ((measure.special_cases || []).length) {
    const ul = el("ul", {});
    measure.special_cases.forEach((s) => ul.appendChild(el("li", {}, [inlineMath(s)])));
    root.appendChild(section("Special cases", ul));
  }

  // Related + graph.
  const related = (measure.related || []).map((id) => db.byId.get(id)).filter(Boolean);
  if (related.length) {
    const relWrap = el("div", {});
    const links = el("div", { class: "chips" }, related.map((m) =>
      chip(m.canonical_name, { variant: "related", href: `#/measure/${m.id}` })
    ));
    relWrap.appendChild(links);
    const g = renderGraph(db, measure);
    if (g) relWrap.appendChild(el("div", { class: "graph-wrap" }, [g]));
    root.appendChild(section("Related measures", relWrap));
  }

  // Code.
  root.appendChild(renderCodePanel(db, measure));

  // References.
  if ((measure.references || []).length) {
    const ul = el("ul", {});
    measure.references.forEach((r) => {
      const item = r.url
        ? el("a", { href: r.url, target: r.url.startsWith("http") ? "_blank" : "_self", rel: "noopener" }, [r.title])
        : document.createTextNode(r.title);
      const li = el("li", {}, [item]);
      if (r.note) li.appendChild(document.createTextNode(" — " + r.note));
      ul.appendChild(li);
    });
    root.appendChild(section("References", ul));
  }

  if (measure.source_section) {
    root.appendChild(el("p", { class: "source-note" }, [
      "Curated from the ",
      el("a", { href: measure.source_section }, ["Taxonomy of Distances & Divergences"]),
      " post.",
    ]));
  }

  // Contribute (collaborative, static): edit the data on GitHub, suggest an edit,
  // or copy the card JSON. A merged change updates this card everywhere — including
  // links inside annotated PDFs, which point to the stable #/m/:id permalink.
  {
    const box = el("div", {});
    box.appendChild(el("p", { class: "muted" }, [
      `This card is data-driven — a merged edit updates it everywhere (its permalink is #/m/${measure.id}).`,
    ]));
    const copyBtn = el("button", { type: "button", class: "answer-cta" }, ["Copy card JSON"]);
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(measure, null, 2));
        copyBtn.textContent = "Copied!";
      } catch (_) { copyBtn.textContent = "Copy failed"; }
      setTimeout(() => (copyBtn.textContent = "Copy card JSON"), 1400);
    });
    box.appendChild(el("div", { class: "chips" }, [
      el("a", { class: "answer-cta", href: editUrl(), target: "_blank", rel: "noopener" }, ["Edit data on GitHub"]),
      el("a", { class: "answer-cta", href: editCardIssueUrl(measure), target: "_blank", rel: "noopener" }, ["Suggest an edit"]),
      copyBtn,
    ]));
    root.appendChild(section("Contribute", box));
  }

  return root;
}

/* -------------------------------- compare --------------------------------- */

const COMPARE_ROWS = [
  { label: "Symmetric?", fn: (m) => boolCell(m.properties, "symmetric") },
  { label: "Bounded?", fn: (m) => boolCell(m.properties, "bounded") },
  { label: "Metric?", fn: (m) => boolCell(m.properties, "metric") },
  { label: "√ is a metric?", fn: (m) => boolCell(m.properties, "sqrt_metric") },
  { label: "Range", fn: (m) => m.range || "—" },
  { label: "Object types", fn: (m) => (m.input_types || []).map((t) => OBJECT_TYPE_LABELS[t] || t).join(", ") || "—" },
  { label: "Families", fn: (m, db) => (m.family || []).map((f) => familyLabel(db, f)).join(", ") || "—" },
  { label: "When to use", fn: (m) => m.when_to_use || "—" },
];

function boolCell(props, key) {
  if (!props || !(key in props)) return "—";
  return props[key] === true ? "Yes" : "No";
}

export function renderCompare(db, app, ids) {
  const measures = ids.map((id) => db.byId.get(id)).filter(Boolean);
  const root = el("div", { class: "compare" });
  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  root.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, ["Compare measures"]));

  if (measures.length < 2) {
    root.appendChild(el("p", { class: "empty" }, [
      "Select 2–4 measures to compare. Use the “+ Compare” button on any measure, then open the comparison.",
    ]));
    return root;
  }

  const wrap = el("div", { class: "table-wrap" });
  const table = el("table", { class: "compare-table" });
  const thead = el("thead");
  const hrow = el("tr", {}, [el("th", {}, ["Property"])]);
  measures.forEach((m) => {
    const th = el("th", {}, [el("a", { href: `#/measure/${m.id}` }, [m.canonical_name])]);
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  // Formula row (math).
  const tbody = el("tbody");
  const frow = el("tr", {}, [el("td", { class: "row-label" }, ["Formula"])]);
  measures.forEach((m) => {
    const td = el("td", {});
    if (m.formula_latex) td.textContent = `\\(${m.formula_latex}\\)`;
    else td.textContent = "—";
    frow.appendChild(td);
  });
  tbody.appendChild(frow);

  COMPARE_ROWS.forEach((row) => {
    const tr = el("tr", {}, [el("td", { class: "row-label" }, [row.label])]);
    measures.forEach((m) => {
      const val = row.fn(m, db);
      const td = el("td", {});
      td.textContent = val;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  root.appendChild(wrap);
  return root;
}

/* ----------------------------- browse by type ----------------------------- */

export function renderTypesView(db, app) {
  const root = el("div", { class: "types-view" });
  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  root.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, ["Browse by object type"]));
  root.appendChild(el("p", { class: "detail-lead" }, [
    "Dissimilarities grouped by the kind of object they compare. A measure can appear under more than one type.",
  ]));
  root.appendChild(el("p", { class: "hero-contribute" }, [
    "Missing a type or a measure? ",
    el("a", { href: "#/contribute" }, ["Contribute →"]),
  ]));

  const groups = new Map();
  for (const m of db.measures) {
    const types = (m.input_types && m.input_types.length) ? m.input_types : ["unknown"];
    for (const t of types) {
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(m);
    }
  }
  const types = [...groups.keys()].sort((a, b) =>
    groups.get(b).length - groups.get(a).length ||
    (OBJECT_TYPE_LABELS[a] || a).localeCompare(OBJECT_TYPE_LABELS[b] || b)
  );

  const nav = el("div", { class: "types-nav" }, types.map((t) => {
    const b = el("button", { type: "button", class: "chip" }, [`${OBJECT_TYPE_LABELS[t] || t} (${groups.get(t).length})`]);
    b.addEventListener("click", () => {
      const s = document.getElementById(`type-${t}`);
      if (s) s.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return b;
  }));
  root.appendChild(nav);

  for (const t of types) {
    const sec = el("section", { class: "lk-section" });
    sec.appendChild(el("h2", { id: `type-${t}` }, [`${OBJECT_TYPE_LABELS[t] || t} (${groups.get(t).length})`]));
    const grid = el("div", { class: "card-grid" });
    groups.get(t)
      .slice()
      .sort((a, b) => a.canonical_name.localeCompare(b.canonical_name))
      .forEach((m) => grid.appendChild(renderResultCard(db, app, m)));
    sec.appendChild(grid);
    root.appendChild(sec);
  }
  return root;
}

/* ------------------------------- contribute ------------------------------- */

const NEW_MEASURE_SKELETON = {
  id: "my_measure",
  canonical_name: "My Measure",
  aliases: [],
  short_description: "One-sentence description of what it measures.",
  family: [],
  input_types: ["vector"],
  symbols: [],
  formula_latex: "",
  formula_plaintext: "",
  properties: { nonnegative: true, symmetric: true, bounded: false, metric: false },
  identities: [],
  inequalities: [],
  range: "",
  parameters: [],
  practical_use_cases: [],
  when_to_use: "",
  when_not_to_use: "",
  related: [],
  references: [{ title: "", url: "" }],
};

export function renderContribute(db) {
  const root = el("div", { class: "contribute" });
  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  root.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, ["Contribute to the dictionary"]));
  root.appendChild(el("p", { class: "detail-lead" }, [
    "The flash cards are data-driven — they live in one JSON file, so anyone can propose a new measure or an ",
    "edit with no local setup. Because links use the stable #/m/:id permalink, a merged change updates the card ",
    "everywhere automatically, including inside already-annotated PDFs.",
  ]));

  // Primary actions.
  const actions = el("div", { class: "chips contribute-actions" }, [
    el("a", { class: "answer-cta", href: newCardIssueUrl(NEW_MEASURE_SKELETON), target: "_blank", rel: "noopener" }, ["➕ Propose a new measure"]),
    el("a", { class: "answer-cta", href: editUrl(), target: "_blank", rel: "noopener" }, ["✎ Edit measures.json on GitHub"]),
    el("a", { class: "answer-cta", href: "#/" }, ["🔎 Browse & edit an existing card"]),
  ]);
  root.appendChild(section("Ways to contribute", actions));

  // How it works.
  const how = el("ol", { class: "contribute-steps" }, [
    el("li", {}, ["Open any measure and use its ", el("strong", {}, ["Contribute"]), " box to edit it, or start from the buttons above."]),
    el("li", {}, ["The ", el("a", { href: "#/linker" }, ["PDF Linker"]), " can draft a new entry for you: it flags a measure that isn't in the dictionary and the AI drafts a schema-valid card to download or propose."]),
    el("li", {}, ["Open a pull request (or a prefilled issue). Continuous integration validates the data automatically — ids, types, and every cross-reference."]),
    el("li", {}, ["A maintainer reviews and merges. GitHub Pages rebuilds and the card is live; existing annotated PDFs keep working because their links point to the permalink."]),
  ]);
  root.appendChild(section("How it works", how));

  // Schema summary.
  const schema = el("div", {});
  schema.appendChild(el("p", { class: "muted" }, ["Each entry is one JSON object. The core fields:"]));
  const dl = el("dl", { class: "schema-list" });
  [
    ["id", "unique kebab-case slug (becomes the #/m/:id permalink)"],
    ["canonical_name", "the primary display name"],
    ["aliases", "other names it goes by — used by search and the PDF linker"],
    ["input_types", "objects compared: vector, matrix, spd_matrix, probability_vector, …"],
    ["symbols", "LaTeX symbol forms, e.g. D_{KL}(p\\|q)"],
    ["formula_latex / formula_plaintext", "the definition"],
    ["properties", "{ nonnegative, symmetric, bounded, metric }"],
    ["identities / inequalities", "cross-linked relations: { latex, refs, note }"],
    ["related / references", "other measure ids and citations"],
  ].forEach(([k, v]) => {
    dl.appendChild(el("dt", {}, [k]));
    dl.appendChild(el("dd", {}, [v]));
  });
  schema.appendChild(dl);
  schema.appendChild(el("p", { class: "muted" }, [
    "Full schema and validation rules live with the data: ",
    el("a", { href: blobUrl(), target: "_blank", rel: "noopener" }, ["measures.json"]),
    ". Set metric / symmetric / bounded / SPD flags from known mathematics, not guesses.",
  ]));
  root.appendChild(section("Entry schema", schema));

  root.appendChild(el("p", { class: "muted" }, [
    `The dictionary currently has ${db.measures.length} measures. No unreviewed math reaches the site — human review and CI gate every contribution.`,
  ]));
  return root;
}

/* ------------------------------- pipeline --------------------------------- */

// Informational only: a map of the whole project. Each block expands to explain
// how that stage is used. This page runs nothing.
const PIPELINE_GROUPS = [
  {
    label: "Dictionary data",
    blocks: [{
      id: "data",
      cat: "data",
      title: "Dictionary data",
      short: "Curated cards in JSON, indexed & validated on load",
      modules: ["data.js", "measures.json", "aliases.json"],
      detail: [
        "Every measure is one JSON object: name, aliases, symbols, formula, properties, cross-linked identities & inequalities, audited code, and references.",
        "On load, data.js builds fast lookups (by id, and an alias index mapping every name/alias to a measure) and validates the data. This single source of truth powers search, the assistant, and the PDF linker.",
      ],
      link: { href: "#/contribute", label: "How to add a card" },
    }],
  },
  {
    label: "Explore the dictionary",
    blocks: [
      {
        id: "search",
        cat: "browser",
        title: "Search & filter",
        short: "Instant lexical search + faceted filters (no key)",
        modules: ["search.js", "fuzzy.js", "aliasResolver.js", "filters.js"],
        detail: [
          "A dependency-free cascade: exact alias → fuzzy (bigram-Dice + edit distance) → field-weighted token match. Facet filters (object type, property, family, application) are URL-driven, so a filtered view is shareable.",
          "Runs entirely in your browser — no network, no key.",
        ],
        link: { href: "#/", label: "Open search" },
      },
      {
        id: "lightai",
        cat: "model",
        title: "Light in-browser AI (optional)",
        short: "Free semantic search — MiniLM, no key, on your device",
        modules: ["embeddings.js", "Transformers.js"],
        detail: [
          "“Enable AI search” downloads a small embedding model (MiniLM, ~23MB, then cached) that runs fully in your browser and ranks measures by meaning — so natural-language queries work even with no keyword overlap. No API key; nothing leaves your device.",
          "This is the “light web version”: whenever a BYOK model is not configured, the app falls back to these free, on-device methods.",
        ],
        link: { href: "#/", label: "Try it on search" },
      },
      {
        id: "assistant",
        cat: "browser",
        title: "Rule-based assistant",
        short: "Deterministic Q&A — always on, no model",
        modules: ["assistant.js"],
        detail: [
          "Hard-coded intent rules answer common questions (e.g. “I have covariance matrices”, “a bounded symmetric divergence?”) and greet off-topic queries. It never calls a model and is always available.",
        ],
        link: { href: "#/ask", label: "Open Ask AI" },
      },
      {
        id: "byok",
        cat: "model",
        title: "BYOK LLM (optional) — where the LLM is used",
        short: "Your OWN Claude / Gemini / OpenRouter / HF key + model",
        modules: ["llm.js", "chat.js"],
        detail: [
          "When you add your OWN provider key AND model, the app can call a large language model for two things: (1) grounded natural-language answers on the Ask page (retrieval-augmented over the local cards), and (2) detecting unnamed / formula-defined measures in the PDF linker.",
          "The key stays in your browser, is sent directly to your provider, and is billed to you — never the site owner. Without a key+model, the light path above is used instead. The LLM is always grounded: it can only link to measure ids that already exist in the dictionary.",
        ],
        link: { href: "#/ask", label: "Configure your key" },
      },
    ],
  },
  {
    label: "Read a PDF (the linker)",
    blocks: [
      {
        id: "extract",
        cat: "browser",
        title: "1 · Extract text",
        short: "pdf.js reads the PDF in your browser",
        modules: ["pdf.js"],
        detail: [
          "pdf.js pulls out the text with per-word geometry and character offsets — no server, no key. (Optional: Mathpix OCR for equation-heavy PDFs, using your own Mathpix key.)",
        ],
      },
      {
        id: "match",
        cat: "browser",
        title: "2 · Dictionary match",
        short: "Deterministically link measures named in our cards",
        modules: ["linker.js"],
        detail: [
          "A deterministic pass scans the text against every name / alias / abbreviation in the dictionary and links each hit to its card, with correct offsets and no LLM. This is the reliable core, and it runs with no key (light mode).",
        ],
      },
      {
        id: "detect",
        cat: "model",
        title: "3 · LLM detect (optional)",
        short: "Find unnamed / formula-defined measures",
        modules: ["linker.js", "llm.js"],
        detail: [
          "If a key+model are set, chunks of text plus a compact catalog go to your LLM, which returns measures that appear only as formulas or under names not in our dictionary. Its results are merged with the dictionary matches (the dictionary wins overlaps), and invalid JSON from a weak model is non-fatal.",
        ],
      },
      {
        id: "present",
        cat: "browser",
        title: "4 · Reading view + export",
        short: "Linkified text, code, and a highlighted annotated PDF",
        modules: ["linkerView.js", "annotate.js", "verify.js"],
        detail: [
          "The reading view shows the text with each measure linked to its card, plus audited code for each. You can download an annotated PDF (pdf-lib) where every detected measure is highlighted and clickable to its card, and optionally verify a drafted measure’s code in-browser with Pyodide.",
        ],
        link: { href: "#/linker", label: "Open the linker" },
      },
    ],
  },
  {
    label: "Present & collaborate",
    blocks: [
      {
        id: "render",
        cat: "browser",
        title: "Rendering",
        short: "Cards, MathJax formulas, audited code, relation graph",
        modules: ["render.js", "mathjax.js", "codegen.js", "graph.js"],
        detail: [
          "Detail pages render formulas with MathJax, show audited NumPy / PyTorch / JAX (never AI-generated code), cross-linked identities & inequalities, and an SVG graph of related measures.",
        ],
      },
      {
        id: "collaborate",
        cat: "data",
        title: "Collaborate",
        short: "Data-driven cards, GitHub PR + CI, stable permalinks",
        modules: ["config.js", "GitHub Actions"],
        detail: [
          "Because cards are just data, anyone can propose or edit one on GitHub. CI validates every change; once merged, GitHub Pages rebuilds and the card updates everywhere — including inside already-annotated PDFs, whose links point to the stable #/m/:id permalink.",
        ],
        link: { href: "#/contribute", label: "Contribute" },
      },
    ],
  },
];

export function renderPipeline(db) {
  const root = el("div", { class: "pipeline" });
  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  root.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, ["How this project works"]));
  root.appendChild(el("p", { class: "detail-lead pipe-lead" }, [
    "A map of the whole pipeline — click any stage to see how it works. Informational only; it runs nothing.",
  ]));
  root.appendChild(el("p", { class: "muted pipe-credit" }, [
    "The original idea for this project — a taxonomy of distances & divergences — was suggested by ",
    el("a", { href: "https://franknielsen.github.io/Divergence/index.html", target: "_blank", rel: "noopener" }, ["Frank Nielsen"]),
    ".",
  ]));

  // Legends: node SHAPE (role) + COLOR (compute tier), plus the provider-layer note.
  root.appendChild(el("div", { class: "pipe-legends" }, [
    el("div", { class: "pipe-legend pipe-legend-shapes" }, [
      miniShape("cylinder", "Data store"),
      miniShape("rect", "In-browser"),
      miniShape("hexagon", "Model / AI"),
      miniShape("parallelogram", "Input / output"),
      miniShape("diamond", "Decision"),
      miniShape("stadium", "Contribute"),
    ]),
    el("div", { class: "pipe-legend pipe-legend-colors" }, [
      el("span", { class: "pipe-legend-item" }, [el("span", { class: "pipe-swatch cat-model", "aria-hidden": "true" }), "Model"]),
      el("span", { class: "pipe-legend-item" }, [el("span", { class: "pipe-swatch cat-browser", "aria-hidden": "true" }), "In-browser"]),
      el("span", { class: "pipe-legend-item" }, [el("span", { class: "pipe-swatch cat-data", "aria-hidden": "true" }), "Data"]),
    ]),
  ]));
  root.appendChild(el("p", { class: "muted pipe-caption" }, [
    "Model steps (hexagons) run through the provider layer — request pacing, 503/429 backoff, and your own BYOK key.",
  ]));

  const layout = el("div", { class: "pipe-layout" });
  const diagram = el("div", { class: "pipe-diagram" });
  const panel = el("aside", { class: "pipe-panel", id: "pipe-panel", "aria-live": "polite" });

  // Single inline SVG that scales to fit its pane (preserveAspectRatio=meet).
  const diag = svg("svg", {
    class: "pipe-svg", viewBox: "0 0 760 980", preserveAspectRatio: "xMidYMid meet",
    role: "group", "aria-label": "Project pipeline diagram",
  });
  diag.appendChild(svg("defs", {}, [
    svg("marker", { id: "pipe-arrow", markerWidth: "9", markerHeight: "9", refX: "7", refY: "3", orient: "auto", markerUnits: "userSpaceOnUse" }, [
      svg("path", { d: "M0,0 L7,3 L0,6 z", class: "pipe-arrowhead" }),
    ]),
  ]));

  // Edges first (drawn under the nodes).
  pipeEdges().forEach((ed) => {
    diag.appendChild(svg("path", {
      class: "pipe-edge" + (ed.dashed ? " dashed" : ""), d: ed.d,
      "data-from": ed.from, "data-to": ed.to, "marker-end": "url(#pipe-arrow)",
    }));
    if (ed.label) diag.appendChild(svg("text", { x: ed.lx, y: ed.ly, class: "pipe-edge-label", "text-anchor": "middle" }, [ed.label]));
  });

  const clickable = [];         // interactive <g> nodes in order (arrow-key nav)
  const blockOfG = new Map();   // <g> -> its block

  const select = (block, g) => {
    clickable.forEach((x) => { x.classList.remove("selected"); x.setAttribute("aria-pressed", "false"); });
    g.classList.add("selected");
    g.setAttribute("aria-pressed", "true");
    diag.classList.add("has-selection");
    // Highlight the connectors touching this node.
    diag.querySelectorAll(".pipe-edge").forEach((p) => {
      p.classList.toggle("active", p.getAttribute("data-from") === block.id || p.getAttribute("data-to") === block.id);
    });
    // Fresh content node → replays the pipeZoom animation; aria-live announces the change.
    panel.replaceChildren(renderStageDetail(block));
    // Shareable URL without a full re-render (replaceState does NOT fire hashchange).
    try { history.replaceState(null, "", buildHash(["pipeline", block.id])); } catch (_) { /* ignore */ }
    // On mobile the panel sits below the diagram — bring it into view (no-op while detached on load).
    if (window.matchMedia && window.matchMedia("(max-width: 820px)").matches) panel.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  pipeNodes().forEach((n) => {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    const clickableNode = !!n.block;
    const g = svg("g", clickableNode
      ? { class: `pipe-node shape-${n.shape} cat-${n.cat}`, role: "button", tabindex: "0", "aria-pressed": "false", "aria-controls": "pipe-panel", "data-id": n.id, "aria-label": n.block.title }
      : { class: `pipe-endpoint shape-${n.shape}`, "aria-hidden": "true" });
    shape(n.shape, n.x, n.y, n.w, n.h).forEach((p) => g.appendChild(p));
    g.appendChild(nodeLabel(n.label, cx, n.shape === "cylinder" ? cy + 5 : cy));
    if (clickableNode) {
      g.addEventListener("click", () => select(n.block, g));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.block, g); return; }
        const i = clickable.indexOf(g); let j = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") j = Math.min(clickable.length - 1, i + 1);
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = Math.max(0, i - 1);
        if (j >= 0 && j !== i) { e.preventDefault(); const t = clickable[j]; if (t.focus) t.focus(); select(blockOfG.get(t), t); }
      });
      clickable.push(g);
      blockOfG.set(g, n.block);
    }
    diag.appendChild(g);
  });

  diagram.appendChild(diag);
  layout.append(diagram, panel);
  root.appendChild(layout);

  // Deep link: preselect #/pipeline/<id> when it names a real block; else a short overview.
  const wanted = parseHash().parts[1];
  const startG = wanted ? clickable.find((g) => blockOfG.get(g).id === wanted) : null;
  if (startG) {
    select(blockOfG.get(startG), startG);
  } else {
    panel.replaceChildren(el("div", { class: "pipe-panel-content" }, [
      el("h2", {}, ["Overview"]),
      el("p", {}, ["Select a stage in the diagram to see the modules it uses and how it works. Everything here runs in your browser — nothing executes."]),
    ]));
  }

  root.appendChild(el("p", { class: "muted pipe-footnote" }, [
    "Everything runs in your browser. The only network calls are to your own AI / Mathpix provider (if you add a key) and to CDNs for libraries.",
  ]));
  return root;
}

/** Build the side-panel content for one stage (fresh node so the zoom animation replays). */
function renderStageDetail(b) {
  const content = el("div", { class: "pipe-panel-content" });
  content.appendChild(el("h2", {}, [b.title]));
  b.detail.forEach((p) => content.appendChild(el("p", {}, [p])));
  if (b.modules && b.modules.length) {
    content.appendChild(el("div", { class: "pipe-modules chips" }, b.modules.map((mn) => chip(mn, { variant: "type" }))));
  }
  if (b.link) content.appendChild(el("p", {}, [el("a", { class: "answer-cta", href: b.link.href }, [`${b.link.label} →`])]));
  return content;
}

/* -------- pipeline diagram: shapes, node layout, connectors (SVG) --------- */

/** SVG shape element(s) for a node type; fill/stroke come from the cat-* CSS vars. */
function shape(type, x, y, w, h) {
  if (type === "stadium") return [svg("rect", { x, y, width: w, height: h, rx: h / 2, class: "shape" })];
  if (type === "parallelogram") {
    const s = 16;
    return [svg("polygon", { points: `${x + s},${y} ${x + w},${y} ${x + w - s},${y + h} ${x},${y + h}`, class: "shape" })];
  }
  if (type === "hexagon") {
    const c = 16;
    return [svg("polygon", { points: `${x + c},${y} ${x + w - c},${y} ${x + w},${y + h / 2} ${x + w - c},${y + h} ${x + c},${y + h} ${x},${y + h / 2}`, class: "shape" })];
  }
  if (type === "diamond") {
    return [svg("polygon", { points: `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`, class: "shape" })];
  }
  if (type === "cylinder") {
    const ry = Math.max(3, Math.min(9, h * 0.16));
    return [
      svg("path", { d: `M ${x},${y + ry} V ${y + h - ry} A ${w / 2},${ry} 0 0 0 ${x + w},${y + h - ry} V ${y + ry}`, class: "shape" }),
      svg("ellipse", { cx: x + w / 2, cy: y + ry, rx: w / 2, ry, class: "shape" }),
    ];
  }
  return [svg("rect", { x, y, width: w, height: h, rx: 8, class: "shape" })]; // rect / default
}

/** Centered SVG label; wraps a long label onto two balanced lines. */
function nodeLabel(label, cx, cy) {
  if (label.length <= 15 || label.indexOf(" ") < 0) {
    return svg("text", { x: cx, y: cy, class: "pipe-node-label", "text-anchor": "middle", "dominant-baseline": "central" }, [label]);
  }
  const words = label.split(" ");
  let i = 0, len = 0;
  for (; i < words.length - 1; i++) { len += words[i].length + 1; if (len >= label.length / 2) { i++; break; } }
  const t = svg("text", { x: cx, y: cy, class: "pipe-node-label", "text-anchor": "middle", "dominant-baseline": "central" });
  t.appendChild(svg("tspan", { x: cx, dy: "-0.55em" }, [words.slice(0, i).join(" ")]));
  t.appendChild(svg("tspan", { x: cx, dy: "1.1em" }, [words.slice(i).join(" ")]));
  return t;
}

/** A tiny legend icon of a shape + its label. */
function miniShape(type, label) {
  const s = svg("svg", { class: "pipe-mini", viewBox: "0 0 34 20", width: "34", height: "20", "aria-hidden": "true" });
  shape(type, 2, 3, 30, 14).forEach((p) => s.appendChild(p));
  return el("span", { class: "pipe-legend-item" }, [s, label]);
}

/**
 * Diagram nodes (viewBox 1180×600). Clickable nodes carry a real block (looked up by id);
 * the rest (I/O endpoints, the decision diamond) are non-clickable labels.
 */
function pipeNodes() {
  // Resolve clickable nodes against PIPELINE_GROUPS (the pipeline blocks) — NOT db.byId,
  // which is the measures map and has none of these ids.
  const byId = new Map();
  PIPELINE_GROUPS.forEach((g) => g.blocks.forEach((b) => byId.set(b.id, b)));
  const N = (key, id, label, sh, cat, x, y, w, h) => ({ key, id, label, shape: sh, cat, x, y, w, h, block: id ? byId.get(id) : null });
  return [
    N("data", "data", "Dictionary data", "cylinder", "data", 230, 30, 300, 130),
    // explore lane (left column, top → bottom)
    N("search", "search", "Search & filter", "rect", "browser", 45, 220, 145, 80),
    N("assistant", "assistant", "Rule-based assistant", "rect", "browser", 200, 220, 145, 80),
    N("gate", null, "Key + model set?", "diamond", "neutral", 140, 340, 110, 110),
    N("lightai", "lightai", "Light in-browser AI", "hexagon", "model", 45, 490, 145, 80),
    N("byok", "byok", "BYOK LLM", "hexagon", "model", 200, 490, 145, 80),
    N("render", "render", "Rendering", "rect", "browser", 45, 610, 300, 80),
    N("answers", null, "Answers / results", "parallelogram", "io", 45, 720, 300, 80),
    // linker lane (right column, top → bottom)
    N("upload", null, "Upload PDF", "parallelogram", "io", 415, 220, 300, 80),
    N("extract", "extract", "Extract text", "rect", "browser", 415, 330, 300, 80),
    N("match", "match", "Dictionary match", "rect", "browser", 415, 440, 300, 80),
    N("detect", "detect", "AI detect", "hexagon", "model", 415, 550, 300, 80),
    N("present", "present", "Reading view", "rect", "browser", 415, 660, 300, 80),
    N("annot", null, "Annotated PDF", "parallelogram", "io", 415, 770, 300, 80),
    // contribute
    N("collaborate", "collaborate", "Contribute", "stadium", "data", 45, 850, 300, 72),
  ];
}

/** Orthogonal L-shaped connectors (main flow only; long runs hug the outer margins so
    they never cross a node). Coordinates match the viewBox 760×980 layout above. */
function pipeEdges() {
  const e = [];
  const push = (from, to, d, opts = {}) => e.push({ from, to, d, dashed: !!opts.dashed, label: opts.label || null, lx: opts.lx, ly: opts.ly });
  // data store → the two lanes
  push("data", "search", "M 380,160 V 190 H 118 V 220");
  push("data", "assistant", "M 380,160 V 190 H 273 V 220");
  // explore lane (top → bottom)
  push("search", "gate", "M 118,300 V 320 H 195 V 340");
  push("gate", "lightai", "M 195,450 V 470 H 118 V 490", { label: "no", lx: 150, ly: 465 });
  push("gate", "byok", "M 195,450 V 470 H 273 V 490", { label: "yes", lx: 244, ly: 465 });
  push("lightai", "render", "M 118,570 V 610");
  push("byok", "render", "M 273,570 V 610");
  push("search", "render", "M 45,260 H 25 V 650 H 45");        // left rail: keyword results
  push("assistant", "render", "M 345,260 H 365 V 650 H 345");  // mid rail: assistant results
  push("render", "answers", "M 195,690 V 720");
  // linker lane (straight vertical chain)
  push("upload", "extract", "M 565,300 V 330");
  push("extract", "match", "M 565,410 V 440");
  push("match", "detect", "M 565,520 V 550");
  push("detect", "present", "M 565,630 V 660");
  push("present", "annot", "M 565,740 V 770");
  // data catalog → match (dashed, right rail)
  push("data", "match", "M 530,95 H 735 V 480 H 715", { dashed: true, label: "catalog", lx: 632, ly: 84 });
  // contribute feedback loop (dashed, far-left rail)
  push("collaborate", "data", "M 195,850 H 15 V 95 H 230", { dashed: true, label: "feedback", lx: 44, ly: 470 });
  return e;
}

/* ------------------------------- not found -------------------------------- */

export function renderNotFound(message) {
  const root = el("div", { class: "not-found" });
  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  root.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, ["Not found"]));
  root.appendChild(el("p", {}, [message || "That measure does not exist."]));
  return root;
}
