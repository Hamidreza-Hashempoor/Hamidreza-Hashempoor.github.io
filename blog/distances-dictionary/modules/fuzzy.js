// Dependency-free fuzzy string matching: bigram Dice coefficient plus a
// bounded Levenshtein distance for short tokens. Enough for ~50 entries and
// keeps the no-build promise (no CDN dependency).

import { normalize } from "./util.js";

/** Character bigrams of a normalized string. */
function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sorensen-Dice coefficient over character bigrams, in [0, 1]. */
export function diceCoefficient(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  const counts = new Map();
  for (const g of ba) counts.set(g, (counts.get(g) || 0) + 1);
  let inter = 0;
  for (const g of bb) {
    const c = counts.get(g) || 0;
    if (c > 0) { inter++; counts.set(g, c - 1); }
  }
  return (2 * inter) / (ba.length + bb.length);
}

/** Levenshtein edit distance (early exit not needed at this scale). */
export function levenshtein(a, b) {
  a = normalize(a);
  b = normalize(b);
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let curr = new Array(m + 1);
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

/**
 * Combined fuzzy score in [0, 1] between a query and a candidate string.
 * Blends Dice similarity with a normalized edit-distance similarity, and
 * rewards substring containment.
 */
export function fuzzyScore(query, candidate) {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (c.includes(q)) return Math.max(0.85, q.length / c.length);
  const dice = diceCoefficient(q, c);
  const ed = levenshtein(q, c);
  const editSim = 1 - ed / Math.max(q.length, c.length);
  return Math.max(dice, editSim);
}

/**
 * Is this query a likely fuzzy match for the candidate?
 * Accepts a high Dice score, or a small edit distance for short tokens.
 */
export function isFuzzyMatch(query, candidate, { diceThreshold = 0.6, maxEdits = 2 } = {}) {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return false;
  if (c.includes(q) && q.length >= 3) return true;
  if (diceCoefficient(q, c) >= diceThreshold) return true;
  if (q.length <= 12 && levenshtein(q, c) <= maxEdits) return true;
  return false;
}
