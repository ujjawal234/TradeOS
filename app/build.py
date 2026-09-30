"""Build the TradeOS app page:  python app/build.py <out_dir>   (then build data with scripts/build_app_data.py <out_dir>)"""
import sys
from pathlib import Path
here = Path(__file__).resolve().parent
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
engine = (here.parent / "lab" / "engine.js").read_text()
part2 = (here / "app_part2.js").read_text().replace("  /*__PART3__*/", (here / "app_part3.js").read_text())
app = (here / "app.js").read_text().replace("  /*__PART2__*/", part2)
html = (here / "app.html").read_text().replace("/*__ENGINE__*/", engine).replace("/*__APP__*/", app)
(out / "index.html").write_text(html)
print(f"wrote {out / 'index.html'} ({len(html) // 1024} KB)")
