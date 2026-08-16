// Inherit the cache-busting token this module was loaded with, so stats.js
// never resolves to a stale copy while app.js is fresh.
const S = await import(`./stats.js${new URL(import.meta.url).search}`);

/* ── tokens ──────────────────────────────────────────────────── */

const css = (n) => getComputedStyle(document.documentElement)
  .getPropertyValue(n).trim();

function tokens() {
  return {
    s1: css("--series-1"), s2: css("--series-2"), s3: css("--series-3"),
    pos: css("--pos"), neg: css("--neg"), mid: css("--mid"),
    text: css("--text-primary"), sec: css("--text-secondary"),
    muted: css("--text-muted"), grid: css("--grid"), axis: css("--axis"),
    surface: css("--surface-1"), band1: css("--band-1"), band2: css("--band-2"),
  };
}

/* ── formatting ──────────────────────────────────────────────── */

const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(d));
const pct = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(d)}%`);
const signed = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
const bps = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`);
// Direction classes for rate-move columns. A rising USD/TRY is the lira getting
// weaker, so positive reads red — matching the charts and the header, not the
// generic "green means up" convention.
const cls = (v) => (v > 0 ? "weaker" : v < 0 ? "stronger" : "dim");
const shortDate = (iso) => iso.slice(2).replace(/-/g, "‑");

/* ── state ───────────────────────────────────────────────────── */

const charts = new Map();
let DATA = null;
const state = { preset: "1y", from: null, to: null };

// History begins July 2023, so "All" is already "since the policy turn" — a
// separate preset for that would select the same range.
const PRESETS = [
  { id: "3m", label: "3M", days: 92 },
  { id: "6m", label: "6M", days: 183 },
  { id: "ytd", label: "YTD" },
  { id: "1y", label: "1Y", days: 365 },
  { id: "2y", label: "2Y", days: 730 },
  { id: "all", label: "All" },
];

/* ── boot ────────────────────────────────────────────────────── */

init();

async function init() {
  try {
    const res = await fetch(`data.json?v=${Date.now()}`);
    if (!res.ok) throw new Error(`data.json → HTTP ${res.status}`);
    DATA = await res.json();
  } catch (e) {
    document.querySelector("main").innerHTML =
      `<div class="error"><strong>Could not load data.json.</strong><br>${e.message}
       <br><br>Run <code>python3 fetch_data.py</code>, then serve the folder
       (<code>./serve.sh</code>) — opening index.html directly from disk will not work.</div>`;
    return;
  }

  buildPresets();
  wireToggles();
  wireTheme();

  // Keep the custom pickers inside the range that actually has data.
  for (const id of ["fromDate", "toDate"]) {
    const el = document.getElementById(id);
    el.min = DATA.dates[0];
    el.max = DATA.dates.at(-1);
  }

  document.getElementById("fromDate").addEventListener("change", onCustom);
  document.getElementById("toDate").addEventListener("change", onCustom);
  document.getElementById("weeklyAll").addEventListener("change", render);
  window.addEventListener("resize", () => charts.forEach((c) => c.resize()));

  applyPreset("1y");
}

function buildPresets() {
  const host = document.getElementById("presets");
  host.innerHTML = "";
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.dataset.id = p.id;
    b.setAttribute("aria-pressed", String(p.id === state.preset));
    b.addEventListener("click", () => applyPreset(p.id));
    host.appendChild(b);
  }
}

function applyPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  const dates = DATA.dates;
  const end = dates[dates.length - 1];
  let from = dates[0];

  if (p.days) {
    const d = new Date(end + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - p.days);
    from = d.toISOString().slice(0, 10);
  } else if (p.id === "ytd") {
    from = `${end.slice(0, 4)}-01-01`;
  } else if (p.from) {
    from = p.from;
  }

  state.preset = id;
  state.from = from;
  state.to = end;
  document.getElementById("fromDate").value = from;
  document.getElementById("toDate").value = end;
  document.querySelectorAll("#presets button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.id === id)));
  render();
}

function onCustom() {
  state.from = document.getElementById("fromDate").value || DATA.dates[0];
  state.to = document.getElementById("toDate").value || DATA.dates.at(-1);
  state.preset = null;
  document.querySelectorAll("#presets button")
    .forEach((b) => b.setAttribute("aria-pressed", "false"));
  render();
}

function wireTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = saved || (prefersDark ? "dark" : "light");
  document.getElementById("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    charts.forEach((c) => c.dispose());
    charts.clear();
    render();
  });
}

function wireToggles() {
  document.querySelectorAll(".btn-toggle").forEach((btn) => {
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      const id = btn.dataset.view;
      const on = btn.getAttribute("aria-pressed") === "true";
      btn.setAttribute("aria-pressed", String(!on));
      btn.textContent = on ? "Table" : "Chart";
      document.getElementById(id).hidden = !on;
      document.getElementById(`${id}-table`).hidden = on;
      if (on === false && charts.has(id)) charts.get(id).resize();
    });
  });
}

/* ── chart helpers ───────────────────────────────────────────── */

function draw(id, option) {
  const el = document.getElementById(id);
  if (!el) return;
  let c = charts.get(id);
  if (!c) {
    c = echarts.init(el, null, { renderer: "canvas" });
    charts.set(id, c);
  }
  c.setOption(option, true);
}

const baseGrid = { left: 58, right: 22, top: 26, bottom: 46, containLabel: true };

function axisCommon(t) {
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
  };
}

function tooltipBox(t) {
  return {
    backgroundColor: t.surface,
    borderColor: t.axis,
    borderWidth: 1,
    textStyle: { color: t.text, fontSize: 12 },
    extraCssText: "box-shadow:0 4px 14px rgba(0,0,0,.10);border-radius:8px;",
  };
}

/** A filled band, as an invisible baseline plus a stacked delta on top of it.
 *  Returns two series; only the second carries `name`, so the legend shows one
 *  entry. Both axes must be linear — on the path chart the data is log10, which
 *  keeps the stack arithmetic valid. */
function bandSeries(name, upper, lower, color, z = 1) {
  const base = {
    name: `_${name}_base`, type: "line", stack: name, z,
    data: lower, showSymbol: false, silent: true,
    lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 },
    emphasis: { disabled: true },
  };
  const fill = {
    name, type: "line", stack: name, z,
    data: upper.map((v, i) => v - lower[i]),
    showSymbol: false, silent: true,
    lineStyle: { opacity: 0 },
    areaStyle: { color },
    itemStyle: { color },          // keeps the legend swatch matching the fill
    emphasis: { disabled: true },
  };
  return [base, fill];
}

