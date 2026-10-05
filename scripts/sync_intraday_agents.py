"""Put the app's paper-trading intraday agents into intraday/agents.json, where the live runner
(scripts/intraday_run.py, NSE live data every session) picks them up. Run by the daily after-market job.

    python scripts/sync_intraday_agents.py build/agents.json

agents file: [{id, name, status, runner_id?, paper: {version, since}, version: {spec, test}}] (the paper version's spec, as stored
by the app). Hand-written agents in intraday/agents.json (ids not starting with "app_") are kept as they are; app
agents are added as "app_<agent id>" with "engine": "js" (rules evaluated by the app's own engine) and removed when
they stop paper trading. Prints what changed.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "intraday" / "agents.json"
FIELDS = ["symbols", "bar_minutes", "side", "entry", "exit", "rank_by", "opening_range_minutes", "stop_loss_pct", "target_pct",
          "trailing_stop_pct", "capital", "max_positions", "position_pct", "start_after", "no_entry_after", "square_off",
          "max_trades_per_symbol", "cost_pct", "slippage_pct"]


def main(path: str) -> None:
    agents = json.loads(Path(path).read_text())
    cfg = json.loads(CONFIG.read_text()) if CONFIG.exists() else {"agents": []}
    keep = [a for a in cfg.get("agents", []) if not str(a.get("id", "")).startswith("app_")]
    old = {a["id"]: a for a in cfg.get("agents", []) if str(a.get("id", "")).startswith("app_")}
    app = []
    for a in agents:
        spec = (a.get("version") or {}).get("spec") or {}
        if a.get("status") != "paper" or spec.get("type") != "intraday" or a.get("runner_id"):
            continue  # runner_id: a hand-written runner agent shown in the app (already in the file)
        entry = {"id": f"app_{a['id']}", "name": a.get("name") or a["id"], "enabled": True, "engine": "js",
                 "source": "app", "version": (a.get("paper") or {}).get("version"), "paper_since": (a.get("paper") or {}).get("since")}
        for k in FIELDS:
            if spec.get(k) is not None and spec.get(k) != "":
                entry[k] = spec[k]
        app.append(entry)
    new_ids = {a["id"] for a in app}
    added = [a["id"] for a in app if a["id"] not in old]
    changed = [a["id"] for a in app if a["id"] in old and old[a["id"]] != a]
    removed = [i for i in old if i not in new_ids]
    cfg["agents"] = keep + app
    CONFIG.write_text(json.dumps(cfg, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({"app_intraday_agents": len(app), "added": added, "changed": changed, "removed": removed, "hand_written": len(keep)}))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "build/agents.json")
