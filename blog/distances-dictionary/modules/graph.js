// A small dependency-free SVG "related measures" graph: the current measure in
// the centre, related measures around it, each a hash link to its detail page.

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function truncate(s, n = 20) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Render the related-measure graph for a measure.
 * @returns {SVGElement|null}
 */
export function renderGraph(db, measure) {
  const related = (measure.related || []).map((id) => db.byId.get(id)).filter(Boolean).slice(0, 7);
  if (related.length === 0) return null;

  const W = 640, H = 320, cx = W / 2, cy = H / 2, R = Math.min(120, 70 + related.length * 6);
  const root = svg("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "rel-graph",
    role: "img",
    "aria-label": `Measures related to ${measure.canonical_name}`,
  });

  const positions = related.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / related.length;
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });

  // Edges first (under the nodes).
  positions.forEach((p) => {
    root.appendChild(svg("line", { x1: cx, y1: cy, x2: p.x, y2: p.y, class: "rel-edge" }));
  });

  // Outer (related) nodes.
  related.forEach((m, i) => {
    const p = positions[i];
    const label = truncate(m.canonical_name, 18);
    const w = Math.max(70, label.length * 7 + 16);
    const a = svg("a", { href: `#/measure/${m.id}`, class: "rel-node" });
    a.appendChild(svg("rect", { x: p.x - w / 2, y: p.y - 14, width: w, height: 28, rx: 9, class: "rel-rect" }));
    a.appendChild(svg("text", { x: p.x, y: p.y + 5, "text-anchor": "middle", class: "rel-text" }, [label]));
    const title = svg("title", {}, [m.canonical_name]);
    a.appendChild(title);
    root.appendChild(a);
  });

  // Centre node.
  const center = truncate(measure.canonical_name, 20);
  const cw = Math.max(90, center.length * 8 + 18);
  const g = svg("g", { class: "rel-node rel-center" });
  g.appendChild(svg("rect", { x: cx - cw / 2, y: cy - 16, width: cw, height: 32, rx: 10, class: "rel-rect-center" }));
  g.appendChild(svg("text", { x: cx, y: cy + 5, "text-anchor": "middle", class: "rel-text-center" }, [center]));
  root.appendChild(g);

  return root;
}
