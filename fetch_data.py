#!/usr/bin/env python3
"""Fetch the USD/TRY daily series and write it to site/data.json.

Primary source   : Yahoo Finance chart API (USDTRY=X) — daily market close.
Cross-check      : ECB reference rates via Frankfurter (EUR/TRY / EUR/USD).
Optional source  : CBRT EVDS official buying rate, when EVDS_API_KEY is set.

All analytics live in the browser (site/js/stats.js); this script only produces
a clean, de-duplicated daily series so the page has a single trustworthy input.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "site" / "data.json"

YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/USDTRY=X"
FRANKFURTER = "https://api.frankfurter.dev/v1"
EVDS = "https://evds3.tcmb.gov.tr/service/evds"

# History starts here: July 2023, the first full month after the June 2023
# policy turn. That deliberately excludes the step-devaluation itself — a single
# +24% month that widens every fitted band and swamps the shared y-axis on the
# faceted panels. What is left is the managed-crawl era.
START = dt.date(2023, 7, 1)
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}


def log(msg: str) -> None:
    print(f"  {msg}", file=sys.stderr)


def fetch_yahoo() -> dict[dt.date, float]:
    """Daily closes keyed by trading date.

    Yahoo stamps each daily FX bar at midnight in the exchange timezone, which
    arrives as 23:00 UTC the *previous* calendar day. Adding gmtoffset back
    recovers the real trading date; without it every bar lands a day early and
    Fridays masquerade as Sundays.
    """
    p = {"period1": int(dt.datetime.combine(START, dt.time()).timestamp()),
         "period2": 9999999999, "interval": "1d"}
    r = requests.get(YAHOO, params=p, headers=UA, timeout=30)
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    off = res["meta"].get("gmtoffset", 0)
    closes = res["indicators"]["quote"][0]["close"]

    out: dict[dt.date, float] = {}
    for ts, close in zip(res["timestamp"], closes):
        if close is None:
            continue
        d = dt.datetime.fromtimestamp(ts + off, dt.UTC).date()
        if d.weekday() >= 5:  # FX weekend stubs are not real sessions
            continue
        # period1 is interpreted in local time, so the boundary bar can land a
        # day early. Clip explicitly rather than trusting the request window.
        if d < START:
            continue
        out[d] = round(float(close), 4)  # later bar for a date wins (live quote)
    return out


def fetch_ecb(start: dt.date) -> dict[dt.date, float]:
    """USD/TRY implied by ECB reference rates, used only as a sanity check."""
    url = f"{FRANKFURTER}/{start.isoformat()}..?base=USD&symbols=TRY"
    r = requests.get(url, headers=UA, timeout=60)
    r.raise_for_status()
    rates = r.json()["rates"]
    return {dt.date.fromisoformat(d): round(float(v["TRY"]), 4)
            for d, v in rates.items()}


def fetch_evds(key: str) -> dict[dt.date, float]:
    """CBRT official USD buying rate (TP.DK.USD.A). Requires a free EVDS key."""
    url = (f"{EVDS}/series=TP.DK.USD.A"
           f"/startDate={START:%d-%m-%Y}/endDate={dt.date.today():%d-%m-%Y}"
           f"/type=json")
    r = requests.get(url, headers={**UA, "key": key}, timeout=60)
    r.raise_for_status()
    out: dict[dt.date, float] = {}
    for row in r.json().get("items", []):
        v = row.get("TP_DK_USD_A")
        if not v:
            continue
        d = dt.datetime.strptime(row["Tarih"], "%d-%m-%Y").date()
        out[d] = round(float(v), 4)
    return out


def cross_check(primary: dict[dt.date, float],
                other: dict[dt.date, float]) -> dict | None:
    """Largest and median absolute % gap on overlapping dates."""
    common = sorted(set(primary) & set(other))
    if len(common) < 20:
        return None
    diffs = [(d, abs(primary[d] / other[d] - 1) * 100) for d in common]
    diffs.sort(key=lambda x: x[1])
    worst_date, worst = diffs[-1]
    median = diffs[len(diffs) // 2][1]
    return {"n_overlap": len(common),
            "median_abs_pct": round(median, 4),
            "max_abs_pct": round(worst, 4),
            "max_abs_date": worst_date.isoformat()}


def main() -> int:
    print("Fetching USD/TRY…", file=sys.stderr)

    series = fetch_yahoo()
    if len(series) < 200:
        print("ERROR: Yahoo returned too few points; aborting.", file=sys.stderr)
        return 1
    log(f"Yahoo: {len(series)} sessions, {min(series)} → {max(series)}")

    checks: dict[str, dict] = {}
    try:
        ecb = fetch_ecb(max(START, max(series) - dt.timedelta(days=550)))
        chk = cross_check(series, ecb)
        if chk:
            checks["ecb_reference"] = chk
            log(f"ECB cross-check: median {chk['median_abs_pct']:.3f}%, "
                f"max {chk['max_abs_pct']:.3f}% ({chk['max_abs_date']})")
    except Exception as e:  # a failed cross-check must not block the build
        log(f"ECB cross-check unavailable: {e}")

    cbrt_official: dict[str, float] = {}
    key = os.environ.get("EVDS_API_KEY", "").strip()
    if key:
        try:
            evds = fetch_evds(key)
            chk = cross_check(series, evds)
            if chk:
                checks["cbrt_evds"] = chk
            cbrt_official = {d.isoformat(): v for d, v in sorted(evds.items())}
            log(f"CBRT EVDS: {len(evds)} official rates")
        except Exception as e:
            log(f"EVDS fetch failed: {e}")
    else:
        log("EVDS_API_KEY not set — skipping CBRT official rate (optional).")

    dates = sorted(series)
    payload = {
        "meta": {
            "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "pair": "USD/TRY",
            "source": "Yahoo Finance (USDTRY=X) daily close",
            "sources_note": "Weekday sessions only; weekend stubs dropped.",
            "n": len(dates),
            "start": dates[0].isoformat(),
            "end": dates[-1].isoformat(),
            "last": series[dates[-1]],
            "cross_checks": checks,
            "has_cbrt_official": bool(cbrt_official),
        },
        "dates": [d.isoformat() for d in dates],
        "close": [series[d] for d in dates],
        "cbrt_official": cbrt_official,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {OUT.relative_to(ROOT)} "
          f"({len(dates)} sessions, last {payload['meta']['last']} "
          f"on {payload['meta']['end']})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