/* ── table helpers ───────────────────────────────────────────── */

function table(headers, rows) {
  const th = headers.map((h) => `<th>${h}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c) =>
    typeof c === "object" && c !== null
      ? `<td class="${c.cls || ""}">${c.v}</td>`
      : `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

const setTable = (id, html) => { document.getElementById(id).innerHTML = html; };

/* ── main render ─────────────────────────────────────────────── */

function render() {
  const t = tokens();
  const all = DATA.dates;
  const i0 = all.findIndex((d) => d >= state.from);
  let i1 = all.length - 1;
  while (i1 > 0 && all[i1] > state.to) i1--;

  if (i0 < 0 || i1 - i0 < 20) {
    document.getElementById("rangeNote").textContent =
      "Range too short — need at least 20 sessions.";
    return;
  }

  const dates = all.slice(i0, i1 + 1);
  const close = DATA.close.slice(i0, i1 + 1);
  const logY = close.map(Math.log);
  const ret = logY.slice(1).map((v, i) => v - logY[i]);

  const fit = S.pathFit(dates, close);
  const stats = S.describe(ret);

  document.getElementById("rangeNote").textContent =
    `${dates.length} sessions · ${dates[0]} → ${dates.at(-1)}`;

  // Each panel is isolated: a failure in one leaves the rest of the page usable
  // instead of blanking everything below it.
  const safe = (label, fn) => {
    try { fn(); } catch (e) { console.error(`[${label}] ${e.message}`, e); }
  };

  safe("header", () => renderHeader());
  safe("tiles", () => renderTiles(fit, stats));
  safe("path", () => renderPath(t, dates, close, fit));
  safe("deviation", () => renderDeviation(t, dates, fit));
  safe("pace", () => renderPace(t, dates, logY, fit));
  const segs = S.regimes(dates, logY);
  const weekClass = S.classifyWeeks(dates, close, fit, segs);
  safe("regimes", () => renderRegimes(segs, close));
  safe("week-regimes", () => renderWeekRegimes(t, weekClass));
  safe("weekday-by-regime", () => renderWeekdayByRegime(t, dates, ret, weekClass));
  safe("weekday-by-segment", () => renderWeekdayBySegment(t, dates, ret, segs, weekClass));
  safe("weekday", () => renderWeekday(t, dates, ret));
  safe("intraweek", () => renderIntraWeek(t, dates, ret));
  safe("heatmap", () => renderHeatmap(t, dates, ret));
  safe("weekly", () => renderWeekly(dates, close));
  safe("vol", () => renderVol(t, dates, ret));
  safe("hist", () => renderHist(t, ret, stats));
  safe("reversion", () => renderReversion(t, fit, ret));
  safe("projection", () => renderProjection(fit, dates));
  safe("monthly", () => renderMonthly(t));
  safe("provenance", () => renderProvenance());
}

/* ── header & tiles ──────────────────────────────────────────── */

function renderHeader() {
  const c = DATA.close, d = DATA.dates;
  const last = c.at(-1), prev = c.at(-2);
  const chg = (last / prev - 1) * 100;
  document.getElementById("spotValue").textContent = last.toFixed(4);
  const el = document.getElementById("spotChange");
  el.textContent = `${signed(chg, 2)}% d/d`;
  el.className = chg >= 0 ? "neg" : "pos";
  document.getElementById("spotDate").textContent = d.at(-1);
}

function tile(label, value, unit, note, klass = "") {
  return `<div class="tile"><span class="tile-label">${label}</span>
    <span class="tile-value ${klass}">${value}${unit ? `<span class="tile-unit">${unit}</span>` : ""}</span>
    <span class="tile-note">${note}</span></div>`;
}

function renderTiles(fit, stats) {
  const z = fit.lastZ;
  const where = Math.abs(z) < 0.5 ? "sitting on the path"
    : z > 0 ? "above the path (lira weaker)" : "below the path (lira stronger)";

  document.getElementById("tiles").innerHTML = [
    tile("Crawl pace, annualised", fmt(fit.pace, 2), "%",
      `95% CI ${fmt(fit.paceLo, 2)} – ${fmt(fit.paceHi, 2)}%`),
    tile("Implied per week", fmt(fit.weeklyPace, 3), "%",
      `${fmt(fit.monthlyPace, 2)}% per month`),
    tile("Deviation from path", signed(fit.lastResid, 2), "%",
      `${signed(z, 2)}σ — ${where}`),
    tile("Corridor width ±2σ", `±${fmt(fit.residSd * 2, 2)}`, "%",
      `residual σ = ${fmt(fit.residSd, 2)}%`),
    tile("Fit quality R²", fmt(fit.r2, 4), "",
      `${fit.n} sessions in window`),
    tile("Realised vol, annualised", fmt(stats.annVol, 2), "%",
      `mean ${bps(stats.meanBps, 1)} bp per session`),
    tile("Sessions lira gained", fmt(stats.shareDown, 1), "%",
      `${Math.round(stats.shareDown / 100 * stats.n)} of ${stats.n} sessions down`),
    tile("Largest single move", bps(stats.maxUp, 0), "bp",
      `biggest drop ${bps(stats.maxDown, 0)} bp`),
  ].join("");
}

/* ── 1. the path ─────────────────────────────────────────────── */

function renderPath(t, dates, close, fit) {
  const k1 = Math.exp(fit.residSd / 100), k2 = Math.exp(2 * fit.residSd / 100);
  // Plotted in log10 so a constant-% crawl is a straight line. The axis stays
  // linear (ECharts' log axis produces almost no ticks over a narrow range) and
  // the labels are converted back to price.
  const L = Math.log10;
  const px = close.map(L);
  const path = fit.fitted.map(L);
  const up1 = fit.fitted.map((v) => L(v * k1)), lo1 = fit.fitted.map((v) => L(v / k1));
  const up2 = fit.fitted.map((v) => L(v * k2)), lo2 = fit.fitted.map((v) => L(v / k2));

  draw("pathChart", {
    grid: { ...baseGrid, right: 52 },   // room for the end label
    backgroundColor: "transparent",
    legend: {
      data: ["USD/TRY", "Fitted path", "±1σ", "±2σ"],
      textStyle: { color: t.sec, fontSize: 12 },
      icon: "roundRect", itemWidth: 14, itemHeight: 3, right: 10, top: 0,
    },
    tooltip: {
      trigger: "axis", ...tooltipBox(t),
      axisPointer: { type: "line", lineStyle: { color: t.axis, width: 1 } },
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        return `<strong>${dates[i]}</strong><br>
          Rate <b>${close[i].toFixed(4)}</b><br>
          Path <b>${fit.fitted[i].toFixed(4)}</b><br>
          Deviation <b>${signed(fit.resid[i], 2)}%</b> (${signed(fit.resid[i] / fit.residSd, 2)}σ)`;
      },
    },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      ...axisCommon(t), splitLine: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value", ...axisCommon(t),
      min: Math.min(...lo2, ...px) - 0.002,
      max: Math.max(...up2, ...px) + 0.002,
      splitNumber: 5,
      axisLabel: {
        color: t.muted, fontSize: 11,
        formatter: (v) => Math.pow(10, v).toFixed(2),
      },
    },
    series: [
      ...bandSeries("±2σ", up2, lo2, t.band2, 1),
      ...bandSeries("±1σ", up1, lo1, t.band1, 2),
      {
        name: "Fitted path", type: "line", data: path, z: 3,
        showSymbol: false, lineStyle: { color: t.s2, width: 2 }, color: t.s2,
      },
      {
        name: "USD/TRY", type: "line", data: px, z: 4,
        showSymbol: false, lineStyle: { color: t.s1, width: 2 }, color: t.s1,
        endLabel: {
          show: true, color: t.s1, fontSize: 11, fontWeight: 600,
          formatter: (p) => Math.pow(10, p.value).toFixed(2),
        },
      },
    ],
  });

  const touch = fit.daysSinceBandTouch === 0
    ? "the rate is outside ±1σ right now"
    : `the rate last sat outside ±1σ ${fit.daysSinceBandTouch} sessions ago`;
  document.getElementById("pathNote").innerHTML =
    `Over this window the crawl runs at <strong>${fmt(fit.pace, 2)}% annualised</strong>
     (${fmt(fit.weeklyPace, 3)}% per week) with R² of ${fmt(fit.r2, 4)}. Residual σ is
     <strong>${fmt(fit.residSd, 2)}%</strong>, so the ±2σ corridor is just
     ${fmt(fit.residSd * 4, 2)}% wide. Today sits ${signed(fit.lastResid, 2)}%
     from the line (${signed(fit.lastZ, 2)}σ); ${touch}.`;

  const step = Math.max(1, Math.floor(dates.length / 120));
  setTable("pathChart-table", table(
    ["Date", "Rate", "Path", "Deviation %", "z"],
    dates.filter((_, i) => i % step === 0 || i === dates.length - 1).map((d) => {
      const i = dates.indexOf(d);
      return [d, close[i].toFixed(4), fit.fitted[i].toFixed(4),
        { v: signed(fit.resid[i], 2), cls: cls(fit.resid[i]) },
        signed(fit.resid[i] / fit.residSd, 2)];
    })));
}

