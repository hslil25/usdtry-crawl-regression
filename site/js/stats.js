/* Statistics for the USD/TRY crawl analysis.
 *
 * Everything works on the log of the rate: a managed crawling path is a
 * constant *percentage* pace, which is a straight line in logs. So the slope
 * of an OLS fit on log(rate) is the daily crawl rate, and the residuals are
 * the deviation from the path the currency floats around.
 */

export const TRADING_DAYS = 252;

/* ---------- primitives ---------- */

export const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

export function sd(a, ddof = 1) {
  if (a.length <= ddof) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - ddof));
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Abramowitz & Stegun 7.1.26 — plenty accurate for two-sided p-values.
function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

/** Two-sided p-value for a t-statistic, via the normal approximation.
 *  Sample sizes here are 20+ per bucket, where the gap to the t-distribution
 *  is immaterial for the "is this pattern real" question being asked. */
export const pValue = (t) => 2 * (1 - 0.5 * (1 + erf(Math.abs(t) / Math.SQRT2)));

/* ---------- ordinary least squares ---------- */

/** OLS of y on 0..n-1 (or on supplied x). Returns slope, fit, residuals,
 *  R², and the standard error / t-stat of the slope. */
export function ols(y, x = null) {
  const n = y.length;
  if (n < 3) return null;
  const xs = x || Array.from({ length: n }, (_, i) => i);
  const mx = mean(xs);
  const my = mean(y);
  let cxx = 0, cxy = 0, cyy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = y[i] - my;
    cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
  }
  const slope = cxy / cxx;
  const intercept = my - slope * mx;
  const fit = xs.map((v) => intercept + slope * v);
  const resid = y.map((v, i) => v - fit[i]);
  const rss = resid.reduce((s, v) => s + v * v, 0);
  const r2 = cyy > 0 ? 1 - rss / cyy : NaN;
  const sigma = Math.sqrt(rss / Math.max(n - 2, 1)); // residual std error
  const seSlope = sigma / Math.sqrt(cxx);
  return {
    n, slope, intercept, fit, resid, r2, sigma, seSlope,
    tSlope: slope / seSlope,
  };
}

/** Cumulative sums allowing O(1) OLS residual sums on any sub-range —
 *  used by the breakpoint search, which evaluates thousands of segments. */
function prefix(y) {
  const n = y.length;
  const sx = new Float64Array(n + 1), sy = new Float64Array(n + 1);
  const sxx = new Float64Array(n + 1), sxy = new Float64Array(n + 1);
  const syy = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sx[i + 1] = sx[i] + i;
    sy[i + 1] = sy[i] + y[i];
    sxx[i + 1] = sxx[i] + i * i;
    sxy[i + 1] = sxy[i] + i * y[i];
    syy[i + 1] = syy[i] + y[i] * y[i];
  }
  return { sx, sy, sxx, sxy, syy };
}

/** Residual sum of squares of a straight-line fit over [i, j). */
function segRSS(P, i, j) {
  const n = j - i;
  if (n < 3) return 0;
  const sx = P.sx[j] - P.sx[i], sy = P.sy[j] - P.sy[i];
  const cxx = P.sxx[j] - P.sxx[i] - (sx * sx) / n;
  const cxy = P.sxy[j] - P.sxy[i] - (sx * sy) / n;
  const cyy = P.syy[j] - P.syy[i] - (sy * sy) / n;
  if (cxx <= 0) return cyy;
  return Math.max(cyy - (cxy * cxy) / cxx, 0);
}

/* ---------- regime detection ---------- */

/** Binary segmentation on log price: repeatedly split the segment whose split
 *  buys the largest drop in residual sum of squares, keeping a split only when
 *  it improves BIC. Each regime is then a stretch with its own crawl pace. */
