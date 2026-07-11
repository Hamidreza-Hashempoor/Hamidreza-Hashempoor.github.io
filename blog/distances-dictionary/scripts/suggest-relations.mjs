// Suggest candidate `related` links (Phase 3). Node authoring tool — run at authoring time;
// NOT run in this environment (no Node). For each card, prints the top-N nearest cards by
// embedding cosine (reuses data/embeddings.json from Phase 2) that ALSO share a domain or
// subtopic — candidates for a HUMAN to confirm. Never writes edges (keeps the graph clean).
//
// Usage (from blog/distances-dictionary/, after building embeddings):
//   node scripts/build-embeddings.mjs   # produces data/embeddings.json
//   node scripts/suggest-relations.mjs

import fs from "node:fs";
import path from "node:path";

const DATA = path.resolve(process.cwd(), "data");
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8"));
const TOP_N = 5;

let files = ["measures.json"];
try {
  const m = readJSON("cards/manifest.json");
  if (Array.isArray(m.files) && m.files.length) files = m.files;
} catch { /* no manifest */ }
const cards = files.flatMap((f) => readJSON(f));

let vecs;
try {
  vecs = readJSON("embeddings.json");
} catch {
  console.error("data/embeddings.json not found — run scripts/build-embeddings.mjs first.");
  process.exit(1);
}

const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? d / Math.sqrt(na * nb) : 0;
};
const shares = (a, b) => {
  const tags = new Set([...(a.domain || []), ...(a.subtopics || [])]);
  return [...(b.domain || []), ...(b.subtopics || [])].some((x) => tags.has(x));
};

for (const c of cards) {
  const cv = vecs[c.id];
  if (!cv) continue;
  const already = new Set([c.id, ...(c.related || [])]);
  const scored = [];
  for (const o of cards) {
    if (already.has(o.id) || !vecs[o.id] || !shares(c, o)) continue;
    scored.push([o.id, cosine(cv, vecs[o.id])]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const top = scored.slice(0, TOP_N);
  if (top.length) console.log(`${c.id}: ${top.map(([id, s]) => `${id}(${s.toFixed(2)})`).join(", ")}`);
}
