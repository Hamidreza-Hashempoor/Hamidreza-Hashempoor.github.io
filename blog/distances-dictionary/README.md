# Distances & Divergences Dictionary

An interactive, searchable dictionary of distances, divergences and probability
metrics — the interactive companion to the
[Taxonomy of Principal Distances & Divergences](../distances/distances.html) post.

It is a **self-contained static site**: plain HTML + ES-module JavaScript + JSON
data, using CDN libraries only. There is **no build step** — commit the files and
GitHub Pages serves them. Live at:

```
https://hamidreza-hashempoor.github.io/blog/distances-dictionary/
```

## Features

- **Search** by name, alias, formula idea, object type, property, or use case
  (lexical cascade: exact alias → fuzzy → field-weighted token match).
- **Filter** by object type, mathematical property, family, and application.
- **Detail pages** with KaTeX-style MathJax formulas, properties, worked
  examples, parameters, related measures, and a relation graph.
- **Compare** 2–4 measures side by side.
- **Safe code generation** — audited NumPy / PyTorch / JAX templates only
  (never AI-generated code).
- **Three optional AI layers**:
  1. *Rule-based assistant* — deterministic, no model, always on.
  2. *In-browser semantic search* — free MiniLM embeddings via Transformers.js
     (loaded on demand, no API key).
  3. *BYO-token chat* — natural-language Q&A grounded in the local entries using
     your own HuggingFace Inference token (kept only in your browser).

## Local development

`fetch()` of the JSON data is blocked under `file://`, so run a tiny static
server from the repository root (this is a dev convenience, **not** a build):

```bash
python3 -m http.server 8000
# then open:
# http://localhost:8000/blog/distances-dictionary/
```

On GitHub Pages the data loads normally (same-origin fetch over https).

## Adding or editing a measure

All content lives in `data/`:

- `data/measures.json` — one object per measure (see the schema below).
- `data/aliases.json` — extra colloquial aliases (`"emd": "wasserstein"`).
  Canonical aliases are auto-derived from each measure, so you only add forms
  not already listed.
- `data/families.json` — family slug → `{ label, blurb }`.
- `data/code_templates.json` — measure id → `{ numpy, pytorch, jax, notes,
  requires_spd, requires_probability }`. Each language is an **array of lines**
  joined with newlines.

### `measures.json` entry schema

```jsonc
{
  "id": "jensen_shannon",                 // unique slug
  "canonical_name": "Jensen-Shannon divergence",
  "aliases": ["JS divergence", "JSD"],
  "short_description": "…",
  "family": ["symmetrized", "f-divergence"],   // family slugs (see families.json)
  "input_types": ["probability_vector"],        // see KNOWN_OBJECT_TYPES in modules/data.js
  "formula_latex": "\\mathrm{JS}(p,q)=…",       // raw LaTeX (no surrounding $$)
  "formula_plaintext": "JS(p,q) = …",           // for code/AI context
  "properties": { "symmetric": true, "bounded": true, "metric": false },
  "range": "[0, log 2]",
  "parameters": [{ "name": "alpha", "description": "…", "default": "0" }],
  "assumptions": ["…"],
  "practical_use_cases": ["…"],
  "when_to_use": "…",
  "when_not_to_use": "…",
  "related": ["kullback_leibler"],              // ids only
  "special_cases": ["…"],
  "references": [{ "title": "…", "url": "…" }],
  "code_templates": ["numpy", "pytorch"],       // which targets exist in code_templates.json
  "implementation_notes": ["…"],
  "worked_example": "$\\mathrm{JS}\\approx 0.102$ …",  // may contain inline $…$
  "source_section": "../distances/distances.html#detailed"
}
```

The loader (`modules/data.js`) validates on startup and logs **non-fatal**
warnings to the browser console: duplicate ids, `related`/alias references to
unknown ids, unknown object-type/property keys, declared-but-missing code
templates, empty formulas. Open the console after editing to check the data.

> **Accuracy:** set `metric` / `symmetric` / `bounded` / SPD requirements from
> known mathematics, not guesses (e.g. only Total Variation among f-divergences
> is a metric; Jeffreys is symmetric but unbounded; Log-Det requires SPD inputs).

## Optional: offline PDF → entries pipeline

Not part of the deployed site. To bootstrap entries from a PDF table offline:

1. Extract text with PyMuPDF / pdfplumber.
2. Match candidate names against `data/aliases.json`.
3. Attach formulas from the curated database; flag uncertain matches for review.
4. Hand-review before adding to `measures.json`.

Math extracted from PDFs is noisy — never trust extracted formulas without
review.

## File map

```
index.html              app shell + themed post intro + MathJax config
app.js                  controller: data load, routing, compare, AI wiring
styles.css              theme (matches the blog palette)
modules/
  data.js               load + index + validate JSON
  router.js             hash routing
  search.js             lexical search cascade
  aliasResolver.js      exact/fuzzy alias lookup
  fuzzy.js              dependency-free fuzzy matcher
  filters.js            faceted filtering (URL-driven)
  render.js             home / detail / compare / cards / filter rail
  graph.js              related-measure SVG graph
  codegen.js            code panel from audited templates
  mathjax.js            serialized MathJax re-typeset
  assistant.js          Layer 1 rule-based assistant
  embeddings.js         Layer 2 Transformers.js semantic search (lazy)
  chat.js               Layer 3 BYO-token RAG chat
  util.js               DOM/string helpers
data/                   measures.json, aliases.json, families.json, code_templates.json
```
