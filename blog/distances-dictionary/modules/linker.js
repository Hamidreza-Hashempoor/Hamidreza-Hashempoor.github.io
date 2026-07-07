// Linker orchestration: build a compact catalog from the dictionary, chunk the
// document text, and ask the user's LLM to detect measure mentions AND link each
// to a canonical id — grounded so the model can only choose ids that exist.
// Combines the plan's Stage 2 (named), 3 (linking), and 4 (formula-defined).
//
// All LLM access is injected as `call({system, user}) -> parsedJSON`, so this
// module is testable with a fake and provider-agnostic (see llm.callJSON).
//
// Detection is a HYBRID: a deterministic dictionary-match pass (lexicalPass,
// needs no LLM) links every measure named in our cards; the LLM then augments
// with unnamed/formula-defined measures. See detectAndLink().

import { normalize } from "./util.js";

/** Compact, prompt-sized catalog (the whole dictionary fits in one prompt). */
export function buildCatalog(db) {
  // Fold the external aliases (data/aliases.json, merged into db.aliasIndex) in
  // per measure so the model also sees "KL", "EMD", "JS", etc.
  const extra = new Map();
  if (db.aliasIndex) {
    for (const [term, id] of db.aliasIndex) {
      const meas = db.byId && db.byId.get(id);
      if (meas && normalize(meas.canonical_name) === term) continue; // canonical kept as `name`
      if (!extra.has(id)) extra.set(id, new Set());
      extra.get(id).add(term);
    }
  }
  return db.measures.map((m) => ({
    id: m.id,
    name: m.canonical_name,
    aliases: [...new Set([...(m.aliases || []), ...(extra.get(m.id) || [])])],
    symbols: m.symbols || [],
    operand_types: m.input_types || [],
    formula: m.formula_plaintext || m.formula_latex || "",
  }));
}

/** Split text into overlapping chunks, tracking each chunk's base offset. */
export function chunk(text, size = 6000, overlap = 400) {
  const out = [];
  if (!text) return out;
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + size);
    out.push({ text: text.slice(i, end), base: i });
    if (end >= text.length) break;
    i = end - overlap;
  }
  return out;
}

/* ---------------------- deterministic dictionary match -------------------- */

// Ordinary-English / ambiguous single words: link only via the LLM (with
// context), never from a blind scan. Multi-word forms ("cosine similarity",
// "energy distance") are unaffected.
const STOPLIST = new Set([
  "cosine", "quadratic", "energy", "linear", "angular", "spectral", "kernel",
  "gaussian", "distance", "divergence", "similarity", "metric", "norm", "loss",
]);

// High-value abbreviations matched CASE-SENSITIVELY against the original text
// with hard word boundaries, so "KL"/"EMD" link but "tv"/"ks"/"js" inside
// ordinary words do not. Each is resolved to an id via the alias index.
const ABBREVS = ["KL", "JS", "JSD", "EMD", "MMD", "KSD", "DTW", "TV", "KS",
  "W1", "W2", "WFR", "CKA", "GED", "AIRM", "L1", "L2", "SSD", "TVD"];

/** A single-token key is too short/ambiguous for a blind scan? */
function passesPrecision(key) {
  if (STOPLIST.has(key)) return false;
  const toks = key.split(" ");
  if (toks.length === 1 && key.length < 4) return false; // handled by ABBREVS if useful
  return true;
}

/** normTerm -> {id, tokens, type} lexicon, from our cards' names + aliases. */
function buildLexicon(db) {
  const lex = new Map();
  const put = (term, id, type) => {
    if (!term || lex.has(term) || !passesPrecision(term)) return;
    lex.set(term, { id, tokens: term.split(" "), type });
  };
  if (db.aliasIndex) {
    for (const [term, id] of db.aliasIndex) {
      const meas = db.byId && db.byId.get(id);
      const isCanon = meas && normalize(meas.canonical_name) === term;
      put(term, id, isCanon ? "exact" : "alias");
      if (meas && isCanon) {
        // "Euclidean distance (L2)" rarely appears verbatim — also index the
        // parenthetical-stripped form "euclidean distance".
        const noParen = normalize(meas.canonical_name.replace(/\([^)]*\)/g, ""));
        if (noParen && noParen !== term) put(noParen, id, "exact");
      }
    }
  }
  return lex;
}

