// Serialized MathJax re-typesetting for dynamically inserted LaTeX.
//
// MathJax 3 only typesets once on load; content we inject at runtime must be
// typeset manually. Concurrent typeset calls can corrupt MathJax state, so we
// chain every request through a single promise. The CDN script is loaded with
// `defer`, so we also wait for MathJax.startup.promise before the first call.

let chain = Promise.resolve();

/**
 * Re-typeset a DOM subtree (default: whole document body).
 * Safe to call repeatedly; calls are serialized and never reject.
 * @param {Element|Element[]} root
 * @returns {Promise<void>}
 */
export function typeset(root = document.body) {
  const roots = Array.isArray(root) ? root : [root];
  chain = chain
    .then(() => (window.MathJax && window.MathJax.startup ? window.MathJax.startup.promise : null))
    .then(() => {
      if (!window.MathJax || !window.MathJax.typesetPromise) return null;
      // Drop any stale typeset state for these roots, then re-render.
      if (window.MathJax.typesetClear) {
        try { window.MathJax.typesetClear(roots); } catch (_) { /* ignore */ }
      }
      return window.MathJax.typesetPromise(roots);
    })
    .catch((err) => {
      console.warn("[distances-dictionary] MathJax typeset failed:", err);
    });
  return chain;
}
