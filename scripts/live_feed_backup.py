"""Backup live price feed for the session: every minute, Yahoo Finance 1-minute prices for the Nifty 500 and the main
indices, published to the live-quotes branch in the same format the intraday runner uses (quotes.json), so the continuous
agent runner and the app keep getting fresh prices when NSE's server stops answering GitHub's machines.

It steps aside whenever the intraday runner has published fresh prices of its own (less than 2 minutes old), so the two
never fight over the branch while NSE is healthy. Each price keeps its own time; names Yahoo didn't refresh keep their
older time, and the paper fills refuse any name whose own price is too old. Paper trading only.

    python scripts/live_feed_backup.py [--until 15:31]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tradeos.live.market_feed import BRANCH, IST, MarketFeed  # noqa: E402


def remote_doc() -> dict | None:
    try:
        subprocess.run(["git", "-C", str(ROOT), "fetch", "-q", "--depth", "1", "origin", f"refs/heads/{BRANCH}"], check=True, capture_output=True, timeout=45)
        return json.loads(subprocess.run(["git", "-C", str(ROOT), "show", "FETCH_HEAD:quotes.json"], check=True, capture_output=True, timeout=30).stdout)
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--until", default="15:31")
    args = ap.parse_args()
    now = datetime.now(IST)
    if now.weekday() >= 5:
        print("weekend")
        return 0
    stocks = json.loads((ROOT / "data" / "universe.json").read_text()).get("stocks", {})
    n500 = [s for s, m in stocks.items() if m.get("nifty500")]
    feed = MarketFeed(ROOT, 1, push=True, bars=None, backup_syms=n500)
    feed.nse_down = True  # this job never asks NSE; the intraday runner does that
    today = now.date().isoformat()
    feed.restore(today)
    hh, mm = map(int, args.until.split(":"))
    published = skipped = 0
    while True:
        now = datetime.now(IST)
        if now.hour * 60 + now.minute >= hh * 60 + mm:
            break
        if now.hour * 60 + now.minute < 9 * 60 + 16:
            time.sleep(30)
            continue
        t0 = time.monotonic()
        rd = remote_doc()
        fresh_nse = rd and rd.get("date") == today and not str(rd.get("source", "")).startswith("Yahoo backup") and \
            (now - datetime.fromisoformat(rd["asof"])).total_seconds() < 120
        if fresh_nse:
            skipped += 1
            feed.last_doc = rd  # keep the newest prices as the base for when NSE stops again
        else:
            try:
                if rd and rd.get("date") == today and (not feed.last_doc or rd.get("asof", "") > feed.last_doc.get("asof", "")):
                    feed.last_doc = rd
                doc = feed.snapshot()
                if doc:
                    published += 1
            except Exception as e:  # noqa: BLE001
                print(f"{now:%H:%M:%S} backup snapshot failed: {e}", flush=True)
        if (published + skipped) % 15 == 1:
            print(f"{now:%H:%M:%S} published {published}, stood aside {skipped} (intraday runner fresh)", flush=True)
        time.sleep(max(5.0, 60 - (time.monotonic() - t0)))
    print(f"done: published {published}, stood aside {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
