// Loads the JSON data files, builds lookup indexes, and validates the database.
// Fetch is relative to the document (index.html at the app root), so "data/..."
// resolves correctly on GitHub Pages. Under file:// fetch fails; the caller
// surfaces a friendly banner (see app.js).

import { normalize } from "./util.js";

const DATA_FILES = {
  measures: "data/measures.json",
  aliases: "data/aliases.json",
  families: "data/families.json",
  codeTemplates: "data/code_templates.json",
};

export const KNOWN_OBJECT_TYPES = new Set([
  "scalar", "vector", "matrix", "spd_matrix", "probability_vector",
  "probability_density", "probability_distribution", "empirical_samples",
  "function", "set", "metric_space", "graph", "string", "time_series",
]);

export const OBJECT_TYPE_LABELS = {
  scalar: "Scalar",
  vector: "Vector",
  matrix: "Matrix",
  spd_matrix: "SPD matrix",
  probability_vector: "Probability vector",
  probability_density: "Probability density",
  probability_distribution: "Probability distribution",
  empirical_samples: "Empirical samples",
  function: "Function",
  set: "Set",
  metric_space: "Metric space",
  graph: "Graph",
  string: "String",
  time_series: "Time series",
};

export const KNOWN_PROPERTY_KEYS = new Set([
  "nonnegative", "symmetric", "bounded", "metric", "sqrt_metric",
  "differentiable", "convex_in_first_argument",
  "finite_requires_absolute_continuity", "requires_same_support",
  "closed_form_gaussian",
]);

export const PROPERTY_LABELS = {
  nonnegative: "Non-negative",
  symmetric: "Symmetric",
  bounded: "Bounded",
  metric: "Metric",
  sqrt_metric: "Square root is a metric",
  differentiable: "Differentiable",
  convex_in_first_argument: "Convex in first argument",
  finite_requires_absolute_continuity: "Finite only if absolutely continuous",
  requires_same_support: "Requires same support",
  closed_form_gaussian: "Closed form for Gaussians",
};

export const APPLICATION_LABELS = {
  classification: "Classification",
  "generative-modeling": "Generative modeling",
  "hypothesis-testing": "Hypothesis testing",
  privacy: "Privacy",
  clustering: "Clustering",
  "manifold-learning": "Manifold learning",
  "mcmc-diagnostics": "MCMC diagnostics",
  "information-theory": "Information theory",
  retrieval: "Retrieval",
  "domain-adaptation": "Domain adaptation",
  "audio-speech": "Audio & speech",
  "metric-learning": "Metric learning",
  "robust-statistics": "Robust statistics",
};

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${path} (HTTP ${res.status})`);
  return res.json();
}

/**
 * Load all data, build indexes, and validate. Returns a db object.
 * Throws if the core measures file cannot be fetched (e.g. file://).
 */
export async function loadData() {
  const [measures, extraAliases, families, codeTemplates] = await Promise.all([
    fetchJSON(DATA_FILES.measures),
    fetchJSON(DATA_FILES.aliases).catch(() => ({})),
    fetchJSON(DATA_FILES.families).catch(() => ({})),
    fetchJSON(DATA_FILES.codeTemplates).catch(() => ({})),
  ]);

  const byId = new Map();
  for (const m of measures) byId.set(m.id, m);

  // Alias index: normalized term -> measure id. Built from the explicit alias
  // file plus every measure's own aliases and canonical name (single source of
  // truth, so the two never drift).
  const aliasIndex = new Map();
  const addAlias = (term, id) => {
    const key = normalize(term);
    if (key && !aliasIndex.has(key)) aliasIndex.set(key, id);
  };
  for (const m of measures) {
    addAlias(m.canonical_name, m.id);
    addAlias(m.id.replace(/_/g, " "), m.id);
    for (const a of m.aliases || []) addAlias(a, m.id);
  }
  for (const [term, id] of Object.entries(extraAliases)) addAlias(term, id);

  // Collected facet vocabularies for the filter panel.
  const allFamilies = new Set();
  const allInputTypes = new Set();
  const allProperties = new Set();
  const allApplications = new Set();
  for (const m of measures) {
    (m.family || []).forEach((f) => allFamilies.add(f));
    (m.input_types || []).forEach((t) => allInputTypes.add(t));
    (m.applications || []).forEach((a) => allApplications.add(a));
    for (const [k, v] of Object.entries(m.properties || {})) {
      if (v === true) allProperties.add(k);
    }
  }

  const db = {
    measures,
    byId,
    aliasIndex,
    families,
    codeTemplates,
    allFamilies: [...allFamilies].sort(),
    allInputTypes: [...allInputTypes].sort(),
    allProperties: [...allProperties].sort(),
    allApplications: [...allApplications].sort(),
    warnings: [],
  };

  db.warnings = validate(db);
  if (db.warnings.length) {
    console.warn(`[distances-dictionary] ${db.warnings.length} data warning(s):`);
    db.warnings.forEach((w) => console.warn("  -", w));
  }
  return db;
}

/** Resolve a family/object-type slug to a human label. */
export function familyLabel(db, key) {
  return (db.families[key] && db.families[key].label) || key;
}

/** Non-fatal data integrity checks (logged, never thrown). */
function validate(db) {
  const warnings = [];
  const ids = new Set();
  const names = new Set();
  for (const m of db.measures) {
    if (!m.id) { warnings.push("entry with missing id"); continue; }
    if (ids.has(m.id)) warnings.push(`duplicate id: ${m.id}`);
    ids.add(m.id);
    const nk = normalize(m.canonical_name);
    if (names.has(nk)) warnings.push(`duplicate canonical name: ${m.canonical_name}`);
    names.add(nk);
    if (!m.formula_latex && (m.code_templates || []).length === 0) {
      warnings.push(`${m.id}: empty formula and no code templates`);
    }
    for (const rel of m.related || []) {
      if (!db.byId.has(rel)) warnings.push(`${m.id}: related -> unknown id "${rel}"`);
    }
    for (const t of m.input_types || []) {
      if (!KNOWN_OBJECT_TYPES.has(t)) warnings.push(`${m.id}: unknown input type "${t}"`);
    }
    for (const k of Object.keys(m.properties || {})) {
      if (!KNOWN_PROPERTY_KEYS.has(k)) warnings.push(`${m.id}: unknown property "${k}"`);
    }
    for (const t of m.code_templates || []) {
      const tpl = db.codeTemplates[m.id];
      if (!tpl || !tpl[t]) warnings.push(`${m.id}: declared code template "${t}" not found`);
    }
  }
  for (const [term, id] of db.aliasIndex) {
    if (!db.byId.has(id)) warnings.push(`alias "${term}" -> unknown id "${id}"`);
  }
  return warnings;
}
