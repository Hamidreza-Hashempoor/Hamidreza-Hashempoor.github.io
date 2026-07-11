#!/usr/bin/env python3
"""Phase 1 one-shot migration: add kind/domain/subtopics/prerequisites/tags to every
card in data/measures.json.

Python (not the Node script from the spec) because Node isn't available in the authoring
environment; semantics are identical. Run once from blog/distances-dictionary/, commit
the result. The new fields are inserted TEXTUALLY after each card's single-line
"family" entry so the hand-authored formatting of every existing line is preserved
byte-for-byte (the diff is pure additions).

Domain rule (spec heuristic, corrected after computing it on all 61 cards):
  probability-like inputs (probability_*, histogram, distribution) OR an
  information-theory-ish family (diverg|entropy|informat|bregman|mutual|f-diverg)
  -> information-theory; else -> metric-geometry.
  Override: frobenius, spectral_norm -> metric-geometry (plain matrix-norm distances;
  only their "matrix-bregman" family LABEL matches the regex, the measures aren't
  Bregman divergences).
"""
import json
import re
import sys
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / "data" / "measures.json"

INFO_RE = re.compile(r"diverg|entropy|informat|bregman|mutual|f-diverg", re.I)
METRIC_OVERRIDES = {"frobenius", "spectral_norm"}


def domain_for(card):
    if card["id"] in METRIC_OVERRIDES:
        return ["metric-geometry"]
    it = " ".join(card.get("input_types") or []).lower()
    fam = " ".join(card.get("family") or []).lower()
    if ("probability" in it or "distribution" in it or "histogram" in it
            or INFO_RE.search(fam)):
        return ["information-theory"]
    return ["metric-geometry"]


def new_fields(card):
    tags = list(dict.fromkeys((card.get("tags") or []) + ["distances-divergences"]))
    return {
        "kind": "measure",
        "domain": domain_for(card),
        "subtopics": list(card.get("family") or []),
        "prerequisites": card.get("prerequisites") or [],
        "tags": tags,
    }


def main():
    original_text = PATH.read_text(encoding="utf-8")
    cards = json.loads(original_text)

    already = [c["id"] for c in cards if "kind" in c]
    if already:
        sys.exit(f"refusing to run: {len(already)} card(s) already migrated (e.g. {already[0]})")

    # File order == array order, so the Nth "family" line belongs to cards[N].
    family_line = re.compile(r'^(\s*)"family": \[.*\],$')
    out_lines = []
    idx = 0
    for line in original_text.splitlines(keepends=True):
        out_lines.append(line)
        m = family_line.match(line.rstrip("\n"))
        if m:
            if idx >= len(cards):
                sys.exit("more family lines than cards — aborting, file untouched")
            indent = m.group(1)
            fields = new_fields(cards[idx])
            for key in ("kind", "domain", "subtopics", "prerequisites", "tags"):
                out_lines.append(f'{indent}"{key}": {json.dumps(fields[key])},\n')
            idx += 1
    if idx != len(cards):
        sys.exit(f"anchored {idx} of {len(cards)} cards — aborting, file untouched")

    migrated_text = "".join(out_lines)

    # Self-check before writing: parses, and equals the original plus EXACTLY the 5 new keys.
    migrated = json.loads(migrated_text)
    assert len(migrated) == len(cards)
    for old, new in zip(cards, migrated):
        expect = dict(old)
        expect.update(new_fields(old))
        if new != expect:
            sys.exit(f"self-check failed on {old['id']} — aborting, file untouched")

    PATH.write_text(migrated_text, encoding="utf-8")
    split = {}
    for c in migrated:
        for d in c["domain"]:
            split[d] = split.get(d, 0) + 1
    print(f"migrated {len(migrated)} cards; domain split: {split}")


if __name__ == "__main__":
    main()
