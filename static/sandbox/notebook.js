// DPG Sandbox: renders quickstart_iris.ipynb as runnable cells backed by a Pyodide web worker
// (worker.js). Rich outputs come from dpg_sandbox.py as JSON messages.
(() => {
  const NB_URL = "quickstart_iris.ipynb";
  const IRIS_COLUMNS = ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"];
  const PALETTE = ["--yellow", "--orange", "--olive", "--red", "--c5", "--c6", "--c7", "--c8"];
  const PARAM_RE = /^(\s*)([A-Za-z_]\w*)(\s*=\s*)(.*?)(\s*#\s*@param\s*(.*))$/;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colour = (i) => css(PALETTE[i % PALETTE.length]);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmtNum = (v) => {
    if (typeof v !== "number") return v == null ? "" : String(v);
    if (Number.isInteger(v)) return String(v);
    if (v !== 0 && Math.abs(v) < 1e-3) return v.toExponential(2);
    return String(+v.toFixed(Math.abs(v) >= 100 ? 1 : 4));
  };

  const nbEl = $("#notebook"), runAllBtn = $("#run-all"), kernelEl = $("#kernel");
  let cells = [];
  let worker = null, kernelInfo = "", execCount = 0, nextRunId = 1, running = false;
  let readyResolve, kernelReady;
  const pending = new Map();                          // run id -> {cell, resolve}
  const files = new Map([["iris.csv", null]]);        // name -> ArrayBuffer (null: written by Python)
  const headers = new Map([["iris.csv", IRIS_COLUMNS]]);

  // ---- kernel ---------------------------------------------------------------
  function startKernel() {
    kernelReady = new Promise((resolve) => (readyResolve = resolve));
    worker = new Worker("worker.js", { type: "module" });
    worker.onmessage = (e) => onWorker(e.data);
    worker.onerror = (e) => setKernel("error", `Python worker failed: ${e.message || "unknown error"}`);
    for (const [name, buf] of files) if (buf) worker.postMessage({ type: "file", name, bytes: buf });
    setKernel("loading", "Starting Python…");
  }

  function setKernel(state, text) {
    if (state === "ready" && text) kernelInfo = text;
    kernelEl.dataset.state = state;
    $(".kernel-text", kernelEl).textContent = state === "ready" ? `Ready · ${kernelInfo}` : text || "Running…";
    runAllBtn.disabled = state === "loading" || state === "error";
    if (state === "ready" || state === "error") $("#first-run").hidden = true;
  }

  function onWorker(msg) {
    if (msg.type === "status") {
      if (msg.state === "ready" && !msg.text) return setKernel(running ? "busy" : "ready");
      setKernel(msg.state, msg.text);
      if (msg.state === "ready") readyResolve();
    } else if (msg.type === "output") {
      const p = pending.get(msg.id);
      if (p) renderOutput(p.cell, msg.out);
    } else if (msg.type === "done") {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p) p.resolve(msg.ok);
    }
  }

  function restartKernel() {
    worker.terminate();
    for (const { cell, resolve } of pending.values()) {
      renderOutput(cell, { kind: "error", ename: "Restarted", evalue: "Python was restarted while this cell was running.", traceback: "" });
      resolve(false);
    }
    pending.clear();
    execCount = 0;
    cells.filter((c) => c.type === "code").forEach((c) => { c.count = null; setPrompt(c); c.el.dataset.state = ""; c.el.classList.add("stale"); });
    startKernel();
  }

  // ---- running cells --------------------------------------------------------
  function setPrompt(cell, text) {
    cell.prompt.textContent = `In [${text ?? cell.count ?? " "}]:`;
  }

  async function runCell(cell) {
    if (cell.type !== "code") return true;
    cell.el.dataset.state = "queued";
    setPrompt(cell, "*");
    await kernelReady;
    const id = nextRunId++, count = ++execCount;
    clearOutputs(cell);
    cell.el.classList.remove("stale");
    cell.el.dataset.state = "running";
    if (cell.form) cell.el.classList.remove("params-changed");
    const ok = await new Promise((resolve) => {
      pending.set(id, { cell, resolve });
      worker.postMessage({ type: "run", id, code: cell.cm.getValue(), count });
    });
    cell.count = count;
    setPrompt(cell);
    cell.el.dataset.state = ok ? "done" : "error";
    finishLog(cell, ok);
    return ok;
  }

  async function runAll(from = 0) {
    if (running) return;
    running = true;
    runAllBtn.classList.remove("pulse");
    const todo = cells.slice(from).filter((c) => c.type === "code");
    todo.forEach((c) => { c.el.dataset.state = "queued"; setPrompt(c, "*"); });
    try {
      for (let i = 0; i < todo.length; i++) {
        if (!(await runCell(todo[i]))) {
          todo.slice(i + 1).forEach((c) => { c.el.dataset.state = ""; setPrompt(c); });
          break;
        }
      }
    } finally {
      running = false;
      if (kernelEl.dataset.state === "busy") setKernel("ready");
    }
  }

  // ---- notebook structure ----------------------------------------------------
  const srcText = (s) => (Array.isArray(s) ? s.join("") : s || "");

  async function loadNotebook() {
    const nb = await (await fetch(NB_URL)).json();
    cells.forEach((c) => clearOutputs(c));
    nbEl.innerHTML = "";
    cells = [];
    for (const c of nb.cells) {
      addCell(c.cell_type === "markdown" ? "markdown" : "code", srcText(c.source), { form: !!(c.metadata && c.metadata.sandbox && c.metadata.sandbox.form) });
    }
    const bar = el("div", "add-cell", `<button type="button" class="btn btn-sm">+ Add code cell</button>`);
    bar.querySelector("button").onclick = () => addCell("code", "", { focus: true });
    nbEl.append(bar);
  }

  function addCell(type, source, { form = false, after = null, focus = false } = {}) {
    const cell = { type, form, count: null, graphs: [] };
    if (type === "markdown") {
      cell.el = el("div", "cell md");
      cell.el.innerHTML = `<div class="cell-gutter"></div><div class="cell-main"><div class="cell-box"><div class="md-body"></div></div></div>`;
      $(".md-body", cell.el).innerHTML = DOMPurify.sanitize(marked.parse(source));
      cell.source = source;
    } else {
      buildCodeCell(cell, source);
    }
    const index = after ? cells.indexOf(after) + 1 : cells.length;
    const ref = after ? after.el.nextSibling : $(".add-cell", nbEl);
    nbEl.insertBefore(cell.el, ref || null);
    cells.splice(index, 0, cell);
    if (cell.cm) { cell.cm.refresh(); if (focus) cell.cm.focus(); }
    return cell;
  }

  function buildCodeCell(cell, source) {
    cell.el = el("div", "cell code");
    cell.el.innerHTML = `
      <div class="cell-gutter">
        <span class="prompt">In [ ]:</span>
        <button type="button" class="run-btn" title="Run cell (Shift+Enter)" aria-label="Run cell"><svg viewBox="0 0 10 12"><path d="M0 0l10 6-10 6z"/></svg></button>
      </div>
      <div class="cell-main">
        <div class="cell-box">
          ${cell.form ? `<div class="form"></div><div class="changed-note">Parameters changed. <button type="button" class="btn btn-sm btn-primary">▶ Run all</button></div>` : ""}
          ${cell.form ? `<button type="button" class="code-toggle" aria-expanded="false">Show code</button>` : ""}
          <div class="cell-editor"${cell.form ? " hidden" : ""}></div>
        </div>
        <div class="cell-tools">
          <button type="button" data-act="add">+ Code below</button>
          ${cell.form ? "" : `<button type="button" data-act="delete">Delete</button>`}
        </div>
        <div class="cell-output"></div>
      </div>`;
    cell.prompt = $(".prompt", cell.el);
    cell.out = $(".cell-output", cell.el);
    const runKey = isMac ? "Cmd-Enter" : "Ctrl-Enter";
    cell.cm = CodeMirror($(".cell-editor", cell.el), {
      value: source.replace(/\n$/, ""), mode: "python", indentUnit: 4, tabSize: 4, matchBrackets: true,
      viewportMargin: Infinity, lineWrapping: false,
      extraKeys: {
        "Shift-Enter": () => { runCell(cell); focusNext(cell); },
        [runKey]: () => runCell(cell),
        Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("    ", "end")),
        "Shift-Tab": (cm) => cm.indentSelection("subtract"),
      },
    });
    cell.cm.on("focus", () => cell.el.classList.add("focused"));
    cell.cm.on("blur", () => cell.el.classList.remove("focused"));
    $(".run-btn", cell.el).onclick = () => runCell(cell);
    $('[data-act="add"]', cell.el).onclick = () => addCell("code", "", { after: cell, focus: true });
    const del = $('[data-act="delete"]', cell.el);
    if (del) del.onclick = () => { clearOutputs(cell); cell.el.remove(); cells.splice(cells.indexOf(cell), 1); };

    if (cell.form) {
      const toggle = $(".code-toggle", cell.el), editor = $(".cell-editor", cell.el);
      toggle.onclick = () => {
        editor.hidden = !editor.hidden;
        toggle.textContent = editor.hidden ? "Show code" : "Hide code";
        toggle.setAttribute("aria-expanded", String(!editor.hidden));
        if (!editor.hidden) cell.cm.refresh();
      };
      $(".changed-note .btn", cell.el).onclick = () => runAll();
      let timer = 0;
      cell.cm.on("change", () => {
        if (cell.syncing) return;
        clearTimeout(timer);
        timer = setTimeout(() => buildForm(cell), 250);
        paramsChanged(cell);
      });
      setupDrop(cell);
      buildForm(cell);
    }
  }

  function focusNext(cell) {
    const next = cells.slice(cells.indexOf(cell) + 1).find((c) => c.type === "code");
    (next || addCell("code", "")).cm.focus();
  }

  function paramsChanged(cell) {
    if (cell.count == null) return; // not run yet: nothing is out of date
    cell.el.classList.add("params-changed");
    runAllBtn.classList.add("pulse");
    cells.slice(cells.indexOf(cell)).forEach((c) => c.type === "code" && c.el.classList.add("stale"));
  }

  // ---- parameter form (Colab-style "# @param" lines) -------------------------
  function parseSpec(text) {
    text = text.trim();
    try {
      if (text.startsWith("[")) return { type: "select", options: JSON.parse(text) };
      if (text.startsWith("{")) return JSON.parse(text.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":'));
    } catch { /* fall through */ }
    return { type: "string" };
  }
  function pyValue(raw) {
    if (raw === "True") return true;
    if (raw === "False") return false;
    const q = /^(['"])(.*)\1$/.exec(raw);
    if (q) return q[2];
    if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
    return raw;
  }
  const pyLiteral = (v) => (typeof v === "boolean" ? (v ? "True" : "False") : typeof v === "number" ? String(v) : JSON.stringify(String(v)));

  function params(cell) {
    const out = [];
    cell.cm.getValue().split("\n").forEach((line, i) => {
      const m = PARAM_RE.exec(line);
      if (m) out.push({ line: i, name: m[2], raw: m[4], value: pyValue(m[4]), spec: parseSpec(m[6]) });
    });
    return out;
  }

  function setParam(cell, name, literal) {
    const doc = cell.cm.getDoc();
    for (let i = 0; i < doc.lineCount(); i++) {
      const line = doc.getLine(i), m = PARAM_RE.exec(line);
      if (!m || m[2] !== name) continue;
      cell.syncing = true;
      doc.replaceRange(m[1] + m[2] + m[3] + literal + m[5], { line: i, ch: 0 }, { line: i, ch: line.length });
      cell.syncing = false;
      paramsChanged(cell);
      return;
    }
  }

  function currentDataset(cell) {
    const p = params(cell).find((x) => x.spec.type === "file");
    return p ? String(p.value) : "iris.csv";
  }

  function buildForm(cell) {
    const form = $(".form", cell.el);
    form.innerHTML = "";
    for (const p of params(cell)) {
      const { spec } = p, id = `p-${p.name}`;
      const label = esc(spec.label || p.name.replace(/_/g, " "));
      const name = `<span class="fname">${esc(p.name)}</span>`;
      let field;
      if (spec.type === "file") {
        field = el("div", "field wide", `<span class="flabel">${label}</span>
          <div class="dropzone">
            <select id="${id}" aria-label="${label}">${[...files.keys()].map((f) => `<option${f === p.value ? " selected" : ""}>${esc(f)}</option>`).join("")}</select>
            <button type="button" class="btn btn-sm">Load CSV…</button>
            <input type="file" accept=".csv,text/csv" hidden>
            <span class="hint">or drop a CSV here · read locally, never uploaded</span>
          </div>`);
        const select = $("select", field), input = $("input", field);
        select.onchange = () => { setParam(cell, p.name, pyLiteral(select.value)); buildForm(cell); };
        $("button", field).onclick = () => input.click();
        input.onchange = () => { if (input.files[0]) loadFile(cell, input.files[0]); };
      } else if (spec.type === "boolean") {
        field = el("div", "field check", `<input type="checkbox" id="${id}"${p.value === true ? " checked" : ""}><label for="${id}">${label}</label>`);
        $("input", field).onchange = (e) => setParam(cell, p.name, e.target.checked ? "True" : "False");
      } else if (spec.type === "select") {
        field = el("div", "field", `<label for="${id}">${label}</label><select id="${id}">${spec.options.map((o, k) =>
          `<option value="${k}"${String(o) === String(p.value) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>${name}`);
        $("select", field).onchange = (e) => setParam(cell, p.name, pyLiteral(spec.options[+e.target.value]));
      } else if (spec.type === "slider") {
        const step = spec.step ?? 1;
        field = el("div", "field", `<label for="${id}">${label}</label><div class="slider">
          <input type="range" id="${id}" min="${spec.min ?? 0}" max="${spec.max ?? 100}" step="${step}" value="${esc(p.value)}"><output>${esc(p.value)}</output></div>${name}`);
        const range = $("input", field), output = $("output", field);
        range.oninput = () => { output.textContent = range.value; };
        range.onchange = () => setParam(cell, p.name, String(+range.value));
      } else if (spec.type === "integer" || spec.type === "number") {
        field = el("div", "field", `<label for="${id}">${label}</label><input type="text" inputmode="decimal" id="${id}" value="${esc(p.raw)}" spellcheck="false">${name}`);
        const input = $("input", field);
        input.onchange = () => {
          const v = input.value.trim(), okNum = v !== "" && !Number.isNaN(Number(v)) && (spec.type !== "integer" || Number.isInteger(Number(v)));
          input.classList.toggle("invalid", !okNum);
          if (okNum) setParam(cell, p.name, v);
        };
      } else {
        const cols = spec.type === "column" ? headers.get(currentDataset(cell)) || [] : [];
        field = el("div", "field", `<label for="${id}">${label}</label><input type="text" id="${id}" value="${esc(p.value)}" placeholder="${esc(spec.placeholder || "")}" spellcheck="false"${cols.length ? ` list="${id}-list"` : ""}>
          ${cols.length ? `<datalist id="${id}-list">${cols.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>` : ""}${name}`);
        $("input", field).onchange = (e) => setParam(cell, p.name, pyLiteral(e.target.value));
      }
      form.append(field);
    }
  }

  // ---- loading a CSV from disk --------------------------------------------------
  function csvHeader(buf) {
    const text = new TextDecoder().decode(buf.slice(0, 65536)).replace(/^﻿/, "");
    const first = text.split(/\r?\n/)[0] || "";
    return (first.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()).slice(0, -1);
  }

  async function loadFile(cell, file) {
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      alert("Please choose a .csv file (feature columns plus a target column).");
      return;
    }
    const buf = await file.arrayBuffer();
    const name = file.name.replace(/[^\w.\- ()]/g, "_");
    files.set(name, buf);
    const header = csvHeader(buf);
    headers.set(name, header);
    worker.postMessage({ type: "file", name, bytes: buf.slice(0) });
    setParam(cell, "dataset", pyLiteral(name));
    setParam(cell, "target_column", '""');
    setParam(cell, "first_column_is_index", header[0] === "" || /^Unnamed/.test(header[0] || "") ? "True" : "False");
    buildForm(cell);
    runAll();
  }

  function setupDrop(cell) {
    let depth = 0;
    cell.el.addEventListener("dragenter", (e) => { if (e.dataTransfer.types.includes("Files")) { depth++; cell.el.classList.add("dragover"); } });
    cell.el.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; cell.el.classList.remove("dragover"); } });
    cell.el.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); });
    cell.el.addEventListener("drop", (e) => {
      e.preventDefault(); depth = 0; cell.el.classList.remove("dragover");
      const f = e.dataTransfer.files[0];
      if (f) loadFile(cell, f);
    });
  }

  // ---- outputs ---------------------------------------------------------------------
  function clearOutputs(cell) {
    (cell.graphs || []).forEach((h) => h._dpgDestroy && h._dpgDestroy());
    cell.graphs = [];
    cell.log = null;
    if (cell.out) cell.out.innerHTML = "";
  }

  function appendStream(cell, text) {
    if (!cell.log) {
      cell.log = { text: "", details: el("details", "out-log", `<summary>Output</summary><pre></pre>`) };
      cell.log.details.open = true;
      cell.out.prepend(cell.log.details);
    }
    const log = cell.log;
    // carriage returns (progress bars) overwrite the current line, as in a terminal
    log.text = (log.text + text).split("\n").map((line) => {
      const parts = line.split("\r").filter((s) => s !== "");
      return parts.length ? parts[parts.length - 1] : "";
    }).join("\n");
    const pre = $("pre", log.details);
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = log.text;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    const n = log.text.trimEnd().split("\n").length;
    $("summary", log.details).textContent = `Output · ${n} line${n === 1 ? "" : "s"}`;
  }

  function finishLog(cell, ok) {
    if (!cell.log) return;
    if (!cell.log.text.trim()) { cell.log.details.remove(); cell.log = null; return; }
    if (ok && cell.out.children.length > 1) cell.log.details.open = false; // results first, log on demand
  }

  function renderOutput(cell, out) {
    if (out.kind === "stream") return appendStream(cell, out.text);
    let node;
    if (out.kind === "text") node = el("pre", "out-text", esc(out.text));
    else if (out.kind === "error") {
      node = el("div", "out-error", `<strong>${esc(out.ename)}</strong> <span class="evalue">${esc(out.evalue)}</span>${out.traceback ? `<pre>${esc(out.traceback)}</pre>` : ""}`);
    } else if (out.kind === "table") node = renderTable(out);
    else if (out.kind === "dataset") node = renderDataset(out);
    else if (out.kind === "scores") node = renderScores(out);
    else if (out.kind === "boundaries") node = renderBoundaries(out);
    else if (out.kind === "image") node = el("div", "out-image", `<img alt="Figure" src="data:image/png;base64,${out.png}">`);
    else if (out.kind === "graph") node = renderGraph(cell, out.data);
    else node = el("pre", "out-text", esc(JSON.stringify(out)));
    cell.out.append(node);
    if (node._mount) node._mount();
  }

  function renderTable(t) {
    const wrap = el("div", "out-table");
    const numeric = t.columns.map((_, j) => t.rows.length > 0 && t.rows.every((r) => r[j] == null || typeof r[j] === "number"));
    let rows = t.rows.slice(), sortCol = -1, dir = 1;
    wrap.innerHTML = `${t.caption ? `<div class="tbl-foot">${esc(t.caption)}</div>` : ""}<div class="tbl-scroll"><table>
      <thead><tr>${t.columns.map((c, j) => `<th scope="col" data-j="${j}"${numeric[j] ? ' class="numc"' : ""}>${esc(c)}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
      <div class="tbl-foot">${t.total > t.rows.length ? `Showing the first ${t.rows.length} of ${t.total} rows` : `${t.total} row${t.total === 1 ? "" : "s"}`}${t.columns.length > 1 ? " · click a header to sort" : ""}</div>`;
    const tbody = $("tbody", wrap);
    const draw = () => {
      tbody.innerHTML = rows.map((r) => `<tr>${r.map((v, j) => `<td${numeric[j] ? ' class="numc"' : ""}>${esc(fmtNum(v))}</td>`).join("")}</tr>`).join("");
    };
    wrap.querySelectorAll("th").forEach((th) => (th.onclick = () => {
      const j = +th.dataset.j;
      dir = sortCol === j ? -dir : numeric[j] ? -1 : 1;
      sortCol = j;
      rows = t.rows.slice().sort((a, b) => {
        const x = a[j], y = b[j];
        if (x == null) return 1;
        if (y == null) return -1;
        return (numeric[j] ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
      });
      wrap.querySelectorAll("th").forEach((h) => h.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
      draw();
    }));
    draw();
    return wrap;
  }

  function renderDataset(d) {
    const wrap = el("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:12px";
    const classes = Object.entries(d.classes), max = Math.max(1, ...classes.map(([, n]) => n));
    wrap.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="k">Rows</div><div class="v">${d.rows}</div></div>
        <div class="tile"><div class="k">Features</div><div class="v">${d.features.length}</div></div>
        <div class="tile"><div class="k">Classes</div><div class="v">${classes.length}</div></div>
        <div class="tile"><div class="k">Target</div><div class="v" style="font-size:1.1rem">${esc(d.target)}</div></div>
      </div>
      <div class="ds-grid">
        <div class="out-card"><h4>Class balance</h4><div class="balance">${classes.map(([k, n], i) => `
          <span>${esc(k)}</span><span class="bar"><span style="width:${(n / max) * 100}%;background:${colour(i)}"></span></span><span class="n">${n}</span>`).join("")}</div></div>
        <div class="out-card"><h4>Features</h4><div class="chips">${d.features.map((f) => `<span class="chip">${esc(f)}</span>`).join("")}</div></div>
      </div>`;
    const head = renderTable({ ...d.head, caption: "First rows" });
    wrap.append(head);
    return wrap;
  }

  function renderScores(s) {
    const tiles = el("div", "tiles tiles-wide");
    for (const [name, values] of Object.entries(s.metrics)) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length - 1));
      tiles.append(el("div", "tile", `<div class="k">${esc(name)}</div>
        <div class="v">${mean.toFixed(3)} <small>± ${sd.toFixed(3)}</small></div>
        <div class="folds" aria-label="Per-fold values">${values.map((v, i) => `<span style="height:${Math.max(3, v * 100)}%" title="fold ${i + 1}: ${v.toFixed(3)}"></span>`).join("")}</div>
        <div class="fold-axis"><span>fold 1</span><span>fold ${values.length}</span></div>`));
    }
    return tiles;
  }

  function renderBoundaries(b) {
    const wrap = el("div", "bounds");
    Object.entries(b.classes).forEach(([cls, constraints], i) => {
      const card = el("div", "bound", `<h4>${esc(cls)}</h4><ul>${constraints.map((c) => `<li>${esc(c)}</li>`).join("") || "<li>no constraints</li>"}</ul>`);
      card.style.borderTopColor = colour(i);
      wrap.append(card);
    });
    return wrap;
  }

  function renderGraph(cell, data) {
    const wrap = el("div", "graph-out");
    const host = el("div", "dpg-graph");
    const classes = data.nodes.filter((n) => n.isClass).length;
    const stats = el("div", "graph-stats", `<span><b>${data.nodes.length}</b> nodes</span><span><b>${data.edges.length}</b> edges</span>
      <span><b>${classes}</b> class nodes</span><span><b>${data.communities.length}</b> communities</span>`);
    wrap.append(host, stats);
    cell.graphs.push(host);
    const mount = () => {
      if (typeof window.mountDPGGraph !== "function") { host.innerHTML = `<p class="graph-warn">The graph library failed to load.</p>`; return; }
      window.mountDPGGraph(host, data, { label: `Interactive Decision Predicate Graph with ${data.nodes.length} nodes` });
    };
    wrap._mount = () => {
      if (data.nodes.length <= 1500) return requestAnimationFrame(mount);
      host.innerHTML = `<div class="graph-warn">This graph has ${data.nodes.length} nodes, so laying it out can take a while. <button type="button" class="btn btn-sm">Draw it</button></div>`;
      $("button", host).onclick = () => { host.innerHTML = ""; mount(); };
    };
    return wrap;
  }

  // ---- toolbar ---------------------------------------------------------------------
  function downloadNotebook() {
    const base = new URL(".", location.href).href;
    const setup = [
      "# Running this notebook outside the DPG Sandbox? This cell installs dpg and fetches the display",
      "# helpers once. To use your own data, put the CSV next to the notebook and set `dataset` below.",
      "import importlib.util, urllib.request",
      'if importlib.util.find_spec("dpg") is None:',
      "    %pip install dpg",
      'if importlib.util.find_spec("dpg_sandbox") is None:',
      `    urllib.request.urlretrieve("${base}dpg_sandbox.py", "dpg_sandbox.py")`,
    ].join("\n");
    const lines = (s) => s.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
    const nb = {
      nbformat: 4, nbformat_minor: 5,
      metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } },
      cells: [
        { cell_type: "code", id: "setup", metadata: {}, execution_count: null, outputs: [], source: lines(setup) },
        ...cells.map((c, i) => (c.type === "markdown"
          ? { cell_type: "markdown", id: `cell-${i}`, metadata: {}, source: lines(c.source) }
          : { cell_type: "code", id: `cell-${i}`, metadata: c.form ? { sandbox: { form: true } } : {}, execution_count: null, outputs: [], source: lines(c.cm.getValue()) })),
      ],
    };
    const a = el("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(nb, null, 1) + "\n"], { type: "application/x-ipynb+json" }));
    a.download = "dpg_quickstart_iris.ipynb";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  runAllBtn.onclick = () => runAll();
  $("#restart").onclick = () => restartKernel();
  $("#download").onclick = downloadNotebook;
  $("#reset").onclick = async () => {
    if (!confirm("Restore the original notebook? Your edits to the cells will be lost (loaded CSV files stay available).")) return;
    await loadNotebook();
    runAll();
  };

  startKernel();
  loadNotebook()
    .then(() => runAll())
    .catch((err) => { nbEl.innerHTML = `<div class="out-error"><strong>Could not load the notebook</strong> <span class="evalue">${esc(err.message || err)}</span></div>`; });
})();
