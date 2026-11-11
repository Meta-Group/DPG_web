# DPG website

Website for [Decision Predicate Graph (DPG)](https://github.com/Meta-Group/DPG), published with GitHub Pages
at http://machinelearning.inginf.units.it/DPG_web/ (`meta-group.github.io/DPG_web/` redirects there).

| Path | What |
|---|---|
| `static/index.html`, `static/assets/` | Landing page: what DPG is, `pip install dpg`, quickstart, links to the [docs](https://dpg.readthedocs.io/), citation |
| `static/sandbox/` | Sandbox: an in-browser DPG notebook (below) |
| `static/sandbox/counterfactuals/` | Counterfactuals: DPG-CF counterfactual explanations in the browser (below) |
| `scripts/vendor_dpg_cf.py` | Refreshes the copy of DPG-CF that the Counterfactuals page runs |
| `static/dashboard/` | W&B run viewer frontend (below) |
| `app.py` | Flask server for the run viewer; also serves the landing page at `/` |
| `scripts/export_iris_dpg.py` | Rebuilds `static/assets/iris-dpg.json`, the landing page's interactive example graph (needs `pip install dpg`) |

`.github/workflows/pages.yml` publishes `static/` on every push to `main` that touches it
(Settings → Pages → Source: **GitHub Actions**). Pages hosts static files only, so the run viewer
at `/dashboard/` renders there but cannot load runs: it needs the `/api` routes of `app.py`, and W&B
does not accept browser requests from the Pages origin. Run `app.py` to use it.

To preview the site locally: `cd static && python3 -m http.server` (the Sandbox and Counterfactuals
pages need it: they fetch their Python files, which `file://` URLs block).

## Sandbox

`static/sandbox/` runs DPG in the browser with [Pyodide](https://pyodide.org) (Python 3.14 and
scikit-learn compiled to WebAssembly), so it works on GitHub Pages with no server.

| File | What |
|---|---|
| `quickstart_iris.ipynb` | The notebook shown on the page (a real `.ipynb`), following DPG's `examples/quickstart_iris.py`. Lines ending in `# @param {...}` become form fields, in the style of Google Colab. |
| `notebook.js` | Renders the cells (CodeMirror editors, Shift+Enter to run), the parameter form, CSV loading, rich outputs and `.ipynb` download. |
| `worker.js` | Python kernel: Pyodide in a module web worker. It installs the latest `dpg` from PyPI with micropip on start. |
| `dpg_sandbox.py` | Display helpers (`show_dataset`, `show_scores`, `show_graph`, `show_boundaries`). In the Sandbox they send JSON to the page; in Jupyter they fall back to IPython display, so a downloaded notebook runs there too. |

The first visit downloads about 40 MB (Pyodide, NumPy, pandas, SciPy, scikit-learn, matplotlib)
from the jsDelivr CDN, which the browser then caches. Loaded CSV files stay in the browser.
To upgrade Pyodide, change the version in the `import` at the top of `worker.js`.

## Counterfactuals

`static/sandbox/counterfactuals/` generates counterfactual explanations with DPG-CF, the method of
*Model-Centric Counterfactual Explanations via Decision Predicate Graphs*. DPG-CF reads per-class
feature intervals off the model's DPG, merges them with actionability rules (`free`,
`non_decreasing`, `non_increasing`, `no_change`) and searches inside them without touching the
training data. Like the Sandbox it runs on Pyodide, so it works on GitHub Pages.

The page has three steps: train a random forest on a preset (Diabetes, the paper's worked
example, or Iris) or on your CSV and see its DPG class intervals; pick a test instance, a target
class and the actionability rules; generate. The result shows which search stage found the base
counterfactual, the paper's metrics (validity, actionability, sparsity, MAD distance, diversity,
implausibility), the changes per feature, where each counterfactual lands relative to the class
intervals, a CSV download and the equivalent Python.

