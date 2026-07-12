// Faceted filtering. Within a facet the semantics are OR; across facets, AND.
// Properties are AND (e.g. "symmetric AND bounded AND metric").

/** Empty filter state. */
export function emptyFilterState() {
  return {
    domains: new Set(),
    kinds: new Set(),
    inputTypes: new Set(),
    families: new Set(),
    applications: new Set(),
    properties: new Set(),
  };
}

export function isFilterActive(state) {
  return (
    state.domains.size +
    state.kinds.size +
    state.inputTypes.size +
    state.families.size +
    state.applications.size +
    state.properties.size
  ) > 0;
}

export function filterCount(state) {
  return state.domains.size + state.kinds.size + state.inputTypes.size + state.families.size + state.applications.size + state.properties.size;
}

function anyOf(values, selected) {
  if (selected.size === 0) return true;
  for (const v of values || []) if (selected.has(v)) return true;
  return false;
}

/** Apply the filter state to a list of measures. */
export function applyFilters(measures, state) {
  return measures.filter((m) => {
    // domain: OR-within (a card may sit in several domains); kind: scalar match.
    if (!anyOf(m.domain, state.domains)) return false;
    if (state.kinds.size && !state.kinds.has(m.kind)) return false;
    if (!anyOf(m.input_types, state.inputTypes)) return false;
    if (!anyOf(m.family, state.families)) return false;
    if (!anyOf(m.applications, state.applications)) return false;
    // properties: AND
    for (const key of state.properties) {
      if (!(m.properties && m.properties[key] === true)) return false;
    }
    return true;
  });
}

/** Serialize filter state to URL query params. */
export function filterToParams(state) {
  const p = new URLSearchParams();
  if (state.domains.size) p.set("domains", [...state.domains].join(","));
  if (state.kinds.size) p.set("kinds", [...state.kinds].join(","));
  if (state.inputTypes.size) p.set("types", [...state.inputTypes].join(","));
  if (state.families.size) p.set("families", [...state.families].join(","));
  if (state.applications.size) p.set("apps", [...state.applications].join(","));
  if (state.properties.size) p.set("props", [...state.properties].join(","));
  return p;
}

/** Parse filter state from URL query params. */
export function filterFromParams(params) {
  const state = emptyFilterState();
  const load = (key, set) => {
    const raw = params.get(key);
    if (raw) raw.split(",").filter(Boolean).forEach((v) => set.add(v));
  };
  load("domains", state.domains);
  load("kinds", state.kinds);
  load("types", state.inputTypes);
  load("families", state.families);
  load("apps", state.applications);
  load("props", state.properties);
  return state;
}