export function findBreakpoints(y, { minSize = 25, maxBreaks = 8 } = {}) {
  const n = y.length;
  if (n < minSize * 2 + 10) return [];
  const P = prefix(y);
  const bounds = [0, n];
  const breaks = [];

  for (let k = 0; k < maxBreaks; k++) {
    let best = null;
    for (let s = 0; s < bounds.length - 1; s++) {
      const [lo, hi] = [bounds[s], bounds[s + 1]];
      if (hi - lo < 2 * minSize) continue;
      const base = segRSS(P, lo, hi);
      for (let c = lo + minSize; c <= hi - minSize; c++) {
        const gain = base - segRSS(P, lo, c) - segRSS(P, c, hi);
        if (!best || gain > best.gain) best = { gain, cut: c };
      }
    }
    if (!best || best.gain <= 0) break;

    // BIC on the whole partition: 2 free parameters per extra segment.
    const rssBefore = bounds.slice(0, -1)
      .reduce((s, lo, i) => s + segRSS(P, lo, bounds[i + 1]), 0);
    const rssAfter = rssBefore - best.gain;
    const kBefore = 2 * (bounds.length - 1);
    const bicBefore = n * Math.log(rssBefore / n) + kBefore * Math.log(n);
    const bicAfter = n * Math.log(rssAfter / n) + (kBefore + 2) * Math.log(n);
    if (bicAfter >= bicBefore) break;

    breaks.push(best.cut);
    bounds.push(best.cut);
    bounds.sort((a, b) => a - b);
  }
  return breaks.sort((a, b) => a - b);
}

/** Split the series at the detected breakpoints and fit each regime. */
export function regimes(dates, logY) {
  const cuts = findBreakpoints(logY);
  const edges = [0, ...cuts, logY.length];
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const [lo, hi] = [edges[i], edges[i + 1]];
    const seg = logY.slice(lo, hi);
    const f = ols(seg);
    if (!f) continue;
    out.push({
      startIdx: lo,
      endIdx: hi - 1,
      start: dates[lo],
      end: dates[hi - 1],
      n: hi - lo,
      pace: annualPace(f.slope),
      r2: f.r2,
      residSd: f.sigma * 100,
      fit: f.fit,
    });
  }
  return out;
}

/* ---------- crawl-path metrics ---------- */

/** Daily log slope → annualised percentage pace. */
export const annualPace = (slope) => (Math.exp(slope * TRADING_DAYS) - 1) * 100;

/** Fit the crawl path over a window and describe where price sits in the band. */
export function pathFit(dates, close) {
  const logY = close.map(Math.log);
  const f = ols(logY);
  if (!f) return null;
  const residPct = f.resid.map((r) => r * 100);      // ≈ % deviation from path
  const s = f.sigma * 100;
  const last = residPct[residPct.length - 1];

  // How long since the rate last sat outside ±1σ of the path.
  let sinceTouch = 0;
  for (let i = residPct.length - 1; i >= 0; i--, sinceTouch++) {
    if (Math.abs(residPct[i]) >= s) break;
  }

  return {
    n: f.n,
    start: dates[0],
    end: dates[dates.length - 1],
    slope: f.slope,
    intercept: f.intercept,
    pace: annualPace(f.slope),
    paceLo: annualPace(f.slope - 1.96 * f.seSlope),
    paceHi: annualPace(f.slope + 1.96 * f.seSlope),
    r2: f.r2,
    residSd: s,
    resid: residPct,
    fitted: f.fit.map(Math.exp),
    lastResid: last,
    lastZ: last / s,
    bandPct: 2 * s,
    daysSinceBandTouch: sinceTouch,
    monthlyPace: (Math.exp(f.slope * 21) - 1) * 100,
    weeklyPace: (Math.exp(f.slope * 5) - 1) * 100,
  };
}

/** Rolling annualised pace from a trailing OLS window — the "is the crawl
 *  speeding up or slowing down" series. */
export function rollingPace(logY, win) {
  const out = new Array(logY.length).fill(null);
  if (logY.length < win) return out;
  const P = prefix(logY);
  for (let j = win; j <= logY.length; j++) {
    const i = j - win;
    const n = win;
    const sx = P.sx[j] - P.sx[i], sy = P.sy[j] - P.sy[i];
    const cxx = P.sxx[j] - P.sxx[i] - (sx * sx) / n;
    const cxy = P.sxy[j] - P.sxy[i] - (sx * sy) / n;
    out[j - 1] = annualPace(cxy / cxx);
  }
  return out;
}

