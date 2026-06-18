// Lexical search cascade over the measure database.
//
// Order: normalize -> exact alias -> field-weighted token match (multi-word AND)
// -> fuzzy fallback. An optional semantic re-rank (Layer 2) can be blended in.

import { normalize, tokens } from "./util.js";
import { PROPERTY_LABELS, OBJECT_TYPE_LABELS, APPLICATION_LABELS, familyLabel } from "./data.js";
import { resolveExact, resolveFuzzy } from "./aliasResolver.js";
import { fuzzyScore } from "./fuzzy.js";

const blobCache = new Map();

/** Weighted text fields for a measure (built once, cached by id). */
function fieldsFor(db, m) {
  if (blobCache.has(m.id)) return blobCache.get(m.id);
  const fields = [];
  const push = (text, weight) => { if (text) fields.push({ text: normalize(text), weight }); };
  push(m.canonical_name, 5);
  push(m.id.replace(/_/g, " "), 4);
  (m.aliases || []).forEach((a) => push(a, 4));
  (m.family || []).forEach((f) => push(familyLabel(db, f) + " " + f, 2.2));
  (m.input_types || []).forEach((t) => push((OBJECT_TYPE_LABELS[t] || t) + " " + t, 2));
  Object.entries(m.properties || {}).forEach(([k, v]) => {
    if (v === true) push((PROPERTY_LABELS[k] || k) + " " + k, 2);
  });
  (m.applications || []).forEach((a) => push(APPLICATION_LABELS[a] || a, 1.4));
  push(m.short_description, 1.6);
  (m.practical_use_cases || []).forEach((u) => push(u, 1.4));
  push(m.when_to_use, 1);
  push(m.when_not_to_use, 0.8);
  blobCache.set(m.id, fields);
  return fields;
}

/** How well a single query token matches one field's text. */
function matchQuality(token, text) {
  const tks = text.split(" ");
  if (tks.includes(token)) return 1;
  if (tks.some((w) => w.startsWith(token) && token.length >= 3)) return 0.85;
  if (text.includes(token) && token.length >= 3) return 0.6;
  return 0;
}

/** Score one measure against the query tokens. Returns {score, matched} */
function scoreMeasure(db, m, queryTokens) {
  const fields = fieldsFor(db, m);
  let total = 0;
  let matchedAll = true;
  for (const token of queryTokens) {
    let best = 0;
    for (const f of fields) {
      const q = matchQuality(token, f.text);
      if (q > 0) best = Math.max(best, q * f.weight);
    }
    if (best === 0) matchedAll = false;
    total += best;
  }
  return { score: total, matchedAll };
}

/**
 * Run the search. Returns:
 *   { query, exact, results: [{ measure, score }] }
 * `opts.semantic`: optional (queryStr, candidateMeasures) => Map(id -> cosine in [0,1]).
 */
export function search(db, query, opts = {}) {
  const q = normalize(query);
  if (!q) {
    const results = [...db.measures]
      .sort((a, b) => a.canonical_name.localeCompare(b.canonical_name))
      .map((measure) => ({ measure, score: 0 }));
    return { query: "", exact: null, results };
  }

  const exact = resolveExact(db, query);
  const queryTokens = tokens(query);

  // Field-weighted token scoring (multi-word AND).
  let scored = [];
  for (const m of db.measures) {
    const { score, matchedAll } = scoreMeasure(db, m, queryTokens);
    if (matchedAll && score > 0) scored.push({ measure: m, score });
  }

  // Fuzzy fallback when nothing matched cleanly (typos, near-misses).
  if (scored.length === 0) {
    const fuzzy = resolveFuzzy(db, query);
    const seen = new Set();
    const out = [];
    if (fuzzy) { out.push({ measure: db.byId.get(fuzzy.id), score: 3 }); seen.add(fuzzy.id); }
    for (const m of db.measures) {
      const s = Math.max(
        fuzzyScore(q, m.canonical_name),
        ...(m.aliases || []).map((a) => fuzzyScore(q, a))
      );
      if (s >= 0.45 && !seen.has(m.id)) { out.push({ measure: m, score: s }); seen.add(m.id); }
    }
    scored = out;
  }

  // Boost an exact alias hit to the top.
  if (exact) {
    const hit = scored.find((r) => r.measure.id === exact.id);
    if (hit) hit.score += 100;
    else scored.unshift({ measure: db.byId.get(exact.id), score: 100 });
  }

  // Optional semantic blend (Layer 2).
  if (opts.semantic && scored.length > 1) {
    const sims = opts.semantic(query, scored.map((r) => r.measure));
    if (sims && sims.size) {
      const maxLex = Math.max(...scored.map((r) => r.score)) || 1;
      for (const r of scored) {
        const lex = r.score / maxLex;
        const sem = sims.get(r.measure.id) || 0;
        r.score = r.measure.id === (exact && exact.id) ? r.score : 0.6 * lex + 0.4 * sem;
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return { query: q, exact, results: scored };
}
