// DOM builders for every route: home (search + filters + results), measure
// detail, comparison table, and the result card / filter rail components.
// Render functions receive the `app` controller (app.js) for callbacks.

import { el, chip, escapeHTML, debounce, latexBalanced } from "./util.js";
import {
  PROPERTY_LABELS, OBJECT_TYPE_LABELS, APPLICATION_LABELS, familyLabel,
  KNOWN_OBJECT_TYPES, KNOWN_PROPERTY_KEYS,
} from "./data.js";
import { search } from "./search.js";
import { converse, renderAnswer } from "./assistant.js";
import { hasToken } from "./chat.js";
import { applyFilters, isFilterActive, filterCount } from "./filters.js";
import { renderCodePanel } from "./codegen.js";
import { renderGraph, svg } from "./graph.js";
import { editUrl, editCardIssueUrl, newCardIssueUrl, blobUrl } from "./config.js";
import { parseHash, buildHash } from "./router.js";
import { typeset } from "./mathjax.js";

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

// Labels for optional typed relations[] edges (Phase 3), grouped in "Related / See also".
const RELATION_LABELS = {
  generalizes: "Generalizes", specializes: "Specializes", reduces_to: "Reduces to",
  dual_of: "Dual of", equivalent: "Equivalent to", uses: "Uses", see_also: "See also",
};

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

// Kind-specific prose fields (concept/object/theorem/method/transform/function/formula/
// distribution). Presence-driven and skips fields already rendered elsewhere (formula,
// worked_example, range, parameters, assumptions). Text may carry inline $...$ (typeset later).
const CARD_BODY_FIELDS = [
  { key: "definition", label: "Definition", type: "prose" },
  { key: "notation", label: "Notation", type: "prose" },
  { key: "examples", label: "Examples", type: "list" },
  { key: "statement", label: "Statement", type: "prose" },
  { key: "hypotheses", label: "Hypotheses", type: "list" },
  { key: "conclusion", label: "Conclusion", type: "prose" },
  { key: "proof_sketch", label: "Proof sketch", type: "prose" },
  { key: "consequences", label: "Consequences", type: "list" },
  { key: "derivation", label: "Derivation", type: "prose" },
  { key: "conditions", label: "Conditions", type: "list" },
  { key: "equality_conditions", label: "Equality conditions", type: "prose" },
  { key: "summary", label: "Summary", type: "prose" },
  { key: "inputs", label: "Inputs", type: "list" },
  { key: "outputs", label: "Outputs", type: "list" },
  { key: "steps", label: "Steps", type: "steps" },
  { key: "complexity", label: "Complexity", type: "prose" },
  { key: "domain_of_definition", label: "Domain", type: "prose" },
  { key: "special_values", label: "Special values", type: "list" },
  { key: "inverse_latex", label: "Inverse", type: "latex" },
  { key: "support", label: "Support", type: "prose" },
  { key: "pdf_pmf", label: "PDF / PMF", type: "latex" },
  { key: "mean", label: "Mean", type: "prose" },
  { key: "variance", label: "Variance", type: "prose" },
  { key: "moments", label: "Moments", type: "prose" },
  { key: "mgf", label: "Moment-generating function", type: "latex" },
  { key: "conjugate_prior", label: "Conjugate prior", type: "prose" },
];

