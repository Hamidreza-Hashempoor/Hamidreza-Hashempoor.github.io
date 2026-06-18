// Resolve a user term to a measure id via the alias index (exact then fuzzy).

import { normalize } from "./util.js";
import { isFuzzyMatch, diceCoefficient } from "./fuzzy.js";

/**
 * Exact alias / canonical-name match.
 * @returns {{id:string, term:string}|null}
 */
export function resolveExact(db, query) {
  const key = normalize(query);
  if (!key) return null;
  const id = db.aliasIndex.get(key);
  return id ? { id, term: key } : null;
}

/**
 * Fuzzy alias / canonical-name match: best-scoring known term within threshold.
 * @returns {{id:string, term:string, score:number}|null}
 */
export function resolveFuzzy(db, query) {
  const key = normalize(query);
  if (!key) return null;
  let best = null;
  for (const [term, id] of db.aliasIndex) {
    if (!isFuzzyMatch(key, term)) continue;
    const score = diceCoefficient(key, term);
    if (!best || score > best.score) best = { id, term, score };
  }
  return best;
}
