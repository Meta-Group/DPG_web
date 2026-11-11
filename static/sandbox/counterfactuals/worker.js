// Python for the Counterfactuals page: Pyodide in a module web worker, so DPG-CF runs
// without freezing the page. Same Pyodide release as the notebook (../worker.js).
// Messages in:  {type: "file", name, bytes} | {type: "call", id, fn, args}
// Messages out: {type: "status", state, text} | {type: "result", id, ok, value | error}
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

const HOME = "/home/pyodide";
const API = new Set(["presets", "load_dataset", "train", "generate"]);
const status = (state, text) => postMessage({ type: "status", state, text });

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

// Copy dpg_cf/ (listed in its MANIFEST.json), dpg_cf_app.py and the preset CSVs into the worker FS.
async function writeSources(py) {
  const manifest = JSON.parse(await fetchText("dpg_cf/MANIFEST.json"));
  const paths = [...manifest.map((p) => `dpg_cf/${p}`), "dpg_cf_app.py", "datasets/diabetes.csv"];
  const texts = await Promise.all(paths.map(fetchText));
  paths.forEach((path, i) => {
    const full = `${HOME}/${path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    py.FS.writeFile(full, texts[i]);
  });
}

let app = null;
const ready = (async () => {
  status("loading", "Loading Python…");
  const py = await loadPyodide();
  status("loading", "Installing dpg and scikit-learn…");
  await py.loadPackage("micropip");
  await Promise.all([py.pyimport("micropip").install("dpg"), writeSources(py)]);
  status("loading", "Importing DPG-CF…");
  await py.runPythonAsync(`import sys, os; os.chdir("${HOME}"); sys.path.insert(0, "${HOME}")\nimport dpg_cf_app`);
  app = py.pyimport("dpg_cf_app");
  const versions = py.runPython(
    "import sys, sklearn; from importlib.metadata import version; " +
    "f'Python {sys.version.split()[0]} · dpg {version(\"dpg\")} · scikit-learn {sklearn.__version__}'");
  status("ready", versions);
  return py;
})();
ready.catch((err) => status("error", `Python failed to start: ${err.message || err}`));

// One call at a time, in order.
let queue = Promise.resolve();
self.onmessage = (event) => {
  const msg = event.data;
  queue = queue.then(() => handle(msg)).catch(() => {});
};

async function handle(msg) {
  let py;
  try {
    py = await ready;
  } catch (err) {
    if (msg.type === "call") postMessage({ type: "result", id: msg.id, ok: false, error: "Python is not available." });
    return;
  }
  if (msg.type === "file") {
    py.FS.writeFile(`${HOME}/${msg.name}`, new Uint8Array(msg.bytes));
    return;
  }
  if (msg.type !== "call") return;
  if (!API.has(msg.fn)) {
    postMessage({ type: "result", id: msg.id, ok: false, error: `Unknown function ${msg.fn}` });
    return;
  }
  status("busy", msg.label || "Running…");
  try {
    const out = msg.args === undefined ? app[msg.fn]() : app[msg.fn](JSON.stringify(msg.args));
    postMessage({ type: "result", id: msg.id, ok: true, value: JSON.parse(out) });
  } catch (err) {
    // PythonError messages end with the exception line; keep that for the page
    const text = String(err.message || err).trim();
    const last = text.split("\n").filter(Boolean).pop() || text;
    postMessage({ type: "result", id: msg.id, ok: false, error: last, detail: text });
  }
  status("ready");
}