function renderCardBody(root, measure) {
  for (const f of CARD_BODY_FIELDS) {
    const v = measure[f.key];
    if (f.type === "list" || f.type === "steps") {
      if (Array.isArray(v) && v.length) {
        const list = el(f.type === "steps" ? "ol" : "ul", {}, v.map((x) => el("li", {}, [inlineMath(String(x))])));
        root.appendChild(section(f.label, list));
      }
    } else if (f.type === "latex") {
      if (v) root.appendChild(section(f.label, mathDiv(v)));
    } else if (v) {
      root.appendChild(section(f.label, el("p", { class: "detail-prose" }, [inlineMath(String(v))])));
    }
  }
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

  renderCardBody(root, measure);

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

  // Relationships (Phase 3): from the graph, so `related` is symmetric and reverse
  // prerequisite edges ("builds toward") are available. Each section is skipped when empty.
  const gnode = db.graph && db.graph.get(measure.id);
  if (gnode) {
    const chipsFor = (ids) => {
      const cards = [...ids].map((id) => db.byId.get(id)).filter(Boolean);
      if (!cards.length) return null;
      return el("div", { class: "chips" }, cards.map((m) =>
        chip(m.canonical_name, { variant: "related", href: `#/m/${m.id}` })));
    };

    const preChips = chipsFor(gnode.prereqs);
    if (preChips) root.appendChild(section("Prerequisites", preChips));

    const path = db.learningPath(measure.id);
    if (path.length) {
      const lp = el("div", { class: "learning-path" });
      path.forEach((m) => {
        lp.appendChild(chip(m.canonical_name, { variant: "related", href: `#/m/${m.id}` }));
        lp.appendChild(el("span", { class: "lp-arrow", "aria-hidden": "true" }, ["→"]));
      });
      lp.appendChild(el("span", { class: "lp-current" }, [measure.canonical_name]));
      root.appendChild(section("Learning path", lp));
    }

    const depChips = chipsFor(gnode.dependents);
    if (depChips) root.appendChild(section("Builds toward / Used in", depChips));

    // Related / See also: symmetric `related` + typed `relations` grouped by type + the graph.
    const relWrap = el("div", {});
    const relChips = chipsFor(gnode.related);
    if (relChips) relWrap.appendChild(relChips);
    if (gnode.relations.length) {
      // Use the graph's already-cleaned typed edges (self-links + dangling ids filtered by
      // buildGraph), so the rendering never diverges from the graph.
      const byType = new Map();
      for (const e of gnode.relations) {
        if (!byType.has(e.type)) byType.set(e.type, []);
        byType.get(e.type).push(db.byId.get(e.to));
      }
      for (const [type, cards] of byType) {
        relWrap.appendChild(el("div", { class: "rel-typed" }, [
          el("span", { class: "rel-type-label" }, [(RELATION_LABELS[type] || type) + ": "]),
          ...cards.map((m) => chip(m.canonical_name, { variant: "related", href: `#/m/${m.id}` })),
        ]));
      }
    }
    const g = renderGraph(db, measure);
    if (g) relWrap.appendChild(el("div", { class: "graph-wrap" }, [g]));
    if (relWrap.childNodes.length) root.appendChild(section("Related / See also", relWrap));
  }

  // Code — measure-only: non-measure kinds have no code templates and the panel copy is
  // measure-specific, so only show it for measures (or any card that declares code templates).
  if (measure.kind === "measure" || (measure.code_templates && measure.code_templates.length)) {
    root.appendChild(renderCodePanel(db, measure));
  }

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
    // "Browse by object type" is about measures' operands; cards without input_types
    // (concepts, theorems, and other non-measure kinds) are skipped rather than bucketed as "unknown".
    if (!(m.input_types && m.input_types.length)) continue;
    for (const t of m.input_types) {
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

// Field model for the contribute form. Keys match data/templates/*.json; the required rules
// mirror REQUIRED_BY_KIND in scripts/validate-cards.mjs so client + offline gates agree.
const CONTRIB_SLUG_RE = /^[a-z0-9]+([-_][a-z0-9]+)*$/;
const CONTRIB_LATEX_REQUIRED = new Set(["measure", "formula", "function", "distribution", "transform", "inequality"]);

const CONTRIB_CORE_FIELDS = [
  { key: "id", label: "id (slug)", type: "text", required: true, hint: "lowercase, - or _ ; becomes #/m/:id" },
  { key: "canonical_name", label: "Canonical name", type: "text", required: true },
  { key: "aliases", label: "Aliases", type: "csv", hint: "comma-separated" },
  { key: "short_description", label: "Short description", type: "textarea", required: true, hint: "one precise sentence" },
  { key: "formula_latex", label: "Formula (LaTeX)", type: "latex", hint: "raw LaTeX, no surrounding $$" },
  { key: "formula_plaintext", label: "Formula (plain text)", type: "text" },
  { key: "subtopics", label: "Subtopics", type: "csv", hint: "comma-separated" },
  { key: "tags", label: "Tags", type: "csv", hint: "comma-separated" },
  { key: "prerequisites", label: "Prerequisites (card ids)", type: "csv", hint: "comma-separated ids" },
  { key: "related", label: "Related (card ids)", type: "csv", hint: "comma-separated ids" },
];

// Kind-specific fields (shown when that kind is selected). Keys match data/templates/*.json.
const CONTRIB_FIELDS_BY_KIND = {
  measure: [
    { key: "input_types", label: "Input types", type: "checkgroup", options: () => [...KNOWN_OBJECT_TYPES], labelFn: (v) => OBJECT_TYPE_LABELS[v] || v },
    { key: "properties", label: "Properties (check the ones that provably hold)", type: "boolgroup", options: () => [...KNOWN_PROPERTY_KEYS], labelFn: (v) => PROPERTY_LABELS[v] || v },
    { key: "family", label: "Family", type: "csv" },
    { key: "range", label: "Range", type: "text" },
    { key: "when_to_use", label: "When to use", type: "textarea" },
    { key: "when_not_to_use", label: "When NOT to use", type: "textarea" },
    { key: "practical_use_cases", label: "Practical use cases", type: "csv" },
  ],
  concept: [
    { key: "definition", label: "Definition", type: "textarea" },
    { key: "examples", label: "Examples", type: "csv" },
  ],
  object: [
    { key: "definition", label: "Definition", type: "textarea" },
    { key: "examples", label: "Examples", type: "csv" },
    { key: "notation", label: "Notation", type: "text" },
  ],
  theorem: [
    { key: "statement", label: "Statement", type: "textarea" },
    { key: "proof_sketch", label: "Proof sketch", type: "textarea" },
    { key: "consequences", label: "Consequences", type: "csv" },
  ],
  formula: [
    { key: "statement", label: "Statement", type: "textarea" },
    { key: "derivation", label: "Derivation", type: "textarea" },
    { key: "conditions", label: "Conditions", type: "csv" },
  ],
  inequality: [
    { key: "statement", label: "Statement", type: "textarea" },
    { key: "conditions", label: "Conditions", type: "csv" },
    { key: "equality_conditions", label: "Equality conditions", type: "text" },
    { key: "consequences", label: "Consequences", type: "csv" },
  ],
  transform: [
    { key: "definition", label: "Definition", type: "textarea" },
    { key: "inverse_latex", label: "Inverse (LaTeX)", type: "text" },
    { key: "domain_of_definition", label: "Domain of definition", type: "text" },
  ],
  method: [
    { key: "summary", label: "Summary", type: "textarea" },
    { key: "steps", label: "Steps (one per line)", type: "lines" },
    { key: "complexity", label: "Complexity", type: "text" },
    { key: "assumptions", label: "Assumptions", type: "csv" },
  ],
  function: [
    { key: "definition", label: "Definition", type: "textarea" },
    { key: "domain_of_definition", label: "Domain", type: "text" },
    { key: "range", label: "Range", type: "text" },
    { key: "special_values", label: "Special values", type: "csv" },
  ],
  distribution: [
    { key: "support", label: "Support", type: "text" },
    { key: "pdf_pmf", label: "PDF / PMF (LaTeX)", type: "text" },
    { key: "parameters", label: "Parameters (name: description, one per line)", type: "kvlines" },
    { key: "mean", label: "Mean", type: "text" },
    { key: "variance", label: "Variance", type: "text" },
  ],
};

const contribEmpty = (v) => v == null || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
const contribCsv = (s) => {
  const out = [], seen = new Set();
  for (const t of String(s).split(",").map((x) => x.trim()).filter(Boolean)) if (!seen.has(t)) { seen.add(t); out.push(t); }
  return out;
};

export function renderContribute(db) {
  const root = el("div", { class: "contribute" });
  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  root.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, ["Contribute to the dictionary"]));
  root.appendChild(el("p", { class: "detail-lead" }, [
    "Draft a new card below — the fields adapt to the kind you pick, and the form validates before ",
    "it produces a submission. Nothing is committed until a human reviews it: the form opens a prefilled ",
    "GitHub issue (or copies the JSON), and CI validates every merge. Links use the stable #/m/:id permalink.",
  ]));
  root.appendChild(section("Draft a new card", buildContribForm(db)));
  root.appendChild(buildContribInfo(db));
  root.appendChild(el("p", { class: "muted" }, [
    `The dictionary currently has ${db.measures.length} cards. No unreviewed math reaches the site — human review and CI gate every contribution.`,
  ]));
  return root;
}

