// Optional, lazy code verification with Pyodide (Python+NumPy in WASM).
// Used to sanity-check a *drafted/generated* entry: run its reference NumPy on
// its own worked example and check the value + a few declared properties.
// Audited dictionary code is pre-trusted and does not need this.
//
// Pyodide runs in a sandbox (no filesystem/network); it executes the user's own
// drafted code that they explicitly chose to verify.

const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";

let pyPromise = null;
async function getPyodide(onProgress = () => {}) {
  if (pyPromise) return pyPromise;
  pyPromise = (async () => {
    onProgress({ status: "Loading Python (Pyodide, ~10MB, first time only)…" });
    if (!window.loadPyodide) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = PYODIDE_BASE + "pyodide.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("Failed to load Pyodide from CDN."));
        document.head.appendChild(s);
      });
    }
    const py = await window.loadPyodide({ indexURL: PYODIDE_BASE });
    onProgress({ status: "Loading NumPy…" });
    await py.loadPackage("numpy");
    onProgress({ status: "ready" });
    return py;
  })();
  return pyPromise;
}

const HARNESS = `
import json, numpy as np
result = {"ok": False, "checks": []}
try:
    g = {}
    exec(USER_CODE, g)
    funcs = [v for k, v in g.items() if callable(v) and not k.startswith("__")]
    if not funcs:
        raise ValueError("No function defined in reference_impl.numpy")
    f = funcs[-1]
    inputs = json.loads(INPUTS_JSON)
    props = json.loads(PROPS_JSON)
    args = list(inputs.values()) if isinstance(inputs, dict) else list(inputs)
    val = float(f(*args))
    result["value"] = val
    checks = []
    checks.append({"name": "runs & returns a finite number", "pass": bool(np.isfinite(val))})
    if EXPECTED is not None:
        tol = max(1e-3, abs(EXPECTED) * 1e-2)
        checks.append({"name": "matches worked example",
                       "pass": bool(abs(val - EXPECTED) <= tol),
                       "detail": "got %.6g, expected %.6g" % (val, EXPECTED)})
    if props.get("non_negative"):
        checks.append({"name": "non-negative on example", "pass": bool(val >= -1e-9)})
    if props.get("symmetric") and len(args) >= 2:
        try:
            val2 = float(f(args[1], args[0], *args[2:]))
            checks.append({"name": "symmetric on example",
                           "pass": bool(abs(val - val2) <= max(1e-6, abs(val) * 1e-6))})
        except Exception as e:
            checks.append({"name": "symmetric on example", "pass": False, "detail": str(e)})
    result["checks"] = checks
    result["ok"] = bool(checks) and all(c["pass"] for c in checks)
except Exception as e:
    result["error"] = str(e)
json.dumps(result)
`;

/**
 * Verify a drafted entry's NumPy reference implementation.
 * @param {object} entry  schema entry with reference_impl.numpy + worked_example + properties
 * @returns {Promise<{ok:boolean, value?:number, checks?:Array, error?:string}>}
 */
export async function verifyDraft(entry, onProgress = () => {}) {
  const code = entry && entry.reference_impl && entry.reference_impl.numpy;
  if (!code) return { ok: false, error: "Draft has no reference_impl.numpy to run." };
  const we = entry.worked_example || {};
  const inputs = we.inputs || {};
  if (!inputs || (typeof inputs === "object" && Object.keys(inputs).length === 0)) {
    return { ok: false, error: "Draft has no worked_example.inputs to test against." };
  }
  let py;
  try {
    py = await getPyodide(onProgress);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  try {
    py.globals.set("USER_CODE", String(code));
    py.globals.set("INPUTS_JSON", JSON.stringify(inputs));
    py.globals.set("PROPS_JSON", JSON.stringify(entry.properties || {}));
    py.globals.set("EXPECTED", we.expected_value == null ? null : Number(we.expected_value));
    const out = await py.runPythonAsync(HARNESS);
    return JSON.parse(out);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
