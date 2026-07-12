# Card-generation prompt (Phase 4)

A fixed prompt that turns one concept into one schema-valid dictionary card. Use it with any
capable model (or in a batch script). The output is **always** validated by
`scripts/validate-cards.mjs` before commit, and every generated card gets a **mandatory human
review** of its formulas and references — the model is a drafting aid, not the source of truth.

The correctness bar lives in the prompt itself: references required, no fabrication,
omit-if-unsure. Keep those rules intact when adapting it.

Fill the four `{…}` slots before sending:

- `{concept name}` — the concept to write up.
- `{kind}` — one of the 10 kinds in `data/taxonomy.json`.
- `{domain ids}` — one or more domain ids from `data/taxonomy.json` (e.g. `["linear-algebra"]`).
- `{kind template}` — paste the matching `data/templates/{kind}.json`.

---

```
You are writing one entry for a mathematics reference. Produce a SINGLE JSON object for the
concept below, matching the given template for its kind. Output ONLY the JSON — no prose,
no markdown fences.

CONCEPT: {concept name}
KIND: {kind}            # one of: measure, concept, object, theorem, formula, inequality,
                        #         transform, method, function, distribution
DOMAIN: {domain ids}    # from the taxonomy, e.g. ["linear-algebra"]
TEMPLATE: {paste data/templates/{kind}.json}

Rules:
- Ground everything in established, textbook-level mathematics. Do NOT invent definitions,
  identities, inequalities, numbers, or references. If you are not confident a fact is
  standard and correct, omit it rather than guess.
- references: include 1–3 REAL, authoritative sources (standard textbooks, canonical papers,
  or well-known references like Wikipedia / DLMF / nLab). Never fabricate a title or URL; if
  unsure of a URL, give the title only.
- formula_latex: valid LaTeX (renders in MathJax / TeX). Also give formula_plaintext. Use
  standard notation and symbols for the field.
- short_description: one precise sentence (≤ ~30 words) — what it is and why it matters.
- aliases: common alternative names and notations only.
- prerequisites / related: names of directly prerequisite / closely related concepts (they
  will be resolved to ids in review — names are fine here).
- Fill the kind-specific fields from the template; leave any field you can't fill confidently
  as an empty string / empty array rather than inventing content.
- id: a lowercase, hyphen/underscore slug of the canonical name.

Return the JSON object only.
```

---

After generation, run the authoring loop in the project README (§ *Authoring workflow*):
human-review → cross-link (`scripts/suggest-relations.mjs`) → validate
(`scripts/validate-cards.mjs`) → re-embed (`scripts/build-embeddings.mjs`) → add to
`data/cards/manifest.json` and commit.
