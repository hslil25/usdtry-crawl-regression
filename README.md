# USD/TRY — Crawl Path Regression

A dashboard for analysing the managed USD/TRY path: the current crawl pace, how
that pace has shifted week to week, the corridor the rate floats in, and the
weekday structure of daily moves.

**Live: <https://hslil25.github.io/usdtry-crawl-regression/>**

The data refreshes itself: a GitHub Actions cron runs the fetcher at 18:30 UTC on
weekdays, commits `site/data.json` if the rate moved, and redeploys. Refresh and
deploy sit in one job deliberately — a commit made with `GITHUB_TOKEN` does not
trigger other workflows, so a separate refresh job would never kick off a deploy.
You can also run it on demand from the repo's Actions tab.

## Run it locally

```bash
./serve.sh
```

That fetches fresh data and serves <http://localhost:8899>. To skip the fetch and
just serve what's already there:

```bash
./serve.sh --no-fetch
```

Opening `site/index.html` straight from disk will **not** work — the page loads
`data.json` and ES modules over `fetch`, which needs `http://`.

## The idea

A managed crawl is a constant *percentage* pace, which is a straight line in
logs. So the whole analysis is one regression:

```
log(rate) = a + b·t + ε
```

- **b** is the crawl. Annualised as `(exp(b × 252) − 1) × 100`.
- **ε** is the float around the path. Its standard deviation is the corridor
  width; the current residual says where in the corridor the rate sits today.

Every panel is a different cut of that fit. All of it recomputes in the browser
against whatever date range is selected in the filter row.

## What's on the page

| Panel | Question it answers |
|---|---|
| Headline tiles | What is the pace, the corridor width, and today's position in it? |
| The path | Does a single line describe the whole window? How tight is the band? |
| Deviation from the path | When has the rate run hot or cold versus the crawl? |
| Is the pace changing? | Rolling 20/60-session pace — is the crawl accelerating? |
| Detected regimes | Where did the pace actually step, and by how much? |
| Weeks by regime | What kind of week was each one — pause, on path, catch-up, sprint? |
| Weekday profile by regime | Within each kind of week, which weekday carries the move? |
| Weekday profile by detected segment | Does that weekday shape survive a change in the crawl's pace? |
| Day-of-week effect | Do some weekdays carry systematically more depreciation? |
| Drift through the week | How does the average week accumulate its move? |
| Week × weekday moves | The same thing week by week, as a heatmap. |
| Week by week | Each week's realised pace and its change from the prior week. |
| Realised volatility | How noisy is the float, in annualised terms? |
| Daily move distribution | Shape of daily moves — skew, tails, share of down days. |
| Pull back to the path | AR(1) on residuals: half-life of a deviation. |
| If the path holds | Mechanical extrapolation of the current fit. Not a forecast. |
| Change by calendar month | The long view, across the full history. |

## Week regimes

There are two senses of "regime" on the page, and they answer different questions.

**Detected regimes** are structural: binary segmentation finds the dates where
the crawl's slope actually stepped, and each segment gets its own pace.

**Weeks by regime** classifies every individual week against the window's
baseline crawl `b`. The thresholds come from the window's own dispersion of
weekly pace — a median absolute deviation, so one stress week can't widen the
"on path" band until everything falls inside it:

| Class | Rule |
|---|---|
| Reversal | week ended lower — the lira gained |
| Pause | pace ≤ baseline − 0.5·spread |
| On path | within ±0.5·spread of baseline |
| Catch-up | pace ≥ baseline + 0.5·spread |
| Sprint | pace ≥ baseline + 1.5·spread |

The five classes sit on one ordered pace axis, so they are coloured as a
diverging scale (blue = slower, neutral = on path, red = faster) rather than as
arbitrary categories. Each week also carries a high-range flag and the number of
the structural segment it falls in.

Weeks with fewer than three sessions are excluded rather than classified — they
are the partial weeks at the window edges, where annualising a two-day move
turns ordinary noise into a 58% headline.

