"""Convert data/prices/*.csv into compact JSON files for the browser Strategy Lab.

Output: <out>/data/<SYMBOL>.json  {d0, dd, o, h, l, c, v}  (dates as day offsets since 1970-01-01)
        <out>/data/manifest.json  symbols, date ranges, universes, generated date
Usage:  python scripts/build_lab_data.py <out_dir>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tradeos.data.universe import INDICES, NIFTY50, SECTORS  # noqa: E402

MIN_ROWS = 200  # skip symbols Yahoo returned without real history


def main(out: Path) -> None:
    src = ROOT / "data" / "prices"
    dst = out / "data"
    dst.mkdir(parents=True, exist_ok=True)
    fetched = json.loads((ROOT / "data" / "manifest.json").read_text())
    symbols = {}
    for f in sorted(src.glob("*.csv")):
        df = pd.read_csv(f, index_col=0, parse_dates=True).dropna(subset=["close"])
        if len(df) < MIN_ROWS:
            continue
        days = (df.index.values.astype("datetime64[D]").astype("int64")).tolist()
        dd = [days[0]] + [b - a for a, b in zip(days, days[1:])]
        rec = {"d0": 0, "dd": dd}
        for k, col in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close")):
            rec[k] = [round(float(x), 2) for x in df[col].values]
        rec["v"] = [int(x) for x in df["volume"].fillna(0).values]
        (dst / f"{f.stem}.json").write_text(json.dumps(rec, separators=(",", ":")))
        symbols[f.stem] = {"first": str(df.index[0].date()), "last": str(df.index[-1].date()), "rows": len(df)}
    universes = {
        "nifty50": [s for s in NIFTY50 if s in symbols],
        "sectors": [s for s in SECTORS if s in symbols],
        "indices": [s for s in INDICES if s in symbols],
        "banks": [s for s in ["HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK", "INDUSINDBK"] if s in symbols],
        "it": [s for s in ["TCS", "INFY", "HCLTECH", "WIPRO", "TECHM"] if s in symbols],
    }
    manifest = {"generated": fetched.get("generated"), "source": "Yahoo Finance (split & dividend adjusted)",
                "symbols": symbols, "universes": universes}
    (dst / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"{len(symbols)} symbols -> {dst}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
