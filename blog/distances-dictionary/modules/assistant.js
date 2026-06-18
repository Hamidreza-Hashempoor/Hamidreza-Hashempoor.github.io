// Layer 1: a deterministic, rule-based assistant over the structured database.
// No model, no network — always available. Returns a structured answer that
// renderAnswer() turns into DOM with links to detail pages.

import { el, normalize, tokens } from "./util.js";
import { search } from "./search.js";

function has(q, ...words) {
  return words.some((w) => q.includes(w));
}

/**
 * Measures whose canonical name / alias (incl. the alias index, so short forms
 * like "kl", "js", "emd" count) appears in the query. A term matches only if all
 * of its tokens are present as whole tokens in the query, which avoids substring
 * false positives. Sorted by specificity (longer terms first).
 */
function findMentioned(db, query) {
  const qset = new Set(tokens(query));
  const byId = new Map(); // id -> best specificity score
  for (const [term, id] of db.aliasIndex) {
    const tts = term.split(" ").filter(Boolean);
    if (!tts.length) continue;
    if (tts.every((t) => qset.has(t))) {
      const score = tts.join("").length;
      if (!byId.has(id) || score > byId.get(id)) byId.set(id, score);
    }
  }
  return [...byId.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => db.byId.get(id))
    .filter(Boolean);
}

function pick(db, ids) {
  return ids.map((id) => db.byId.get(id)).filter(Boolean);
}

/**
 * Produce a grounded answer object:
 *   { title, lead, items: [{measure, reason}], links: [{label, href}], caveats: [] }
 */
