// Small DOM and string helpers shared across the app. No dependencies.

/** Escape a string for safe insertion as HTML text/attribute content. */
export function escapeHTML(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** querySelector shortcut. */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** querySelectorAll -> Array shortcut. */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Create an element from a tag, props, and children.
 * props.class -> className, props.html -> innerHTML, on* -> event listeners,
 * data-* and aria-* and plain attributes are set with setAttribute.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props || {})) {
    if (val == null || val === false) continue;
    if (key === "class") node.className = val;
    else if (key === "html") node.innerHTML = val;
    else if (key === "text") node.textContent = val;
    else if (key.startsWith("on") && typeof val === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (key === "dataset") {
      Object.assign(node.dataset, val);
    } else {
      node.setAttribute(key, val);
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
}

/** A small rounded chip element (for aliases, family tags, etc.). */
export function chip(label, opts = {}) {
  const props = { class: "chip" + (opts.variant ? " chip-" + opts.variant : "") };
  if (opts.title) props.title = opts.title;
  if (opts.href) {
    return el("a", { ...props, href: opts.href }, [label]);
  }
  return el("span", props, [label]);
}

/** Debounce a function by `wait` ms. */
export function debounce(fn, wait = 180) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * Normalize a query/term: lowercase, NFKD, strip diacritics + punctuation,
 * collapse whitespace. Used everywhere search compares text.
 */
export function normalize(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenize normalized text into words. */
export function tokens(text) {
  const n = normalize(text);
  return n ? n.split(" ") : [];
}

/** Clamp a number to [lo, hi]. */
export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
