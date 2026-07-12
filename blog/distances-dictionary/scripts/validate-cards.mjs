// Card validator (Phase 4). Node authoring tool — run at authoring time; NOT run in this
// environment (no Node). Mirrors validate() in modules/data.js and the CI checks in
// .github/workflows/validate-measures.yml, and ADDS Phase-4 quality checks:
//   - kind-specific required fields (REQUIRED_BY_KIND) + recommended fields (soft)
//   - >=1 reference with a non-empty title; any present url must parse (new URL())
//   - id must be a valid slug
//   - LaTeX on formula_latex / symbols[] / identities[].latex / inequalities[].latex
//     (katex renderToString({throwOnError:true}) if installed; else structural latexBalanced())
//   - alias-collision: an alias that normalizes to a DIFFERENT card's name/alias
// HARD errors -> exit 1; SOFT warnings -> print, exit 0. Run before committing a content batch.
//
// Usage (from blog/distances-dictionary/):
//   node scripts/validate-cards.mjs            # structural LaTeX unless katex is installed
//   npm i katex && node scripts/validate-cards.mjs   # stricter LaTeX parse
//   NO_KATEX=1 node scripts/validate-cards.mjs  # force structural even if katex is present

import fs from "node:fs";
import path from "node:path";
import { normalize, latexBalanced } from "../modules/util.js";

const DATA = path.resolve(process.cwd(), "data");
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8"));
const tryJSON = (p, fb) => { try { return readJSON(p); } catch { return fb; } };

// ---- taxonomy + known vocabularies (mirror data.js) ----
const taxonomy = readJSON("taxonomy.json"); // required
const KNOWN_KINDS = new Set((taxonomy.kinds || []).map((k) => k.id));
const KNOWN_DOMAINS = new Set((taxonomy.domains || []).map((d) => d.id));
const KNOWN_TYPES = new Set(["scalar", "vector", "matrix", "spd_matrix", "probability_vector",
  "probability_density", "probability_distribution", "empirical_samples", "function", "set",
  "metric_space", "graph", "string", "time_series", "point_cloud", "tensor", "sequence"]);
const KNOWN_PROPS = new Set(["nonnegative", "symmetric", "bounded", "metric", "sqrt_metric",
  "differentiable", "convex_in_first_argument", "finite_requires_absolute_continuity",
  "requires_same_support", "closed_form_gaussian"]);
const ANTISYM = new Set(["generalizes", "specializes", "reduces_to"]);

// ---- cards (manifest -> measures.json fallback, same as relations-report.mjs) ----
let files = ["measures.json"];
try { const m = readJSON("cards/manifest.json"); if (Array.isArray(m.files) && m.files.length) files = m.files; } catch { /* no manifest */ }
const cards = files.flatMap((f) => readJSON(f));
const byId = new Map(cards.map((c) => [c.id, c]));
const aliases = tryJSON("aliases.json", {});        // flat { term: id }
const codeTemplates = tryJSON("code_templates.json", {}); // { id: { backend: ... } }

// ---- optional katex (brand-new optional dev dep; structural fallback otherwise) ----
let katex = null;
if (process.env.NO_KATEX !== "1") {
  try { const m = await import("katex"); katex = m.default || m; }
  catch { /* not installed -> structural latexBalanced() */ }
}
function latexError(s) {
  if (!s || !String(s).trim()) return null; // emptiness is a required-field concern, not a LaTeX one
  if (katex) {
    try { katex.renderToString(String(s), { throwOnError: true, displayMode: true }); return null; }
    catch (e) { return "katex: " + String(e.message || e).split("\n")[0]; }
  }
  return latexBalanced(String(s)) ? null : "unbalanced braces or $";
}

// ---- Phase-4 policy maps ----
const SLUG_RE = /^[a-z0-9]+([-_][a-z0-9]+)*$/;
const CORE_REQUIRED = ["id", "canonical_name", "kind", "domain", "short_description"];
// HARD kind-specific requirements. all: every field non-empty; oneOf: >=1 field per group non-empty.
const REQUIRED_BY_KIND = {
  measure: { all: ["input_types"], oneOf: [["formula_latex", "code_templates"]] },
  formula: { all: ["formula_latex"] },
  function: { all: ["formula_latex"] },
  distribution: { all: ["formula_latex"] },
  transform: { all: ["formula_latex"] },
  inequality: { oneOf: [["formula_latex", "inequalities"]] },
  theorem: {},
  concept: {},
  object: {},
  method: {},
};
// SOFT recommendations (warn only).
const RECOMMENDED_BY_KIND = {
  measure: ["properties", "range", "when_to_use", "practical_use_cases"],
  distribution: ["parameters", "range"],
  theorem: ["formula_latex", "prerequisites"],
  method: ["practical_use_cases", "when_to_use"],
  _all: ["tags", "related"],
};