| File | What |
|---|---|
| `dpg_cf/` | DPG-CF itself, copied from [DPG_research](https://github.com/Meta-Group/DPG_research/tree/main/counterfactual) by `scripts/vendor_dpg_cf.py` (imports made package-relative; see `dpg_cf/SOURCE.md`). Don't edit it by hand. |
| `dpg_cf_app.py` | The page's Python API (`load_dataset`, `train`, `generate`): presets with the experiments' model settings and actionability rules, DPG constraint extraction, metrics. |
| `worker.js` | Pyodide worker: installs `dpg` from PyPI, copies `dpg_cf/` (listed in `dpg_cf/MANIFEST.json`), `dpg_cf_app.py` and the preset CSV into its filesystem, and serves the page's calls. |
| `cf.js`, `cf.css`, `index.html` | The page. It reuses the Sandbox's bar, form, table and tile styles. |
| `datasets/diabetes.csv` | Pima diabetes, as used in the experiments (rows with a zero in any feature are dropped on load). |

Defaults follow the paper's experiments (`methods.dpg` in DPG-CF's `configs/config.yaml`; per-dataset
model settings and rules from `configs/<dataset>/config.yaml`; 80/20 split with `random_state=42`).
One option is the page's own: *Close open-ended DPG intervals with the observed feature range*
(on by default) fills a missing DPG bound, such as the lower bound in `Glucose <= 159`, with the
training minimum or maximum. Without it the diverse-candidate stage can push such a feature far
outside any realistic value (Glucose = -536 in one test). Switch it off for the paper's strictly
data-free setting.

To update DPG-CF: `.venv/bin/python scripts/vendor_dpg_cf.py ../DPG_research/counterfactual`.
`dpg_cf_app.py` also runs under plain CPython (with `dpg` installed), which is the quickest way
to test a change before trying it in the browser:

```bash
cd static/sandbox/counterfactuals
../../../.venv/bin/python -c "import json, dpg_cf_app as a; a.load_dataset('{\"preset\": \"diabetes\"}'); \
  a.train('{}'); print(json.loads(a.generate('{\"index\": 1, \"target\": 0}'))['metrics'])"
```

## W&B run viewer

A small Flask app that loads a single W&B run by id and shows everything about it.
DPG graphs are rebuilt from their `dpg_structure` JSON artifacts as interactive
Cytoscape graphs instead of being shown as the logged PNGs.

- **Overview**: state, project, group, job type, user, host, timings, commit, tags, and all summary scalars.
- **DPG graphs**: one tab per variant (BASIC / GROUPED / GROUPED-SPLIT / ...).
  - Zoom and pan the graph.
  - Hover a node to trace every path through it; click it for in/out edges with weights.
  - The detail panel also shows community, class probabilities and node metrics.
  - Colour nodes by community or by any node metric (e.g. betweenness).
  - Search nodes, switch between LR and TB layout, export a PNG, or toggle the original image.
- **Metrics**: history charts (grouped by prefix, filterable) and system metrics.
- **Tables**: `wandb.Table`s, sortable and filterable.
- **Artifacts**: every logged artifact, with CSV/JSON/text previews and download links.
- **Config, environment, output.log**, and every run file.

### Run

```bash
cd DPG_web
/usr/bin/python3 -m venv .venv && .venv/bin/pip install flask requests waitress
.venv/bin/python app.py          # http://0.0.0.0:8050/dashboard/
```

Open the page, go to **Settings** and paste your API key (wandb.ai/authorize).
The key is stored in the browser's localStorage and sent with each request in
the `X-Wandb-Key` header. The server passes it on to W&B and never writes it anywhere.
Entity and project are optional: if you leave the project blank, the app searches every
project of the entity. The input also accepts `project/id`, `entity/project/id`
or a full wandb.ai run URL, and `/#run=<ref>` links load a run directly.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `DASHBOARD_HOST` / `DASHBOARD_PORT` | `0.0.0.0` / `8050` | bind address |
| `WANDB_BASE_URL` | `https://api.wandb.ai` | for self-hosted W&B |
| `DASHBOARD_WANDB_API_KEY` | unset | server-side fallback key. Anyone who can reach the port can then read your W&B data, so only set it on a trusted network. |

### Keep it running (systemd)

```ini
# /etc/systemd/system/wandb-dashboard.service
[Unit]
Description=W&B run dashboard (DPG)
After=network-online.target

[Service]
WorkingDirectory=/root/gitgud/temp/DPG/wandb_dashboard
ExecStart=/root/gitgud/temp/DPG/wandb_dashboard/.venv/bin/python app.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now wandb-dashboard
```

JS libraries (Cytoscape, dagre, cytoscape-dagre, Plotly basic) are vendored in
`static/dashboard/vendor/`, so the page needs no CDN.