/* ── 2. deviation ────────────────────────────────────────────── */

function renderDeviation(t, dates, fit) {
  const s = fit.residSd;
  const devMax = Math.max(...fit.resid.map(Math.abs));
  draw("devChart", {
    grid: { ...baseGrid, top: 18 },
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis", ...tooltipBox(t),
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        return `<strong>${dates[i]}</strong><br>Deviation <b>${signed(fit.resid[i], 2)}%</b>
                (${signed(fit.resid[i] / s, 2)}σ)`;
      },
    },
    // Diverging around the path: two opposed hues with a neutral gray midpoint.
    // (A piecewise map silently drops the line here; continuous is the reliable
    // form for colouring a line by value.)
    visualMap: {
      show: false, type: "continuous", dimension: 1, seriesIndex: 0,
      min: -devMax, max: devMax,
      inRange: { color: [t.pos, t.muted, t.neg] },
    },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      ...axisCommon(t), splitLine: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value", ...axisCommon(t),
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v) => `${v.toFixed(1)}%` },
    },
    series: [{
      type: "line", data: fit.resid, showSymbol: false,
      lineStyle: { width: 2 },
      markLine: {
        symbol: "none", silent: true,
        label: { color: t.muted, fontSize: 10, formatter: (p) => p.name },
        lineStyle: { color: t.axis, width: 1, type: "dashed" },
        data: [
          { yAxis: 0, name: "path", lineStyle: { color: t.axis, type: "solid" } },
          { yAxis: s, name: "+1σ" }, { yAxis: -s, name: "−1σ" },
          { yAxis: 2 * s, name: "+2σ" }, { yAxis: -2 * s, name: "−2σ" },
        ],
      },
    }],
  });

  const out1 = fit.resid.filter((r) => Math.abs(r) > s).length;
  const out2 = fit.resid.filter((r) => Math.abs(r) > 2 * s).length;
  setTable("devChart-table", table(
    ["Measure", "Value"],
    [
      ["Residual σ", `${fmt(s, 3)}%`],
      ["Sessions beyond ±1σ", `${out1} (${fmt(out1 / fit.n * 100, 1)}%)`],
      ["Sessions beyond ±2σ", `${out2} (${fmt(out2 / fit.n * 100, 1)}%)`],
      ["Widest gap above path", `${fmt(Math.max(...fit.resid), 2)}%`],
      ["Widest gap below path", `${fmt(Math.min(...fit.resid), 2)}%`],
      ["Current deviation", `${signed(fit.lastResid, 2)}% (${signed(fit.lastZ, 2)}σ)`],
    ]));
}

/* ── 3. rolling pace ─────────────────────────────────────────── */

function renderPace(t, dates, logY, fit) {
  const p20 = S.rollingPace(logY, 20);
  const p60 = S.rollingPace(logY, 60);

  draw("paceChart", {
    grid: { ...baseGrid, top: 26 },
    backgroundColor: "transparent",
    legend: {
      data: ["20-session pace", "60-session pace"],
      textStyle: { color: t.sec, fontSize: 12 },
      icon: "roundRect", itemWidth: 14, itemHeight: 3, right: 10, top: 0,
    },
    tooltip: {
      trigger: "axis", ...tooltipBox(t),
      valueFormatter: (v) => (v == null ? "—" : `${v.toFixed(2)}%`),
    },
    xAxis: {
      type: "category", data: dates, boundaryGap: false,
      ...axisCommon(t), splitLine: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value", scale: true, ...axisCommon(t),
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v) => `${v.toFixed(0)}%` },
    },
    series: [
      {
        name: "20-session pace", type: "line", data: p20, showSymbol: false,
        lineStyle: { color: t.s1, width: 2 }, color: t.s1, connectNulls: false,
      },
      {
        name: "60-session pace", type: "line", data: p60, showSymbol: false,
        lineStyle: { color: t.s2, width: 2 }, color: t.s2, connectNulls: false,
        markLine: {
          symbol: "none", silent: true,
          label: { color: t.muted, fontSize: 10, position: "insideStartTop",
            formatter: `window ${fmt(fit.pace, 1)}%` },
          lineStyle: { color: t.axis, width: 1, type: "dashed" },
          data: [{ yAxis: fit.pace }],
        },
      },
    ],
  });

  const valid = p20.filter((v) => v != null);
  const v60 = p60.filter((v) => v != null);
  setTable("paceChart-table", table(
    ["Measure", "20-session", "60-session"],
    [
      ["Latest", `${fmt(valid.at(-1), 2)}%`, `${fmt(v60.at(-1), 2)}%`],
      ["Mean", `${fmt(S.mean(valid), 2)}%`, `${fmt(S.mean(v60), 2)}%`],
      ["Std deviation", `${fmt(S.sd(valid), 2)}pp`, `${fmt(S.sd(v60), 2)}pp`],
      ["Min", `${fmt(Math.min(...valid), 2)}%`, `${fmt(Math.min(...v60), 2)}%`],
      ["Max", `${fmt(Math.max(...valid), 2)}%`, `${fmt(Math.max(...v60), 2)}%`],
    ]));
}