**Weekday profile by regime** then crosses the two: mean daily move by weekday,
faceted by week class. It separates two explanations of the Friday effect — that
Friday is genuinely the day the crawl is delivered, versus that fast weeks are
simply big and happen to end on a Friday. Faceting rather than five series on one
grid is deliberate: two of the five regime steps differ only in lightness, which
is not a safe way to tell side-by-side bars apart, so identity comes from the
panel instead. The panels share a y-axis, so panel height is the level of
depreciation and shape within a panel is where in the week it landed.

**Weekday profile by detected segment** runs the same cut across the structural
segments instead of the week classes — across eras rather than across week types.
Both faceted panels share one y-axis for comparability, which means a window
containing the June 2023 devaluation will compress the calm segments; the exact
values stay in the tooltip and the table view. Panel colour reuses the week-class
pace scale, so a fast stretch reads as the same red as a fast week.

The two cuts disagree in a useful way. Over the last year the weekday shape is
rigid: Friday leads in all seven detected segments, with its mean confined to
+12 to +20 bp even as segment pace ranges from roughly 15% to 21%. Widen to the
full history and it loosens — Friday leads in 5 of 9 segments and its mean spans
−20 to +19 bp, with the March 2025 stress episode inside the window. The
regularity is a feature of the calm crawl, not a constant of the lira.

## Data

`fetch_data.py` writes `site/data.json`.

History starts **2023-07-03**, the first session of the first full month after
the June 2023 policy turn. The step-devaluation itself is excluded deliberately:
a single +24% month widens every fitted band and swamps the shared y-axis on the
faceted panels. Everything on the site therefore describes the managed-crawl era
and says nothing about what came before it. Change `START` in `fetch_data.py` to
go back further.

- **Primary:** Yahoo Finance `USDTRY=X` daily close.
  Yahoo stamps each daily FX bar at midnight in the exchange timezone, which
  arrives as 23:00 UTC the *previous* day — the fetcher adds `gmtoffset` back to
  recover the real trading date. Without that correction every bar lands a day
  early and Fridays show up as Sundays.
- **Cross-check:** ECB reference rates via Frankfurter, reported in the page
  footer. Recent run: median gap 0.04% over 386 overlapping days.
- **Optional:** the CBRT official buying rate (`TP.DK.USD.A`) from EVDS. It needs
  a free key from <https://evds2.tcmb.gov.tr> (the service now redirects to
  `evds3`):

  ```bash
  EVDS_API_KEY=your_key python3 fetch_data.py
  ```

Stooq is deliberately not used — it sits behind a JavaScript bot check.

## Layout

```
fetch_data.py        data fetch + cross-check → site/data.json
serve.sh             fetch and serve
serve.py             no-cache static server for site/
.github/workflows/   scheduled refresh + Pages deploy
site/index.html      page structure
site/css/style.css   tokens and layout
site/js/stats.js     OLS, breakpoints, weekday stats, AR(1), distributions
site/js/app.js       data loading, filters, charts, tables
site/vendor/         ECharts, vendored so the page works offline
```

`stats.js` has no dependencies and can be checked from the command line:

```bash
node --input-type=module -e "import('./site/js/stats.js').then(async S=>{const d=JSON.parse(require('fs').readFileSync('site/data.json'));console.log(S.pathFit(d.dates,d.close).pace)})"
```

## Reading it honestly

- A high R² is not evidence of management by itself — any smooth trending series
  scores well. The informative part is how *small* the residual σ is next to the
  trend.
- Breakpoints are descriptive. They do not identify policy decisions, and a break
  can reflect market stress rather than a change in the managed pace.
- Weekday tests treat sessions as independent and use a normal approximation.
  Residuals are strongly autocorrelated, so small p-values are suggestive rather
  than conclusive.
- The bands are fitted, not announced. The CBRT publishes no explicit corridor;
  ±1σ/±2σ describe how the rate has actually behaved in the window.
- The projection panel extends the current fit mechanically. It assumes the crawl
  and the band hold exactly, which is the one thing a regime change breaks.