/** Rolling annualised realised volatility of daily log returns (%). */
export function rollingVol(ret, win) {
  const out = new Array(ret.length).fill(null);
  for (let i = win - 1; i < ret.length; i++) {
    out[i] = sd(ret.slice(i - win + 1, i + 1)) * Math.sqrt(TRADING_DAYS) * 100;
  }
  return out;
}

/* ---------- weekly / weekday structure ---------- */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday"];

/** Mean daily move by weekday, in basis points, with a significance test
 *  against "no weekday effect". */
export function weekdayStats(dates, ret) {
  const buckets = new Map();
  for (let i = 0; i < ret.length; i++) {
    const d = new Date(dates[i + 1] + "T00:00:00Z").getUTCDay();
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(ret[i] * 10000); // log-return → bps
  }
  const overall = ret.map((r) => r * 10000);
  const gm = mean(overall);
  const rows = [];
  for (const day of [1, 2, 3, 4, 5]) {
    const v = buckets.get(day) || [];
    if (!v.length) continue;
    const m = mean(v), s = sd(v), se = s / Math.sqrt(v.length);
    const t = (m - gm) / se;
    rows.push({
      day, name: DAY_NAMES[day], short: DAY_NAMES[day].slice(0, 3),
      n: v.length, mean: m, sd: s, se, vsAll: m - gm, t, p: pValue(t),
      shareUp: v.filter((x) => x > 0).length / v.length * 100,
      median: quantile([...v].sort((a, b) => a - b), 0.5),
    });
  }
  return { rows, overallMean: gm };
}

/** Average cumulative drift through the week, Monday close = 0. */
export function intraWeekPath(dates, ret) {
  const byDay = new Map([[1, []], [2, []], [3, []], [4, []], [5, []]]);
  const weeks = groupWeeks(dates.slice(1), ret.map((r) => r * 10000));
  for (const w of weeks) {
    let cum = 0;
    for (const p of w.points) {
      cum += p.v;
      if (byDay.has(p.dow)) byDay.get(p.dow).push(cum);
    }
  }
  return [...byDay.entries()]
    .filter(([, v]) => v.length)
    .map(([dow, v]) => ({
      dow, short: DAY_NAMES[dow].slice(0, 3), n: v.length,
      mean: mean(v), se: sd(v) / Math.sqrt(v.length),
    }));
}