function buildContribForm(db) {
  const form = el("div", { class: "contrib-form" });
  const inputs = new Map(); // namespaced key -> getter()

  // Shared live MathJax preview for the formula_latex field.
  const previewNode = el("div", { class: "eq contrib-preview" });
  const runPreview = debounce((latex) => {
    previewNode.textContent = latex ? `$$${latex}$$` : "";
    typeset(previewNode); // async, never rejects; safe if MathJax is absent
  }, 220);

  function buildField(def, ns) {
    const key = ns + def.key;
    const wrap = el("div", { class: "contrib-field" });
    const labelText = def.label + (def.required ? " *" : "");
    if (def.type === "checkgroup" || def.type === "boolgroup") {
      const box = el("details", { class: "filter-group contrib-checks" });
      box.appendChild(el("summary", {}, [labelText]));
      const list = el("div", { class: "filter-options" });
      const boxes = [];
      (def.options ? def.options() : []).forEach((v) => {
        const cb = el("input", { type: "checkbox" });
        boxes.push([v, cb]);
        list.appendChild(el("label", { class: "filter-opt" }, [cb, el("span", {}, [def.labelFn ? def.labelFn(v) : v])]));
      });
      box.appendChild(list);
      wrap.appendChild(box);
      inputs.set(key, () => {
        const checked = boxes.filter(([, cb]) => cb.checked).map(([v]) => v);
        if (def.type === "boolgroup") { const o = {}; checked.forEach((v) => (o[v] = true)); return o; }
        return checked;
      });
      return wrap;
    }
    wrap.appendChild(el("label", { class: "field-label" }, [labelText]));
    if (def.hint) wrap.appendChild(el("span", { class: "contrib-hint" }, [def.hint]));
    const multiline = def.type === "textarea" || def.type === "lines" || def.type === "kvlines";
    const control = multiline
      ? el("textarea", { class: "llm-field contrib-input", rows: def.type === "textarea" ? "2" : "3" })
      : el("input", { type: "text", class: "llm-field contrib-input" });
    if (def.type === "latex") control.addEventListener("input", () => runPreview(control.value.trim()));
    wrap.appendChild(control);
    if (def.type === "latex") wrap.appendChild(previewNode);
    inputs.set(key, () => {
      const raw = control.value.trim();
      if (def.type === "csv") return contribCsv(raw);
      if (def.type === "lines") return raw ? raw.split("\n").map((x) => x.trim()).filter(Boolean) : [];
      if (def.type === "kvlines") return raw
        ? raw.split("\n").map((x) => x.trim()).filter(Boolean).map((line) => {
            const i = line.indexOf(":");
            return i === -1 ? { name: line } : { name: line.slice(0, i).trim(), description: line.slice(i + 1).trim() };
          })
        : [];
      return raw;
    });
    return wrap;
  }

  // Kind select.
  const kindSel = el("select", { class: "llm-field contrib-input" });
  ((db.taxonomy && db.taxonomy.kinds) || []).forEach((k) => kindSel.appendChild(el("option", { value: k.id }, [k.label || k.id])));
  kindSel.value = "measure";
  form.appendChild(el("div", { class: "contrib-field" }, [el("label", { class: "field-label" }, ["Kind *"]), kindSel]));

  // Domain multi-select.
  const domBoxes = [];
  const domList = el("div", { class: "filter-options" });
  ((db.taxonomy && db.taxonomy.domains) || []).forEach((d) => {
    const cb = el("input", { type: "checkbox" });
    domBoxes.push([d.id, cb]);
    domList.appendChild(el("label", { class: "filter-opt" }, [cb, el("span", {}, [d.label || d.id])]));
  });
  const getDomains = () => domBoxes.filter(([, cb]) => cb.checked).map(([id]) => id);
  form.appendChild(el("div", { class: "contrib-field" }, [
    el("details", { class: "filter-group contrib-checks", open: "" }, [el("summary", {}, ["Domain(s) *"]), domList]),
  ]));

  // Core fields.
  CONTRIB_CORE_FIELDS.forEach((def) => form.appendChild(buildField(def, "")));

  // Kind-specific groups: build all once, toggle visibility (no re-render).
  const kindGroups = [];
  Object.entries(CONTRIB_FIELDS_BY_KIND).forEach(([kind, defs]) => {
    const g = el("div", { class: "contrib-kind-group", dataset: { kind } });
    defs.forEach((def) => g.appendChild(buildField(def, kind + "::")));
    kindGroups.push(g);
    form.appendChild(g);
  });
  const applyKind = (kind) => kindGroups.forEach((g) => { g.hidden = g.dataset.kind !== kind; });
  kindSel.addEventListener("change", () => applyKind(kindSel.value));
  applyKind(kindSel.value);

  // References repeater (≥ 1 row; a row needs a title).
  const refList = el("div", { class: "contrib-refs" });
  const addRefRow = (title = "", url = "") => {
    const t = el("input", { type: "text", class: "llm-field contrib-input", placeholder: "Reference title" });
    const u = el("input", { type: "text", class: "llm-field contrib-input", placeholder: "URL (optional)" });
    t.value = title; u.value = url;
    const rm = el("button", { type: "button", class: "contrib-ref-rm", title: "Remove" }, ["×"]);
    const row = el("div", { class: "ref-row" }, [t, u, rm]);
    row._get = () => ({ title: t.value.trim(), url: u.value.trim() });
    rm.addEventListener("click", () => { row.remove(); if (!refList.children.length) addRefRow(); });
    refList.appendChild(row);
  };
  addRefRow();
  const getRefs = () => Array.from(refList.children).map((r) => r._get())
    .filter((r) => r.title || r.url)
    .map((r) => (r.url ? { title: r.title, url: r.url } : { title: r.title }));
  const addRefBtn = el("button", { type: "button", class: "answer-cta" }, ["+ Add reference"]);
  addRefBtn.addEventListener("click", () => addRefRow());
  form.appendChild(el("div", { class: "contrib-field" }, [
    el("label", { class: "field-label" }, ["References * (at least one with a title)"]),
    refList, addRefBtn,
  ]));

  // Build the entry object (template field order; empty optional core fields dropped).
  const collectEntry = () => {
    const kind = kindSel.value;
    const e = {
      id: inputs.get("id")(),
      canonical_name: inputs.get("canonical_name")(),
      aliases: inputs.get("aliases")(),
      kind,
      domain: getDomains(),
      subtopics: inputs.get("subtopics")(),
      tags: inputs.get("tags")(),
      short_description: inputs.get("short_description")(),
      formula_latex: inputs.get("formula_latex")(),
      formula_plaintext: inputs.get("formula_plaintext")(),
      prerequisites: inputs.get("prerequisites")(),
      related: inputs.get("related")(),
      references: getRefs(),
    };
    (CONTRIB_FIELDS_BY_KIND[kind] || []).forEach((def) => {
      const v = inputs.get(kind + "::" + def.key)();
      if (!contribEmpty(v)) e[def.key] = v;
    });
    for (const k of ["aliases", "formula_latex", "formula_plaintext", "subtopics", "tags", "prerequisites", "related"]) {
      if (contribEmpty(e[k])) delete e[k];
    }
    return e;
  };

  // Client validation mirroring the offline validator's core checks.
  const validateEntry = (e) => {
    const errs = [];
    if (!e.id) errs.push("id is required");
    else if (!CONTRIB_SLUG_RE.test(e.id)) errs.push("id must be a slug (lowercase letters, digits, - or _)");
    if (!e.canonical_name) errs.push("Canonical name is required");
    if (!e.short_description) errs.push("Short description is required");
    if (!e.domain.length) errs.push("Select at least one domain");
    if (!e.references.some((r) => r.title)) errs.push("Add at least one reference with a title");
    e.references.forEach((r) => {
      if (!r.url) return;
      let bad = /\s/.test(r.url);
      if (!bad) { try { new URL(r.url, "https://card.invalid/"); } catch { bad = true; } }
      if (bad) errs.push(`Reference URL is malformed: ${r.url}`);
    });
    if (CONTRIB_LATEX_REQUIRED.has(e.kind) && !e.formula_latex) errs.push(`A ${e.kind} needs a formula (LaTeX)`);
    if (e.kind === "measure" && !(e.input_types && e.input_types.length)) errs.push("A measure needs at least one input type");
    if (e.formula_latex && !latexBalanced(e.formula_latex)) errs.push("Formula LaTeX has unbalanced braces or $");
    return errs;
  };

  // Actions.
  const errorBox = el("div", { class: "contrib-errors", role: "alert", tabindex: "-1" });
  const status = el("span", { class: "chat-status contrib-status" });
  const showErrors = (errs) => {
    errorBox.textContent = "";
    if (!errs.length) return;
    errorBox.appendChild(el("p", {}, ["Please fix before submitting:"]));
    errorBox.appendChild(el("ul", {}, errs.map((x) => el("li", {}, [x]))));
    errorBox.scrollIntoView({ block: "nearest" });
    errorBox.focus();
  };
  const issueBtn = el("button", { type: "button", class: "answer-cta primary" }, ["Open GitHub issue"]);
  issueBtn.addEventListener("click", () => {
    const e = collectEntry(), errs = validateEntry(e);
    if (errs.length) return showErrors(errs);
    showErrors([]);
    window.open(newCardIssueUrl(e), "_blank", "noopener");
    status.textContent = "Opened a prefilled GitHub issue for review.";
  });
  const copyBtn = el("button", { type: "button", class: "answer-cta" }, ["Copy card JSON"]);
  copyBtn.addEventListener("click", async () => {
    const e = collectEntry(), errs = validateEntry(e);
    if (errs.length) return showErrors(errs);
    showErrors([]);
    try { await navigator.clipboard.writeText(JSON.stringify(e, null, 2)); copyBtn.textContent = "Copied!"; }
    catch (_) { copyBtn.textContent = "Copy failed"; }
    setTimeout(() => (copyBtn.textContent = "Copy card JSON"), 1400);
  });
  form.appendChild(errorBox);
  form.appendChild(el("div", { class: "chips contribute-actions" }, [issueBtn, copyBtn, status]));
  return form;
}

