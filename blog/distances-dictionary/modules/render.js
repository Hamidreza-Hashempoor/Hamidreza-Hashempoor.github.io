// DOM builders for every route: home (search + filters + results), measure
// detail, comparison table, and the result card / filter rail components.
// Render functions receive the `app` controller (app.js) for callbacks.

import { el, chip, escapeHTML } from "./util.js";
import {
  PROPERTY_LABELS, OBJECT_TYPE_LABELS, APPLICATION_LABELS, familyLabel,
} from "./data.js";
import { search } from "./search.js";
import { applyFilters, isFilterActive, filterCount } from "./filters.js";
import { renderCodePanel } from "./codegen.js";
import { renderGraph } from "./graph.js";

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

export function renderHome(db, app) {
  const root = el("div", { class: "home" });

  // Hero + example chips.
  const hero = el("section", { class: "hero-block" });
  hero.appendChild(el("p", { class: "hero-lead" }, [
    "Search by name, alias, formula idea, object type, property, or application. ",
    "Open a measure for its formula, properties, code, and related measures.",
  ]));
  const examples = el("div", { class: "examples" }, EXAMPLE_QUERIES.map((q) => {
    const b = el("button", { type: "button", class: "example-chip" }, [q]);
    b.addEventListener("click", () => app.setQuery(q));
    return b;
  }));
  hero.appendChild(examples);
  root.appendChild(hero);

  // Body: filter rail + results.
  const body = el("div", { class: "home-body" });
  body.appendChild(renderFilterRail(db, app));

  const main = el("section", { class: "results-col", "aria-label": "Results" });

  // Run search + filters.
  const { exact, results } = search(db, app.state.query, {
    semantic: app.state.semanticEnabled ? app.semanticRanker() : null,
  });
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
  if (app.state.semanticEnabled) {
    status.appendChild(el("span", { class: "ai-on" }, [" · AI semantic ranking on"]));
  }
  main.appendChild(status);

  if (measures.length === 0) {
    main.appendChild(el("p", { class: "empty" }, ["No measures match. Try fewer filters or a different term."]));
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

/* ------------------------------- not found -------------------------------- */

export function renderNotFound(message) {
  const root = el("div", { class: "not-found" });
  root.appendChild(el("a", { class: "back-link", href: "#/" }, ["← Back to search"]));
  root.appendChild(el("h1", { tabindex: "-1", id: "route-heading" }, ["Not found"]));
  root.appendChild(el("p", {}, [message || "That measure does not exist."]));
  return root;
}
