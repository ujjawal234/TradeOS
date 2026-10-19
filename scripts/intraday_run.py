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
import threading
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
from tradeos.live.market_feed import MarketFeed, yahoo_quotes  # noqa: E402
from tradeos.live.minute_bars import MinuteBars  # noqa: E402

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


def config_from_main(path: str = "intraday/agents.json") -> list[dict] | None:
    """The agents file as it is on origin/main right now (the continuous agent runner commits the team's Names-box
    changes there during the session); None if it can't be read."""
    try:
        import subprocess
        subprocess.run(["git", "-C", str(ROOT), "fetch", "-q", "--depth", "1", "origin", "main"], check=True, capture_output=True, timeout=45)
        out = subprocess.run(["git", "-C", str(ROOT), "show", f"FETCH_HEAD:{path}"], check=True, capture_output=True, timeout=30).stdout
        return json.loads(out)["agents"]
    except Exception as e:  # noqa: BLE001 — never let this stop trading
        print(f"agents reload failed: {e}", flush=True)
        return None


def apply_config(sess, specs: list[dict], universe: dict, bars, seen: dict) -> list[str]:
    """Names changed in the app (and app agents started on paper) take effect mid-session: new symbols are backfilled
    from today's 1-minute bars so their first bar is complete, then traded from the next bar close."""
    from tradeos.live.intraday import IntradayAgent  # noqa: PLC0415
    before = set(sess.watchlist())
    msgs = sess.update_symbols(specs, universe)
    have = {a.id for a in sess.agents}
    for sp in specs:
        if sp.get("enabled", True) and str(sp.get("id", "")).startswith("app_") and sp["id"] not in have:
            try:
                sess.agents.append(IntradayAgent(sp, universe))
                msgs.append(f"[{sp.get('name', sp['id'])}] joined the session with {len(sess.agents[-1].symbols)} names")
            except Exception as e:  # noqa: BLE001
                msgs.append(f"[{sp.get('name', sp['id'])}] could not join: {e}")
    for sym in sorted(set(sess.watchlist()) - before):
        day = (bars.bars.get(sym) if bars else None) or {}
        rows = [[m, b[0], b[1], b[2], b[3], b[4]] for m, b in sorted(day.items())]
        q = seen.get(sym)
        sess.store.seed(sym, rows, getattr(q, "open", None) or None, getattr(q, "prev_close", None) or None)
    return msgs


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
    ap.add_argument("--feed-min", type=float, default=15, help="minutes between full-market price snapshots (0 = off)")
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
    # near-live prices for every NSE stock and the indices, for the app and the CIO (live-quotes branch)
    # today's 1-minute bars for every NSE stock the polls see (published with each snapshot as bars_1m.json.gz)
    bars = MinuteBars(ds)
    feed = MarketFeed(ROOT, args.feed_min, push=bool(os.environ.get("GITHUB_ACTIONS")), bars=bars,
                      backup_syms=[s for s, m in universe.items() if m.get("nifty500")]) if args.feed_min > 0 else None
    if feed and resumed:
        feed.restore(ds)
    while now_ist() < day + pd.Timedelta(hours=9, minutes=14):
        time.sleep(15)
    if not resumed:
        telegram(f"TradeOS intraday {ds}: {len(sess.agents)} paper agent(s) watching {len(watch)} stocks on NSE live data.")
    else:
        print(f"Resuming {ds} with {sum(len(a.st.positions) for a in sess.agents)} open position(s).", flush=True)

    handoff = False
    reload_every, last_reload = 120.0, time.monotonic()
    ROTATION, poll_n, backoff = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 0, 0
    # Yahoo backup while NSE isn't answering: the agents' names every minute, the Nifty 500 every 3 minutes (background)
    n500 = [s for s, m in universe.items() if m.get("nifty500")]
    ycache: dict = {}
    ybg: threading.Thread | None = None
    ybg_at = 0.0
    while True:
        now = now_ist()
        if now >= end_t:
            break
        if args.max_runtime_min and time.monotonic() - started > args.max_runtime_min * 60:
            handoff = True
            break
        upd = None
        seen = {}
        try:
            # the agents' letters every minute plus 6 more in rotation (the whole market every ~6 minutes): NSE's server
            # throttles a client that asks for every letter every minute, and then nothing arrives at all
            rot = ROTATION[(poll_n * 6) % len(ROTATION):(poll_n * 6) % len(ROTATION) + 6]
            poll_n += 1
            if not backoff or poll_n % 5 == 0:  # while NSE is down, try it again only every 5th minute (Yahoo meanwhile)
                seen, upd = live.quotes(watch, extra_letters=rot)
                ok = getattr(live, "answered", 1) >= max(1, getattr(live, "asked", 1)) * 0.5
                if not ok:
                    print(f"{now:%H:%M:%S} NSE answered {live.answered}/{live.asked} letters: using Yahoo until it recovers", flush=True)
                backoff = 0 if ok else 60
            if feed:
                feed.nse_down = bool(backoff)
        except Exception as e:  # never let one bad poll end the day
            print(f"{now:%H:%M:%S} poll failed: {e}", flush=True)
        wset = set(watch)
        if backoff or (wset and sum(1 for s in wset if s in seen) < 0.5 * len(wset)):
            try:
                prev = {s: v[4] for s, v in ((feed.last_doc or {}).get("quotes") or {}).items() if v and len(v) > 4} if feed else {}
                missing = [s for s in watch if s not in seen]
                yq = yahoo_quotes(missing, prev, timeout=35) if missing else {}
                for s, q in yq.items():
                    seen.setdefault(s, q)
                if feed and not (ybg and ybg.is_alive()) and time.monotonic() - ybg_at >= 180:
                    ybg_at = time.monotonic()
                    ybg = threading.Thread(target=lambda p=prev: ycache.update(yahoo_quotes(n500, p, timeout=150)), daemon=True)
                    ybg.start()
                for s, q in list(ycache.items()):
                    seen.setdefault(s, q)  # NSE's own price wins whenever it has one
                print(f"{now:%H:%M:%S} NSE short: Yahoo backup {len(yq)}/{len(missing)} agent names, {len(ycache)} market names", flush=True)
            except Exception as e:  # noqa: BLE001 — the backup must never stop trading
                print(f"{now:%H:%M:%S} Yahoo backup failed: {e}", flush=True)
        quotes = {s: q for s, q in seen.items() if s in wset}
        try:
            bars.add(seen)
        except Exception as e:  # noqa: BLE001 — minute bars must never stop trading
            print(f"{now:%H:%M:%S} minute bars failed: {e}", flush=True)
        if feed and feed.due() and now.time() >= tm("09:15"):
            feed.start()
        elif feed and seen and now.time() >= tm("09:15"):
            feed.quick(seen)  # prices for the continuous agent runner every minute between full snapshots
        if os.environ.get("GITHUB_ACTIONS") and time.monotonic() - last_reload >= reload_every:
            last_reload = time.monotonic()
            new_specs = config_from_main()
            if new_specs is not None and new_specs != specs:
                specs = new_specs
                changed = apply_config(sess, specs, universe, bars, seen)
                watch = sess.watchlist()
                if changed:
                    telegram("TradeOS intraday (paper)\n" + "\n".join(changed))
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
        print(f"{now:%H:%M:%S} {len(quotes)}/{len(watch)} quotes ({len(seen)} stocks seen), data clock {sess.store.clock()}, "
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

    if feed:
        if feed.thread:
            feed.thread.join(timeout=120)
        if not handoff:  # closing prices
            try:
                feed.snapshot()
            except Exception as e:  # noqa: BLE001
                print(f"live feed: final snapshot failed: {e}", flush=True)
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
