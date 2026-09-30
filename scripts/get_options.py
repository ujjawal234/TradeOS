"""Download the latest option-price bundles (built daily by .github/workflows/options-data.yml and published as the
`options-data` release asset) into .options/opt, where scripts/build_app_data.py picks them up.
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


if __name__ == "__main__":
    main()