/** ISO-week key (Monday-anchored) for a yyyy-mm-dd string. */
export function weekStart(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const shift = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

function groupWeeks(dates, values) {
  const map = new Map();
  for (let i = 0; i < dates.length; i++) {
    const k = weekStart(dates[i]);
    if (!map.has(k)) map.set(k, { week: k, points: [] });
    map.get(k).points.push({
      date: dates[i], v: values[i],
      dow: new Date(dates[i] + "T00:00:00Z").getUTCDay(),
    });
  }
  return [...map.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/** Week-by-week table: pace, change, range, and how the pace shifted from the
 *  week before — the "trend change per week" view. */
export function weeklyTable(dates, close) {
  const map = new Map();
  for (let i = 0; i < dates.length; i++) {
    const k = weekStart(dates[i]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ date: dates[i], c: close[i], i });
  }
  const weeks = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const rows = [];
  for (const [k, pts] of weeks) {
    const cs = pts.map((p) => p.c);
    const f = pts.length >= 3 ? ols(cs.map(Math.log)) : null;
    const changePct = (cs[cs.length - 1] / cs[0] - 1) * 100;
    const rets = cs.slice(1).map((c, j) => Math.log(c / cs[j]) * 10000);
    rows.push({
      week: k,
      firstDate: pts[0].date,
      lastDate: pts[pts.length - 1].date,
      days: pts.length,
      open: cs[0],
      close: cs[cs.length - 1],
      high: Math.max(...cs),
      low: Math.min(...cs),
      changePct,
      // Annualise the week's own drift; with a full week this is 5 sessions.
      annPace: (Math.pow(cs[cs.length - 1] / cs[0], TRADING_DAYS / Math.max(pts.length - 1, 1)) - 1) * 100,
      slopePace: f ? annualPace(f.slope) : null,
      r2: f ? f.r2 : null,
      rangePct: (Math.max(...cs) / Math.min(...cs) - 1) * 100,
      vol: rets.length > 1 ? sd(rets) / 100 * Math.sqrt(TRADING_DAYS) : null,
      upDays: rets.filter((r) => r > 0).length,
      downDays: rets.filter((r) => r < 0).length,
    });
  }
  for (let i = 1; i < rows.length; i++) {
    rows[i].paceDelta = rows[i].annPace - rows[i - 1].annPace;
  }
  return rows;
}

/* ---------- weekly regime classification ---------- */

/** The five week types, ordered slowest → fastest. The order matters: it is a
 *  single pace axis, so it gets a diverging scale rather than arbitrary hues. */
export const WEEK_REGIMES = [
  { key: "reversal", label: "Reversal", hint: "lira ended the week stronger" },
  { key: "pause", label: "Pause", hint: "crawl ran well below its baseline" },
  { key: "onpath", label: "On path", hint: "crawl ran at its baseline pace" },
  { key: "catchup", label: "Catch-up", hint: "crawl ran above its baseline" },
  { key: "sprint", label: "Sprint", hint: "crawl ran far above its baseline" },
];

/** Robust spread: the median absolute deviation, scaled to be comparable with
 *  a standard deviation. Weekly pace has fat tails, so a plain σ would let one
 *  stress week widen the "on path" band until everything falls inside it. */
/** Place a pace on the five-step scale, given the baseline crawl and the spread
 *  of weekly pace around it. Shared by the week classes and the segment facets
 *  so the same pace reads as the same colour in both. */
export function paceRank(pace, baseline, spread) {
  if (pace < 0) return 0;                                  // reversal
  if (pace >= baseline + 1.5 * spread) return 4;           // sprint
  if (pace >= baseline + 0.5 * spread) return 3;           // catch-up
  if (pace <= baseline - 0.5 * spread) return 1;           // pause
  return 2;                                                // on path
}

function robustSd(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const med = quantile(sorted, 0.5);
  const dev = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return 1.4826 * quantile(dev, 0.5);
}

/** Label every week by how its own pace compares with the window's baseline
 *  crawl, and attach the structural segment it belongs to.
 *
 *  Thresholds are derived from the window's own dispersion of weekly pace, not
 *  hard-coded — so the classification adapts when the crawl gets tighter or
 *  looser instead of asserting a fixed idea of "normal".
 */
export function classifyWeeks(dates, close, fit, segments = []) {
  // Weeks with fewer than three sessions are dropped, not classified. They are
  // the partial weeks at the window edges (and holiday weeks), and annualising
  // a two-day move turns ordinary noise into a headline number — a 0.45% move
  // over two sessions annualises to ~58%.
  const all = weeklyTable(dates, close);
  const rows = all.filter((r) => r.days >= 3);
  const dropped = all.length - rows.length;
  if (!rows.length) return { rows: [], baseline: NaN, spread: NaN, counts: {}, dropped };

  const baseline = fit.pace;
  const paces = rows.map((r) => r.annPace);
  // Guard against a degenerate spread (a window where every week is identical).
  const spread = Math.max(robustSd(paces), 1e-6);

  // Deviation from the path at each week's first and last session: how far the
  // week travelled up or down inside the corridor.
  const residByDate = new Map(dates.map((d, i) => [d, fit.resid[i]]));
  const ranges = rows.map((r) => r.rangePct).sort((a, b) => a - b);
  const stressCut = quantile(ranges, 0.9);

  for (const r of rows) {
    r.residStart = residByDate.get(r.firstDate);
    r.residEnd = residByDate.get(r.lastDate);
    r.residDrift = r.residEnd - r.residStart;
    r.vsBaseline = r.annPace - baseline;
    r.stress = r.rangePct >= stressCut;

    r.rank = paceRank(r.annPace, baseline, spread);
    r.regime = WEEK_REGIMES[r.rank];

    // Which detected structural regime this week starts in.
    const seg = segments.findIndex((s) => r.firstDate >= s.start && r.firstDate <= s.end);
    r.segment = seg < 0 ? null : seg;
  }

  const counts = {};
  for (const w of WEEK_REGIMES) counts[w.key] = 0;
  for (const r of rows) counts[r.regime.key]++;

  // Runs of the same label, so "three catch-up weeks in a row" is visible.
  const runs = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    if (last && last.key === r.regime.key) { last.n++; last.end = r.week; }
    else runs.push({ key: r.regime.key, label: r.regime.label, n: 1, start: r.week, end: r.week });
  }

  return { rows, baseline, spread, counts, runs, stressCut, dropped };
}

/** Weekday profile within each week-regime class.
 *
 *  Answers whether the day-of-week pattern is structural or just an artefact of
 *  the fast weeks: if Friday leads inside every class, the shape is not simply
 *  "catch-up weeks are big and happen to end on a Friday".
 *
 *  `classified` is the row set from classifyWeeks — short weeks are already
 *  excluded there, so sessions in an unclassified week are skipped here too.
 */
export function weekdayByRegime(dates, ret, classified) {
  const rankByWeek = new Map(classified.map((r) => [r.week, r.rank]));
  const buckets = new Map();        // rank → dow → bps samples

  for (let i = 0; i < ret.length; i++) {
    const date = dates[i + 1];
    const rank = rankByWeek.get(weekStart(date));
    if (rank === undefined) continue;
    addSample(buckets, rank, date, ret[i] * 10000);
  }

  const groups = [];
  for (let rank = 0; rank < WEEK_REGIMES.length; rank++) {
    const weeks = classified.filter((r) => r.rank === rank).length;
    if (!weeks) continue;
    groups.push({
      rank,
      regime: WEEK_REGIMES[rank],
      weeks,
      ...summariseWeekdays(buckets.get(rank)),
    });
  }
  return groups;
}

/** The same weekday profile, cut by the detected structural segments instead of
 *  by week type — the across-eras version of the question. A daily move is
 *  attributed to the segment the day it was realised falls in. */
export function weekdayBySegment(dates, ret, segments, baseline, spread) {
  const buckets = new Map();        // segment index → dow → bps samples

  for (let i = 0; i < ret.length; i++) {
    const idx = i + 1;              // ret[i] is the move onto dates[i + 1]
    const si = segments.findIndex((s) => idx >= s.startIdx && idx <= s.endIdx);
    if (si < 0) continue;
    addSample(buckets, si, dates[idx], ret[i] * 10000);
  }

  return segments.map((seg, si) => ({
    index: si,
    segment: seg,
    // Reuses the week-class pace scale so a fast stretch reads the same colour
    // here as a fast week does above.
    rank: paceRank(seg.pace, baseline, spread),
    ...summariseWeekdays(buckets.get(si)),
  })).filter((g) => g.sessions > 0);
}

function addSample(buckets, key, date, value) {
  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  if (dow < 1 || dow > 5) return;
  if (!buckets.has(key)) buckets.set(key, new Map());
  const byDow = buckets.get(key);
  if (!byDow.has(dow)) byDow.set(dow, []);
  byDow.get(dow).push(value);
}

/** Mon–Fri means, standard errors and share-of-week for one bucket. */
function summariseWeekdays(byDow) {
  const days = [];
  for (const dow of [1, 2, 3, 4, 5]) {
    const v = (byDow && byDow.get(dow)) || [];
    days.push({
      dow,
      short: DAY_NAMES[dow].slice(0, 2),
      name: DAY_NAMES[dow],
      n: v.length,
      mean: v.length ? mean(v) : null,
      se: v.length > 1 ? sd(v) / Math.sqrt(v.length) : null,
    });
  }

  // Share of the average week each day contributes. Only meaningful when the
  // week as a whole moved up; against a negative total the share would flip
  // sign and read as nonsense.
  const total = days.reduce((s, d) => s + (d.mean || 0), 0);
  for (const d of days) {
    d.share = total > 0 && d.mean != null ? (d.mean / total) * 100 : null;
  }

  const ranked = days.filter((d) => d.mean != null).sort((a, b) => b.mean - a.mean);
  return {
    days,
    total,
    sessions: days.reduce((s, d) => s + d.n, 0),
    topDay: ranked[0] || null,
  };
}

/** Weeks × weekday grid of daily moves in bps, for the heatmap. */
export function weekdayHeatmap(dates, ret, maxWeeks = 26) {
  const weeks = groupWeeks(dates.slice(1), ret.map((r) => r * 10000));
  const tail = weeks.slice(-maxWeeks);
  const cells = [];
  tail.forEach((w, wi) => {
    for (const p of w.points) {
      if (p.dow >= 1 && p.dow <= 5) {
        cells.push({ x: p.dow - 1, y: wi, v: p.v, date: p.date });
      }
    }
  });
  return { weeks: tail.map((w) => w.week), cells };
}

/* ---------- mean reversion inside the band ---------- */

/** AR(1) on the residuals: how strongly deviations from the path get pulled
 *  back, and the implied half-life in sessions. */
export function meanReversion(resid) {
  if (resid.length < 30) return null;
  const y = resid.slice(1);
  const x = resid.slice(0, -1);
  const f = ols(y, x);
  if (!f) return null;
  const phi = f.slope;
  const halfLife = phi > 0 && phi < 1 ? Math.log(0.5) / Math.log(phi) : null;
  return { phi, halfLife, tStat: f.tSlope, p: pValue(f.tSlope) };
}

/** Autocorrelation of daily returns at lags 1..maxLag. */
export function acf(x, maxLag = 10) {
  const m = mean(x);
  const denom = x.reduce((s, v) => s + (v - m) ** 2, 0);
  const out = [];
  for (let k = 1; k <= maxLag; k++) {
    let num = 0;
    for (let i = k; i < x.length; i++) num += (x[i] - m) * (x[i - k] - m);
    out.push({ lag: k, r: num / denom, ci: 1.96 / Math.sqrt(x.length) });
  }
  return out;
}

/* ---------- distribution & projection ---------- */

export function histogram(values, bins = 30) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const w = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    counts[Math.min(Math.floor((v - lo) / w), bins - 1)]++;
  }
  return counts.map((c, i) => ({ x0: lo + i * w, x1: lo + (i + 1) * w, n: c }));
}

