// Counterfactuals page: a three-step UI over dpg_cf_app.py, which runs in a Pyodide web
// worker (worker.js). 1) train a forest and read its DPG class intervals, 2) pick a test
// instance, a target class and actionability rules, 3) run DPG-CF and show the result.
(() => {
  const PALETTE = ["--yellow", "--orange", "--olive", "--red", "--c5", "--c6", "--c7", "--c8"];
  const RULES = [
    ["free", "free"],
    ["non_decreasing", "↑ only increase"],
    ["non_increasing", "↓ only decrease"],
    ["no_change", "fixed"],
  ];
  const RULE_MARK = { non_decreasing: "↑", non_increasing: "↓", no_change: "fixed" };

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colour = (i) => css(PALETTE[i % PALETTE.length]);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmt = (v, digits = 4) => {
    if (v == null || Number.isNaN(v)) return "–";
    if (Number.isInteger(v)) return String(v);
    if (v !== 0 && Math.abs(v) < 1e-3) return v.toExponential(2);
    return String(+v.toFixed(Math.abs(v) >= 100 ? 1 : digits));
  };
  const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
  const swatch = (i) => `<span class="sw" style="background:${colour(i)}"></span>`;

  const kernelEl = $("#kernel"), trainBtn = $("#train"), genBtn = $("#generate");
  const datasetSel = $("#dataset"), csvInput = $("#csv-file"), targetSel = $("#target-col");
  const modelOut = $("#model-out"), resultOut = $("#result");

  let data = null;      // load_dataset() result
  let model = null;     // train() result
  let result = null;    // generate() result
  let presets = null;   // presets() result: notes per preset
  let defaults = null;  // presets()._cf_defaults
  let query = { index: null, target: null };
  let rules = {};
  let busy = false;

  // ---- worker ----------------------------------------------------------------
  const worker = new Worker("worker.js", { type: "module" });
  const pending = new Map();
  let nextId = 1, kernelInfo = "", readyResolve;
  const ready = new Promise((resolve) => (readyResolve = resolve));

  worker.onmessage = ({ data: msg }) => {
    if (msg.type === "status") {
      if (msg.state === "ready" && msg.text) { kernelInfo = msg.text; readyResolve(); }
      setKernel(msg.state, msg.text);
    } else if (msg.type === "result") {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p) msg.ok ? p.resolve(msg.value) : p.reject(Object.assign(new Error(msg.error), { detail: msg.detail }));
    }
  };
  worker.onerror = (e) => setKernel("error", `Python worker failed: ${e.message || "unknown error"}`);

  function call(fn, args, label) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: "call", id, fn, args, label });
    });
  }

  function setKernel(state, text) {
    kernelEl.dataset.state = state;
    $(".kernel-text", kernelEl).textContent = state === "ready" ? `Ready · ${kernelInfo}` : text || "Running…";
    if (state === "ready" || state === "error") $("#first-run").hidden = true;
    updateButtons();
  }

  function updateButtons() {
    const up = kernelEl.dataset.state === "ready" && !busy;
    trainBtn.disabled = !up || !data;
    genBtn.disabled = !up || !model || query.index == null || query.target == null;
  }

  async function run(fn, args, label) {
    busy = true;
    updateButtons();
    try {
      return await call(fn, args, label);
    } finally {
      busy = false;
      updateButtons();
    }
  }

  function errorBox(err, what) {
    const box = el("div", "out-error");
    box.innerHTML = `<strong>${esc(what)} failed</strong><div class="evalue">${esc(err.message || err)}</div>`;
    if (err.detail && err.detail !== err.message) {
      const d = el("details");
      d.innerHTML = `<summary>Traceback</summary><pre>${esc(err.detail)}</pre>`;
      box.appendChild(d);
    }
    return box;
  }

  // ---- step 1: data and model ---------------------------------------------------
  function datasetSpec() {
    if (datasetSel.value !== "csv") return { preset: datasetSel.value };
    return { csv: "upload.csv", target: targetSel.value };
  }

  async function loadDataset() {
    const isCsv = datasetSel.value === "csv";
    $("#csv-field").hidden = !isCsv;
    $("#target-field").hidden = !isCsv || !targetSel.options.length;
    data = null;
    invalidate("model");
    if (isCsv && !csvInput.files.length) {
      $("#dataset-note").textContent = "Choose a CSV file with a header row. Numeric columns become features.";
      updateButtons();
      return;
    }
    try {
      data = await run("load_dataset", datasetSpec(), "Loading data…");
    } catch (err) {
      $("#dataset-note").textContent = "";
      modelOut.replaceChildren(errorBox(err, "Loading the dataset"));
      return;
    }
    const m = data.model;
    $("#n_estimators").value = m.n_estimators;
    $("#max_depth").value = m.max_depth ?? 0;
    $("#max_features").value = m.max_features == null ? "" : String(m.max_features);
    $("#min_impurity_decrease").value = m.min_impurity_decrease;
    rules = { ...data.actionability };
    const classes = data.classes.map((c) => `${c.name} (${c.count})`).join(", ");
    const note = data.notes.length ? ` ${data.notes.join(" ")}` : "";
    const preset = datasetSel.value !== "csv" && presets ? presets[datasetSel.value] : null;
    $("#dataset-note").textContent =
      `${data.rows} rows, ${data.features.length} features, target “${data.target}”: ${classes}.${note}` +
      (preset ? ` ${preset.note}` : "");
    updateButtons();
  }

  function modelParams() {
    const mf = $("#max_features").value;
    return {
      n_estimators: +$("#n_estimators").value || 10,
      max_depth: +$("#max_depth").value || 0,
      max_features: mf === "" ? null : mf === "sqrt" ? "sqrt" : +mf,
      min_impurity_decrease: +$("#min_impurity_decrease").value || 0,
      random_state: +$("#random_state").value || 0,
      decimal_threshold: +$("#decimal_threshold").value,
    };
  }

  async function train() {
    invalidate("model");
    modelOut.replaceChildren(el("p", "cf-hint", "Training the forest and building its DPG…"));
    try {
      model = await run("train", modelParams(), "Training and extracting constraints…");
    } catch (err) {
      modelOut.replaceChildren(errorBox(err, "Training"));
      return;
    }
    renderModel();
    renderQuery();
  }

  function renderModel() {
    const tiles = el("div", "tiles");
    tiles.innerHTML = [
      ["Train accuracy", pct(model.train_accuracy), `${model.n_train} rows`],
      ["Test accuracy", pct(model.test_accuracy), `${model.n_test} rows`],
      ["Classes with constraints", `${Object.keys(model.constraints).length} / ${model.class_names.length}`, ""],
      ["DPG + constraints", `${fmt(model.dpg_time, 2)} s`, `forest: ${fmt(model.fit_time, 2)} s`],
    ].map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="sub">${s}</div></div>`).join("");

    const plot = el("div", "cf-plot");
    plot.innerHTML = `<h3>DPG class intervals</h3>
      <p class="cf-hint">For each class, the interval of each feature on the DPG paths that lead to that class.
      A dotted end means the DPG gives no bound on that side. These intervals are the only knowledge of the model
      that DPG-CF uses.</p>`;
    const legend = el("div", "cf-legend");
    legend.innerHTML = model.class_names.map((n, i) => `<span>${swatch(i)}${esc(n)}</span>`).join("");
    plot.appendChild(legend);
    const tracks = el("div");
    plot.appendChild(tracks);
    const draw = () => {
      const w = Math.max(200, tracks.clientWidth - (tracks.clientWidth > 560 ? 224 : 0));
      tracks.innerHTML = data.features.map((f) => {
        const classes = model.class_names.map((_, c) => ({ c, b: (model.constraints[c] || {})[f] }));
        const h = 10 + 9 * classes.length + 14;
        return `<div class="cf-track"><div class="name">${esc(f)}</div>${overviewSVG(w, h, f, classes)}</div>`;
      }).join("");
    };
    observe(tracks, draw);

    const table = el("details", "cf-code");
    const head = model.class_names.map((n) => `<th class="numc" colspan="2">${esc(n)}</th>`).join("");
    const sub = model.class_names.map(() => `<th class="numc">min</th><th class="numc">max</th>`).join("");
    const body = data.features.map((f) => `<tr><td>${esc(f)}</td>${model.class_names.map((_, c) => {
      const b = (model.constraints[c] || {})[f];
      return `<td class="numc">${b ? fmt(b.min) : ""}</td><td class="numc">${b ? fmt(b.max) : ""}</td>`;
    }).join("")}</tr>`).join("");
    table.innerHTML = `<summary>As a table</summary><div class="out-table cf-table" style="border:0;border-radius:0">
      <div class="tbl-scroll"><table><thead><tr><th>Feature</th>${head}</tr><tr><th></th>${sub}</tr></thead>
      <tbody>${body}</tbody></table></div></div>`;

    modelOut.replaceChildren(tiles, plot, table);
  }

  // ---- step 2: query -------------------------------------------------------------
  function renderQuery() {
    $("#query-empty").hidden = true;
    $("#query").hidden = false;
    const names = model.class_names;
    const filter = $("#pred-filter");
    filter.innerHTML = `<option value="">any class</option>` +
      names.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join("");
    // default query: binary task -> an instance predicted as the second class (e.g. Diabetic)
    const preferred = names.length === 2 ? 1 : 0;
    const first = model.test.find((r) => r.pred === preferred) || model.test[0];
    filter.value = names.length === 2 ? String(preferred) : "";
    query = { index: first ? first.i : null, target: null };
    if (first) query.target = defaultTarget(first.pred);
    renderRows();
    renderTargets();
    renderRules();
    renderOptions();
    updateButtons();
  }

  function defaultTarget(pred) {
    return model.class_names.findIndex((_, i) => i !== pred);
  }

  function renderRows() {
    const filter = $("#pred-filter").value;
    const rows = model.test.filter((r) => filter === "" || r.pred === +filter);
    const names = model.class_names;
    const listed = model.test.length < model.n_test ? ` (${model.test.length} of ${model.n_test} listed, balanced by prediction)` : "";
    $("#row-count").textContent = `${rows.length} test instances${listed}`;
    const head = `<tr><th>#</th>${data.features.map((f) => `<th class="numc">${esc(f)}</th>`).join("")}
      <th>Predicted</th><th class="numc">Confidence</th><th>True class</th></tr>`;
    const body = rows.map((r) => `<tr tabindex="0" data-i="${r.i}" aria-selected="${r.i === query.index}">
      <td class="numc">${r.i}</td>${r.values.map((v) => `<td class="numc">${fmt(v)}</td>`).join("")}
      <td><span class="cls">${swatch(r.pred)}${esc(names[r.pred])}</span></td><td class="numc">${pct(r.conf)}</td>
      <td><span class="cls">${swatch(r.true)}${esc(names[r.true])}</span></td></tr>`).join("");
    $("#rows").innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    const sel = $(`#rows tr[aria-selected="true"]`);
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function selectRow(i) {
    const row = model.test.find((r) => r.i === i);
    if (!row) return;
    query.index = i;
    if (query.target == null || query.target === row.pred) query.target = defaultTarget(row.pred);
    for (const tr of $("#rows").querySelectorAll("tr[data-i]")) tr.setAttribute("aria-selected", String(+tr.dataset.i === i));
    renderTargets();
    markStale();
    updateButtons();
  }

  function renderTargets() {
    const row = model.test.find((r) => r.i === query.index);
    const names = model.class_names;
    $("#query-summary").innerHTML = row
      ? `Instance #${row.i} is predicted <strong>${esc(names[row.pred])}</strong> (${pct(row.conf)}). Find changes that make it:`
      : "Pick an instance in the table.";
    $("#targets").innerHTML = names.map((n, i) => `<button type="button" data-c="${i}"
      aria-pressed="${i === query.target}" ${row && i === row.pred ? "disabled title=\"Already the predicted class\"" : ""}>
      ${swatch(i)}${esc(n)}</button>`).join("");
  }

  function renderRules() {
    $("#rules").innerHTML = data.features.map((f) => {
      const r = rules[f] || "free";
      const opts = RULES.map(([v, label]) => `<option value="${v}" ${v === r ? "selected" : ""}>${label}</option>`).join("");
      const cls = r === "no_change" ? "locked" : r === "free" ? "" : "directed";
      return `<label class="cf-rule ${cls}"><span title="${esc(f)}">${esc(f)}</span><select data-f="${esc(f)}">${opts}</select></label>`;
    }).join("");
  }

  function renderOptions() {
    if (!defaults) return;
    for (const key of ["diversity_lambda", "overgeneration_factor", "min_probability_margin"]) {
      const input = $(`#${key}`);
      if (input && !input.dataset.touched) input.value = defaults[key];
    }
  }

  function cfParams() {
    return {
      index: query.index,
      target: query.target,
      k: +$("#k").value,
      seed: +$("#seed").value || 0,
      close_intervals: $("#close").checked,
      actionability: rules,
      diversity_lambda: +$("#diversity_lambda").value,
      overgeneration_factor: +$("#overgeneration_factor").value,
      min_probability_margin: +$("#min_probability_margin").value,
    };
  }

  // ---- step 3: generate and show ---------------------------------------------------
  async function generate() {
    const params = cfParams();
    $("#result-empty").hidden = true;
    resultOut.classList.remove("stale");
    resultOut.replaceChildren(el("p", "cf-hint", "Searching…"));
    $("#step-result").scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      result = await run("generate", params, "Generating counterfactuals…");
      result.params = params;
    } catch (err) {
      result = null;
      resultOut.replaceChildren(errorBox(err, "Generation"));
      return;
    }
    renderResult();
  }

  function renderResult() {
    const r = result, names = r.class_names, m = r.metrics;
    const tgt = `${swatch(r.target)}<strong>${esc(names[r.target])}</strong>`;
    const orig = `${swatch(r.original_class)}<strong>${esc(names[r.original_class])}</strong>`;
    const summary = el("div", "cf-summary");
    if (!r.counterfactuals.length) {
      summary.innerHTML = `<p>No counterfactual found for instance #${r.params.index} (${orig} → ${tgt}).</p>
        <p>Try freeing more features, unchecking a direction rule, or another seed.</p>`;
      resultOut.replaceChildren(summary);
      return;
    }
    const st = r.stage;
    const changed = st.changed.length ? `, changing ${st.changed.map((f) => `<code>${esc(f)}</code>`).join(", ")}` : "";
    const stageText = st.number === 0
      ? `The base counterfactual came from moving the constrained features into the target-class intervals, before any search stage${changed}.`
      : `The base counterfactual came from stage ${st.number} (${esc(st.name)})${changed}.`;
    summary.innerHTML = `<p>Instance #${r.params.index}: ${orig} (${pct(r.original_proba[r.original_class])}) → ${tgt}.
      DPG-CF returned ${m.returned} of ${m.requested} counterfactuals in ${fmt(m.runtime, 2)} s.</p>
      <p>${stageText} The other counterfactuals are perturbations of it, chosen for proximity and diversity.</p>`;

    const tiles = el("div", "tiles");
    const tile = (k, v, sub, title, cls = "") =>
      `<div class="tile ${cls}" title="${esc(title)}"><div class="k">${k}</div><div class="v">${v}</div><div class="sub">${sub}</div></div>`;
    tiles.innerHTML = [
      tile("Validity", pct(m.validity), `${Math.round(m.validity * m.requested)} of ${m.requested} reach the target`,
        "Share of the requested counterfactuals that the model assigns to the target class. Higher is better.",
        m.validity === 1 ? "good" : m.validity < 0.5 ? "bad" : ""),
      tile("Actionability", pct(m.actionability), "respect the rules",
        "Share of the requested counterfactuals that respect the actionability rules. Higher is better.",
        m.actionability === 1 ? "good" : ""),
      tile("Sparsity", fmt(m.sparsity, 2), `${fmt(m.changed, 1)} of ${r.features.length} features changed`,
        "Mean share of features changed. Lower is better."),
      tile("Distance", fmt(m.distance, 2), "MAD-scaled L1",
        "Mean distance from the instance to its counterfactuals, each feature scaled by its median absolute deviation on the training set. Lower is better."),
      tile("Diversity", m.diversity == null ? "–" : fmt(m.diversity, 2), "mean pairwise, MAD L1",
        "Mean pairwise distance between the counterfactuals. Higher means more varied options."),
      tile("Implausibility", m.implausibility == null ? "–" : fmt(m.implausibility, 2), "to nearest test instance",
        "Mean MAD-scaled distance from each valid counterfactual to the closest test instance predicted as the same class. Lower is better."),
    ].join("");

    const plot = el("div", "cf-plot");
    plot.innerHTML = `<h3>Where the counterfactuals land</h3>
      <p class="cf-hint">Each feature on its training range. The search moves features out of the predicted class's
      DPG interval and into the target class's one, within the actionability rules.</p>`;
    const legend = el("div", "cf-legend");
    legend.innerHTML = `
      <span><svg viewBox="0 0 22 12"><rect x="1" y="2" width="20" height="8" rx="2" fill="${colour(r.target)}" class="cf-band-target"/></svg>${esc(names[r.target])} (target) interval</span>
      <span><svg viewBox="0 0 22 12"><rect x="1" y="2" width="20" height="8" rx="2" class="cf-band-orig"/></svg>${esc(names[r.original_class])} (predicted) interval</span>
      <span><svg viewBox="0 0 22 12"><path d="M11 0 17 6 11 12 5 6Z" class="cf-x"/></svg>instance</span>
      <span><svg viewBox="0 0 22 12"><circle cx="11" cy="6" r="4.5" class="cf-dot"/></svg>counterfactuals</span>`;
    plot.appendChild(legend);
    const tracks = el("div");
    plot.appendChild(tracks);
    observe(tracks, () => drawResultTracks(tracks));

    const table = el("div", "out-table cf-table");
    table.innerHTML = `<div class="tbl-scroll" style="max-height:none">${resultTable()}</div>`;

    const actions = el("div", "cf-row-actions");
    const dl = el("button", "btn btn-sm", "Download CSV");
    dl.type = "button";
    dl.addEventListener("click", downloadCsv);
    actions.appendChild(dl);

    const code = el("details", "cf-code");
    code.innerHTML = `<summary>The same run in Python</summary><pre><code>${esc(pythonCode())}</code></pre>`;

    resultOut.replaceChildren(summary, tiles, table, plot, actions, code);
  }

  function resultTable() {
    const r = result, names = r.class_names, cfs = r.counterfactuals;
    const head = `<tr><th>Feature</th><th class="numc">Instance</th>${cfs.map((_, j) => `<th class="numc">CF ${j + 1}</th>`).join("")}</tr>`;
    const rows = r.features.map((f) => {
      const x = r.original[f], rule = r.rules[f];
      const mark = RULE_MARK[rule] ? `<span class="rule" title="${esc(rule)}">${RULE_MARK[rule]}</span>` : "";
      const cells = cfs.map((cf) => {
        const v = cf.values[f];
        if (!cf.changed.includes(f)) return `<td class="numc">${fmt(v)}</td>`;
        const d = v - x;
        return `<td class="numc chg ${d > 0 ? "up" : "down"}">${fmt(v)}<span class="d">${d > 0 ? "+" : ""}${fmt(d)}</span></td>`;
      }).join("");
      return `<tr><td>${esc(f)}${mark}</td><td class="numc">${fmt(x)}</td>${cells}</tr>`;
    }).join("");
    const pred = `<tr class="sep"><td>prediction</td><td class="numc"><span class="cls">${swatch(r.original_class)}${esc(names[r.original_class])}</span></td>${cfs.map((cf) =>
      `<td class="numc"><span class="cls ${cf.valid ? "" : "bad"}">${swatch(cf.pred)}${esc(names[cf.pred])}</span></td>`).join("")}</tr>`;
    const prob = `<tr><td>P(${esc(names[r.target])})</td><td class="numc">${pct(r.original_proba[r.target])}</td>${cfs.map((cf) =>
      `<td class="numc">${pct(cf.proba[r.target])}</td>`).join("")}</tr>`;
    const act = `<tr><td>actionable</td><td class="numc"></td>${cfs.map((cf) =>
      `<td class="numc ${cf.actionable ? "" : "bad"}">${cf.actionable ? "yes" : "no"}</td>`).join("")}</tr>`;
    return `<table><thead>${head}</thead><tbody>${rows}${pred}${prob}${act}</tbody></table>`;
  }

  function downloadCsv() {
    const r = result;
    const quote = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [["row", ...r.features, "predicted_class"].map(quote).join(",")];
    lines.push(["instance", ...r.features.map((f) => r.original[f]), r.class_names[r.original_class]].map((v) => quote(String(v))).join(","));
    r.counterfactuals.forEach((cf, j) =>
      lines.push([`cf${j + 1}`, ...r.features.map((f) => cf.values[f]), r.class_names[cf.pred]].map((v) => quote(String(v))).join(",")));
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = `counterfactuals_${r.params.index}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function pythonCode() {
    const p = result.params, mp = modelParams();
    const dict = (o) => `{${Object.entries(o).map(([k, v]) => `"${k}": ${typeof v === "string" ? `"${v}"` : v}`).join(", ")}}`;
    const active = Object.fromEntries(Object.entries(p.actionability).filter(([, v]) => v !== "free"));
    const py = (v) => (v == null ? "None" : typeof v === "string" ? `"${v}"` : v);
    const lines = [
      "import numpy as np",
      "from sklearn.ensemble import RandomForestClassifier",
      "from sklearn.model_selection import train_test_split",
      "from dpg_cf import ConstraintParser, CounterFactualModel  # static/counterfactual/dpg_cf/ in DPG_web",
      "",
      "# X: DataFrame of numeric features, y: class labels encoded as 0..K-1",
      "X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)",
      `model = RandomForestClassifier(n_estimators=${mp.n_estimators}, max_depth=${mp.max_depth || "None"}, max_features=${py(mp.max_features)},`,
      `                               min_impurity_decrease=${mp.min_impurity_decrease}, random_state=${mp.random_state}).fit(X_train, y_train)`,
      "",
      "dpg = ConstraintParser.extract_constraints_from_dataset(",
      "    model, X_train.values, y_train.values, list(X.columns),",
      `    dpg_config={"dpg": {"default": {"perc_var": 1e-7, "decimal_threshold": ${mp.decimal_threshold}, "n_jobs": 1}}})`,
      "constraints = dpg[\"constraints\"]  # {\"Class 0\": [{\"feature\", \"min\", \"max\"}, ...], ...}",
    ];
    if (p.close_intervals) lines.push(
      "for entries in constraints.values():  # close open-ended intervals with the observed range",
      "    for e in entries:",
      "        e[\"min\"] = X_train[e[\"feature\"]].min() if e[\"min\"] is None else e[\"min\"]",
      "        e[\"max\"] = X_train[e[\"feature\"]].max() if e[\"max\"] is None else e[\"max\"]");
    lines.push(
      "",
      "cf_model = CounterFactualModel(",
      `    model, constraints, dict_non_actionable=${Object.keys(active).length ? dict(active) : "None"},`,
      `    requested_counterfactuals=${p.k}, diversity_lambda=${p.diversity_lambda}, overgeneration_factor=${p.overgeneration_factor},`,
      `    min_probability_margin=${p.min_probability_margin}, diversity_weight=${defaults.diversity_weight}, repulsion_weight=${defaults.repulsion_weight},`,
      `    distance_factor=${defaults.distance_factor}, boundary_weight=${defaults.boundary_weight}, constraints_factor=${defaults.constraints_factor})`,
      `np.random.seed(${p.seed})`,
      `counterfactuals = cf_model.generate_counterfactual(X_test.iloc[${p.index}].to_dict(), target_class=${p.target})`);
    return lines.join("\n");
  }

  // ---- SVG tracks -------------------------------------------------------------
  const PAD_L = 8, PAD_R = 8;

  function domain(f, extra) {
    const rg = (model || result).ranges[f];
    const vals = [rg.min, rg.max, ...extra].filter((v) => v != null && Number.isFinite(v));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.03;
    return [lo - pad, hi + pad];
  }

  function scaler(w, [lo, hi]) {
    return (v) => PAD_L + ((v - lo) / (hi - lo)) * (w - PAD_L - PAD_R);
  }

  // x/width attributes of an interval band; a (near-)degenerate interval becomes a 5px tick.
  function band(a, z) {
    return z - a >= 5 ? `x="${a}" width="${z - a}"` : `x="${(a + z) / 2 - 2.5}" width="5"`;
  }

  // One band per class for the step-1 overview.
  function overviewSVG(w, h, f, classes) {
    const extra = classes.flatMap(({ b }) => (b ? [b.min, b.max] : []));
    const dom = domain(f, extra), x = scaler(w, dom), rg = model.ranges[f];
    let out = `<svg width="${w}" height="${h}" role="img" aria-label="${esc(f)} intervals">`;
    classes.forEach(({ c, b }, k) => {
      const y = 6 + 9 * k;
      if (!b) return;
      const a = b.min == null ? x(dom[0]) : x(b.min), z = b.max == null ? x(dom[1]) : x(b.max);
      out += `<rect ${band(a, z)} y="${y}" height="7" rx="2" fill="${colour(c)}" class="cf-band-target">` +
        `<title>${esc(model.class_names[c])}: ${b.min == null ? "−∞" : fmt(b.min)} < ${esc(f)} ≤ ${b.max == null ? "∞" : fmt(b.max)}</title></rect>`;
      if (b.min == null) out += `<line x1="${a}" x2="${a + 14}" y1="${y + 3.5}" y2="${y + 3.5}" class="cf-open" stroke="${css("--surface")}"/>`;
      if (b.max == null) out += `<line x1="${z - 14}" x2="${z}" y1="${y + 3.5}" y2="${y + 3.5}" class="cf-open" stroke="${css("--surface")}"/>`;
    });
    const ya = h - 10;
    out += `<line x1="${x(rg.min)}" x2="${x(rg.max)}" y1="${ya}" y2="${ya}" class="cf-axis"/>`;
    out += `<text x="${x(rg.min)}" y="${h}" text-anchor="start">${fmt(rg.min)}</text><text x="${x(rg.max)}" y="${h}" text-anchor="end">${fmt(rg.max)}</text>`;
    return out + "</svg>";
  }

  function drawResultTracks(container) {
    const r = result;
    const w = Math.max(200, container.clientWidth - (container.clientWidth > 560 ? 224 : 0));
    container.innerHTML = r.features.map((f) => {
      const t = r.bounds.target[f], o = r.bounds.original[f];
      const rule = r.rules[f];
      const ruleText = { non_decreasing: "may only increase", non_increasing: "may only decrease", no_change: "fixed" }[rule] || "";
      const label = `<div class="name">${esc(f)}${ruleText ? `<small>${ruleText}</small>` : ""}</div>`;
      if (!t) {
        return `<div class="cf-track">${label}<div class="fixed">No DPG interval for ${esc(r.class_names[r.target])}: kept at ${fmt(r.original[f])}.</div></div>`;
      }
      return `<div class="cf-track">${label}${resultSVG(w, f, t, o)}</div>`;
    }).join("");
  }

  function resultSVG(w, f, t, o) {
    const r = result, h = 46;
    const values = r.counterfactuals.map((cf) => cf.values[f]);
    const dom = domain(f, [t.min, t.max, o && o.min, o && o.max, r.original[f], ...values]);
    const x = scaler(w, dom), rg = r.ranges[f];
    const span = (b) => [b.min == null ? x(dom[0]) : x(b.min), b.max == null ? x(dom[1]) : x(b.max)];
    let out = `<svg width="${w}" height="${h}" role="img" aria-label="${esc(f)}: instance and counterfactuals">`;
    if (o) {
      const [a, z] = span(o);
      out += `<rect ${band(a, z)} y="3" height="9" rx="2" class="cf-band-orig"><title>${esc(r.class_names[r.original_class])}: ${o.min == null ? "−∞" : fmt(o.min)} to ${o.max == null ? "∞" : fmt(o.max)}</title></rect>`;
    }
    const [a, z] = span(t);
    out += `<rect ${band(a, z)} y="15" height="12" rx="2" fill="${colour(r.target)}" class="cf-band-target" opacity=".85"><title>${esc(r.class_names[r.target])}: ${t.min == null ? "−∞" : fmt(t.min)} to ${t.max == null ? "∞" : fmt(t.max)}</title></rect>`;
    const ya = 36;
    out += `<line x1="${x(rg.min)}" x2="${x(rg.max)}" y1="${ya}" y2="${ya}" class="cf-axis"/>`;
    out += `<text x="${x(rg.min)}" y="${h}" text-anchor="start">${fmt(rg.min)}</text><text x="${x(rg.max)}" y="${h}" text-anchor="end">${fmt(rg.max)}</text>`;
    const xo = x(r.original[f]);
    r.counterfactuals.forEach((cf, j) => {
      const v = cf.values[f];
      if (!cf.changed.includes(f)) return;
      const cx = x(v), cy = 21 + ((j % 3) - 1) * 3;
      out += `<line x1="${xo}" x2="${cx}" y1="21" y2="${cy}" class="cf-link"/>`;
      out += `<circle cx="${cx}" cy="${cy}" r="4.5" class="cf-dot${cf.valid ? "" : " invalid"}"><title>CF ${j + 1}: ${fmt(v)}</title></circle>`;
    });
    out += `<path d="M${xo} 14 ${xo + 7} 21 ${xo} 28 ${xo - 7} 21Z" class="cf-x"><title>instance: ${fmt(r.original[f])}</title></path>`;
    return out + "</svg>";
  }

  // Redraw width-dependent SVGs when their container resizes.
  const observers = new WeakMap();
  function observe(node, draw) {
    let last = 0;
    const ro = new ResizeObserver(() => {
      if (!node.isConnected) return ro.disconnect();
      const w = node.clientWidth;
      if (w && Math.abs(w - last) > 4) { last = w; draw(); }
    });
    ro.observe(node);
    observers.set(node, ro);
  }

  // ---- staleness ----------------------------------------------------------------
  function invalidate(level) {
    if (level === "model") {
      model = null;
      modelOut.replaceChildren();
      $("#query").hidden = true;
      $("#query-empty").hidden = false;
    }
    result = null;
    resultOut.replaceChildren();
    resultOut.classList.remove("stale");
    $("#result-empty").hidden = false;
    updateButtons();
  }

  function markStale() {
    if (result) {
      resultOut.classList.add("stale");
      $("#generate-hint").textContent = "Settings changed: generate again to update the result.";
    }
  }

  // ---- events ---------------------------------------------------------------------
  datasetSel.addEventListener("change", () => { targetSel.innerHTML = ""; loadDataset(); });
  csvInput.addEventListener("change", async () => {
    const file = csvInput.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    worker.postMessage({ type: "file", name: "upload.csv", bytes: buf.slice(0) });
    const header = new TextDecoder().decode(buf.slice(0, 65536)).split(/\r?\n/)[0] || "";
    const cols = parseHeader(header);
    targetSel.innerHTML = cols.map((c) => `<option>${esc(c)}</option>`).join("");
    targetSel.value = cols[cols.length - 1];
    loadDataset();
  });
  targetSel.addEventListener("change", loadDataset);
  $("#model-form").addEventListener("input", (e) => {
    if (model && e.target.closest(".field") && !["dataset", "csv-file", "target-col"].includes(e.target.id)) {
      modelOut.classList.add("stale");
      $("#query").classList.add("stale");
    }
  });
  trainBtn.addEventListener("click", async () => {
    modelOut.classList.remove("stale");
    $("#query").classList.remove("stale");
    await train();
  });
  $("#pred-filter").addEventListener("change", renderRows);
  $("#random-row").addEventListener("click", () => {
    const filter = $("#pred-filter").value;
    const rows = model.test.filter((r) => filter === "" || r.pred === +filter);
    if (rows.length) { selectRow(rows[Math.floor(Math.random() * rows.length)].i); renderRows(); }
  });
  $("#rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (tr) selectRow(+tr.dataset.i);
  });
  $("#rows").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectRow(+tr.dataset.i); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling;
      if (next) { next.focus(); selectRow(+next.dataset.i); }
    }
  });
  $("#targets").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-c]");
    if (!b || b.disabled) return;
    query.target = +b.dataset.c;
    renderTargets();
    markStale();
    updateButtons();
  });
  $("#rules").addEventListener("change", (e) => {
    const s = e.target.closest("select[data-f]");
    if (!s) return;
    rules[s.dataset.f] = s.value;
    s.closest(".cf-rule").className = `cf-rule ${s.value === "no_change" ? "locked" : s.value === "free" ? "" : "directed"}`;
    markStale();
  });
  $("#k").addEventListener("input", () => { $("#k-out").textContent = $("#k").value; markStale(); });
  for (const id of ["seed", "close"]) $(`#${id}`).addEventListener("change", markStale);
  $("#adv-form").addEventListener("input", (e) => { e.target.dataset.touched = "1"; markStale(); });
  genBtn.addEventListener("click", () => { $("#generate-hint").textContent = ""; generate(); });

  function parseHeader(line) {
    const cols = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { cols.push(cur.trim()); cur = ""; } else cur += ch;
    }
    cols.push(cur.trim());
    return cols.filter((c) => c !== "");
  }

  // ---- start: load the default preset and train it as soon as Python is up --------
  ready.then(async () => {
    try {
      const info = await run("presets", undefined, "Loading presets…");
      defaults = info._cf_defaults;
      presets = info;
      renderOptions();
      await loadDataset();
      if (data) await train();
    } catch (err) {
      modelOut.replaceChildren(errorBox(err, "Starting"));
    }
  });
})();
