/* ==========================================================================
   3D Warehouse Visualizer (Demo) — Weekly Space Simulation dock
   Runs SimEngine on the synthetic facilities + planning data, draws the weekly occupancy timeline under the
   3D view and projects the selected week's pallets into the 3D scene.
   ========================================================================== */
(function () {
  "use strict";

  const SVGNS = "http://www.w3.org/2000/svg";
  const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const STATUS = {
    watch: { color: "#fab219", icon: "⚠", label: "Watch" },
    critical: { color: "#d03b3b", icon: "⛔", label: "Critical" },
    overflow: { color: "#d03b3b", icon: "⛔", label: "Overflow" },
  };

  const state = {
    result: null,
    selected: -1, // -1 = snapshot (now); else week index
    options: { forecastMultiplier: 1.0, inboundShiftWeeks: 0, inboundTiming: "spread", prodDaysPerWeek: null, extraPositions: 0 },
    playing: false,
    timer: null,
    table: false,
    parts: new Map(),
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const pct = (n) => `${n.toFixed(1)}%`;

  function el(tag, attrs, text) {
    const node = document.createElementNS(SVGNS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function data() {
    return { facilities: window.DEMO_FACILITIES || {}, planning: window.DEMO_PLANNING };
  }

  function weekDates(w) {
    const start = new Date(`${w.start}T00:00:00`);
    const end = new Date(start.getTime() + 6 * 86400000);
    const f = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${f(start)} – ${f(end)}`;
  }

  function run() {
    const d = data();
    if (!d.planning || !window.SimEngine) return;
    state.parts = new Map(d.planning.parts.map((p) => [p.part_no, p]));
    state.result = window.SimEngine.simulate(d, state.options);
    renderKpis();
    renderChart();
    renderTable();
    select(state.selected, true);
  }

  // ------------------------------------------------------------------ 3D projection
  function positionStates(wi, facilityKey) {
    const r = state.result;
    const snap = r.snapshots[wi];
    const weekStart = r.weeks[wi].startDay;
    const map = new Map();
    r.positions.forEach((pos, i) => {
      if (pos.virtual || pos.facility !== facilityKey) return;
      const pid = snap[i];
      if (pid < 0) return;
      const pl = r.pallets[pid];
      const status = !pl.sim ? "fixed" : pl.initial ? "kept" : pl.arrival >= weekStart ? "week" : "arrived";
      map.set(pos.key, { status, part: pl.part });
    });
    return map;
  }

  function applyToViewer() {
    if (!window.DemoViewer || !state.result) return;
    const app = window.DemoApp && window.DemoApp.getState();
    if (state.selected < 0 || !app) {
      window.DemoViewer.setForecastState(null);
    } else {
      window.DemoViewer.setForecastState(positionStates(state.selected, app.facilityKey));
    }
    if (window.DemoApp && window.DemoApp.renderLegend) window.DemoApp.renderLegend();
  }

  // ------------------------------------------------------------------ KPIs
  function renderKpis() {
    const r = state.result;
    const s = r.summary;
    const worst = r.weeks.find((w) => w.label === s.worstWeek);
    const maxOverflow = Math.max(0, ...r.weeks.map((w) => w.overflowMax));
    $("sim-kpi-now").textContent = pct(r.start.pct);
    $("sim-kpi-now-sub").textContent = `${fmt(r.start.pallets)} / ${fmt(r.capacity)} pallet positions`;
    $("sim-kpi-worst").textContent = worst ? pct(worst.peakPct) : "--";
    $("sim-kpi-worst-sub").textContent = worst ? `${worst.label} mid-week peak (${DAY_NAMES[worst.peakDay] || "start"})` : "";
    $("sim-kpi-first").textContent = s.firstWatchWeek || "None";
    $("sim-kpi-first-sub").textContent = s.firstCriticalWeek ? `critical from ${s.firstCriticalWeek}` : "no critical week";
    $("sim-kpi-overflow").textContent = fmt(maxOverflow);
    $("sim-kpi-overflow-sub").textContent = maxOverflow > 0 ? "pallets without a position" : "every pallet fits";
  }

  // ------------------------------------------------------------------ chart
  function renderChart() {
    const host = $("sim-chart");
    const r = state.result;
    host.innerHTML = "";
    const W = Math.max(480, host.clientWidth);
    const H = Math.max(150, host.clientHeight);
    const compact = H < 175; // short dock: keep only the week label under each column
    const pad = { l: 40, r: 10, t: 26, b: compact ? 18 : 42 };
    const cols = r.weeks.length + 1; // "Now" + weeks
    const band = (W - pad.l - pad.r) / cols;
    // bars start at zero; the top is 100% unless a week overflows the racks
    const maxPct = Math.max(100, ...r.weeks.map((w) => w.peakPct));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / maxPct);
    const barW = Math.min(24, band * 0.42);

    const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "Weekly warehouse occupancy: week-end bars and mid-week peak ticks" });

    // grid, thresholds and y-axis labels (the legend explains the threshold colours)
    const opt = r.options;
    const ticks = [
      { v: 0, cls: "sim-grid" },
      { v: 50, cls: "sim-grid" },
      { v: opt.warnPct, cls: "sim-th-warn" },
      { v: opt.critPct, cls: "sim-th-crit" },
      { v: 100, cls: "sim-th-cap" },
    ];
    ticks.forEach((t) => {
      svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y(t.v), y2: y(t.v), class: t.cls }));
    });
    // label from the bottom up; skip a label that would collide with the one below it (100% always wins)
    let last = null;
    ticks.forEach((t) => {
      const ty = y(t.v);
      if (last && last.y - ty < 11) {
        if (t.v !== 100) return;
        last.node.remove();
      }
      const node = el("text", { x: pad.l - 6, y: ty + 3, class: "sim-axis", "text-anchor": "end" }, `${t.v}%`);
      svg.appendChild(node);
      last = { y: ty, node };
    });

    const columns = [{ now: true, label: "Now", endPct: r.start.pct, peakPct: r.start.pct }].concat(r.weeks);
    // the worst week (highest mid-week peak) gets the only direct value label
    const worstIndex = r.weeks.reduce((a, b) => (b.peakPct > a.peakPct ? b : a), r.weeks[0]).index;
    columns.forEach((c, ci) => {
      const x = pad.l + band * ci + band / 2;
      const wi = c.now ? -1 : c.index;
      const spoken = c.now
        ? `Now: ${pct(c.endPct)} occupied`
        : `${c.label}: week end ${pct(c.endPct)}, mid-week peak ${pct(c.peakPct)}` +
          `${STATUS[c.risk] ? `, ${STATUS[c.risk].label}` : ""}, ${c.inboundPallets} pallets in, ${c.freedPallets} freed`;
      const g = el("g", { class: `sim-col${state.selected === wi ? " selected" : ""}`, tabindex: 0, "data-week": wi,
        role: "button", "aria-label": spoken });
      g.appendChild(el("rect", { x: x - band / 2 + 1, y: pad.t - 14, width: band - 2, height: H - pad.t - pad.b + 14,
        class: "sim-hit", rx: 6 }));
      const top = y(c.endPct);
      const base = y(0);
      const h = Math.max(1, base - top);
      const rr = Math.min(4, h);
      const d = `M${x - barW / 2},${base} L${x - barW / 2},${top + rr} Q${x - barW / 2},${top} ${x - barW / 2 + rr},${top}`
        + ` L${x + barW / 2 - rr},${top} Q${x + barW / 2},${top} ${x + barW / 2},${top + rr} L${x + barW / 2},${base} Z`;
      g.appendChild(el("path", { d, class: c.now ? "sim-bar now" : "sim-bar" }));
      if (!c.now && c.peakPct > c.endPct + 0.05) {
        g.appendChild(el("line", { x1: x - barW / 2 - 6, x2: x + barW / 2 + 6, y1: y(c.peakPct), y2: y(c.peakPct), class: "sim-peak" }));
      }
      const isWorst = !c.now && c.index === worstIndex;
      if (!c.now && (STATUS[c.risk] || isWorst)) {
        const st = STATUS[c.risk];
        const t = el("text", { x, y: Math.min(y(c.peakPct), top) - 7, class: "sim-risk", "text-anchor": "middle" });
        if (st) {
          const icon = el("tspan", { fill: st.color }, st.icon);
          t.appendChild(icon);
        }
        if (isWorst) {
          t.appendChild(el("tspan", { class: "sim-direct", dx: st ? 3 : 0 }, pct(c.peakPct)));
        }
        g.appendChild(t);
      }
      g.appendChild(el("text", { x, y: H - pad.b + 13, class: "sim-xlab", "text-anchor": "middle" }, c.label));
      if (compact) {
        // the tooltip and the table carry the inbound / freed numbers
      } else if (c.now) {
        g.appendChild(el("text", { x, y: H - pad.b + 25, class: "sim-in", "text-anchor": "middle" }, "snapshot"));
      } else if (!c.inboundPallets && !c.freedPallets && !c.prodDays) {
        g.appendChild(el("text", { x, y: H - pad.b + 25, class: "sim-in", "text-anchor": "middle" }, "shutdown"));
      } else {
        g.appendChild(el("text", { x, y: H - pad.b + 25, class: "sim-in", "text-anchor": "middle" }, `+${fmt(c.inboundPallets)}`));
        g.appendChild(el("text", { x, y: H - pad.b + 37, class: "sim-out", "text-anchor": "middle" }, `−${fmt(c.freedPallets)}`));
      }
      g.addEventListener("click", () => select(wi));
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          select(wi);
        }
      });
      g.addEventListener("pointermove", (ev) => showTip(ev, c));
      g.addEventListener("focus", (ev) => showTip(ev, c));
      g.addEventListener("pointerleave", hideTip);
      g.addEventListener("blur", hideTip);
      svg.appendChild(g);
    });

    host.appendChild(svg);
  }

  function showTip(ev, c) {
    const tip = $("sim-tip");
    if (!tip) return;
    tip.innerHTML = "";
    const head = document.createElement("div");
    head.className = "sim-tip-head";
    head.textContent = c.now ? "Now (snapshot)" : `${c.label} · ${weekDates(data().planning.weeks[c.index])}`;
    tip.appendChild(head);
    const rows = c.now
      ? [["Occupied", `${pct(c.endPct)}`]]
      : [
          ["Week end", pct(c.endPct)],
          ["Mid-week peak", `${pct(c.peakPct)} (${DAY_NAMES[c.peakDay] || "start"})`],
          ["Inbound pallets", `+${fmt(c.inboundPallets)}`],
          ["Freed pallets", `−${fmt(c.freedPallets)}`],
        ];
    if (!c.now && c.overflowMax > 0) rows.push(["Overflow", `${fmt(c.overflowMax)} pallets`]);
    if (!c.now && STATUS[c.risk]) rows.push(["Status", `${STATUS[c.risk].icon} ${STATUS[c.risk].label}`]);
    rows.forEach(([k, v]) => {
      const row = document.createElement("div");
      row.className = "sim-tip-row";
      const s = document.createElement("span");
      s.textContent = k;
      const b = document.createElement("strong");
      b.textContent = v;
      row.append(s, b);
      tip.appendChild(row);
    });
    const rect = $("sim-chart").getBoundingClientRect();
    const x = (ev.clientX || rect.left + rect.width / 2) - rect.left;
    tip.style.left = `${Math.min(rect.width - 190, Math.max(0, x + 14))}px`;
    tip.classList.remove("hidden");
  }

  function hideTip() {
    const tip = $("sim-tip");
    if (tip) tip.classList.add("hidden");
  }

  // ------------------------------------------------------------------ table view
  function renderTable() {
    const host = $("sim-table");
    const r = state.result;
    host.innerHTML = "";
    const table = document.createElement("table");
    const head = document.createElement("tr");
    ["Week", "Dates", "Start", "End", "Mid-week peak", "Inbound", "Freed", "Overflow", "Short parts", "Status"].forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    });
    table.appendChild(head);
    r.weeks.forEach((w) => {
      const tr = document.createElement("tr");
      const st = STATUS[w.risk];
      [
        w.label,
        weekDates(data().planning.weeks[w.index]),
        pct(w.startPct),
        pct(w.endPct),
        `${pct(w.peakPct)} ${DAY_NAMES[w.peakDay] || ""}`,
        `+${fmt(w.inboundPallets)}`,
        `−${fmt(w.freedPallets)}`,
        fmt(w.overflowMax),
        String(w.shortages.length),
        st ? st.label : "OK",
      ].forEach((v, k, arr) => {
        const td = document.createElement("td");
        if (k === arr.length - 1 && st) {
          const icon = document.createElement("b");
          icon.className = w.risk === "watch" ? "st-watch" : "st-crit";
          icon.textContent = `${st.icon} `;
          td.append(icon, document.createTextNode(v));
        } else {
          td.textContent = v;
        }
        tr.appendChild(td);
      });
      tr.addEventListener("click", () => select(w.index));
      table.appendChild(tr);
    });
    host.appendChild(table);
    host.classList.toggle("hidden", !state.table);
    $("sim-chart").classList.toggle("hidden", state.table);
  }

  // ------------------------------------------------------------------ detail panel
  function partLabel(partNo) {
    const p = state.parts.get(partNo);
    return p ? `${partNo} ${p.description}` : partNo;
  }

  function renderDetail() {
    const host = $("sim-detail");
    const r = state.result;
    host.innerHTML = "";
    const title = document.createElement("div");
    title.className = "sim-detail-title";
    const body = document.createElement("div");
    body.className = "sim-detail-body";
    const addRow = (k, v) => {
      const row = document.createElement("div");
      row.className = "sim-detail-row";
      const a = document.createElement("span");
      a.textContent = k;
      const b = document.createElement("strong");
      b.textContent = v;
      row.append(a, b);
      body.appendChild(row);
    };
    if (state.selected < 0) {
      title.textContent = "Now · snapshot";
      addRow("Occupied", `${fmt(r.start.pallets)} / ${fmt(r.capacity)} (${pct(r.start.pct)})`);
      addRow("Free positions", fmt(r.capacity - r.start.pallets));
      const note = document.createElement("p");
      note.className = "sim-note";
      note.textContent = "Inbound = OMS weekly quantity ÷ pallet qty (rounded up). Outbound = customer forecast through the BOM, first-in first-out — a position frees only when its pallet is empty. Click a week to see it in 3D.";
      body.appendChild(note);
    } else {
      const w = r.weeks[state.selected];
      const st = STATUS[w.risk];
      title.textContent = `${w.label} · ${weekDates(data().planning.weeks[w.index])}`;
      if (st) {
        const chip = document.createElement("span");
        chip.className = `sim-chip ${w.risk}`;
        chip.textContent = `${st.icon} ${st.label}`;
        title.appendChild(chip);
      }
      addRow("Start → end", `${pct(w.startPct)} → ${pct(w.endPct)}`);
      addRow("Mid-week peak", `${fmt(w.peakPallets)} pallets · ${pct(w.peakPct)} (${DAY_NAMES[w.peakDay] || "start"})`);
      addRow("Inbound / freed", `+${fmt(w.inboundPallets)} / −${fmt(w.freedPallets)} pallets`);
      addRow("Production days", w.prodDays ? String(w.prodDays) : "shutdown");
      if (w.overflowMax > 0) addRow("Overflow", `${fmt(w.overflowMax)} pallets without a position`);
      if (w.shortages.length) addRow("Would run short", `${w.shortages.length} part${w.shortages.length > 1 ? "s" : ""}`);
      if (w.topGrowth.length) {
        const h = document.createElement("div");
        h.className = "sim-detail-sub";
        h.textContent = "Fastest growing parts this week";
        body.appendChild(h);
        w.topGrowth.slice(0, 3).forEach((g) => {
          const row = document.createElement("div");
          row.className = "sim-part-row";
          const a = document.createElement("span");
          a.textContent = partLabel(g.part);
          const b = document.createElement("strong");
          b.textContent = `+${g.delta} plt`;
          row.append(a, b);
          body.appendChild(row);
        });
      }
    }
    host.append(title, body);
  }

  // ------------------------------------------------------------------ selection / play
  function select(wi, silent) {
    state.selected = wi;
    document.querySelectorAll("#sim-chart .sim-col").forEach((g) => {
      g.classList.toggle("selected", Number(g.getAttribute("data-week")) === wi);
    });
    renderDetail();
    applyToViewer();
    if (!silent && window.DemoApp && window.DemoApp.onWeekSelected) window.DemoApp.onWeekSelected(wi);
  }

  function stopPlay() {
    state.playing = false;
    clearTimeout(state.timer);
    state.timer = null;
    $("sim-play").innerHTML = '<i class="fa-solid fa-play"></i> Play';
  }

  function togglePlay() {
    if (state.playing) {
      stopPlay();
      return;
    }
    state.playing = true;
    $("sim-play").innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
    let wi = state.selected < 0 || state.selected >= state.result.weeks.length - 1 ? 0 : state.selected + 1;
    // one week per step; the next step is scheduled after the 3D view has been repainted, so slow
    // machines never skip weeks
    const step = () => {
      if (!state.playing) return;
      select(wi);
      wi += 1;
      state.timer = wi < state.result.weeks.length ? setTimeout(step, 1100) : setTimeout(stopPlay, 1100);
    };
    step();
  }

  // ------------------------------------------------------------------ wiring
  function bind() {
    const fc = $("sim-forecast");
    fc.addEventListener("input", () => {
      $("sim-forecast-val").textContent = `${fc.value}%`;
    });
    fc.addEventListener("change", () => {
      $("sim-forecast-val").textContent = `${fc.value}%`;
      state.options.forecastMultiplier = Number(fc.value) / 100;
      run();
    });
    $("sim-shift").addEventListener("change", (ev) => {
      state.options.inboundShiftWeeks = Number(ev.target.value);
      run();
    });
    $("sim-timing").addEventListener("change", (ev) => {
      state.options.inboundTiming = ev.target.value;
      run();
    });
    $("sim-prod").addEventListener("change", (ev) => {
      state.options.prodDaysPerWeek = ev.target.value === "6" ? 6 : null;
      run();
    });
    $("sim-extra").addEventListener("change", (ev) => {
      state.options.extraPositions = Number(ev.target.value);
      run();
    });
    $("sim-play").addEventListener("click", togglePlay);
    $("sim-table-btn").addEventListener("click", () => {
      state.table = !state.table;
      $("sim-table-btn").classList.toggle("active", state.table);
      renderTable();
      if (!state.table) renderChart();
    });
    $("sim-collapse").addEventListener("click", () => {
      $("sim-dock").classList.toggle("collapsed");
      setTimeout(() => {
        if (!$("sim-dock").classList.contains("collapsed")) renderChart();
      }, 260);
    });
    // redraw when the chart area changes size (window resize, fonts loading, controls wrapping, collapse)
    let resizeTimer = null;
    let lastSize = "";
    const redraw = () => {
      const host = $("sim-chart");
      const size = `${host.clientWidth}x${host.clientHeight}`;
      if (size === lastSize || !state.result || state.table || host.clientHeight < 40) return;
      lastSize = size;
      renderChart();
    };
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(redraw, 120);
      }).observe($("sim-chart"));
    } else {
      window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(redraw, 150);
      });
    }
  }

  window.DemoCapacity = {
    /** Legend spec while a week is projected in 3D, else null (the app shows its own heatmap legend). */
    legendSpec() {
      if (!state.result || state.selected < 0) return null;
      const w = state.result.weeks[state.selected];
      return {
        title: `${w.label} projection (end of week)`,
        rows: [
          { color: "#3987e5", label: "In stock at the snapshot" },
          { color: "#199e70", label: "Received in an earlier week" },
          { color: "#8af5d0", label: `Received in ${w.label}` },
          { color: "#64748b", label: "Sub-assembly / finished goods (held)" },
        ],
      };
    },
    weekLabel() {
      return state.result && state.selected >= 0 ? state.result.weeks[state.selected].label : "now";
    },
    showNow() {
      stopPlay();
      select(-1, true);
    },
    refreshView: applyToViewer,
    getResult: () => state.result,
    run,
  };

  window.addEventListener("DOMContentLoaded", () => {
    if (!$("sim-dock")) return;
    bind();
    if (window.DemoViewer && window.DemoViewer.setTooltipFormatter) {
      window.DemoViewer.setTooltipFormatter(() => window.DemoCapacity.weekLabel());
    }
    // the app loads the first facility on DOMContentLoaded too; run after it
    setTimeout(run, 0);
  });
})();
