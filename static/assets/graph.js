// Interactive DPG graph: a simpler take on the run viewer's graph (dashboard/app.js).
// mountDPGGraph(host, data) renders graph JSON as written by dpg_sandbox.graph_data()
// (sandbox/dpg_sandbox.py, also used by scripts/export_iris_dpg.py). Elements with a
// data-dpg-src attribute are mounted automatically; if that fails their content stays.
(() => {
  if (typeof cytoscape !== "function") return; // keep any static fallback content

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (x) => (x === 0 ? "0" : Math.abs(x) < 0.01 ? x.toExponential(1) : x.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));
  const FONT = "Outfit, system-ui, sans-serif";
  const touch = matchMedia("(hover: none)").matches;
  const measure = document.createElement("canvas").getContext("2d");
  const textWidth = (t, bold) => { measure.font = `${bold ? 700 : 500} 13px ${FONT}`; return measure.measureText(t).width; };

  // communities take the brand colours in order; class nodes are drawn in ink with a coloured ring
  const PALETTE = ["--yellow", "--orange", "--olive", "--red", "--c5", "--c6", "--c7", "--c8"];
  const textOn = (hex) => {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex); if (!m) return "#1c1a14";
    const [r, g, b] = m.slice(1).map((h) => { const c = parseInt(h, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.2 ? "#1c1a14" : "#fffdf7";
  };
  const RAMP = ["#f6ecd2", "#f3d9a4", "#efc275", "#eba54a", "#e38726", "#d7650f", "#c8410f", "#a33208"];

  const fmtW = (w) => (Number.isInteger(w) ? String(w) : fmt(w));

  function mount(host, data, { label = "Interactive Decision Predicate Graph" } = {}) {
    if (host._dpgDestroy) host._dpgDestroy();
    const $ = (sel) => host.querySelector(sel);
    const weights = data.edges.map((e) => e.weight);
    const wMin = weights.length ? Math.min(...weights) : 0, wMax = weights.length ? Math.max(...weights) : 1;
    const bMax = Math.max(0, ...data.nodes.map((n) => n.betweenness || 0));
    const named = data.communities.filter((c) => !/^ambiguous$/i.test(c));
    const commFill = (c) => {
      const i = named.indexOf(c);
      return i >= 0 && i < PALETTE.length ? css(PALETTE[i]) : css("--g-plain-fill");
    };

    host.classList.add("live");
    host.innerHTML = `
      <div class="g-toolbar">
        <div class="seg" role="group" aria-label="Colour nodes by">
          <button type="button" data-mode="community" aria-pressed="true">Communities</button>
          <button type="button" data-mode="betweenness" aria-pressed="false">Betweenness</button>
          <button type="button" data-mode="plain" aria-pressed="false">Plain</button>
        </div>
        <div class="g-zoom">
          <button type="button" data-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
          <button type="button" data-zoom="fit">Fit</button>
        </div>
      </div>
      <div class="g-stage">
        <div class="g-cy" role="img" aria-label="${esc(label)}"></div>
        <div class="g-hint" aria-live="polite"></div>
        ${touch ? `<button type="button" class="g-cover"><span>Tap to explore the graph</span></button><button type="button" class="g-done" hidden>Done</button>` : ""}
        <aside class="g-side" hidden></aside>
      </div>
      <div class="g-legend"></div>`;

    const cyEl = $(".g-cy"), side = $(".g-side"), hint = $(".g-hint"), legend = $(".g-legend");
    let mode = "community", pinned = null, active = false;
    const elements = [
      ...data.nodes.map((n) => ({ data: { ...n, isClass: n.isClass ? 1 : 0, w: textWidth(n.label, n.isClass) + 22, ...colours(n) } })),
      ...data.edges.map((e, i) => ({ data: { id: `e${i}`, ...e, wlabel: fmtW(e.weight) } })),
    ];

    const style = () => {
      const lo = css("--g-edge-lo"), hi = css("--g-edge-hi");
      return [
        { selector: "node", style: {
          shape: "round-rectangle", width: "data(w)", height: 30, label: "data(label)",
          "font-family": FONT, "font-size": 13, "font-weight": 500, "text-valign": "center", "text-halign": "center",
          "background-color": "data(fill)", color: "data(text)", "border-width": 1.5, "border-color": css("--g-node-border"),
        } },
        { selector: "node[isClass = 1]", style: {
          "background-color": css("--g-class-fill"), color: css("--g-class-text"), "font-weight": 700,
          "border-width": 4, "border-color": "data(ring)", height: 34,
        } },
        { selector: "edge", style: {
          width: `mapData(weight, ${wMin}, ${wMax}, 1, 7)`, "curve-style": "bezier",
          "line-color": `mapData(weight, ${wMin}, ${wMax}, ${lo}, ${hi})`,
          "target-arrow-color": `mapData(weight, ${wMin}, ${wMax}, ${lo}, ${hi})`,
          "target-arrow-shape": "triangle", "arrow-scale": 0.8,
          "font-family": FONT, "font-size": 11, "font-weight": 600, color: css("--ink"),
          "text-background-color": css("--g-bg"), "text-background-opacity": 0.9, "text-background-padding": "2px",
        } },
        { selector: ".faded", style: { opacity: 0.1 } },
        { selector: "edge.hl", style: { "line-color": css("--g-accent"), "target-arrow-color": css("--g-accent"), label: "data(wlabel)", "z-index": 9 } },
        { selector: "node.focus", style: { "border-width": 4, "border-color": css("--g-accent") } },
      ];
    };

    function colours(d) {
      let fill = css("--g-plain-fill"), text = css("--ink");
      if (!d.isClass && mode === "community") { fill = commFill(d.community); text = textOn(fill); }
      if (!d.isClass && mode === "betweenness") {
        fill = RAMP[Math.round((bMax ? d.betweenness / bMax : 0) * (RAMP.length - 1))];
        text = textOn(fill);
      }
      return { fill, text, ring: mode === "community" ? commFill(d.community) : css("--g-class-fill") };
    }
    function paint() {
      cy.batch(() => cy.nodes().forEach((n) => n.data(colours(n.data()))));
      renderLegend();
    }

    function renderLegend() {
      const sw = (c, ring) => `<span class="sw" style="background:${c}${ring ? `;box-shadow:inset 0 0 0 3px ${ring}` : ""}"></span>`;
      let html = "";
      if (mode === "community") {
        html += data.communities.map((c) => {
          const k = data.nodes.filter((n) => !n.isClass && n.community === c).length;
          return `<span>${sw(commFill(c))}${esc(c)} community <span class="muted">(${k})</span></span>`;
        }).join("");
      } else if (mode === "betweenness") {
        html += `<span>betweenness 0<span class="ramp" style="background:linear-gradient(90deg,${RAMP.join(",")})"></span>${fmt(bMax)}</span>`;
      } else {
        html += `<span>${sw(css("--g-plain-fill"))}predicate</span>`;
      }
      html += `<span>${sw(css("--g-class-fill"))}class</span><span>edge width = training samples (${fmtW(wMin)}–${fmtW(wMax)})</span>`;
      legend.innerHTML = html;
    }

    const cy = cytoscape({
      container: cyEl, elements, style: style(), minZoom: 0.06, maxZoom: 3,
      userZoomingEnabled: false, boxSelectionEnabled: false, autoungrabify: true,
      layout: { name: "dagre", rankDir: "LR", nodeSep: 8, rankSep: 40, edgeSep: 8 },
    });
    paint();
    const fit = (animate) => (animate ? cy.animate({ fit: { padding: 24 }, duration: 250 }) : cy.fit(undefined, 24));
    fit(false);
    setHint();

    // ---- interaction ------------------------------------------------------
    function highlight(node) {
      cy.batch(() => {
        cy.elements().removeClass("faded hl focus");
        if (!node) return;
        const path = node.predecessors().union(node.successors()).union(node);
        cy.elements().not(path).addClass("faded");
        path.edges().addClass("hl");
        node.addClass("focus");
      });
    }

    function details(node) {
      if (!node) { side.hidden = true; return; }
      const d = node.data();
      const item = (e, other) => `<li><button type="button" data-id="${esc(other.id())}">${esc(other.data("label"))}</button><span>${e.data("wlabel")}</span></li>`;
      const ins = node.incomers("edge").sort((a, b) => b.data("weight") - a.data("weight"));
      const outs = node.outgoers("edge").sort((a, b) => b.data("weight") - a.data("weight"));
      const probs = Object.entries(d.probs || {}).sort((a, b) => b[1] - a[1]);
      side.innerHTML = `
        <button type="button" class="g-close" aria-label="Close details">×</button>
        <h4>${esc(d.label)}</h4>
        <p class="g-sub">${d.isClass ? "Class node" : "Predicate"}${d.community ? ` · <span class="sw" style="background:${commFill(d.community)}"></span>${esc(d.community)} community` : ""}</p>
        ${!d.isClass && probs.length ? `<h5>Class probability</h5>${probs.map(([k, p]) => `
          <div class="prob"><span>${esc(k.replace(/^Class /, ""))}</span><span class="bar"><span style="width:${(p * 100).toFixed(1)}%;background:${commFill(k)}"></span></span><span>${Math.round(p * 100)}%</span></div>`).join("")}` : ""}
        ${!d.isClass ? `<h5>Graph metrics</h5><dl><dt>Betweenness</dt><dd>${fmt(d.betweenness)}</dd><dt>Local reaching</dt><dd>${fmt(d.lrc)}</dd></dl>` : ""}
        <h5>Incoming (${ins.length})</h5><ul>${ins.map((e) => item(e, e.source())).join("") || "<li class='muted'>none, a root predicate</li>"}</ul>
        <h5>Outgoing (${outs.length})</h5><ul>${outs.map((e) => item(e, e.target())).join("") || "<li class='muted'>none</li>"}</ul>`;
      side.hidden = false;
      side.scrollTop = 0;
      side.querySelector(".g-close").onclick = () => select(null);
      side.querySelectorAll("button[data-id]").forEach((b) => (b.onclick = () => select(cy.getElementById(b.dataset.id))));
    }

    // Centre the pinned node at a readable zoom in the area the details panel leaves free
    // (its paths stay highlighted; the panel lists its neighbours).
    const READABLE = 0.9;
    function focus(node) {
      const inset = getComputedStyle(side).position === "absolute" ? side.offsetWidth + 24 : 0;
      const z = Math.max(cy.zoom(), READABLE), p = node.position();
      cy.animate({ zoom: z, pan: { x: (cy.width() - inset) / 2 - p.x * z, y: cy.height() / 2 - p.y * z } }, { duration: 300 });
    }

    function select(node) {
      pinned = node && node.length ? node : null;
      highlight(pinned); details(pinned);
      if (pinned) focus(pinned);
    }

    cy.on("mouseover", "node", (e) => { if (!pinned) highlight(e.target); cyEl.style.cursor = "pointer"; });
    cy.on("mouseout", "node", () => { if (!pinned) highlight(null); cyEl.style.cursor = ""; });
    cy.on("tap", "node", (e) => select(pinned && pinned.same(e.target) ? null : e.target));
    cy.on("tap", (e) => { if (e.target === cy) select(null); });

    // Wheel zoom only once the graph is "active" (clicked) or with Ctrl/⌘, so page scrolling
    // over the graph keeps scrolling the page. On touch screens the cover does the same job.
    function setActive(on) {
      active = on;
      cy.userZoomingEnabled(on);
      host.classList.toggle("active", on);
      if (touch) { $(".g-cover").hidden = on; $(".g-done").hidden = !on; }
      setHint();
    }
    function setHint(msg) {
      hint.textContent = msg || (touch
        ? (active ? "Pinch to zoom · drag to pan · tap a node for details" : "")
        : (active ? "Scroll to zoom · drag to pan · hover a node to trace its paths · click for details"
          : "Click the graph to enable scroll-zoom · drag to pan · hover a node to trace its paths"));
    }
    let hintTimer = 0;
    cyEl.addEventListener("wheel", (e) => {
      if (active) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = cyEl.getBoundingClientRect();
        const level = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * Math.exp(-e.deltaY * 0.002)));
        cy.zoom({ level, renderedPosition: { x: e.clientX - r.left, y: e.clientY - r.top } });
        return;
      }
      setHint(`Click the graph first, or hold ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} while scrolling, to zoom`);
      host.classList.add("nudge");
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { host.classList.remove("nudge"); setHint(); }, 1800);
    }, { passive: false });
    if (touch) {
      $(".g-cover").onclick = () => setActive(true);
      $(".g-done").onclick = () => { setActive(false); select(null); };
    } else {
      cyEl.addEventListener("mousedown", () => setActive(true));
      host.addEventListener("mouseleave", () => setActive(false));
    }

    host.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => {
      mode = b.dataset.mode;
      host.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      paint();
      if (pinned) details(pinned);
    }));
    host.querySelectorAll("[data-zoom]").forEach((b) => (b.onclick = () => {
      if (b.dataset.zoom === "fit") return fit(true);
      const level = cy.zoom() * (b.dataset.zoom === "in" ? 1.35 : 1 / 1.35);
      cy.animate({ zoom: { level: Math.min(cy.maxZoom(), Math.max(cy.minZoom(), level)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }, duration: 150 });
    }));

    // Re-read the theme colours when the light/dark toggle flips data-theme.
    const themeObserver = new MutationObserver(() => { cy.style(style()); paint(); if (pinned) details(pinned); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    let resizeTimer = 0;
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { cy.resize(); if (!pinned) fit(false); }, 150); };
    addEventListener("resize", onResize);

    host._dpgDestroy = () => {
      themeObserver.disconnect();
      removeEventListener("resize", onResize);
      clearTimeout(resizeTimer); clearTimeout(hintTimer);
      cy.destroy();
      host._dpgDestroy = null;
    };
    return cy;
  }

  window.mountDPGGraph = (host, data, opts) => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => mount(host, data, opts));

  document.querySelectorAll("[data-dpg-src]").forEach((host) => {
    fetch(host.dataset.dpgSrc)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => window.mountDPGGraph(host, data, { label: host.dataset.dpgLabel }))
      .catch(() => {}); // the static fallback stays
  });
})();