/* ── 4. regimes ──────────────────────────────────────────────── */

function renderRegimes(regs, close) {
  const rows = regs.map((r, i) => {
    const prev = i > 0 ? regs[i - 1].pace : null;
    const d = prev == null ? null : r.pace - prev;
    return [
      `#${i + 1}`,
      `${r.start} → ${r.end}`,
      r.n,
      `${fmt(r.pace, 2)}%`,
      d == null ? "—" : { v: `${signed(d, 2)}pp`, cls: cls(d) },
      fmt(r.r2, 4),
      `${fmt(r.residSd, 2)}%`,
      `${close[r.startIdx].toFixed(3)} → ${close[r.endIdx].toFixed(3)}`,
    ];
  });
  setTable("regimeTable", regs.length < 2
    ? `<p class="card-sub">No breakpoint improves BIC over this window — a single
       straight line in logs describes the whole stretch, at
       ${fmt(regs[0]?.pace, 2)}% annualised.</p>`
    : table(["Segment", "Period", "Sessions", "Annualised pace", "Δ vs previous",
      "R²", "Residual σ", "Rate"], rows));
}

/* ── 5. weekday effect ───────────────────────────────────────── */

function renderWeekday(t, dates, ret) {
  const { rows, overallMean } = S.weekdayStats(dates, ret);
  const sig = rows.map((r) => r.p < 0.05);

  draw("dowChart", {
    grid: { ...baseGrid, top: 24, bottom: 34 },
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item", ...tooltipBox(t),
      formatter: (p) => {
        const r = rows[p.dataIndex];
        return `<strong>${r.name}</strong><br>
          Mean <b>${bps(r.mean, 1)} bp</b> · median ${bps(r.median, 1)} bp<br>
          vs all days ${bps(r.vsAll, 1)} bp<br>
          t = ${fmt(r.t, 2)}, p = ${fmt(r.p, 3)}<br>
          ${r.n} sessions · ${fmt(r.shareUp, 0)}% lira-negative`;
      },
    },
    xAxis: {
      type: "category", data: rows.map((r) => r.short), ...axisCommon(t),
      splitLine: { show: false },
      axisLabel: { color: t.sec, fontSize: 12 },
    },
    yAxis: {
      type: "value", ...axisCommon(t), name: "bp per session",
      nameTextStyle: { color: t.muted, fontSize: 11, align: "left" },
      nameLocation: "end", nameGap: 12,
      axisLabel: { color: t.muted, fontSize: 11 },
    },
    series: [
      {
        type: "bar", data: rows.map((r, i) => ({
          value: r.mean,
          itemStyle: {
            color: r.mean >= 0 ? t.neg : t.pos,
            borderRadius: r.mean >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4],
            opacity: sig[i] ? 1 : 0.55,
          },
        })),
        barMaxWidth: 46,
        label: {
          show: true, position: "top", color: t.sec, fontSize: 11,
          formatter: (p) => bps(p.value, 1) + (sig[p.dataIndex] ? "*" : ""),
        },
        // The all-day reference plus one ±1 SE whisker per bar. Drawn as
        // markLines rather than a custom series: custom series go through the
        // progressive render pipeline, where a stale task from an earlier pass
        // is replayed without a coord API and throws.
        markLine: {
          symbol: "none", silent: true,
          lineStyle: { color: t.axis, width: 1, type: "dashed" },
          data: [
            {
              yAxis: overallMean,
              label: { show: true, color: t.muted, fontSize: 10, formatter: "all-day mean" },
            },
            ...rows.map((r, i) => ([
              {
                coord: [i, r.mean - r.se], label: { show: false },
                lineStyle: { color: t.sec, width: 1, type: "solid" },
              },
              { coord: [i, r.mean + r.se], label: { show: false } },
            ])),
          ],
        },
      },
    ],
  });

  setTable("dowChart-table", table(
    ["Day", "Sessions", "Mean bp", "Median bp", "vs all days", "t", "p", "% lira-negative"],
    rows.map((r) => [r.name, r.n, bps(r.mean, 1), bps(r.median, 1),
      { v: bps(r.vsAll, 1), cls: cls(r.vsAll) }, fmt(r.t, 2),
      { v: fmt(r.p, 3), cls: r.p < 0.05 ? "pos" : "dim" }, fmt(r.shareUp, 0)])));
}

/* ── 6. intra-week drift ─────────────────────────────────────── */

function renderIntraWeek(t, dates, ret) {
  const rows = S.intraWeekPath(dates, ret);
  const up = rows.map((r) => r.mean + r.se);
  const lo = rows.map((r) => r.mean - r.se);

  draw("iwChart", {
    grid: { ...baseGrid, top: 24, bottom: 34 },
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis", ...tooltipBox(t),
      formatter: (ps) => {
        const r = rows[ps[0].dataIndex];
        return `<strong>${r.short}</strong><br>Cumulative <b>${bps(r.mean, 1)} bp</b>
                ± ${fmt(r.se, 1)} (n = ${r.n})`;
      },
    },
    xAxis: {
      type: "category", data: rows.map((r) => r.short), boundaryGap: false,
      ...axisCommon(t), splitLine: { show: false },
      axisLabel: { color: t.sec, fontSize: 12 },
    },
    yAxis: {
      type: "value", ...axisCommon(t), name: "cumulative bp",
      nameTextStyle: { color: t.muted, fontSize: 11, align: "left" },
      nameGap: 12,
      axisLabel: { color: t.muted, fontSize: 11 },
    },
    series: [
      ...bandSeries("±1 SE", up, lo, t.band1, 1),
      {
        type: "line", data: rows.map((r) => r.mean), z: 3,
        lineStyle: { color: t.s1, width: 2 }, color: t.s1,
        symbol: "circle", symbolSize: 8,
        itemStyle: { color: t.s1, borderColor: t.surface, borderWidth: 2 },
        label: {
          show: true, position: "top", color: t.sec, fontSize: 11,
          formatter: (p) => bps(p.value, 0),
        },
      },
    ],
  });

  setTable("iwChart-table", table(
    ["Day", "Weeks", "Mean cumulative bp", "±1 SE"],
    rows.map((r) => [r.short, r.n, bps(r.mean, 1), fmt(r.se, 1)])));
}

