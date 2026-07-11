// Relationship gap report (Phase 3). Node authoring tool — run at authoring time; NOT run in
// this environment (no Node). Mirrors the graph/cycle logic in modules/data.js and reports:
//   - orphan cards (no related / prereqs / dependents / typed relations),
//   - contradictory antisymmetric typed pairs (A and B both generalize/specialize/reduce_to each other),
//   - prerequisite cycles (the prereq subgraph must be a DAG).
//
// Usage (from blog/distances-dictionary/):
//   node scripts/relations-report.mjs

import fs from "node:fs";
import path from "node:path";

const DATA = path.resolve(process.cwd(), "data");
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8"));

let files = ["measures.json"];
try {
  const m = readJSON("cards/manifest.json");
  if (Array.isArray(m.files) && m.files.length) files = m.files;
} catch { /* no manifest */ }
const cards = files.flatMap((f) => readJSON(f));
const byId = new Map(cards.map((c) => [c.id, c]));

// Graph: mirror `related`, reverse `prerequisites` into `dependents` (same as data.js buildGraph).
const graph = new Map();
const node = (id) => {
  if (!graph.has(id)) graph.set(id, { related: new Set(), prereqs: new Set(), dependents: new Set() });
  return graph.get(id);
};
for (const c of cards) node(c.id);
for (const c of cards) {
  const n = node(c.id);
  for (const r of c.related || []) if (byId.has(r) && r !== c.id) { n.related.add(r); node(r).related.add(c.id); }
  for (const p of c.prerequisites || []) if (byId.has(p) && p !== c.id) { n.prereqs.add(p); node(p).dependents.add(c.id); }
}

const orphans = [...graph]
  .filter(([id, n]) => !n.related.size && !n.prereqs.size && !n.dependents.size && !((byId.get(id).relations || []).length))
  .map(([id]) => id);

const ANTISYM = new Set(["generalizes", "specializes", "reduces_to"]);
const typed = new Set();
for (const c of cards) for (const e of c.relations || []) {
  if (e && e.to && ANTISYM.has(e.type)) typed.add(`${e.type} ${c.id} ${e.to}`);
}
const contradictions = [];
for (const k of typed) {
  const [t, a, b] = k.split(" ");
  if (a < b && typed.has(`${t} ${b} ${a}`)) contradictions.push(`${a} & ${b} both "${t}"`);
}

const color = new Map(), cycles = [];
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

console.log(`cards: ${cards.length}`);
console.log(`orphans (no edges): ${orphans.length}${orphans.length ? " -> " + orphans.join(", ") : ""}`);
console.log(`contradictory typed pairs: ${contradictions.length}${contradictions.length ? " -> " + contradictions.join("; ") : ""}`);
console.log(`prerequisite cycles: ${cycles.length}${cycles.length ? " -> " + cycles.map((c) => c.join("->")).join("; ") : ""}`);
