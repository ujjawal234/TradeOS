"""Intraday paper trading on NSE's live data (official NSE MCP server), polled once a minute.

    python scripts/intraday_run.py                 # live: waits for 09:14 IST, trades until the close
    python scripts/intraday_run.py --probe         # one poll: is NSE reachable, how many symbols came back
    python scripts/intraday_run.py --replay data/intraday/2026-10-06.csv.gz   # re-run a saved day (offline)

Agents live in intraday/agents.json. Per day it writes data/intraday/<date>.csv.gz (every snapshot, for replays
and future backtests), intraday/state/<date>.json (positions, so a new run can resume) and, after the close,
intraday/results/<date>.json. Alerts go to Telegram when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.

GitHub Actions jobs stop after 6 hours and the session is 6h15m: --max-runtime-min ends the run early with
handoff=true in $GITHUB_OUTPUT, and the next run resumes from the saved state.

Paper trading only. NSE's live data runs 1-3 minutes behind the market and is for informational use.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tradeos.live.intraday import COLS, Session, tm  # noqa: E402
from tradeos.live.nse_live import NseLive, Quote  # noqa: E402

IST = ZoneInfo("Asia/Kolkata")
CONFIG = ROOT / "intraday" / "agents.json"
TICKS_DIR, STATE_DIR, RESULTS_DIR = ROOT / "data" / "intraday", ROOT / "intraday" / "state", ROOT / "intraday" / "results"


def now_ist() -> pd.Timestamp:
    return pd.Timestamp(datetime.now(IST).replace(tzinfo=None))


def telegram(text: str) -> None:
    print(text, flush=True)
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if tok and chat:
        try:
            requests.post(f"https://api.telegram.org/bot{tok}/sendMessage", data={"chat_id": chat, "text": text[:4000]}, timeout=10)
        except requests.RequestException as e:
            print(f"telegram failed: {e}", flush=True)


def gh_output(key: str, val: str) -> None:
    p = os.environ.get("GITHUB_OUTPUT")
    if p:
        with open(p, "a") as f:
            f.write(f"{key}={val}\n")


def load_specs(path: Path) -> list[dict]:
    return json.loads(path.read_text())["agents"]


def load_universe() -> dict:
    f = ROOT / "data" / "universe.json"
    return json.loads(f.read_text()).get("stocks", {}) if f.exists() else {}


def quotes_from_rows(g: pd.DataFrame) -> dict:
    return {r.sym: Quote(r.sym, r.ltp, r.open, r.high, r.low, r.prev_close, r.volume, r.value_cr, str(r.ts)) for r in g.itertuples(index=False)}


def read_ticks(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df["polled"], df["ts"] = pd.to_datetime(df["polled"]), pd.to_datetime(df["ts"])
    return df[COLS]


def eod_text(sess: Session) -> str:
    res = sess.results()
    lines = [f"TradeOS intraday {res['date']} (paper trading, not advice)"]
    for a in res["agents"]:
        lines.append(f"{a['name']}: {a['trades']} trades, {a['wins']} wins, P&L Rs {a['pnl']:,.0f} ({a['return_pct']:+.2f}%)")
    return "\n".join(lines)


def replay(path: Path, specs, universe, out: Path | None) -> dict:
    df = read_ticks(path)
    day = df["ts"].dt.normalize().mode().iloc[0]
    sess = Session(day, specs, universe)
    for polled, g in df.groupby("polled", sort=True):
        for m in sess.feed(polled, quotes_from_rows(g)):
            print(m)
    for m in sess.finish():
        print(m)
    res = sess.results()
    print(eod_text(sess))
    if out:
        out.write_text(json.dumps(res, indent=1))
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(CONFIG))
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--replay", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--max-runtime-min", type=float, default=0, help="stop early and hand off (0 = no limit)")
    ap.add_argument("--end", default="15:31", help="IST time to stop polling")
    args = ap.parse_args()
    specs, universe = load_specs(Path(args.config)), load_universe()

    if args.replay:
        replay(Path(args.replay), specs, universe, Path(args.out) if args.out else None)
        return 0

    day = now_ist().normalize()
    ds = str(day.date())
    for d in (TICKS_DIR, STATE_DIR, RESULTS_DIR):
        d.mkdir(parents=True, exist_ok=True)
    tick_f, state_f = TICKS_DIR / f"{ds}.csv.gz", STATE_DIR / f"{ds}.json"
    state = json.loads(state_f.read_text()) if state_f.exists() else None
    ticks = read_ticks(tick_f) if tick_f.exists() else None
    sess = Session(day, specs, universe, state, ticks)
    watch = sess.watchlist()
    live = NseLive()

    if args.probe:
        ok = 0
        for k in range(3):  # three polls a minute apart: speed and whether the data moves
            t0 = time.time()
            q, upd = live.quotes(watch)
            secs = time.time() - t0
            slow = sorted(live.timings.items(), key=lambda x: -x[1])[:3]
            line = f"poll {k + 1}: {len(q)}/{len(watch)} symbols in {secs:.1f}s, NSE updated {upd}, slowest letters {slow}"
            print(line, flush=True)
            if os.environ.get("GITHUB_ACTIONS"):
                print(f"::notice title=NSE probe {k + 1}::{line}", flush=True)
            ok += len(q) >= 0.8 * len(watch)
            if k < 2:
                time.sleep(max(0.0, 60 - secs))
        for s in list(q)[:3]:
            print(" ", q[s])
        return 0 if ok >= 2 else 1

    if day.dayofweek >= 5:
        print("Weekend: market closed.")
        return 0
    if sess.done:
        print(f"{ds} already finished.")
        return 0
    end_t = day + pd.Timedelta(hours=tm(args.end).hour, minutes=tm(args.end).minute)
    started, resumed = time.monotonic(), state is not None
    while now_ist() < day + pd.Timedelta(hours=9, minutes=14):
        time.sleep(15)
    if not resumed:
        telegram(f"TradeOS intraday {ds}: {len(sess.agents)} paper agent(s) watching {len(watch)} stocks on NSE live data.")
    else:
        print(f"Resuming {ds} with {sum(len(a.st.positions) for a in sess.agents)} open position(s).", flush=True)

    handoff = False
    while True:
        now = now_ist()
        if now >= end_t:
            break
        if args.max_runtime_min and time.monotonic() - started > args.max_runtime_min * 60:
            handoff = True
            break
        upd = None
        try:
            quotes, upd = live.quotes(watch)
        except Exception as e:  # never let one bad poll end the day
            print(f"{now:%H:%M:%S} poll failed: {e}", flush=True)
            quotes = {}
        msgs = sess.feed(now, quotes) if quotes else []
        msgs += sess.force_square_off(now)
        if now.time() >= tm("09:35") and sess.store.clock() is None:
            print("No trades today in NSE's data by 09:35: market holiday.")
            sess.done = True
            state_f.write_text(json.dumps(sess.state(), indent=1))
            return 0
        if msgs:
            telegram(f"TradeOS intraday (paper)\n" + "\n".join(msgs))
        sess.store.frame().to_csv(tick_f, index=False)
        state_f.write_text(json.dumps(sess.state(), indent=1))
        print(f"{now:%H:%M:%S} {len(quotes)}/{len(watch)} quotes, data clock {sess.store.clock()}, "
              f"open positions {sum(len(a.st.positions) for a in sess.agents)}", flush=True)
        # next poll ~10 s after NSE's next crawl (it refreshes once a minute)
        wait = 60.0
        if upd:
            try:
                nxt = pd.Timestamp(upd).tz_convert(IST).tz_localize(None) + pd.Timedelta(seconds=70)
                wait = min(75.0, max(20.0, (nxt - now_ist()).total_seconds()))
            except (ValueError, TypeError):
                pass
        time.sleep(wait)

    if handoff:
        print("Run time limit reached: handing off to a new run.", flush=True)
        gh_output("handoff", "true")
    else:
        msgs = sess.finish()
        if msgs:
            telegram("TradeOS intraday (paper)\n" + "\n".join(msgs))
        (RESULTS_DIR / f"{ds}.json").write_text(json.dumps(sess.results(), indent=1))
        telegram(eod_text(sess))
        gh_output("handoff", "false")
    sess.store.frame().to_csv(tick_f, index=False)
    state_f.write_text(json.dumps(sess.state(), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