function buildContribInfo(db) {
  const wrap = el("details", { class: "contrib-info" });
  wrap.appendChild(el("summary", {}, ["Other ways to contribute & the entry schema"]));
  wrap.appendChild(el("div", { class: "chips contribute-actions" }, [
    el("a", { class: "answer-cta", href: editUrl(), target: "_blank", rel: "noopener" }, ["✎ Edit measures.json on GitHub"]),
    el("a", { class: "answer-cta", href: "#/" }, ["🔎 Browse & edit an existing card"]),
  ]));
  const how = el("ol", { class: "contribute-steps" }, [
    el("li", {}, ["Fill the form above; the ", el("a", { href: "#/linker" }, ["PDF Linker"]), " can also draft a card from a paper for you to review."]),
    el("li", {}, ["Open the prefilled issue (or a pull request). CI validates the data automatically — schema, taxonomy, references, and every cross-reference."]),
    el("li", {}, ["A maintainer reviews and merges. GitHub Pages rebuilds and the card is live; existing annotated PDFs keep working because their links point to the permalink."]),
  ]);
  wrap.appendChild(section("How it works", how));

  const schema = el("div", {});
  schema.appendChild(el("p", { class: "muted" }, ["Each entry is one JSON object. Core fields (every kind):"]));
  const dl = el("dl", { class: "schema-list" });
  [
    ["id", "unique slug (becomes the #/m/:id permalink)"],
    ["canonical_name", "the primary display name"],
    ["kind / domain", "taxonomy classification (see data/taxonomy.json)"],
    ["aliases", "other names it goes by — used by search and the PDF linker"],
    ["short_description", "one precise sentence"],
    ["formula_latex / formula_plaintext", "the definition"],
    ["prerequisites / related", "other card ids (relationship graph)"],
    ["references", "1–3 real, authoritative sources { title, url }"],
  ].forEach(([k, v]) => {
    dl.appendChild(el("dt", {}, [k]));
    dl.appendChild(el("dd", {}, [v]));
  });
  schema.appendChild(dl);
  schema.appendChild(el("p", { class: "muted" }, [
    "Kind-specific fields (measures add input_types, properties, …; theorems add a statement; etc.) live in ",
    el("a", { href: blobUrl(), target: "_blank", rel: "noopener" }, ["the data"]),
    " under data/templates/. Set metric / symmetric / bounded / SPD flags from known mathematics, not guesses.",
  ]));
  wrap.appendChild(section("Entry schema", schema));
  return wrap;
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
      short: "Curated JSON cards + taxonomy, indexed, graphed & validated on load",
      modules: ["data.js", "measures.json", "taxonomy.json", "aliases.json"],
      detail: [
        "Every card is one JSON object: a kind and domain(s) from the taxonomy, name, aliases, symbols, formula, properties, cross-linked identities & inequalities, related/prerequisite links, audited code, and references.",
        "On load, data.js builds fast lookups (by id + an alias index), a taxonomy of kinds/domains, and a relationship graph (symmetric “related” plus prerequisite/dependent edges), then validates ids, taxonomy, and graph consistency (dangling links, prerequisite cycles). Cards load from a multi-file manifest, so new domains drop in as separate files. This single source of truth powers search, the assistant, and the PDF linker.",
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
        short: "pdf.js reads the PDF; optional vision reader transcribes equations",
        modules: ["pdf.js", "vision.js"],
        detail: [
          "pdf.js pulls out the text with per-word geometry and character offsets — no server, no key.",
          "Optionally, a vision-capable model (your own key) transcribes each page’s equations to LaTeX (vision.js), so measures that appear only as formulas — not named in prose — can still be detected and linked.",
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
        short: "Find unnamed / formula-defined measures (retrieval-scoped)",
        modules: ["linker.js", "llm.js", "embeddings.js"],
        detail: [
          "If a key+model are set, each text chunk goes to your LLM with a compact catalog, and it returns measures that appear only as formulas or under names not in our dictionary.",
          "To keep cost flat as the library grows, retrieval sends only the cards relevant to each chunk — lexical hits plus their neighbours and MiniLM embedding nearest-neighbours — instead of the whole catalog. Results merge with the dictionary matches (the dictionary wins overlaps), and invalid JSON from a weak model is non-fatal.",
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
        short: "Cards, formulas, audited code, relationships & learning paths",
        modules: ["render.js", "mathjax.js", "codegen.js", "graph.js"],
        detail: [
          "Detail pages render formulas with MathJax, show audited NumPy / PyTorch / JAX (never AI-generated code), and cross-linked identities & inequalities.",
          "From the relationship graph they also surface prerequisites, a learning path (the ordered chain to reach a concept), what a card builds toward, and related / see-also cards — with an SVG neighbourhood graph.",
        ],
      },
      {
        id: "collaborate",
        cat: "data",
        title: "Collaborate",
        short: "Data-driven cards, GitHub PR + CI, stable permalinks",
        modules: ["config.js", "GitHub Actions"],
        detail: [
          "Because cards are just data, anyone can propose or edit one on GitHub. CI validates every change — schema, taxonomy (kinds/domains), and relationship consistency (dangling links, prerequisite cycles); once merged, GitHub Pages rebuilds and the card updates everywhere — including inside already-annotated PDFs, whose links point to the stable #/m/:id permalink.",
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
