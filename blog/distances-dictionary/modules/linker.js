// Linker orchestration: build a compact catalog from the dictionary, chunk the
// document text, and ask the user's LLM to detect measure mentions AND link each
// to a canonical id — grounded so the model can only choose ids that exist.
// Combines the plan's Stage 2 (named), 3 (linking), and 4 (formula-defined).
//
// All LLM access is injected as `call({system, user}) -> parsedJSON`, so this
// module is testable with a fake and provider-agnostic (see llm.callJSON).

/** Compact, prompt-sized catalog (the whole ~48-entry dictionary fits). */
export function buildCatalog(db) {
  return db.measures.map((m) => ({
    id: m.id,
    name: m.canonical_name,
    aliases: m.aliases || [],
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

const DETECT_SYSTEM =
  "You analyze an academic text CHUNK and identify every MENTION of a distance, divergence, " +
  "similarity, or metric MEASURE between mathematical objects (vectors, matrices, probability " +
  "distributions, functions, strings, quantum states). Include measures referred to by an alias or " +
  "abbreviation, and measures DEFINED by a formula even if unnamed. " +
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
  };
}

/** Drop overlapping spans, keeping the higher-confidence one. */
function dedupe(ms) {
  ms.sort((a, b) => a.start - b.start || b.confidence - a.confidence);
  const out = [];
  for (const m of ms) {
    const last = out[out.length - 1];
    if (last && m.start < last.end) {
      if (m.confidence > last.confidence) out[out.length - 1] = m;
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Detect + link measures over the whole document text.
 * @param {{db, text, call, onProgress?, maxChunks?}} opts
 *   call: async ({system,user}) => parsed JSON object
 * @returns {Promise<{mentions:Array, chunks:number, dropped:number, errors:string[]}>}
 */
export async function detectAndLink({ db, text, call, onProgress = () => {}, maxChunks = 25 }) {
  const catalog = buildCatalog(db);
  const ids = new Set(catalog.map((c) => c.id));
  const chunks = chunk(text);
  const use = chunks.slice(0, maxChunks);
  const dropped = chunks.length - use.length;
  const errors = [];
  const all = [];

  for (let i = 0; i < use.length; i++) {
    onProgress({ stage: "detect", index: i + 1, total: use.length });
    const { text: ctext, base } = use[i];
    let parsed;
    try {
      parsed = await call({ system: DETECT_SYSTEM, user: detectUser(catalog, ctext) });
    } catch (e) {
      errors.push(String(e && e.message ? e.message : e));
      continue;
    }
    const mentions = (parsed && Array.isArray(parsed.mentions)) ? parsed.mentions : [];
    for (const raw of mentions) {
      const norm = normalizeMention(raw, ctext, base, ids);
      if (norm) all.push(norm);
    }
  }

  return { mentions: dedupe(all), chunks: chunks.length, dropped, errors };
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
