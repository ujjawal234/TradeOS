"""Wait for the next live price snapshot on the `live-quotes` branch and copy it out (for the "TradeOS live prices"
scheduled task, which writes it to the app database as live/quotes).

    python3 scripts/live_wait.py --out build/live/quotes.json [--after <asof of the last copy>] [--max-wait 420] [--until 15:40]

Polls `git fetch origin live-quotes` every 30 s until quotes.json there is newer than --after (an ISO time), then
writes it to --out and prints {"asof", "date", "stocks", "indices", "bytes"}. Exit codes: 0 = new snapshot written,
2 = nothing newer within --max-wait seconds, 3 = past --until (IST) or not a session day: stop copying.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
IST = ZoneInfo("Asia/Kolkata")


def latest() -> dict | None:
    try:
        subprocess.run(["git", "-C", str(ROOT), "fetch", "-q", "--depth", "1", "origin", "live-quotes"], check=True, capture_output=True, timeout=90)
        raw = subprocess.run(["git", "-C", str(ROOT), "show", "FETCH_HEAD:quotes.json"], check=True, capture_output=True, timeout=60).stdout
        doc = json.loads(raw)
        return doc if doc.get("asof") and doc.get("quotes") else None
    except (subprocess.SubprocessError, OSError, ValueError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--after", default="")
    ap.add_argument("--max-wait", type=float, default=420)
    ap.add_argument("--until", default="15:40", help="IST time after which copying stops")
    args = ap.parse_args()
    t0 = time.monotonic()
    after = datetime.fromisoformat(args.after) if args.after else None
    hh, mm = map(int, args.until.split(":"))
    while True:
        now = datetime.now(IST)
        if now.weekday() >= 5 or (now.hour, now.minute) > (hh, mm):
            print(json.dumps({"stop": "past the session" if now.weekday() < 5 else "weekend"}))
            return 3
        doc = latest()
        if doc and doc.get("date") == now.date().isoformat() and (after is None or datetime.fromisoformat(doc["asof"]) > after):
            out = Path(args.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            text = json.dumps(doc, separators=(",", ":"))
            out.write_text(text)
            print(json.dumps({"asof": doc["asof"], "date": doc["date"], "stocks": len(doc["quotes"]), "indices": len(doc.get("indices") or {}), "bytes": len(text)}))
            return 0
        if time.monotonic() - t0 > args.max_wait:
            print(json.dumps({"waiting": "no newer snapshot yet", "latest": doc and doc.get("asof")}))
            return 2
        time.sleep(30)


if __name__ == "__main__":
    sys.exit(main())
