// Python kernel for the Sandbox: Pyodide in a (module) web worker, so long runs don't freeze the page.
// Pyodide 314+ only supports module workers, hence `new Worker(..., {type: "module"})` in notebook.js.
// Messages in:  {type: "run", id, code, count} | {type: "file", name, bytes}
// Messages out: {type: "status", state, text} | {type: "output", id, out} | {type: "done", id, ok}
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

let currentId = null, runCell = null;
const status = (state, text) => postMessage({ type: "status", state, text });

const ready = (async () => {
  status("loading", "Loading Python…");
  const py = await loadPyodide();
  py.registerJsModule("sandbox_bridge", { emit: (json) => postMessage({ type: "output", id: currentId, out: JSON.parse(json) }) });
  status("loading", "Installing dpg and scikit-learn…");
  await py.loadPackage("micropip");
  await py.pyimport("micropip").install("dpg");
  const helpers = await fetch("dpg_sandbox.py");
  if (!helpers.ok) throw new Error(`dpg_sandbox.py: HTTP ${helpers.status}`);
  py.FS.writeFile("/home/pyodide/dpg_sandbox.py", await helpers.text());
  status("loading", "Importing libraries…");
  await py.runPythonAsync("import dpg_sandbox; dpg_sandbox._setup(); import dpg, sklearn");
  runCell = py.pyimport("dpg_sandbox").run_cell;
  const versions = py.runPython(
    "import sys, sklearn; from importlib.metadata import version; " +
    "f'Python {sys.version.split()[0]} · dpg {version(\"dpg\")} · scikit-learn {sklearn.__version__}'");
  status("ready", versions);
  return py;
})();
ready.catch((err) => status("error", `Python failed to start: ${err.message || err}`));

// Run messages one at a time, in order.
let queue = Promise.resolve();
self.onmessage = (event) => {
  const msg = event.data;
  queue = queue.then(() => handle(msg)).catch(() => {});
};

async function handle(msg) {
  const py = await ready;
  if (msg.type === "file") {
    py.FS.writeFile(`/home/pyodide/${msg.name}`, new Uint8Array(msg.bytes));
    postMessage({ type: "file-saved", name: msg.name });
    return;
  }
  if (msg.type === "run") {
    currentId = msg.id;
    status("busy", "Running…");
    let ok = false;
    try {
      ok = await runCell(msg.code, msg.count);
    } catch (err) {
      postMessage({ type: "output", id: msg.id, out: { kind: "error", ename: "SandboxError", evalue: String(err.message || err), traceback: "" } });
    }
    postMessage({ type: "done", id: msg.id, ok });
    status("ready");
    currentId = null;
  }
}