/* ── 7. heatmap ──────────────────────────────────────────────── */

function renderHeatmap(t, dates, ret) {
  const { weeks, cells } = S.weekdayHeatmap(dates, ret, 26);
  const lim = Math.max(...cells.map((c) => Math.abs(c.v)), 1);
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  draw("heatChart", {
    grid: { left: 90, right: 30, top: 16, bottom: 62 },
    backgroundColor: "transparent",
    tooltip: {
      ...tooltipBox(t),
      formatter: (p) => {
        const c = cells[p.dataIndex];
        return `<strong>${c.date}</strong> (${labels[c.x]})<br>
                Move <b>${bps(c.v, 1)} bp</b>`;
      },
    },
    xAxis: {
      type: "category", data: labels, position: "top",
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: t.sec, fontSize: 12 },
    },
    yAxis: {
      type: "category", data: weeks, inverse: true,
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v) => `w/c ${shortDate(v)}` },
    },
    visualMap: {
      min: -lim, max: lim, calculable: true, orient: "horizontal",
      left: "center", bottom: 8, itemWidth: 12, itemHeight: 140,
      text: [`+${lim.toFixed(0)} bp (lira weaker)`, `−${lim.toFixed(0)} bp (lira stronger)`],
      textStyle: { color: t.muted, fontSize: 11 },
      inRange: { color: [t.pos, t.mid, t.neg] },
    },
    series: [{
      type: "heatmap",
      data: cells.map((c) => [c.x, c.y, c.v]),
      itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
      progressive: 0,
    }],
  });

  const byWeek = new Map();
  for (const c of cells) {
    if (!byWeek.has(c.y)) byWeek.set(c.y, {});
    byWeek.get(c.y)[c.x] = c.v;
  }
  setTable("heatChart-table", table(
    ["Week of", ...labels],
    weeks.map((w, i) => [w, ...[0, 1, 2, 3, 4].map((d) => {
      const v = byWeek.get(i)?.[d];
      return v == null ? { v: "—", cls: "dim" } : { v: bps(v, 1), cls: cls(v) };
    })])));
}

/* ── 7b. week regimes ────────────────────────────────────────── */

const regimeColor = (rank) => css(`--regime-${rank}`);

function renderWeekRegimes(t, { rows, baseline, spread, counts, runs, dropped }) {
  if (!rows.length) return;
  WEEKLY_REGIMES = rows;   // reused by the week-by-week table below

  document.getElementById("regimeLegend").innerHTML = S.WEEK_REGIMES
    .map((w, i) => `<span class="regime-chip" title="${w.hint}">
        <span class="sw" style="background:${regimeColor(i)}"></span>
        <b>${w.label}</b><span class="cnt">${counts[w.key]}</span></span>`)
    .join("");

  draw("regimeChart", {
    grid: { ...baseGrid, top: 22, bottom: 60 },
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item", ...tooltipBox(t),
      formatter: (p) => {
        const r = rows[p.dataIndex];
        return `<strong>week of ${r.week}</strong> · ${r.regime.label}<br>
          Pace <b>${fmt(r.annPace, 1)}%</b> annualised
          (${signed(r.vsBaseline, 1)}pp vs baseline)<br>
          Change ${pct(r.changePct, 2)} · range ${fmt(r.rangePct, 2)}%<br>
          Moved ${signed(r.residDrift, 2)}% within the corridor
          ${r.stress ? "<br><b>High-range week</b>" : ""}`;
      },
    },
    xAxis: {
      type: "category", data: rows.map((r) => r.week), ...axisCommon(t),
      splitLine: { show: false },
      axisLabel: { color: t.muted, fontSize: 10, rotate: 55, hideOverlap: true },
    },
    yAxis: {
      type: "value", ...axisCommon(t), name: "% annualised pace",
      nameTextStyle: { color: t.muted, fontSize: 11, align: "left" }, nameGap: 12,
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v) => `${v.toFixed(0)}%` },
    },
    series: [{
      type: "bar", barMaxWidth: 26,
      data: rows.map((r) => ({
        value: r.annPace,
        itemStyle: {
          color: regimeColor(r.rank),
          borderRadius: r.annPace >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4],
          borderColor: t.surface, borderWidth: 1,
        },
      })),
      markLine: {
        symbol: "none", silent: true,
        lineStyle: { color: t.axis, width: 1, type: "dashed" },
        data: [
          { yAxis: baseline, label: { color: t.muted, fontSize: 10,
            position: "insideStartTop", formatter: `baseline ${fmt(baseline, 1)}%` } },
          { yAxis: baseline + 0.5 * spread, label: { show: false } },
          { yAxis: baseline - 0.5 * spread, label: { show: false } },
        ],
      },
    }],
  });

  const longest = runs.slice().sort((a, b) => b.n - a.n)[0];
  const recent = rows.slice(-4);
  document.getElementById("regimeNote").innerHTML =
    `Baseline crawl is <strong>${fmt(baseline, 2)}%</strong>; a week counts as
     on path within ±${fmt(0.5 * spread, 1)}pp of it. The last four weeks read
     <strong>${recent.map((r) => r.regime.label.toLowerCase()).join(" → ")}</strong>.
     Longest unbroken run: ${longest.n} ${longest.label.toLowerCase()} week${longest.n > 1 ? "s" : ""}
     (${longest.start}${longest.n > 1 ? ` → ${longest.end}` : ""}).
     ${dropped ? `${dropped} short week${dropped > 1 ? "s" : ""} of under three
       sessions excluded — annualising a two-day move is meaningless.` : ""}`;

  setTable("regimeChart-table", table(
    ["Week of", "Regime", "Pace", "vs baseline", "Change", "Corridor move",
      "Range", "High range", "Segment"],
    rows.slice().reverse().map((r) => [
      r.week,
      `<span class="regime-cell"><span class="sw" style="background:${regimeColor(r.rank)}"></span>${r.regime.label}</span>`,
      `${fmt(r.annPace, 1)}%`,
      { v: `${signed(r.vsBaseline, 1)}pp`, cls: cls(r.vsBaseline) },
      { v: pct(r.changePct, 2), cls: cls(r.changePct) },
      { v: signed(r.residDrift, 2), cls: cls(r.residDrift) },
      `${fmt(r.rangePct, 2)}%`,
      r.stress ? `<span class="stress-dot">●</span>` : { v: "—", cls: "dim" },
      r.segment == null ? { v: "—", cls: "dim" } : `#${r.segment + 1}`,
    ])));
}