export function describe(ret) {
  const bps = ret.map((r) => r * 10000);
  const m = mean(bps), s = sd(bps);
  const sorted = [...bps].sort((a, b) => a - b);
  const skew = mean(bps.map((v) => ((v - m) / s) ** 3));
  const kurt = mean(bps.map((v) => ((v - m) / s) ** 4)) - 3;
  return {
    n: bps.length, meanBps: m, sdBps: s, skew, kurt,
    annVol: s / 100 * Math.sqrt(TRADING_DAYS),
    shareUp: bps.filter((v) => v > 0).length / bps.length * 100,
    shareDown: bps.filter((v) => v < 0).length / bps.length * 100,
    maxUp: sorted[sorted.length - 1], maxDown: sorted[0],
    p05: quantile(sorted, 0.05), p95: quantile(sorted, 0.95),
    median: quantile(sorted, 0.5),
  };
}

/* ---------- forward path estimator ---------- */

/** Standard normal CDF. */
export const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Signed count of weekday sessions between two dates. Public holidays are not
 *  modelled, so a horizon spanning one is a session or two long; at these
 *  horizons that shifts the estimate by a fraction of a basis point. */
export function businessDaysBetween(fromISO, toISO) {
  const a = new Date(`${fromISO}T00:00:00Z`);
  const b = new Date(`${toISO}T00:00:00Z`);
  const dir = b >= a ? 1 : -1;
  const d = new Date(a);
  let n = 0;
  while (dir > 0 ? d < b : d > b) {
    d.setUTCDate(d.getUTCDate() + dir);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n += dir;
  }
  return n;
}

