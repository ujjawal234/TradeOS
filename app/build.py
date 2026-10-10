"""Build the TradeOS app page:  python app/build.py <out_dir>   (then build data with scripts/build_app_data.py <out_dir>)"""
import sys
from pathlib import Path
here = Path(__file__).resolve().parent
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
lab = here.parent / "lab"
engine = (lab / "engine.js").read_text()
oms = (lab / "oms.js").read_text() + "\n" + (lab / "alerts.js").read_text()
part2 = (here / "app_part2.js").read_text().replace("  /*__PART3__*/", (here / "app_part3.js").read_text())
views = (here / "app_fund.js").read_text() + "\n" + (here / "app_home.js").read_text() + "\n" + (here / "app_cio.js").read_text() + "\n" + (here / "app_watch.js").read_text()
app = ((here / "app.js").read_text().replace("  /*__VIEWS__*/", views).replace("  /*__PART2__*/", part2)
       .replace("  /*__RESEARCH__*/", (here / "app_research.js").read_text()))
html = (here / "app.html").read_text().replace("/*__ENGINE__*/", engine).replace("/*__OMS__*/", oms).replace("/*__APP__*/", app)
(out / "index.html").write_text(html)
print(f"wrote {out / 'index.html'} ({len(html) // 1024} KB)")
