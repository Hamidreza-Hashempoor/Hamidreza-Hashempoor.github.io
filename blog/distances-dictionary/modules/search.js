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

// Tuning constants for semantic (Layer 2) mode.
const SEM_THRESHOLD = 0.22;    // min cosine for a pure-semantic (no-keyword) result to show
const RELEVANCE_THRESHOLD = 0.30; // below this (and no keyword hit) the query is treated as off-topic
const SEM_CAP = 18;            // max results to show in semantic mode

/**
 * Run the search. Returns:
 *   { query, exact, semantic, results: [{ measure, score }] }
 * `opts.semantic`: optional (queryStr, candidateMeasures) => Map(id -> cosine in [0,1]).
 * When that ranker returns scores, results are ranked over the WHOLE corpus by
 * meaning, so natural-language queries surface related measures even with no
 * keyword overlap. Otherwise the lexical cascade (exact -> token match -> fuzzy)
 * is used unchanged.
 */
export function search(db, query, opts = {}) {
  const q = normalize(query);
  if (!q) {
    const results = [...db.measures]
      .sort((a, b) => a.canonical_name.localeCompare(b.canonical_name))
      .map((measure) => ({ measure, score: 0 }));
    return { query: "", exact: null, semantic: false, results };
  }

  const exact = resolveExact(db, query);
  const queryTokens = tokens(query);

  // Lexical score for every measure (matchedAll flags a genuine keyword hit).
  const lex = new Map();
  let maxLex = 0;
  for (const m of db.measures) {
    const { score, matchedAll } = scoreMeasure(db, m, queryTokens);
    const s = matchedAll && score > 0 ? score : 0;
    lex.set(m.id, s);
    if (s > maxLex) maxLex = s;
  }

  // Semantic similarities over the FULL corpus (empty if AI off or query not embedded yet).
  const sims = opts.semantic ? opts.semantic(query, db.measures) : null;

  // ----- Semantic mode: rank the whole corpus by meaning -----
  if (sims && sims.size) {
    const denom = maxLex || 1;
    let maxSem = 0;
    let anyLex = false;
    let scored = db.measures.map((m) => {
      const lx = lex.get(m.id) || 0;
      const sem = sims.get(m.id) || 0;
      if (sem > maxSem) maxSem = sem;
      if (lx > 0) anyLex = true;
      let score;
      if (exact && exact.id === m.id) score = 1000;               // exact alias stays on top
      else if (lx > 0) score = 1 + 0.5 * sem + 0.3 * (lx / denom); // keyword hits keep priority
      else score = sem;                                            // pure semantic recall
      return { measure: m, score, sem, lx };
    });
    scored.sort((a, b) => b.score - a.score);

    // On-topic gate: an exact/keyword hit, or a sufficiently similar measure.
    const relevant = !!exact || anyLex || maxSem >= RELEVANCE_THRESHOLD;
    if (!relevant) {
      return { query: q, exact, semantic: true, relevant: false, maxSem, results: [] };
    }
    const results = scored
      .filter((r) => r.lx > 0 || r.sem >= SEM_THRESHOLD || (exact && exact.id === r.measure.id))
      .slice(0, SEM_CAP);
    return { query: q, exact, semantic: true, relevant: true, maxSem, results };
  }

  // ----- Lexical mode (AI off): token match, then fuzzy fallback, then exact boost -----
  let scored = [];
  for (const m of db.measures) {
    if (lex.get(m.id) > 0) scored.push({ measure: m, score: lex.get(m.id) });
  }
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
  if (exact) {
    const hit = scored.find((r) => r.measure.id === exact.id);
    if (hit) hit.score += 100;
    else scored.unshift({ measure: db.byId.get(exact.id), score: 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  return { query: q, exact, semantic: false, relevant: scored.length > 0, results: scored };
}