/** Distribution of the rate h sessions ahead, conditional on the crawl holding.
 *
 *  The model is the one the rest of the page already fits:
 *      log P_t = a + b·t + ε_t ,   ε_t = φ·ε_{t-1} + u_t
 *
 *  so h sessions out, in logs,
 *      mean = a + b·(T+h) + φ^h·ε_T          today's gap decays back to the path
 *      var  = σ²(1 − φ^{2h})                 deviation, widening to the corridor
 *           + σ²·k·(1/n + (x−x̄)²/Sxx)       uncertainty in the fitted line
 *
 *  The k = (1+φ)/(1−φ) factor is the usual AR(1) correction to the effective
 *  sample size. Without it the slope looks far better pinned down than 260
 *  strongly autocorrelated residuals can justify, and the long-horizon cone
 *  comes out implausibly tight.
 *
 *  This is a conditional distribution, not a forecast: it prices the noise
 *  around the path, never the chance that the path itself is repriced.
 */
export function forecastAt(fit, phi, h) {
  const n = fit.n;
  const x = (n - 1) + h;
  const xbar = (n - 1) / 2;
  const sxx = (n * (n * n - 1)) / 12;      // Σ(x−x̄)² for x = 0..n−1
  const sigma = fit.residSd / 100;         // residual σ in log units
  const eps = fit.lastResid / 100;         // today's gap from the path

  // A φ at or above 1 is a non-stationary estimate; clamp so the correction
  // stays finite rather than dividing by ~0.
  const p = Math.min(Math.max(phi ?? 0, 0), 0.98);

  const muLog = fit.intercept + fit.slope * x + Math.pow(p, h) * eps;
  const varDev = sigma * sigma * (1 - Math.pow(p, 2 * h));
  const varLine = sigma * sigma * ((1 + p) / (1 - p))
    * (1 / n + Math.pow(x - xbar, 2) / sxx);
  const sd = Math.sqrt(varDev + varLine);

  return {
    h, muLog, sd,
    median: Math.exp(muLog),
    /** Rate at probability q (0–1). */
    quantile: (q) => Math.exp(muLog + invNorm(q) * sd),
    /** P(rate ends at or above `level`). */
    probAbove: (level) => 1 - normalCdf((Math.log(level) - muLog) / sd),
  };
}

