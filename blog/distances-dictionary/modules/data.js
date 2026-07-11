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
  taxonomy: "data/taxonomy.json",
  manifest: "data/cards/manifest.json",
};

export const KNOWN_OBJECT_TYPES = new Set([
  "scalar", "vector", "matrix", "spd_matrix", "probability_vector",
  "probability_density", "probability_distribution", "empirical_samples",
  "function", "set", "metric_space", "graph", "string", "time_series",
  "point_cloud", "tensor", "sequence",
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
  point_cloud: "Point cloud",
  tensor: "Tensor",
  sequence: "Sequence",
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
  const [manifest, taxonomy, extraAliases, families, codeTemplates] = await Promise.all([
    fetchJSON(DATA_FILES.manifest).catch(() => null), // optional; falls back to measures.json
    fetchJSON(DATA_FILES.taxonomy),                   // required: defines allowed kinds/domains
    fetchJSON(DATA_FILES.aliases).catch(() => ({})),
    fetchJSON(DATA_FILES.families).catch(() => ({})),
    fetchJSON(DATA_FILES.codeTemplates).catch(() => ({})),
  ]);

  // Cards come from the manifest's file list (paths relative to data/) so future
  // domains can drop in as separate files; without a manifest, load the single
  // measures file exactly as before.
  const useManifest = manifest && Array.isArray(manifest.files) && manifest.files.length;
  if (manifest && !useManifest) {
    console.warn("[distances-dictionary] data/cards/manifest.json has no usable \"files\" array — falling back to measures.json");
  }
  const cardFiles = useManifest ? manifest.files.map((f) => "data/" + f) : [DATA_FILES.measures];
  // One broken/missing card file must not take down the rest — skip it with a
  // console warning. Only an empty result (nothing loaded at all) stays fatal.
  const measures = (await Promise.all(cardFiles.map((f) =>
    fetchJSON(f).catch((e) => { console.warn(`[distances-dictionary] skipping card file ${f}: ${e.message}`); return []; })
  ))).flat();
  if (!measures.length) throw new Error("No dictionary cards could be loaded.");

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
  const allKinds = new Set();
  const allDomains = new Set();
  for (const m of measures) {
    (m.family || []).forEach((f) => allFamilies.add(f));
    (m.input_types || []).forEach((t) => allInputTypes.add(t));
    (m.applications || []).forEach((a) => allApplications.add(a));
    for (const [k, v] of Object.entries(m.properties || {})) {
      if (v === true) allProperties.add(k);
    }
    if (m.kind) allKinds.add(m.kind);
    (m.domain || []).forEach((d) => allDomains.add(d));
  }

  const db = {
    measures,
    byId,
    aliasIndex,
    families,
    codeTemplates,
    taxonomy,
    // Array.isArray guards: a malformed taxonomy must surface as validate() warnings
    // ("unknown kind/domain"), not crash loadData before validation can run.
    knownKinds: new Set((Array.isArray(taxonomy.kinds) ? taxonomy.kinds : []).map((k) => k.id)),
    knownDomains: new Set((Array.isArray(taxonomy.domains) ? taxonomy.domains : []).map((d) => d.id)),
    allFamilies: [...allFamilies].sort(),
    allInputTypes: [...allInputTypes].sort(),
    allProperties: [...allProperties].sort(),
    allApplications: [...allApplications].sort(),
    allKinds: [...allKinds].sort(),
    allDomains: [...allDomains].sort(),
    warnings: [],
  };

  // Relationship graph (reverse edges + symmetric `related`) + navigation helpers.
  db.graph = buildGraph(measures, byId);
  db.neighbors = (id) => {
    const n = db.graph.get(id);
    return n ? new Set([...n.related, ...n.prereqs, ...n.dependents]) : new Set();
  };
  // Transitive prerequisites, topologically ordered (prereqs first), self dropped.
  db.learningPath = (id) => {
    const seen = new Set(), order = [];
    const visit = (x) => {
      if (seen.has(x)) return;
      seen.add(x);
      for (const p of (db.graph.get(x)?.prereqs || [])) visit(p);
      order.push(x);
    };
    visit(id);
    order.pop(); // drop the card itself (visited last)
    return order.map((i) => byId.get(i)).filter(Boolean);
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

/* ----------------------------- relationship graph ------------------------ */

// Antisymmetric typed-relation kinds: A->type->B and B->type->A is contradictory.
const ANTISYMMETRIC_RELATIONS = new Set(["generalizes", "specializes", "reduces_to"]);

/**
 * Adjacency map with reverse edges. `related` is mirrored (symmetric); `prerequisites`
 * become forward `prereqs` + reverse `dependents`; optional typed `relations[]` are kept
 * as authored. Self-edges and edges to unknown ids are skipped (validate() warns on them).
 * @returns {Map<string, {related:Set<string>, prereqs:Set<string>, dependents:Set<string>, relations:Array<{to:string,type:string}>}>}
 */
function buildGraph(cards, byId) {
  const graph = new Map();
  const node = (id) => {
    if (!graph.has(id)) graph.set(id, { related: new Set(), prereqs: new Set(), dependents: new Set(), relations: [] });
    return graph.get(id);
  };
  for (const c of cards) node(c.id);
  for (const c of cards) {
    const n = node(c.id);
    for (const r of c.related || []) {
      if (byId.has(r) && r !== c.id) { n.related.add(r); node(r).related.add(c.id); } // symmetric
    }
    for (const p of c.prerequisites || []) {
      if (byId.has(p) && p !== c.id) { n.prereqs.add(p); node(p).dependents.add(c.id); } // reverse
    }
    for (const e of c.relations || []) {
      if (e && byId.has(e.to) && e.to !== c.id) n.relations.push({ to: e.to, type: e.type });
    }
  }
  return graph;
}

/** Prerequisite cycles (the prereq subgraph must be a DAG). Returns each cycle path. */
function prereqCycles(graph) {
  const color = new Map(), cycles = []; // 0 white, 1 gray, 2 black
  const dfs = (id, stack) => {
    color.set(id, 1);
    for (const p of graph.get(id).prereqs) {
      const c = color.get(p) || 0;
      if (c === 1) cycles.push([...stack, id, p]);
      else if (c !== 2) dfs(p, [...stack, id]);
    }
    color.set(id, 2);
  };
  for (const id of graph.keys()) if ((color.get(id) || 0) === 0) dfs(id, []);
  return cycles;
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
    // Taxonomy checks: every card needs a known kind and >=1 known domain.
    if (!m.kind) warnings.push(`${m.id}: missing kind`);
    else if (!db.knownKinds.has(m.kind)) warnings.push(`${m.id}: unknown kind "${m.kind}"`);
    if (!Array.isArray(m.domain) || m.domain.length === 0) warnings.push(`${m.id}: missing domain`);
    else for (const d of m.domain) {
      if (!db.knownDomains.has(d)) warnings.push(`${m.id}: unknown domain "${d}"`);
    }
    for (const p of m.prerequisites || []) {
      if (!db.byId.has(p)) warnings.push(`${m.id}: prerequisites -> unknown id "${p}"`);
    }
    // Measure-specific rules: don't judge future non-measure kinds by them.
    if (m.kind === "measure") {
      if (!m.formula_latex && (m.code_templates || []).length === 0) {
        warnings.push(`${m.id}: empty formula and no code templates`);
      }
      for (const t of m.input_types || []) {
        if (!KNOWN_OBJECT_TYPES.has(t)) warnings.push(`${m.id}: unknown input type "${t}"`);
      }
      for (const k of Object.keys(m.properties || {})) {
        if (!KNOWN_PROPERTY_KEYS.has(k)) warnings.push(`${m.id}: unknown property "${k}"`);
      }
    }
    for (const rel of m.related || []) {
      if (!db.byId.has(rel)) warnings.push(`${m.id}: related -> unknown id "${rel}"`);
    }
    // Relationship edges: self-links and duplicates within related/prerequisites.
    for (const field of ["related", "prerequisites"]) {
      const seenEdge = new Set();
      for (const r of m[field] || []) {
        if (r === m.id) warnings.push(`${m.id}: ${field} -> self-link`);
        if (seenEdge.has(r)) warnings.push(`${m.id}: ${field} -> duplicate id "${r}"`);
        seenEdge.add(r);
      }
    }
    for (const e of m.relations || []) {
      if (!e || !e.to) { warnings.push(`${m.id}: relations entry missing "to"`); continue; }
      if (e.to === m.id) warnings.push(`${m.id}: relations -> self-link`);
      else if (!db.byId.has(e.to)) warnings.push(`${m.id}: relations -> unknown id "${e.to}"`);
    }
    for (const t of m.code_templates || []) {
      const tpl = db.codeTemplates[m.id];
      if (!tpl || !tpl[t]) warnings.push(`${m.id}: declared code template "${t}" not found`);
    }
    for (const kind of ["identities", "inequalities"]) {
      for (const rel of m[kind] || []) {
        if (!rel || !rel.latex) warnings.push(`${m.id}: ${kind} entry missing latex`);
        for (const r of (rel && rel.refs) || []) {
          if (!db.byId.has(r)) warnings.push(`${m.id}: ${kind} ref -> unknown id "${r}"`);
        }
      }
    }
  }
  for (const [term, id] of db.aliasIndex) {
    if (!db.byId.has(id)) warnings.push(`alias "${term}" -> unknown id "${id}"`);
  }
  // Typed asymmetry: A ->(antisymmetric type)-> B and B ->(same type)-> A is contradictory.
  const typed = new Set();
  for (const m of db.measures) {
    for (const e of m.relations || []) {
      if (e && e.to && ANTISYMMETRIC_RELATIONS.has(e.type)) typed.add(`${e.type} ${m.id} ${e.to}`);
    }
  }
  for (const key of typed) {
    const [type, a, b] = key.split(" ");
    if (a < b && typed.has(`${type} ${b} ${a}`)) {
      warnings.push(`contradictory typed relation: ${a} and ${b} both "${type}" each other`);
    }
  }
  // Prerequisite cycles: the prereq subgraph must be a DAG.
  if (db.graph) {
    for (const cyc of prereqCycles(db.graph)) warnings.push(`prerequisite cycle: ${cyc.join(" -> ")}`);
  }
  return warnings;
}