export function answer(db, query) {
  const q = normalize(query);
  const mentioned = findMentioned(db, query);

  // 1) Alias / "also called".
  if (has(q, "also called", "another name", "other name", "alias", "aka", "what is") && mentioned.length) {
    const m = mentioned[0];
    return {
      title: `${m.canonical_name}`,
      lead: (m.aliases && m.aliases.length)
        ? `Also known as: ${m.aliases.join(", ")}.`
        : "No common aliases recorded.",
      items: [{ measure: m, reason: m.short_description }],
      links: [], caveats: [],
    };
  }

  // 2) SPD / covariance matrices.
  if (has(q, "spd", "covariance", "positive definite", "positive-definite", "psd", "covariances")) {
    return {
      title: "Distances for SPD / covariance matrices",
      lead: "For symmetric positive-definite matrices these respect the SPD geometry (Frobenius is a quick baseline):",
      items: [
        { measure: db.byId.get("affine_invariant_riemannian"), reason: "Congruence-invariant Riemannian metric — the geometric gold standard." },
        { measure: db.byId.get("bures_wasserstein"), reason: "Optimal-transport (W2-between-Gaussians) metric with a closed form." },
        { measure: db.byId.get("logdet_bregman"), reason: "Information-theoretic Bregman divergence (ITML metric learning)." },
        { measure: db.byId.get("frobenius"), reason: "Simple, fast baseline that ignores SPD curvature." },
      ].filter((x) => x.measure),
      links: [], caveats: ["Affine-invariant and Bures-Wasserstein are symmetric metrics; Log-Det is an asymmetric divergence."],
    };
  }

  // 3) bounded + symmetric (+ metric) over probability distributions.
  if (has(q, "bounded") && has(q, "symmetric")) {
    const wantMetric = has(q, "metric");
    return {
      title: wantMetric ? "Symmetric, bounded, metric distances on distributions" : "Symmetric & bounded divergences on distributions",
      lead: "These are symmetric and bounded; Total variation and Hellinger are true metrics, and the square root of Jensen-Shannon is a metric:",
      items: [
        { measure: db.byId.get("total_variation"), reason: "Symmetric, bounded in [0,1], and a metric." },
        { measure: db.byId.get("hellinger"), reason: "Symmetric, bounded in [0,1], and a metric." },
        { measure: db.byId.get("jensen_shannon"), reason: "Symmetric and bounded by log 2; its square root is a metric." },
      ].filter((x) => x.measure),
      links: [], caveats: ["Jeffreys divergence is symmetric but NOT bounded."],
    };
  }

  // 4) samples / empirical / two-sample.
  if (has(q, "samples", "empirical", "two sample", "two-sample", "from data")) {
    return {
      title: "Distances you can estimate from samples",
      lead: "These work directly from empirical samples (no densities required):",
      items: pick(db, ["wasserstein", "mmd", "kolmogorov_smirnov"]).map((m) => ({ measure: m, reason: m.short_description })),
      links: [], caveats: ["MMD needs a kernel; Kolmogorov-Smirnov is essentially one-dimensional."],
    };
  }

  // 5) differential privacy.
  if (has(q, "privacy", "differential privacy", "dp ")) {
    return {
      title: "Divergences for differential privacy",
      lead: "Renyi divergence underlies Renyi differential privacy accounting:",
      items: pick(db, ["renyi_divergence", "kullback_leibler"]).map((m) => ({ measure: m, reason: m.short_description })),
      links: [], caveats: [],
    };
  }

  // 6) goodness of fit / hypothesis testing.
  if (has(q, "goodness", "hypothesis", "two sample test", "goodness-of-fit")) {
    return {
      title: "Hypothesis testing & goodness-of-fit",
      lead: "Common choices for testing whether samples come from the same distribution:",
      items: pick(db, ["kolmogorov_smirnov", "pearson_chi2", "mmd", "chernoff"]).map((m) => ({ measure: m, reason: m.short_description })),
      links: [], caveats: [],
    };
  }

  // 7) MCMC diagnostics.
  if (has(q, "mcmc", "sampler", "stein", "convergence diagnostic")) {
    return {
      title: "MCMC / sampler diagnostics",
      lead: "Stein discrepancy needs only the score (no normalizing constant):",
      items: pick(db, ["stein_discrepancy", "total_variation", "mmd"]).map((m) => ({ measure: m, reason: m.short_description })),
      links: [], caveats: [],
    };
  }

  // 8) code request for a specific measure.
  if (has(q, "code", "numpy", "pytorch", "jax", "implement", "implementation") && mentioned.length) {
    const m = mentioned[0];
    const targets = m.code_templates || [];
    return {
      title: `Code for ${m.canonical_name}`,
      lead: targets.length
        ? `Audited ${targets.join(", ")} templates are on the measure page.`
        : "No audited template yet — this measure is often intractable in closed form; see its page for guidance.",
      items: [{ measure: m, reason: "Open the page and use the Code panel." }],
      links: [{ label: `Open ${m.canonical_name} → Code`, href: `#/measure/${m.id}` }],
      caveats: [],
    };
  }

  // 9) compare X and Y.
  if (has(q, "compare", "vs", "versus", "difference between") && mentioned.length >= 2) {
    const ids = mentioned.slice(0, 4).map((m) => m.id);
    return {
      title: "Side-by-side comparison",
      lead: `Comparing ${mentioned.slice(0, 4).map((m) => m.canonical_name).join(", ")}:`,
      items: mentioned.slice(0, 4).map((m) => ({ measure: m, reason: m.short_description })),
      links: [{ label: "Open comparison table", href: `#/compare?ids=${ids.join(",")}` }],
      caveats: [],
    };
  }

  // 10) property question about a specific mentioned measure.
  if (mentioned.length && has(q, "is ", "bounded", "symmetric", "metric")) {
    const m = mentioned[0];
    const p = m.properties || {};
    const fmt = (k, label) => (k in p ? `${label}: ${p[k] ? "yes" : "no"}` : null);
    const facts = [fmt("symmetric", "symmetric"), fmt("bounded", "bounded"), fmt("metric", "metric"), fmt("nonnegative", "non-negative")].filter(Boolean);
    return {
      title: m.canonical_name,
      lead: facts.length ? facts.join(" · ") + (p.sqrt_metric ? " · square root is a metric" : "") : m.short_description,
      items: [{ measure: m, reason: m.short_description }],
      links: [], caveats: [],
    };
  }

  // Fallback: top lexical results.
  const { results } = search(db, query);
  const top = results.slice(0, 5).map((r) => r.measure);
  return {
    title: top.length ? "Closest matches" : "No direct match",
    lead: top.length ? "Here are the measures most relevant to your question:" : "Try naming a property (symmetric, bounded, metric), an object type (SPD matrix, probability vector, samples), or a measure name.",
    items: top.map((m) => ({ measure: m, reason: m.short_description })),
    links: [], caveats: [],
  };
}

/** Render a structured answer to DOM (links to detail pages). */
export function renderAnswer(db, ans) {
  const root = el("div", { class: "answer" });
  if (ans.title) root.appendChild(el("h3", { class: "answer-title" }, [ans.title]));
  if (ans.lead) root.appendChild(el("p", { class: "answer-lead" }, [ans.lead]));
  if (ans.items && ans.items.length) {
    const ul = el("ul", { class: "answer-list" });
    ans.items.forEach(({ measure, reason }) => {
      if (!measure) return;
      const li = el("li", {}, [
        el("a", { href: `#/measure/${measure.id}`, class: "answer-link" }, [measure.canonical_name]),
        reason ? document.createTextNode(" — " + reason) : null,
      ].filter(Boolean));
      ul.appendChild(li);
    });
    root.appendChild(ul);
  }
  if (ans.links && ans.links.length) {
    const linkRow = el("div", { class: "answer-links" }, ans.links.map((l) =>
      el("a", { href: l.href, class: "answer-cta" }, [l.label])
    ));
    root.appendChild(linkRow);
  }
  if (ans.caveats && ans.caveats.length) {
    const ul = el("ul", { class: "answer-caveats" });
    ans.caveats.forEach((c) => ul.appendChild(el("li", {}, [c])));
    root.appendChild(el("div", {}, [el("span", { class: "caveat-label" }, ["Caveats"]), ul]));
  }
  return root;
}
