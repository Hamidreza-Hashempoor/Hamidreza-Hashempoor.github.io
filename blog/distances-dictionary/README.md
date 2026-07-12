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
- **Detail pages** with MathJax formulas, properties, worked examples, parameters,
  **cross-linked identities & inequalities** (e.g. Pinsker, √JS is a metric,
  W₂(Gaussians)=Bures), related measures, and a relation graph.
- **Browse by object type** (`#/types`) — flash cards grouped by vector / matrix /
  SPD / distribution / point cloud / graph / …
- **Compare** 2–4 measures side by side.
- **Safe code generation** — audited NumPy / PyTorch / JAX templates only
  (never AI-generated code).
- **Optional AI layers**:
  1. *Rule-based assistant* — deterministic, no model, always on.
  2. *In-browser semantic search* — free MiniLM embeddings via Transformers.js
     (loaded on demand, no API key).
  3. *BYOK chat* — natural-language Q&A grounded in the local entries using **your
     own** AI provider (Anthropic / OpenRouter / Gemini / Hugging Face). The key
     stays in your browser (sessionStorage by default), billed to you — never the
     site owner's. See `modules/llm.js`.
- **PDF → Dictionary Linker** (`#/linker`) — upload a PDF (parsed client-side with
  pdf.js) or paste text. Detection is **hybrid**: a deterministic dictionary match
  links every measure named in the cards (by name, alias, or abbreviation) with
  **no API key at all**; adding your own BYOK LLM additionally detects measures that
  appear only as unnamed formulas or under names not yet in the dictionary, and
  drafts schema-valid entries for missing ones (download for review). Each linked
  measure carries audited code. Optional: Mathpix equation OCR (BYO key), Pyodide
  code verification, and an annotated-PDF export (pdf-lib). Deep links use the stable
  `#/m/:id` permalink. Unnamed-formula detection is the least reliable step —
  low-confidence and unmatched items are flagged, never silently trusted.
- **Contribute** (`#/contribute`) — an in-app page (also linked from the toolbar and
  home) with one-click "propose a new measure" / "edit on GitHub" actions, the entry
  schema, and how the data-driven, CI-gated PR flow keeps the flash cards current.

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
  "input_types": ["probability_vector"],        // object types; see KNOWN_OBJECT_TYPES in modules/data.js
  "symbols": ["\\mathrm{JS}(p,q)"],             // optional LaTeX symbol forms
  "formula_latex": "\\mathrm{JS}(p,q)=…",       // raw LaTeX (no surrounding $$)
  "formula_plaintext": "JS(p,q) = …",           // for code/AI context
  "properties": { "symmetric": true, "bounded": true, "metric": false },
  "identities":   [{ "latex": "…", "refs": ["kullback_leibler"], "note": "…" }],  // cross-linked
  "inequalities": [{ "latex": "…", "refs": ["total_variation"],  "note": "Pinsker" }],
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

## Authoring workflow (content waves)

Phases 5+ add cards in **waves** (one domain at a time) so correctness scales with the corpus.
Each wave is a mechanical, quality-checked loop. The authoring kit lives in `data/templates/`,
`prompts/`, and `scripts/` — all authoring-time (Node/offline); the deployed site never runs them.

1. **Pick the concept list** for the domain (the Phase-5+ specs provide these).
2. **Generate** each card with `prompts/generate-card.md` (paste the matching
   `data/templates/{kind}.json`) into the right `data/cards/{domain}.json`. The prompt enforces
   the correctness bar: references required, no fabrication, omit-if-unsure.
3. **Review — mandatory human step.** Verify every formula and reference by hand; fix anything
   the model omitted or guessed. The model drafts; a human is the source of truth.
4. **Cross-link.** Run `node scripts/suggest-relations.mjs` (after embeddings exist) and confirm
   `related` / `prerequisites`, resolving names to ids. `node scripts/relations-report.mjs`
   flags orphans, contradictory typed relations, and prerequisite cycles.
5. **Validate.** Run `node scripts/validate-cards.mjs` and fix until it passes. It mirrors the
   in-browser `validate()` and the CI checks and adds Phase-4 gates (kind-specific required
   fields, ≥1 titled reference, well-formed URLs, LaTeX sanity, alias collisions). `npm i katex`
   enables a stricter LaTeX parse; otherwise a structural brace/`$` check runs (same as CI).
6. **Re-embed.** Run `node scripts/build-embeddings.mjs` so semantic search and the retrieval
   linker see the new cards; commit the regenerated `data/embeddings.json`.
7. **Register & commit.** Add any new file to `data/cards/manifest.json`, then open a PR — CI
   (`validate-measures.yml`) re-checks the data before merge.

New card kinds beyond `measure` (concept, object, theorem, formula, inequality, transform,
method, function, distribution) share the core schema plus kind-specific fields; the shape for
each is `data/templates/{kind}.json`.

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
  assistant.js          Layer 1 rule-based assistant + converse()
  embeddings.js         Layer 2 Transformers.js semantic search (lazy)
  chat.js               grounded RAG chat (uses llm.js)
  llm.js                multi-provider BYOK client + key store + settings UI
  config.js             repo config + GitHub edit/issue link helpers
  util.js               DOM/string helpers
  # PDF → Dictionary Linker
  pdf.js                pdf.js text extraction (lazy CDN) + page geometry
  linker.js             catalog + chunk + detect/link (grounded) + draft entry
  linkerView.js         the #/linker page (input, results, draft, exports)
  verify.js             optional Pyodide check of a drafted reference impl (lazy)
  mathpix.js            optional BYO equation OCR (experimental, lazy)
  annotate.js           optional annotated-PDF export via pdf-lib (experimental, lazy)
data/                   measures.json, aliases.json, families.json, code_templates.json
  taxonomy.json         card classification: kinds + domains (Phase 1)
  cards/manifest.json   list of card files the app loads (multi-file support)
  templates/            one JSON field template per kind (authoring, Phase 4)
prompts/                generate-card.md — the card-generation prompt (Phase 4)
scripts/                Node authoring tools (offline; NOT part of the deployed site)
  validate-cards.mjs    schema + taxonomy + graph + Phase-4 quality gate
  suggest-relations.mjs candidate related-link suggester (uses embeddings)
  relations-report.mjs  orphan / prerequisite-cycle / contradiction report
  build-embeddings.mjs  precompute data/embeddings.json for semantic search
```

Permalinks: every measure is reachable at `#/m/:id` (used by the linker);
`#/measure/:id` still works. CI: `.github/workflows/validate-measures.yml`
validates the data on PRs that touch `data/`.

## Contributing (dynamic flash cards)

The cards are **data-driven**, so collaborators keep them current without touching
code — and because links (in the app and in annotated PDFs) point to the stable
`#/m/:id` permalink, a merged change shows through everywhere automatically.

- **Edit an existing card:** open a measure → *Contribute* → **Edit data on GitHub**
  (edits `data/measures.json` and opens a PR) or **Suggest an edit** (prefilled issue).
- **Add a missing measure:** in the PDF Linker, an unmatched measure can be
  **drafted** by the AI → **Download JSON** or **Propose via GitHub issue**.
- Add the entry to `data/measures.json` (schema above); reference other measures by
  `id` in `related`, `identities[].refs`, `inequalities[].refs`.
- Open a PR. **CI** (`validate-measures.yml`) checks ids/aliases/types/property keys
  and that every `refs` resolves. Merge → GitHub Pages rebuilds → the card is live.

No unreviewed math reaches the site: human review + CI gate every contribution.