/* ── 7c. weekday profile per regime ──────────────────────────── */

/** Small multiples: one facet per regime, sharing a y-axis. Faceting rather
 *  than five series on one grid — the regime scale is five ordered steps, two
 *  of which differ only in lightness, which is not a safe way to tell bars
 *  apart when they sit side by side. Here identity comes from the panel. */
/** Shared small-multiples renderer: one Mon–Fri panel per group, all sharing a
 *  y-axis, wrapping to a second row when there are more groups than fit. */
function facetWeekdays(id, t, groups, { title, subtitle, maxCols = 5 }) {
  const host = document.getElementById(id);
  if (!groups.length || !host) return;

  const means = groups.flatMap((g) => g.days.map((d) => d.mean)).filter((v) => v != null);
  const lo = Math.min(0, ...means), hi = Math.max(0, ...means);
  // Round the shared scale to multiples of 5 so the ticks read as round numbers
  // rather than "29", and leave headroom for the value labels above the bars.
  const step = 5;
  const yHi = Math.ceil((hi + (hi - lo) * 0.18) / step) * step;
  const yLo = Math.min(0, Math.floor(lo / step) * step);

  const n = groups.length;
  const cols = Math.min(n, maxCols);
  const rowCount = Math.ceil(n / cols);
  const left0 = 5, gap = 2.5;
  const w = (92 - gap * (cols - 1)) / cols;

  const headerH = 44, plotH = 175, axisH = 28, rowGap = 30;
  const rowBlock = headerH + plotH + axisH + rowGap;
  host.style.height = `${rowCount * rowBlock - rowGap + 14}px`;

  const grids = [], xAxes = [], yAxes = [], series = [], titles = [];
  groups.forEach((g, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const left = left0 + col * (w + gap);
    grids.push({
      left: `${left}%`, width: `${w}%`,
      top: row * rowBlock + headerH, height: plotH,
    });
    titles.push({
      text: title(g),
      subtext: subtitle(g),
      left: `${left + w / 2}%`, top: row * rowBlock + 4, textAlign: "center",
      textStyle: { color: t.text, fontSize: 12, fontWeight: 600 },
      subtextStyle: { color: t.muted, fontSize: 11 },
    });
    xAxes.push({
      gridIndex: i, type: "category", data: g.days.map((d) => d.short),
      axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: t.muted, fontSize: 10, interval: 0 },
    });
    yAxes.push({
      gridIndex: i, type: "value", min: yLo, max: yHi, splitNumber: 4,
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: t.grid } },
      axisLabel: col === 0
        ? { color: t.muted, fontSize: 10, formatter: (v) => v.toFixed(0) }
        : { show: false },
    });
    series.push({
      type: "bar", xAxisIndex: i, yAxisIndex: i, barMaxWidth: 22,
      data: g.days.map((d) => d.mean),
      itemStyle: {
        color: regimeColor(g.rank),
        borderRadius: [3, 3, 0, 0],
        borderColor: t.surface, borderWidth: 1,
      },
      label: {
        show: true, position: "top", color: t.sec, fontSize: 9,
        formatter: (p) => (p.value == null ? "" : p.value.toFixed(0)),
      },
    });
  });

  draw(id, {
    backgroundColor: "transparent",
    title: titles,
    grid: grids, xAxis: xAxes, yAxis: yAxes, series,
    tooltip: {
      trigger: "item", ...tooltipBox(t),
      formatter: (p) => {
        const g = groups[p.seriesIndex];
        const d = g.days[p.dataIndex];
        return `<strong>${title(g)}</strong> · ${d.name}<br>
          Mean <b>${bps(d.mean, 1)} bp</b>${d.se != null ? ` ± ${fmt(d.se, 1)}` : ""}<br>
          ${d.share != null ? `${fmt(d.share, 0)}% of the average week<br>` : ""}
          ${d.n} session${d.n === 1 ? "" : "s"}`;
      },
    },
  });
  charts.get(id)?.resize();   // the container height just changed
}

function renderWeekdayByRegime(t, dates, ret, weekClass) {
  const groups = S.weekdayByRegime(dates, ret, weekClass.rows);
  if (!groups.length) return;

  facetWeekdays("dowRegimeChart", t, groups, {
    title: (g) => g.regime.label,
    subtitle: (g) => `${g.weeks} week${g.weeks > 1 ? "s" : ""}`,
  });

  const fridayLeads = groups.filter((g) => g.topDay && g.topDay.dow === 5).length;
  const named = groups.filter((g) => g.topDay && g.topDay.dow === 5)
    .map((g) => g.regime.label.toLowerCase());
  document.getElementById("dowRegimeNote").innerHTML =
    `Friday is the biggest day in <strong>${fridayLeads} of ${groups.length}</strong>
     regime types${named.length ? ` (${named.join(", ")})` : ""}. Bars share one
     y-axis, so panel height is the level of depreciation and the shape within a
     panel is where in the week it landed.`;

  const head = ["Regime", "Weeks", ...groups[0].days.map((d) => d.name), "Busiest day"];
  setTable("dowRegimeChart-table", table(head, groups.map((g) => [
    `<span class="regime-cell"><span class="sw" style="background:${regimeColor(g.rank)}"></span>${g.regime.label}</span>`,
    g.weeks,
    ...g.days.map((d) => (d.mean == null
      ? { v: "—", cls: "dim" }
      : { v: `${bps(d.mean, 1)}${d.share != null ? ` (${fmt(d.share, 0)}%)` : ""}`,
          cls: cls(d.mean) })),
    g.topDay ? g.topDay.name : "—",
  ])));
}

/* ── 7d. weekday profile per detected segment ────────────────── */

/** The same cut, but by the structural segments from the breakpoint search —
 *  across eras rather than across week types. */