/** Inverse standard normal (Acklam's rational approximation, |error| < 1e-9) —
 *  needed to turn a probability back into a rate. */
export function invNorm(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** The forecast evaluated at every session from 1..hMax ahead. */
export function forecastSeries(fit, phi, lastDate, hMax) {
  const out = [];
  let date = lastDate;
  for (let h = 1; h <= hMax; h++) {
    date = addBusinessDays(date, 1);
    const f = forecastAt(fit, phi, h);
    out.push({
      h, date, median: f.median,
      q025: f.quantile(0.025), q10: f.quantile(0.10), q25: f.quantile(0.25),
      q75: f.quantile(0.75), q90: f.quantile(0.90), q975: f.quantile(0.975),
    });
  }
  return out;
}

export function addBusinessDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

/* ---------- monthly pace ---------- */

/** Realised annualised pace per calendar month — the coarse view of how the
 *  managed pace has been reset over time. */
export function monthlyPace(dates, close) {
  const map = new Map();
  for (let i = 0; i < dates.length; i++) {
    const k = dates[i].slice(0, 7);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(close[i]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, cs]) => {
      const f = cs.length >= 5 ? ols(cs.map(Math.log)) : null;
      return {
        month, days: cs.length,
        changePct: (cs[cs.length - 1] / cs[0] - 1) * 100,
        pace: f ? annualPace(f.slope) : null,
        r2: f ? f.r2 : null,
      };
    });
}