const isEmpty = (v) => v == null || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

// alias-collision index: normalized name/alias -> first owning id.
const owner = new Map();
for (const c of cards) {
  for (const t of [c.canonical_name, ...(c.aliases || [])]) {
    const k = normalize(t);
    if (k && !owner.has(k)) owner.set(k, c.id);
  }
}

// ---- per-card checks ----
const report = [];              // { id, errors:[], warns:[] }
const idSeen = new Set();
const nameSeen = new Map();     // normalized canonical_name -> first id

for (const c of cards) {
  const E = [], W = [];
  const id = c.id;
  if (!id) { report.push({ id: "(no id)", errors: ["missing id"], warns: [] }); continue; }
  if (idSeen.has(id)) E.push("duplicate id");
  idSeen.add(id);
  if (!SLUG_RE.test(id)) E.push(`id "${id}" is not a valid slug`);
  const nk = normalize(c.canonical_name);
  if (nk) { if (nameSeen.has(nk) && nameSeen.get(nk) !== id) E.push(`duplicate canonical name "${c.canonical_name}"`); else if (!nameSeen.has(nk)) nameSeen.set(nk, id); }

  // core required
  for (const f of CORE_REQUIRED) if (isEmpty(c[f])) E.push(`missing core field "${f}"`);

  // kind / domain (data.js parity)
  if (c.kind && !KNOWN_KINDS.has(c.kind)) E.push(`unknown kind "${c.kind}"`);
  if (Array.isArray(c.domain)) for (const d of c.domain) if (!KNOWN_DOMAINS.has(d)) E.push(`unknown domain "${d}"`);

  // references: >=1 non-empty title; present urls must parse
  const refs = Array.isArray(c.references) ? c.references : [];
  if (!refs.some((r) => r && r.title && String(r.title).trim())) E.push("no reference with a non-empty title");
  for (const r of refs) {
    // Parse with a base so site-relative refs (e.g. ../distances/distances.html) are accepted;
    // reject internal whitespace (which new URL silently percent-encodes) and anything that throws,
    // matching the CI check so the offline and enforced gates agree.
    if (r && r.url) {
      let bad = /\s/.test(r.url);
      if (!bad) { try { new URL(r.url, "https://card.invalid/"); } catch { bad = true; } }
      if (bad) E.push(`malformed reference url "${r.url}"`);
    }
    else if (r && r.title && !r.url) W.push(`reference "${String(r.title).slice(0, 40)}" has no url`);
  }

  // kind-specific required (HARD) + recommended (SOFT)
  const spec = REQUIRED_BY_KIND[c.kind] || {};
  for (const f of spec.all || []) if (isEmpty(c[f])) E.push(`kind "${c.kind}" requires "${f}"`);
  for (const grp of spec.oneOf || []) if (grp.every((f) => isEmpty(c[f]))) E.push(`kind "${c.kind}" requires one of: ${grp.join(", ")}`);
  for (const f of [...(RECOMMENDED_BY_KIND[c.kind] || []), ...RECOMMENDED_BY_KIND._all]) if (isEmpty(c[f])) W.push(`recommended field "${f}" is empty`);

  // measure-only (data.js parity)
  if (c.kind === "measure") {
    for (const t of c.input_types || []) if (!KNOWN_TYPES.has(t)) E.push(`unknown input type "${t}"`);
    for (const k of Object.keys(c.properties || {})) if (!KNOWN_PROPS.has(k)) E.push(`unknown property "${k}"`);
  }

  // edges: dangling, self-link, in-field duplicate (data.js + CI parity)
  for (const field of ["prerequisites", "related"]) {
    const seen = new Set();
    for (const r of c[field] || []) {
      if (r === id) E.push(`${field} -> self-link`);
      if (seen.has(r)) E.push(`${field} -> duplicate id "${r}"`);
      seen.add(r);
      if (!byId.has(r)) E.push(`${field} -> unknown id "${r}"`);
    }
  }
  for (const e of c.relations || []) {
    if (!e || !e.to) { E.push('relations entry missing "to"'); continue; }
    if (e.to === id) E.push("relations -> self-link");
    else if (!byId.has(e.to)) E.push(`relations -> unknown id "${e.to}"`);
  }

  // declared code templates exist (CI parity)
  for (const t of c.code_templates || []) {
    const tpl = codeTemplates[id];
    if (!tpl || !tpl[t]) E.push(`declared code template "${t}" not found`);
  }

  // identities / inequalities: latex present + valid, refs resolve
  for (const kind of ["identities", "inequalities"]) {
    for (const rel of c[kind] || []) {
      if (!rel || !rel.latex) { E.push(`${kind} entry missing latex`); continue; }
      const le = latexError(rel.latex);
      if (le) E.push(`${kind} latex invalid (${le})`);
      for (const r of rel.refs || []) if (!byId.has(r)) E.push(`${kind} ref -> unknown id "${r}"`);
    }
  }

  // LaTeX on formula_latex + symbols[]
  { const le = latexError(c.formula_latex); if (le) E.push(`formula_latex invalid (${le})`); }
  for (const s of c.symbols || []) { const le = latexError(s); if (le) E.push(`symbol "${s}" invalid (${le})`); }

  // alias-collision: an alias that normalizes to a DIFFERENT card's name/alias.
  // SOFT (advisory) — an ambiguous alias silently loses to first-writer-wins in the alias
  // index rather than breaking anything, and resolving which card owns it is a human call.
  for (const a of c.aliases || []) {
    const o = owner.get(normalize(a));
    if (o && o !== id) W.push(`alias "${a}" collides with card "${o}" (ambiguous)`);
  }

  report.push({ id, errors: E, warns: W });
}