function renderWeekdayBySegment(t, dates, ret, segs, weekClass) {
  const groups = S.weekdayBySegment(dates, ret, segs,
    weekClass.baseline, weekClass.spread);
  if (!groups.length) return;

  const label = (g) => `#${g.index + 1} · ${fmt(g.segment.pace, 1)}%`;
  facetWeekdays("dowSegChart", t, groups, {
    title: label,
    subtitle: (g) => `${g.segment.start.slice(5)} → ${g.segment.end.slice(5)}`,
  });

  const withDay = groups.filter((g) => g.topDay);
  const fri = withDay.filter((g) => g.topDay.dow === 5);
  const friMeans = groups.map((g) => g.days[4].mean).filter((v) => v != null);
  const spanNote = friMeans.length
    ? ` Friday's own mean ranges ${bps(Math.min(...friMeans), 0)} to
        ${bps(Math.max(...friMeans), 0)} bp across segments.`
    : "";

  document.getElementById("dowSegNote").innerHTML = groups.length < 2
    ? `Only one segment in this window — widen the range to compare eras.`
    : `Friday is the biggest day in <strong>${fri.length} of ${withDay.length}</strong>
       detected segments.${spanNote} Panel colour reuses the week-class pace
       scale, so a fast stretch is the same red as a fast week above.`;

  const head = ["Segment", "Period", "Pace", "Sessions",
    ...groups[0].days.map((d) => d.name), "Busiest day"];
  setTable("dowSegChart-table", table(head, groups.map((g) => [
    `<span class="regime-cell"><span class="sw" style="background:${regimeColor(g.rank)}"></span>#${g.index + 1}</span>`,
    `${g.segment.start} → ${g.segment.end}`,
    `${fmt(g.segment.pace, 2)}%`,
    g.sessions,
    ...g.days.map((d) => (d.mean == null
      ? { v: "—", cls: "dim" }
      : { v: `${bps(d.mean, 1)}${d.share != null ? ` (${fmt(d.share, 0)}%)` : ""}`,
          cls: cls(d.mean) })),
    g.topDay ? g.topDay.name : "—",
  ])));
}

/* ── 8. weekly table ─────────────────────────────────────────── */

let WEEKLY_REGIMES = [];

function renderWeekly(dates, close) {
  const all = WEEKLY_REGIMES.length ? WEEKLY_REGIMES : S.weeklyTable(dates, close);
  const showAll = document.getElementById("weeklyAll").checked;
  const rows = (showAll ? all : all.slice(-20)).slice().reverse();

  setTable("weeklyTable", table(
    ["Week of", "Regime", "Days", "Open", "Close", "Change", "Annualised pace",
      "Δ pace vs prior week", "Range", "Fit R²", "Up/Down days"],
    rows.map((r) => {
      const tag = r.paceDelta == null ? `<span class="tag flat">—</span>`
        : r.paceDelta > 1 ? `<span class="tag up">▲ ${fmt(r.paceDelta, 1)}pp</span>`
          : r.paceDelta < -1 ? `<span class="tag down">▼ ${fmt(Math.abs(r.paceDelta), 1)}pp</span>`
            : `<span class="tag flat">≈ ${signed(r.paceDelta, 1)}pp</span>`;
      return [
        r.week,
        r.regime
          ? `<span class="regime-cell"><span class="sw" style="background:${regimeColor(r.rank)}"></span>${r.regime.label}</span>`
          : "—",
        r.days, r.open.toFixed(4), r.close.toFixed(4),
        { v: pct(r.changePct, 2), cls: cls(r.changePct) },
        { v: `${fmt(r.annPace, 1)}%`, cls: "" },
        tag,
        `${fmt(r.rangePct, 2)}%`,
        r.r2 == null ? "—" : fmt(r.r2, 3),
        `${r.upDays}/${r.downDays}`,
      ];
    })));
}

/* ── 9. volatility ───────────────────────────────────────────── */

function renderVol(t, dates, ret) {
  const vol = S.rollingVol(ret, 20);
  const xs = dates.slice(1);

  draw("volChart", {
    grid: { ...baseGrid, top: 18 },
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis", ...tooltipBox(t),
      valueFormatter: (v) => (v == null ? "—" : `${v.toFixed(2)}%`),
    },
    xAxis: {
      type: "category", data: xs, boundaryGap: false,
      ...axisCommon(t), splitLine: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value", scale: true, ...axisCommon(t),
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v) => `${v.toFixed(0)}%` },
    },
    series: [{
      name: "20-session realised vol", type: "line", data: vol,
      showSymbol: false, lineStyle: { color: t.s1, width: 2 }, color: t.s1,
      areaStyle: { color: t.band2 },
      endLabel: {
        show: true, color: t.s1, fontSize: 11, fontWeight: 600,
        formatter: (p) => (p.value == null ? "" : `${p.value.toFixed(1)}%`),
      },
    }],
  });

  const v = vol.filter((x) => x != null);
  setTable("volChart-table", table(["Measure", "Value"], [
    ["Latest", `${fmt(v.at(-1), 2)}%`],
    ["Mean", `${fmt(S.mean(v), 2)}%`],
    ["Min", `${fmt(Math.min(...v), 2)}%`],
    ["Max", `${fmt(Math.max(...v), 2)}%`],
  ]));
}

/* ── 10. return distribution ─────────────────────────────────── */

function renderHist(t, ret, stats) {
  const b = ret.map((r) => r * 10000);
  const h = S.histogram(b, 28);

  draw("histChart", {
    grid: { ...baseGrid, top: 18, bottom: 40 },
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item", ...tooltipBox(t),
      formatter: (p) => {
        const bin = h[p.dataIndex];
        return `${bin.x0.toFixed(0)} to ${bin.x1.toFixed(0)} bp<br><b>${bin.n}</b> sessions`;
      },
    },
    xAxis: {
      type: "category", data: h.map((x) => ((x.x0 + x.x1) / 2).toFixed(0)),
      ...axisCommon(t), splitLine: { show: false },
      name: "bp per session", nameLocation: "middle", nameGap: 26,
      nameTextStyle: { color: t.muted, fontSize: 11 },
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: "value", ...axisCommon(t),
      axisLabel: { color: t.muted, fontSize: 11 },
    },
    series: [{
      type: "bar", data: h.map((x) => x.n),
      itemStyle: {
        color: t.s1, borderRadius: [4, 4, 0, 0],
        borderColor: t.surface, borderWidth: 1,
      },
      markLine: {
        symbol: "none", silent: true,
        label: { color: t.muted, fontSize: 10, formatter: "zero" },
        lineStyle: { color: t.axis, width: 1, type: "dashed" },
        data: [{ xAxis: h.findIndex((x) => x.x0 <= 0 && x.x1 > 0) }],
      },
    }],
  });

  setTable("histChart-table", table(["Measure", "Value"], [
    ["Sessions", stats.n],
    ["Mean", `${bps(stats.meanBps, 1)} bp`],
    ["Median", `${bps(stats.median, 1)} bp`],
    ["Std deviation", `${fmt(stats.sdBps, 1)} bp`],
    ["Annualised vol", `${fmt(stats.annVol, 2)}%`],
    ["Skew", fmt(stats.skew, 2)],
    ["Excess kurtosis", fmt(stats.kurt, 2)],
    ["5th percentile", `${bps(stats.p05, 1)} bp`],
    ["95th percentile", `${bps(stats.p95, 1)} bp`],
    ["Lira-negative sessions", `${fmt(stats.shareUp, 1)}%`],
    ["Lira-positive sessions", `${fmt(stats.shareDown, 1)}%`],
  ]));
}

