"""Today's 1-minute bars built from once-a-minute NSE polls (tradeos/live/minute_bars.py)."""
import gzip
import json

from tradeos.live.minute_bars import MinuteBars, minute_of
from tradeos.live.nse_live import Quote


def q(sym, ltp, hi, lo, vol, ts):
    return Quote(sym, ltp, 100.0, hi, lo, 99.0, vol, 1.0, ts)


def test_minute_of():
    assert minute_of("2026-10-15 09:15:02") == 0
    assert minute_of("2026-10-15 15:29:59") == 374
    assert minute_of("2026-10-15 15:30:00") is None
    assert minute_of("2026-10-15 09:14:59") is None
    assert minute_of("12:37") == 202


def test_bars_from_polls(tmp_path):
    b = MinuteBars("2026-10-15")
    b.add({"AAA": q("AAA", 100, 101, 99, 1000, "2026-10-15 09:16:40"), "OLD": q("OLD", 50, 51, 49, 10, "2026-10-14 15:29:00")})
    b.add({"AAA": q("AAA", 100.5, 101, 99, 1500, "2026-10-15 09:16:58")})          # same minute, more volume
    b.add({"AAA": q("AAA", 102, 103, 99, 2600, "2026-10-15 09:17:50")})            # new high inside the minute
    b.add({"AAA": q("AAA", 102, 103, 99, 2600, "2026-10-15 09:17:50")})            # NSE didn't refresh: nothing changes
    b.add({"AAA": q("AAA", 98, 103, 97.5, 3000, "2026-10-15 09:19:05")})           # new low, a skipped minute
    d = b.doc("x")
    assert "OLD" not in d["bars"]
    assert d["bars"]["AAA"] == [[1, 100, 100.5, 100, 100.5, 500], [2, 102, 103, 102, 102, 1100], [4, 98, 98, 97.5, 98, 400]]
    b.save(tmp_path / "b.json.gz", "x")
    assert json.loads(gzip.decompress((tmp_path / "b.json.gz").read_bytes()))["date"] == "2026-10-15"
    r = MinuteBars("2026-10-15")
    assert r.load(tmp_path / "b.json.gz") and r.doc()["bars"]["AAA"] == d["bars"]["AAA"]
    assert not MinuteBars("2026-10-16").load(tmp_path / "b.json.gz")
