"""Which app files to publish tonight: only the ones that changed since the last successful publish.

Compares every file under <build>/data (and <build>/index.html) with the hashes recorded after the last publish
(state/published.json, committed by the daily job once every batch went through), and splits the changed files into
batches the Artifact tool accepts (at most --max-files files and --max-mb MB per publish). data/manifest.json always goes
in the LAST batch (it points the page at the new files). Paths that are live on the artifact but no longer in the build
(given with --live, one published path per line, from the Artifact "files" listing) are removed in the FIRST batch, so
the version never holds old and new layouts together (an artifact version holds at most 511 files and 256 MB).

Usage: python scripts/publish_plan.py build [--live live_files.txt] [--all]
Writes <build>/publish_plan.json: {"batches": [{"files": [paths], "remove": [paths], "bytes": n}], "changed", "unchanged",
"removed", "total_files", "total_bytes"} and <build>/published_next.json (copy it to state/published.json after publishing).
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("build")
    ap.add_argument("--live", default="", help="file with the artifact's published paths, one per line")
    ap.add_argument("--state", default=str(ROOT / "state" / "published.json"))
    ap.add_argument("--all", action="store_true", help="publish every file (ignore the recorded hashes)")
    ap.add_argument("--max-files", type=int, default=200)
    ap.add_argument("--max-mb", type=float, default=50)
    args = ap.parse_args()
    build = Path(args.build).resolve()
    files = sorted(str(p.relative_to(build)) for p in (build / "data").rglob("*") if p.is_file())
    hashes = {f: hashlib.sha1((build / f).read_bytes()).hexdigest() for f in files}
    st = Path(args.state)
    prev = {} if args.all or not st.exists() else json.loads(st.read_text()).get("files", {})
    changed = [f for f in files if prev.get(f) != hashes[f]]
    live = [x.strip() for x in Path(args.live).read_text().splitlines()] if args.live and Path(args.live).exists() else list(prev)
    remove = sorted({x for x in live if x.startswith("data/") and x not in hashes})
    body = [f for f in changed if f != "data/manifest.json"]
    batches, cur, size = [], [], 0
    cap = args.max_mb * 1e6
    for f in body:
        b = (build / f).stat().st_size
        if cur and (len(cur) >= args.max_files or size + b > cap):
            batches.append({"files": cur, "bytes": size}); cur, size = [], 0
        cur.append(f); size += b
    last = cur + (["data/manifest.json"] if "data/manifest.json" in changed or remove or body else [])
    if last:
        batches.append({"files": last, "bytes": size + ((build / "data/manifest.json").stat().st_size if "data/manifest.json" in last else 0)})
    if batches:
        batches[0]["remove"] = remove
        for b in batches[1:]:
            b["remove"] = []
    elif remove:
        batches = [{"files": ["data/manifest.json"], "remove": remove, "bytes": (build / "data/manifest.json").stat().st_size}]
    plan = {"batches": batches, "changed": len(changed), "unchanged": len(files) - len(changed), "removed": len(remove),
            "total_files": len(files), "total_bytes": sum((build / f).stat().st_size for f in files)}
    (build / "publish_plan.json").write_text(json.dumps(plan, indent=1))
    (build / "published_next.json").write_text(json.dumps({"files": hashes}, indent=0))
    print(f"{len(changed)} changed of {len(files)} files ({plan['total_bytes'] / 1e6:.0f} MB in all), {len(remove)} to remove, "
          f"{len(batches)} batch(es): " + ", ".join(f"{len(b['files'])} files {b['bytes'] / 1e6:.1f} MB" for b in batches))
    if len(files) > 500 or plan["total_bytes"] > 250e6:
        print(f"WARNING: {len(files)} files / {plan['total_bytes'] / 1e6:.0f} MB is close to the artifact limit (511 files, 256 MB)")


if __name__ == "__main__":
    main()
