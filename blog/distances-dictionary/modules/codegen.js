// Safe, template-based code generation. All code comes from audited strings in
// data/code_templates.json (never from the AI). The panel offers a language
// toggle and a copy button.

import { el, escapeHTML } from "./util.js";

const TARGET_LABELS = { numpy: "NumPy", pytorch: "PyTorch", jax: "JAX", scipy: "SciPy", pot: "POT" };

/** Join a template (array of lines or a string) into code text. */
function templateCode(value) {
  if (Array.isArray(value)) return value.join("\n");
  return String(value || "");
}

/**
 * Build the code-generation panel for a measure.
 * @returns {HTMLElement}
 */
export function renderCodePanel(db, measure) {
  const tpl = db.codeTemplates[measure.id] || {};
  const targets = (measure.code_templates || []).filter((t) => tpl[t]);

  const panel = el("section", { class: "codegen", "aria-label": "Code generator" });
  panel.appendChild(el("h2", {}, ["Code"]));

  if (targets.length === 0) {
    panel.appendChild(el("p", { class: "muted" }, [
      "No audited code template for this measure yet — it is often intractable in closed form. " +
      "See the formula and implementation notes above; libraries such as POT, geomstats or SciPy may help.",
    ]));
    appendNotes(panel, db, measure, tpl);
    return panel;
  }

  const tabs = el("div", { class: "code-tabs", role: "tablist" });
  const codeBlock = el("pre", { class: "code-block" });
  const codeEl = el("code", {});
  codeBlock.appendChild(codeEl);

  const setTarget = (target, btn) => {
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    codeEl.textContent = templateCode(tpl[target]);
  };

  targets.forEach((target, i) => {
    const btn = el("button", {
      type: "button",
      role: "tab",
      class: "code-tab",
      "aria-selected": i === 0 ? "true" : "false",
    }, [TARGET_LABELS[target] || target]);
    btn.addEventListener("click", () => setTarget(target, btn));
    tabs.appendChild(btn);
  });

  const copyBtn = el("button", { type: "button", class: "copy-btn" }, ["Copy"]);
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(codeEl.textContent);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1400);
    } catch (_) {
      copyBtn.textContent = "Copy failed";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1400);
    }
  });

  const bar = el("div", { class: "code-bar" }, [tabs, copyBtn]);
  panel.appendChild(bar);
  panel.appendChild(codeBlock);
  codeEl.textContent = templateCode(tpl[targets[0]]);

  appendNotes(panel, db, measure, tpl);
  return panel;
}

function appendNotes(panel, db, measure, tpl) {
  const notes = [];
  if (tpl.requires_spd) notes.push("Inputs must be symmetric positive-definite (SPD).");
  if (tpl.requires_probability) notes.push("Inputs are treated as probability vectors (normalized, clipped).");
  (tpl.notes || []).forEach((n) => notes.push(n));
  (measure.implementation_notes || []).forEach((n) => notes.push(n));
  if (notes.length) {
    panel.appendChild(el("p", { class: "code-notes-title" }, ["Implementation notes"]));
    const ul = el("ul", { class: "code-notes" });
    notes.forEach((n) => ul.appendChild(el("li", { html: escapeHTML(n) })));
    panel.appendChild(ul);
  }
}
