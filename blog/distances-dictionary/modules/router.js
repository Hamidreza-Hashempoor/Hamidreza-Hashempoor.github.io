// Minimal hash router. Routes:
//   #/                       home (search + filters)
//   #/?families=...&...      home with filter state in query
//   #/measure/:id            measure detail
//   #/compare?ids=a,b,c      comparison
//   #/ask                    AI assistant page

/** Parse the current location hash into { parts, params }. */
export function parseHash() {
  let raw = location.hash.replace(/^#/, "");
  if (!raw.startsWith("/")) raw = "/" + raw;
  const qIndex = raw.indexOf("?");
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const query = qIndex >= 0 ? raw.slice(qIndex + 1) : "";
  const parts = path.split("/").filter(Boolean);
  return { parts, params: new URLSearchParams(query) };
}

/** Subscribe to route changes; calls handler immediately and on hashchange. */
export function onRoute(handler) {
  window.addEventListener("hashchange", handler);
  window.addEventListener("DOMContentLoaded", handler);
  return handler;
}

/** Build a hash href from parts + params object. */
export function buildHash(parts, params) {
  const path = "/" + parts.filter(Boolean).join("/");
  const sp = new URLSearchParams(params || {});
  const qs = sp.toString();
  return "#" + path + (qs ? "?" + qs : "");
}
