// Offline card-embedding precompute (Phase 2). Run ONCE in a Node environment and commit the
// result; re-run whenever cards change. Not runnable in the browser and NOT run in the
// authoring environment here (Node/@huggingface/transformers unavailable) — the site falls
// back to in-browser embedding when data/embeddings.json is absent (see embeddings.js
// loadPrebuiltVectors). The point is Phase-5 scale: precomputing avoids embedding hundreds of
// cards in every visitor's browser.
//
// Usage (from blog/distances-dictionary/):
//   npm i @huggingface/transformers
//   node scripts/build-embeddings.mjs
//
// CRITICAL: this MUST match embeddings.js exactly so query and card vectors share one space:
//   - same model id (Xenova/all-MiniLM-L6-v2), same { pooling: "mean", normalize: true }
//   - same per-card text as embeddings.js `embeddingText`:
//     canonical_name. aliases. short_description. family LABELS. practical_use_cases
//   Family labels come from data/families.json (mirrors familyLabel(db, key)).

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "@huggingface/transformers";

const DATA = path.resolve(process.cwd(), "data");
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8"));

// Load every card file listed in the Phase-1 manifest (fallback: measures.json).
let files = ["measures.json"];
try {
  const manifest = readJSON("cards/manifest.json");
  if (Array.isArray(manifest.files) && manifest.files.length) files = manifest.files;
} catch { /* no manifest → measures.json */ }
const cards = files.flatMap((f) => readJSON(f));

// Family label lookup (same source as familyLabel(db, key) in data.js).
let families = {};
try { families = readJSON("families.json"); } catch { /* labels optional */ }
const familyLabel = (key) => (families[key] && families[key].label) || key;

// Same composition as embeddings.js embeddingText(db, m).
const embeddingText = (m) => [
  m.canonical_name,
  (m.aliases || []).join(", "),
  m.short_description || "",
  (m.family || []).map(familyLabel).join(", "),
  (m.practical_use_cases || []).join(", "),
].join(". ");

const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const out = {};
for (const c of cards) {
  const e = await extractor(embeddingText(c), { pooling: "mean", normalize: true });
  out[c.id] = Array.from(e.data);
}
fs.writeFileSync(path.join(DATA, "embeddings.json"), JSON.stringify(out));
console.log(`wrote data/embeddings.json for ${cards.length} cards`);
