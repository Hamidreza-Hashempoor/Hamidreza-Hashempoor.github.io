// Layer 2: free, in-browser semantic search via Transformers.js.
//
// Nothing here runs until enableSemantic() is called (the "Enable AI search"
// button). It dynamically imports Transformers.js from a CDN, loads a small
// MiniLM embedding model (~23MB, fetched from the HF Hub, cached by the browser,
// no API key), embeds every measure once, and returns a ranker that cosine-
// scores a query against the cached vectors. Degrades to lexical on any failure.

import { normalize } from "./util.js";
import { familyLabel } from "./data.js";

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.1.2";
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let state = {
  ready: false,
  loading: false,
  extractor: null,
  vectors: new Map(), // id -> Float32Array (normalized)
  queryCache: new Map(),
};

export function isReady() {
  return state.ready;
}
export function isLoading() {
  return state.loading;
}

function embeddingText(db, m) {
  return [
    m.canonical_name,
    (m.aliases || []).join(", "),
    m.short_description || "",
    (m.family || []).map((f) => familyLabel(db, f)).join(", "),
    (m.practical_use_cases || []).join(", "),
  ].join(". ");
}

function toFloat32(output) {
  // feature-extraction with a single input returns a Tensor; .data is the vector.
  return output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Load the model and embed all measures. Idempotent.
 * @param {object} db
 * @param {(info:{status:string, progress?:number, file?:string})=>void} [onProgress]
 */
export async function enableSemantic(db, onProgress = () => {}) {
  if (state.ready) return true;
  if (state.loading) return false;
  state.loading = true;
  try {
    onProgress({ status: "Loading Transformers.js…" });
    const mod = await import(/* @vite-ignore */ TRANSFORMERS_URL);
    const { pipeline, env } = mod;
    if (env) {
      env.allowLocalModels = false; // always fetch from the Hub CDN
    }
    onProgress({ status: "Downloading embedding model (~23MB)…" });
    state.extractor = await pipeline("feature-extraction", MODEL_ID, {
      progress_callback: (p) => {
        if (p && p.status === "progress" && p.file) {
          onProgress({ status: `Downloading ${p.file}`, progress: p.progress || 0, file: p.file });
        }
      },
    });

    onProgress({ status: "Indexing measures…" });
    for (const m of db.measures) {
      const out = await state.extractor(embeddingText(db, m), { pooling: "mean", normalize: true });
      state.vectors.set(m.id, toFloat32(out));
    }
    state.ready = true;
    state.loading = false;
    onProgress({ status: "ready" });
    return true;
  } catch (err) {
    state.loading = false;
    console.warn("[distances-dictionary] semantic search unavailable:", err);
    onProgress({ status: "error", error: String(err) });
    throw err;
  }
}

/** Embed a query string (cached). */
async function embedQuery(text) {
  const key = normalize(text);
  if (state.queryCache.has(key)) return state.queryCache.get(key);
  const out = await state.extractor(text, { pooling: "mean", normalize: true });
  const v = toFloat32(out);
  state.queryCache.set(key, v);
  return v;
}

/**
 * Synchronous ranker for search(): returns a function
 *   (queryStr, candidateMeasures) => Map(id -> cosine in [0,1]).
 * Because search() is synchronous, this uses the query vector embedded by
 * prepareQuery(). Call prepareQuery(query) (async) before relying on it.
 */
export function ranker() {
  if (!state.ready) return null;
  return (queryStr, candidates) => {
    const qv = state.queryCache.get(normalize(queryStr));
    const sims = new Map();
    if (!qv) return sims; // not embedded yet; lexical-only this pass
    for (const m of candidates) {
      const mv = state.vectors.get(m.id);
      if (mv) sims.set(m.id, Math.max(0, dot(qv, mv)));
    }
    return sims;
  };
}

/** Ensure the query is embedded (async) before a re-render that uses ranker(). */
export async function prepareQuery(query) {
  if (!state.ready || !query) return;
  await embedQuery(query);
}

/** Top-k semantically nearest measure ids to a query (for RAG retrieval). */
export async function nearest(db, query, k = 5) {
  if (!state.ready) return [];
  const qv = await embedQuery(query);
  const scored = [];
  for (const [id, mv] of state.vectors) scored.push({ id, score: dot(qv, mv) });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => db.byId.get(s.id)).filter(Boolean);
}