/* ── 11. mean reversion ──────────────────────────────────────── */

function renderReversion(t, fit, ret) {
  const mr = S.meanReversion(fit.resid);
  const rows = mr ? [
    ["AR(1) coefficient φ", fmt(mr.phi, 3)],
    ["Half-life of a deviation", mr.halfLife ? `${fmt(mr.halfLife, 1)} sessions` : "—"],
    ["t-statistic", fmt(mr.tStat, 1)],
    ["Daily return autocorrelation (lag 1)", fmt(S.acf(ret, 1)[0].r, 3)],
  ] : [["Not enough data", "—"]];

  document.getElementById("revStats").innerHTML = rows.map(([k, v]) =>
    `<div class="stat-row"><span>${k}</span><span>${v}</span></div>`).join("");

  const a = S.acf(ret, 12);
  draw("acfChart", {
    grid: { left: 44, right: 20, top: 12, bottom: 30, containLabel: true },
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item", ...tooltipBox(t),
      formatter: (p) => `Lag ${a[p.dataIndex].lag}<br>r = <b>${fmt(p.value, 3)}</b>`,
    },
    xAxis: {
      type: "category", data: a.map((x) => x.lag), ...axisCommon(t),
      splitLine: { show: false },
      name: "lag (sessions)", nameLocation: "middle", nameGap: 22,
      nameTextStyle: { color: t.muted, fontSize: 11 },
      axisLabel: { color: t.muted, fontSize: 11 },
    },
    yAxis: {
      type: "value", ...axisCommon(t),
      axisLabel: { color: t.muted, fontSize: 11 },
    },
    series: [{
      type: "bar", data: a.map((x) => x.r), barMaxWidth: 14,
      itemStyle: {
        color: (p) => (p.value >= 0 ? t.neg : t.pos),
        borderRadius: 3,
      },
      markLine: {
        symbol: "none", silent: true,
        label: { color: t.muted, fontSize: 10, formatter: "95%" },
        lineStyle: { color: t.axis, width: 1, type: "dashed" },
        data: [{ yAxis: a[0].ci }, { yAxis: -a[0].ci }],
      },
    }],
  });
}

/* ── 12. projection ──────────────────────────────────────────── */

function renderProjection(fit, dates) {
  const rows = S.project(fit, dates.at(-1));
  setTable("projTable", table(
    ["Horizon", "Date", "Path implies", "−2σ", "+2σ"],
    rows.map((r) => [
      r.days === 21 ? "1 month" : r.days === 63 ? "3 months"
        : r.days === 126 ? "6 months" : "12 months",
      r.date, `<strong>${r.mid.toFixed(3)}</strong>`,
      r.lo.toFixed(3), r.hi.toFixed(3),
    ])));
}

/* ── 13. monthly pace ────────────────────────────────────────── */

function renderMonthly(t) {
  const rows = S.monthlyPace(DATA.dates, DATA.close).filter((r) => r.pace != null);
  // Plotted as the month's own % change, not its annualised pace: annualising a
  // single month turns one outlier (June 2023, +24%) into ~1,300% and flattens
  // every other bar. The annualised figure stays in the tooltip and table.
  const overall = S.mean(rows.map((r) => r.changePct));

  draw("monthChart", {
    grid: { ...baseGrid, top: 20, bottom: 52 },
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item", ...tooltipBox(t),
      formatter: (p) => {
        const r = rows[p.dataIndex];
        return `<strong>${r.month}</strong><br>Change <b>${pct(r.changePct, 2)}</b><br>
                ${fmt(r.pace, 1)}% annualised · ${r.days} sessions · R² ${fmt(r.r2, 3)}`;
      },
    },
    xAxis: {
      type: "category", data: rows.map((r) => r.month), ...axisCommon(t),
      splitLine: { show: false },
      axisLabel: { color: t.muted, fontSize: 10, rotate: 60, hideOverlap: true },
    },
    yAxis: {
      type: "value", ...axisCommon(t), name: "% change in month",
      nameTextStyle: { color: t.muted, fontSize: 11, align: "left" }, nameGap: 12,
      axisLabel: { color: t.muted, fontSize: 11 },
    },
    series: [{
      type: "bar", data: rows.map((r) => r.changePct), barMaxWidth: 22,
      itemStyle: {
        color: (p) => (p.value >= 0 ? t.s1 : t.s3),
        borderRadius: [4, 4, 0, 0], borderColor: t.surface, borderWidth: 1,
      },
      markLine: {
        symbol: "none", silent: true,
        label: { color: t.muted, fontSize: 10, formatter: `mean ${fmt(overall, 2)}%` },
        lineStyle: { color: t.axis, width: 1, type: "dashed" },
        data: [{ yAxis: overall }],
      },
    }],
  });

  setTable("monthChart-table", table(
    ["Month", "Sessions", "Change", "Annualised pace", "R²"],
    rows.slice().reverse().map((r) => [r.month, r.days,
      { v: pct(r.changePct, 2), cls: cls(r.changePct) },
      `${fmt(r.pace, 1)}%`, fmt(r.r2, 3)])));
}

/* ── provenance ──────────────────────────────────────────────── */

function renderProvenance() {
  const m = DATA.meta;
  const ecb = m.cross_checks?.ecb_reference;
  document.getElementById("provenance").innerHTML =
    `<strong>Data.</strong> ${m.source} — ${m.n} sessions,
     ${m.start} to ${m.end}. Fetched ${m.generated_at.replace("T", " ")} UTC.
     ${ecb ? `Cross-checked against ECB reference rates on ${ecb.n_overlap} overlapping
      days: median gap ${ecb.median_abs_pct}%, largest ${ecb.max_abs_pct}%
      on ${ecb.max_abs_date}.` : ""}
     ${m.has_cbrt_official ? " CBRT official rate included." : ""}`;
}