// ---- cross-card checks ----
const globalErr = [];
for (const [term, target] of Object.entries(aliases)) if (!byId.has(target)) globalErr.push(`alias "${term}" -> unknown id "${target}"`);
for (const cid of Object.keys(codeTemplates)) if (!byId.has(cid)) globalErr.push(`code_templates has unknown measure id "${cid}"`);

// antisymmetric typed-relation contradictions (data.js parity)
const typed = new Set();
for (const c of cards) for (const e of c.relations || []) if (e && e.to && ANTISYM.has(e.type)) typed.add(`${e.type} ${c.id} ${e.to}`);
for (const key of typed) { const [t, a, b] = key.split(" "); if (a < b && typed.has(`${t} ${b} ${a}`)) globalErr.push(`contradictory typed relation: ${a} & ${b} both "${t}"`); }

// prerequisite cycles: prereq subgraph must be a DAG (3-color DFS, data.js parity)
const prereqs = new Map(cards.map((c) => [c.id, (c.prerequisites || []).filter((p) => byId.has(p) && p !== c.id)]));
const color = new Map();
const visit = (x, stack) => {
  color.set(x, 1);
  for (const p of prereqs.get(x) || []) {
    const cc = color.get(p) || 0;
    if (cc === 1) globalErr.push("prerequisite cycle: " + [...stack, x, p].join(" -> "));
    else if (cc !== 2) visit(p, [...stack, x]);
  }
  color.set(x, 2);
};
for (const x of prereqs.keys()) if ((color.get(x) || 0) === 0) visit(x, []);

// orphan cards (soft, relations-report parity)
const dependents = new Set(cards.flatMap((c) => [...(c.prerequisites || []), ...(c.related || [])]));
for (const c of cards) {
  const hasEdge = (c.related || []).length || (c.prerequisites || []).length || (c.relations || []).length;
  if (!hasEdge && !dependents.has(c.id)) report.find((r) => r.id === c.id)?.warns.push("orphan card (no relationship edges)");
}

// ---- report ----
let hard = 0, soft = 0, failed = 0;
for (const r of report) {
  hard += r.errors.length; soft += r.warns.length;
  if (r.errors.length) { failed++; console.log(`FAIL ${r.id}`); r.errors.forEach((e) => console.log(`   ✗ ${e}`)); }
  r.warns.forEach((w) => console.log(`   ⚠ ${w}`));
}
if (globalErr.length) { console.log("FAIL (cross-card)"); globalErr.forEach((e) => { hard++; console.log(`   ✗ ${e}`); }); }
console.log(`\ncards: ${cards.length}  failing cards: ${failed}  hard errors: ${hard}  warnings: ${soft}  (latex: ${katex ? "katex" : "structural"})`);
console.log(hard ? `FAILED with ${hard} hard error(s).` : "OK: all hard checks passed.");
process.exit(hard ? 1 : 0);