/**
 * Build a normalized copy of `text` plus an offset map back to the original.
 * Mirrors util.normalize's semantics char-by-char so lexicon keys (also built
 * with normalize) line up, while emitting correct ORIGINAL-text offsets. This
 * gives hyphen/space/line-break equivalence for free ("Jensen-Shannon" ==
 * "Jensen Shannon"). map[i] = original index of norm[i]; map[norm.length] = len.
 */
export function buildNormMap(text) {
  const s = String(text == null ? "" : text);
  let norm = "";
  const map = [];
  let prevSpace = true; // drop leading separators (mirrors .trim())
  for (let i = 0; i < s.length; i++) {
    const dec = s[i].toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
    for (const ch of dec) {
      if (/[a-z0-9]/.test(ch)) { norm += ch; map.push(i); prevSpace = false; }
      else if (!prevSpace) { norm += " "; map.push(i); prevSpace = true; }
    }
  }
  if (norm.endsWith(" ")) { norm = norm.slice(0, -1); map.pop(); }
  map.push(s.length);
  return { norm, map };
}

/**
 * Deterministically link every measure named in our cards (by name/alias/
 * abbreviation) within `text`. No LLM required. Returns mention objects with
 * correct original offsets and source:"lexical".
 */
export function lexicalPass(db, text) {
  const hits = [];
  const src = String(text == null ? "" : text);
  const { norm, map } = buildNormMap(src);
  if (!norm) return hits;

  // Token-sequence scan, longest-match-wins.
  const lex = buildLexicon(db);
  const byFirst = new Map();
  for (const info of lex.values()) {
    const arr = byFirst.get(info.tokens[0]) || [];
    arr.push(info);
    byFirst.set(info.tokens[0], arr);
  }
  for (const arr of byFirst.values()) arr.sort((a, b) => b.tokens.length - a.tokens.length);

  const toks = [];
  { let i = 0; for (const part of norm.split(" ")) { if (part) toks.push({ t: part, nStart: i, nEnd: i + part.length }); i += part.length + 1; } }

  for (let i = 0; i < toks.length; i++) {
    const cands = byFirst.get(toks[i].t);
    if (!cands) continue;
    for (const c of cands) {
      const L = c.tokens.length;
      if (i + L > toks.length) continue;
      let ok = true;
      for (let k = 0; k < L; k++) {
        const want = c.tokens[k], have = toks[i + k].t;
        const plural = want.length >= 4 && have === want + "s";
        if (have !== want && !plural) { ok = false; break; }
      }
      if (!ok) continue;
      const start = map[toks[i].nStart];
      const end = map[toks[i + L - 1].nEnd];
      const meas = db.byId && db.byId.get(c.id);
      hits.push({
        surface: src.slice(start, end),
        start, end, id: c.id,
        canonical_guess: null,
        operand_type: (meas && meas.input_types && meas.input_types[0]) || "unknown",
        match_type: c.type,
        confidence: c.type === "exact" ? 0.98 : 0.9,
        needs_review: false,
        source: "lexical",
      });
      i += L - 1; // longest-match-wins: skip consumed tokens
      break;
    }
  }

  // Case-sensitive abbreviation pass over the ORIGINAL text.
  if (db.aliasIndex) {
    for (const ab of ABBREVS) {
      const id = db.aliasIndex.get(normalize(ab));
      if (!id) continue;
      const meas = db.byId && db.byId.get(id);
      const re = new RegExp("\\b" + ab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
      let mt;
      while ((mt = re.exec(src)) !== null) {
        hits.push({
          surface: ab,
          start: mt.index,
          end: mt.index + ab.length,
          id,
          canonical_guess: null,
          operand_type: (meas && meas.input_types && meas.input_types[0]) || "unknown",
          match_type: "alias",
          confidence: 0.85,
          needs_review: false,
          source: "lexical",
        });
      }
    }
  }

  return hits;
}

const DETECT_SYSTEM =
  "You analyze an academic text CHUNK and identify every MENTION of a distance, divergence, " +
  "similarity, or metric MEASURE between mathematical objects (vectors, matrices, probability " +
  "distributions, functions, strings, quantum states). Include measures referred to by an alias or " +
  "abbreviation, and measures DEFINED by a formula even if unnamed — including equations that state a " +
  "measure's definition, an identity, or an inequality between measures (use the equation text as the surface). " +
  "Link each mention to AT MOST ONE entry from the provided CATALOG, matching by name, alias, symbol, " +
  "operand type, or an adjacent formula. If it is genuinely a measure but no catalog entry fits, set " +
  "\"id\": null (a possible new entry). " +
  "Return ONLY JSON (no prose, no markdown fences) of the form: " +
  "{\"mentions\":[{\"surface\":\"<exact substring of the chunk>\",\"char_start\":<int>,\"char_end\":<int>," +
  "\"id\":\"<catalog id or null>\",\"canonical_guess\":\"<name if id is null, else null>\"," +
  "\"operand_type\":\"vector|spd_matrix|probability_distribution|function|string|quantum_state|unknown\"," +
  "\"match_type\":\"exact|alias|symbol|formula|semantic|none\",\"confidence\":<0..1>," +
  "\"needs_human_review\":<bool>}]}. " +
  "Rules: choose ids ONLY from the catalog; never invent an id. char_start/char_end are 0-based offsets " +
  "into the CHUNK text. Set needs_human_review=true when confidence<0.75 or when argument-order/sign " +
  "conventions could change the identity. If none, return {\"mentions\":[]}.";

function detectUser(catalog, chunkText) {
  return `CATALOG (json):\n${JSON.stringify(catalog)}\n\nCHUNK (offsets are 0-based into this exact text):\n${chunkText}`;
}

const DRAFT_SYSTEM =
  "Draft a NEW dictionary entry (JSON only) for an unrecognized measure, using these fields: " +
  "id (kebab-case), canonical_name, aliases (array), symbols (array of LaTeX), family (string), " +
  "operand_type, properties {non_negative, symmetric, bounded, is_metric, triangle_inequality}, " +
  "formula_latex, conventions (string), worked_example {inputs, expected_value (you compute it)}, " +
  "reference_impl {numpy (a single pure function string)}, references (array of strings). " +
  "Mark every field you are unsure of in a \"_review\": [\"field\", ...] array. Do not fabricate " +
  "references. Return ONLY the JSON object.";

/** Validate + clamp one raw mention against a chunk; return null if unusable. */
function normalizeMention(raw, chunkText, base, ids) {
  if (!raw || typeof raw.surface !== "string" || !raw.surface) return null;
  let start = Number.isInteger(raw.char_start) ? raw.char_start : -1;
  let end = Number.isInteger(raw.char_end) ? raw.char_end : -1;
  if (!(start >= 0 && end > start && chunkText.slice(start, end) === raw.surface)) {
    const idx = chunkText.indexOf(raw.surface);
    if (idx < 0) return null;
    start = idx;
    end = idx + raw.surface.length;
  }
  const id = raw.id && ids.has(raw.id) ? raw.id : null;
  const conf = typeof raw.confidence === "number" ? raw.confidence : 0.5;
  return {
    surface: raw.surface,
    start: base + start,
    end: base + end,
    id,
    canonical_guess: id ? null : (raw.canonical_guess || null),
    operand_type: raw.operand_type || "unknown",
    match_type: id ? (raw.match_type || "semantic") : "none",
    confidence: conf,
    needs_review: !!raw.needs_human_review || !id || conf < 0.75,
    source: "llm",
  };
}

/** Priority for overlap resolution: lexical-exact > alias > llm-id > llm-null. */
function rank(m) {
  if (m.source === "lexical") return m.match_type === "exact" ? 4 : 3;
  return m.id ? 2 : 1;
}

/**
 * Merge lexical + LLM mentions. Greedy by priority (then confidence, then
 * longer span): a span is kept only if it doesn't overlap a higher-priority
 * one already kept — so a precise dictionary link beats an overlapping LLM
 * guess, while LLM-only formula/new-measure spans survive where nothing else
 * matched. Result is sorted ascending for the reading view.
 */
export function mergeMentions(lex, llm) {
  const all = [...lex, ...llm].sort((a, b) =>
    rank(b) - rank(a) ||
    b.confidence - a.confidence ||
    (b.end - b.start) - (a.end - a.start) ||
    a.start - b.start);
  const kept = [];
  for (const m of all) {
    if (kept.some((k) => m.start < k.end && m.end > k.start)) continue;
    kept.push(m);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

/**
 * Detect + link measures over the whole document text (hybrid).
 * Always runs the deterministic dictionary pass; runs the LLM pass only when
 * `call` is a function (a key is set). A single chunk's LLM failure is
 * non-fatal and never wipes the lexical hits in its range.
 * @param {{db, text, call?, onProgress?, maxChunks?}} opts
 *   call: async ({system,user}) => parsed JSON object, or null/undefined
 * @returns {Promise<{mentions:Array, chunks:number, dropped:number, errors:string[], bySource:object}>}
 */
export async function detectAndLink({ db, text, call, onProgress = () => {}, maxChunks = 25 }) {
  // 1. Deterministic dictionary match (no key needed).
  onProgress({ stage: "lexical" });
  const lex = lexicalPass(db, text);

  // 2. Optional LLM augmentation for unnamed / formula-defined measures.
  const catalog = buildCatalog(db);
  const ids = new Set(catalog.map((c) => c.id));
  const chunks = chunk(text);
  const use = chunks.slice(0, maxChunks);
  const dropped = chunks.length - use.length;
  const errors = [];
  const llm = [];

  if (typeof call === "function") {
    for (let i = 0; i < use.length; i++) {
      onProgress({ stage: "detect", index: i + 1, total: use.length });
      const { text: ctext, base } = use[i];
      let parsed;
      try {
        parsed = await call({ system: DETECT_SYSTEM, user: detectUser(catalog, ctext) });
      } catch (e) {
        errors.push(String(e && e.message ? e.message : e));
        continue; // lexical hits in this chunk's range are unaffected
      }
      const mentions = (parsed && Array.isArray(parsed.mentions)) ? parsed.mentions : [];
      for (const raw of mentions) {
        const norm = normalizeMention(raw, ctext, base, ids);
        if (norm) llm.push(norm);
      }
    }
  }

  // 3. Merge with lexical priority; keep LLM-only spans where nothing overlaps.
  const merged = mergeMentions(lex, llm);
  return {
    mentions: merged,
    chunks: chunks.length,
    dropped,
    errors,
    bySource: { lexical: lex.length, llm: llm.length, merged: merged.length, usedLLM: typeof call === "function" },
  };
}

/** Stage 7: ask the LLM to draft a schema-valid entry for an unmatched mention. */
export async function draftEntry({ mention, context, call }) {
  const user =
    `Unrecognized measure to draft.\n` +
    `Surface text: ${mention.surface}\n` +
    `Guessed name: ${mention.canonical_guess || "unknown"}\n` +
    `Operand type: ${mention.operand_type}\n` +
    `Surrounding context:\n${context || "(none provided)"}`;
  return call({ system: DRAFT_SYSTEM, user });
}
