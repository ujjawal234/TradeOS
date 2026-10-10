"""Download the latest option-price bundles (built daily by .github/workflows/options-data.yml and published as the
`options-data` release asset) into .options/opt, the daily prices of every NSE and BSE stock (eod-data.yml, `eod-data`
release) into .eod/eod, the intraday bar bundles (.github/workflows/intraday-bars.yml, `intraday-data` release) into
.intraday/intra and company results into .research/fund, where scripts/build_app_data.py picks them up.
Usage: python scripts/get_options.py [--repo ujjawal234/TradeOS]"""
import argparse
import io
import json
import shutil
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="ujjawal234/TradeOS")
    args = ap.parse_args()
    try:
        get_eod(args.repo)
    except Exception as e:  # noqa: BLE001
        print(f"daily stock prices: not downloaded ({e})")
    url = f"https://github.com/{args.repo}/releases/download/options-data/options_app.tar"
    with urllib.request.urlopen(url, timeout=300) as r:
        data = r.read()
    dst = ROOT / ".options"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        t.extractall(dst, filter="data")
    idx = json.loads((dst / "opt" / "index.json").read_text())
    n = len(idx.get("underlyings", {}))
    print(f"options: {n} underlyings to {idx.get('asof')}, {len(data) / 1e6:.1f} MB -> {dst / 'opt'}")
    try:
        get_intraday(args.repo)
    except Exception as e:  # noqa: BLE001
        print(f"intraday bars: not downloaded ({e})")
    try:
        get_research(args.repo)
    except Exception as e:  # noqa: BLE001
        print(f"company results: not downloaded ({e})")


def get_eod(repo: str) -> None:
    url = f"https://github.com/{repo}/releases/download/eod-data/eod_data.tar"
    with urllib.request.urlopen(url, timeout=300) as r:
        data = r.read()
    dst = ROOT / ".eod"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        t.extractall(dst, filter="data")
    meta = json.loads((dst / "eod" / "meta.json").read_text())
    print(f"daily stock prices: {len(meta.get('symbols', {}))} stocks {meta.get('first')} to {meta.get('asof')}, {len(data) / 1e6:.1f} MB -> {dst / 'eod'}")


def get_research(repo: str) -> None:
    url = f"https://github.com/{repo}/releases/download/research-data/research_app.tar"
    with urllib.request.urlopen(url, timeout=300) as r:
        data = r.read()
    dst = ROOT / ".research"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        t.extractall(dst, filter="data")
    idx = json.loads((dst / "fund" / "index.json").read_text())
    print(f"company results: {len(idx.get('companies', {}))} companies, latest filing {idx.get('latest_filing')}, {len(data) / 1e6:.1f} MB -> {dst / 'fund'}")


def get_intraday(repo: str) -> None:
    url = f"https://github.com/{repo}/releases/download/intraday-data/intraday_app.tar"
    with urllib.request.urlopen(url, timeout=300) as r:
        data = r.read()
    dst = ROOT / ".intraday"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        t.extractall(dst, filter="data")
    idx = json.loads((dst / "intra" / "index.json").read_text())
    print(f"intraday bars: {len(idx.get('symbols', {}))} symbols to {idx.get('asof')}, {len(data) / 1e6:.1f} MB -> {dst / 'intra'}")


if __name__ == "__main__":
    main()
