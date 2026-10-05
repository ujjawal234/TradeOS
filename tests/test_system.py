"""End-to-end tests on synthetic data (no network, no API key). Run: python -m pytest -q  (or python tests/test_system.py)"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tradeos.brain import MainAgent  # noqa: E402
from tradeos.config import get_settings  # noqa: E402
from tradeos.data.synthetic import SyntheticProvider  # noqa: E402
from tradeos.manager import Manager  # noqa: E402
from tradeos.rules import RuleError, validate  # noqa: E402


def make_manager(llm=None) -> Manager:
    home = Path(tempfile.mkdtemp(prefix="tradeos_test_"))
    return Manager(get_settings(home, "synthetic"), provider=SyntheticProvider(), llm=llm, quiet=True)


# ---------------------------------------------------------------- rules
def test_rules_reject_unsafe_and_bad_input():
    validate("cross_above(ema(close, 20), ema(close, 50)) and rsi(close, 14) > 50")
    for bad in ["__import__('os').system('ls')", "open.__class__", "close >", "foo(close)", "x > 1"]:
        try:
            validate(bad)
        except RuleError:
            continue
        raise AssertionError(f"accepted bad rule: {bad}")


# ---------------------------------------------------------------- paper == backtest
def test_paper_trades_match_backtest_signals():
    m = make_manager()
    spec = {"symbols": ["RELIANCE"], "entry": "cross_above(ema(close,10), ema(close,30))",
            "exit": "cross_below(ema(close,10), ema(close,30))"}
    a = m.create_agent("rule", "t", spec)
    days = pd.bdate_range("2024-01-01", "2025-06-30")
    for d in days:
        m.run_daily(d, notify_summary=False)
    paper = [(t["date"], "B" if t["qty"] > 0 else "S") for t in reversed(m.store.list_trades(a["id"]))]
    bt = m.backtest(a["id"], start="2024-01-01", end="2025-06-30", save=False)
    trades = bt["recent_trades"] + bt["open_trades"]
    expected = []
    for t in m.agent(a["id"]).backtest("2024-01-01", "2025-06-30")["trades"]:
        expected.append((t["entry_date"], "B"))
        if not t.get("open"):
            expected.append((t["exit_date"], "S"))
    assert paper == expected, (paper[:6], expected[:6])
    assert trades


# ---------------------------------------------------------------- every agent type
def test_all_agent_types_backtest_and_paper():
    m = make_manager()
    ids = [
        m.create_agent("alert", "a", {"alerts": [{"symbol": "TCS", "above": 100}]})["id"],
        m.create_agent("rule", "r", {"symbols": "INFY TCS", "entry": "close > shift(highest(high, 20), 1)",
                                     "exit": "close < lowest(low, 10)", "stop_loss_pct": 5,
                                     "take_profit_pct": 15})["id"],
        m.create_agent("rule", "short", {"symbols": ["SBIN"], "side": "short",
                                         "entry": "cross_below(close, sma(close, 50))",
                                         "exit": "cross_above(close, sma(close, 50))"})["id"],
        m.create_agent("rotation", "rot", {"universe": "nifty50", "top_n": 5})["id"],
        m.create_agent("option_selling", "ic", {"underlying": "NIFTY", "structure": "iron_condor",
                                                "wing_width": 300})["id"],
        m.create_agent("option_selling", "bn", {"underlying": "BANKNIFTY", "structure": "short_put",
                                                "strike_mode": "otm_pct", "otm_pct": 4})["id"],
    ]
    for aid in ids:
        bt = m.backtest(aid, start="2022-01-01", save=False)
        assert bt, aid
    bn = m.agent(ids[-1]).spec
    assert bn["lot_size"] == 30 and bn["expiry"] == "monthly" and bn["strike_step"] == 100
    for d in pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=30):
        r = m.run_daily(d, notify_summary=False)
        assert not r["errors"], r["errors"]
    assert Path(r["report"]).exists()
    # running the same day twice must not double-trade
    before = {i: len(m.store.list_trades(i)) for i in ids}
    m.run_daily(pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=1)[0], notify_summary=False)
    assert before == {i: len(m.store.list_trades(i)) for i in ids}
    # manage lifecycle
    m.add_symbols(ids[1], ["WIPRO"])
    assert "WIPRO" in m.agent(ids[1]).spec["symbols"]
    m.add_alert(ids[0], {"symbol": "NIFTY", "expr": "rsi(close, 14) < 30"})
    m.set_status(ids[3], "paused")
    out = m.destroy_agent(ids[4])
    assert out["status"] == "destroyed" and not m.store.get_positions(ids[4])
    assert len(m.list_agents()) == len(ids) - 1


# ---------------------------------------------------------------- brain + research with a scripted model
class ScriptedLLM:
    """Stands in for Claude: replays tool calls, then a final answer."""

    def __init__(self, script):
        self.script, self.calls = list(script), []

    def create(self, system, messages, tools=None, max_tokens=4096):
        self.calls.append(messages[-1])
        step = self.script.pop(0)
        if isinstance(step, str):
            return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=step)])
        blocks = [SimpleNamespace(type="tool_use", id=f"t{i}", name=n, input=a) for i, (n, a) in enumerate(step)]
        return SimpleNamespace(stop_reason="tool_use", content=blocks)

    def complete_json(self, system, prompt, max_tokens=6000):
        assert "NIFTYBANK" in prompt  # momentum table was included
        return {"summary": "Banks strong", "sectors": [{"name": "Banks", "stance": "overweight"}],
                "stocks": [], "themes": [], "risks": [], "suggested_agents": []}


def test_main_agent_tool_loop():
    llm = ScriptedLLM([
        [("validate_rule", {"expr": "cross_above(close, sma(close, 200))"}), ("list_agents", {})],
        [("create_agent", {"type": "rule", "name": "200dma", "spec": {
            "symbols": ["TATASTEEL"], "entry": "cross_above(close, sma(close, 200))",
            "exit": "cross_below(close, sma(close, 200))"}})],
        [("backtest_agent", {"agent_id": "__LAST__"}), ("validate_rule", {"expr": "bad("})],
        "Created and backtested.",
    ])
    m = make_manager(llm)
    agent = MainAgent(m, llm=llm)
    # patch in the created id when the script reaches the backtest step
    orig = agent.dispatch

    def dispatch(name, a):
        if a.get("agent_id") == "__LAST__":
            a["agent_id"] = m.list_agents()[-1]["id"]
        return orig(name, a)
    agent.dispatch = dispatch
    reply = agent.ask("Tell me when Tata Steel crosses its 200 DMA and test it")
    assert reply == "Created and backtested."
    last_results = llm.calls[-1]["content"]
    assert json.loads(last_results[0]["content"])["metrics"]
    assert last_results[1]["is_error"] is True  # bad rule surfaced back to the model


def test_research_agent_reads_inbox():
    llm = ScriptedLLM([])
    m = make_manager(llm)
    (m.settings.inbox_dir / "note.txt").write_text("Bank credit growth accelerating; IT deal wins slowing.")
    a = m.create_agent("research", "reports", {})
    r = m.run_daily(pd.Timestamp.today().normalize(), notify_summary=False)
    assert not r["errors"], r["errors"]
    assert m.agent_report(a["id"])["status"]["summary"] == "Banks strong"
    r2 = m.run_daily(pd.Timestamp.today().normalize(), notify_summary=False)  # no new files -> no new run
    assert r2["signals"] == 0


# ---------------------------------------------------------------- data: no half-day bars
def test_drop_unfinished_session_bar():
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    from tradeos.data.yahoo import drop_unfinished

    ist = ZoneInfo("Asia/Kolkata")
    df = pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1.0},
                      index=pd.DatetimeIndex(["2026-09-29", "2026-09-30"], name="date"))
    at = lambda h, m, d=30: datetime(2026, 9, d, h, m, tzinfo=ist)  # noqa: E731
    nse = {"exchangeTimezoneName": "Asia/Kolkata",
           "currentTradingPeriod": {"regular": {"start": at(9, 15).timestamp(), "end": at(15, 30).timestamp()}}}
    assert len(drop_unfinished(df, nse, at(12, 34))) == 1     # the 30 Sep incident: midday fetch -> today's bar dropped
    assert len(drop_unfinished(df, nse, at(15, 40))) == 1     # closed, but inside the 15-minute grace
    assert len(drop_unfinished(df, nse, at(16, 0))) == 2      # after the close: kept
    assert len(drop_unfinished(df, None, at(12, 34))) == 1    # no metadata: Indian hours assumed
    assert len(drop_unfinished(df, None, at(16, 0))) == 2
    assert len(drop_unfinished(df, nse, datetime(2026, 10, 1, 10, 0, tzinfo=ist))) == 2  # yesterday's finished bar kept
    rolled = {"exchangeTimezoneName": "Asia/Kolkata",
              "currentTradingPeriod": {"regular": {"end": datetime(2026, 10, 1, 15, 30, tzinfo=ist).timestamp()}}}
    assert len(drop_unfinished(df, rolled, at(20, 0))) == 2   # period already rolled to the next session
    ny = ZoneInfo("America/New_York")
    us = pd.DataFrame({"close": [1.0, 1.0]}, index=pd.DatetimeIndex(["2026-09-29", "2026-09-30"]))
    us_meta = {"exchangeTimezoneName": "America/New_York",
               "currentTradingPeriod": {"regular": {"end": datetime(2026, 9, 30, 16, 0, tzinfo=ny).timestamp()}}}
    assert len(drop_unfinished(us, us_meta, datetime(2026, 9, 30, 15, 10, tzinfo=timezone.utc))) == 1  # 20:40 IST, US open
    assert len(drop_unfinished(us, us_meta, datetime(2026, 9, 30, 20, 30, tzinfo=timezone.utc))) == 2  # after US close


# ---------------------------------------------------------------- intraday (NSE live snapshots)
def _synthetic_day(day="2026-10-06"):
    """One snapshot a minute for 4 stocks: UP breaks out of its opening range on volume at 10:00, DN breaks down,
    DIP rises then has a spike low between snapshots, FLAT drifts. Returns [(polled, {sym: Quote})]."""
    import numpy as np

    from tradeos.live.nse_live import Quote
    d0 = pd.Timestamp(day) + pd.Timedelta(hours=9, minutes=15)
    rng = np.random.default_rng(7)
    paths = {}
    n = 376  # 09:15 .. 15:30
    t = np.arange(n)
    noise = lambda s: np.cumsum(rng.normal(0, s, n))  # noqa: E731
    paths["UP"] = 1000 * (1 + np.where(t < 45, 0.0005 * np.sin(t / 3), 0.004 + 0.0002 * (t - 45)) + noise(0.0001))
    paths["DN"] = 500 * (1 - np.where(t < 45, -0.0005 * np.sin(t / 3), 0.004 + 0.0002 * (t - 45)) + noise(0.0001))
    paths["DIP"] = 200 * (1 + np.where(t < 45, 0.0, 0.003 + 0.00002 * (t - 45)) + noise(0.00005))
    paths["FLAT"] = 300 * (1 + noise(0.0002))
    vol_rate = {s: np.where((t >= 45) & (t < 50) & (s in ("UP", "DN")), 40000, 5000) for s in paths}
    polls = []
    state = {s: {"hi": -1e18, "lo": 1e18, "vol": 0.0, "val": 0.0} for s in paths}
    for i in range(n):
        polled = d0 + pd.Timedelta(minutes=i, seconds=40)
        ts = d0 + pd.Timedelta(minutes=i, seconds=30)
        qs = {}
        for s, p in paths.items():
            st = state[s]
            px = round(float(p[i]), 2)
            spike_lo = px * 0.985 if (s == "DIP" and i == 120) else px  # 11:15: a quick dip below any 0.7% stop
            st["hi"], st["lo"] = max(st["hi"], px), min(st["lo"], spike_lo)
            st["vol"] += float(vol_rate[s][i])
            st["val"] += float(vol_rate[s][i]) * px / 1e7
            qs[s] = Quote(s, px, round(float(p[0]), 2), st["hi"], st["lo"], round(float(p[0]), 2), st["vol"], st["val"], str(ts))
        polls.append((polled, qs))
    return polls


def _intraday_specs():
    base = {"symbols": ["UP", "DN", "DIP", "FLAT"], "bar_minutes": 5, "opening_range_minutes": 15, "capital": 1_000_000,
            "max_positions": 2, "position_pct": 50, "start_after": "09:30", "no_entry_after": "13:30", "square_off": "15:15"}
    return [
        {**base, "id": "orb_long", "side": "long", "entry": "close > or_high and close > vwap and volume > 1.5 * sma(volume, 3)",
         "stop_loss_pct": 0.7, "target_pct": 1.4},
        {**base, "id": "orb_short", "side": "short", "entry": "close < or_low and close < vwap and volume > 1.5 * sma(volume, 3)",
         "stop_loss_pct": 0.7},
        {**base, "id": "dip_long", "symbols": ["DIP"], "side": "long", "entry": "close > or_high", "stop_loss_pct": 0.7},
    ]


def test_intraday_bars_and_paper_trades():
    from tradeos.live.intraday import Session, validate_intraday
    validate_intraday("cross_above(ema(close, 9), ema(close, 21)) and close > vwap and minutes > 30 and day_ret > 0")
    polls = _synthetic_day()
    s = Session("2026-10-06", _intraday_specs(), {})
    for polled, qs in polls:
        s.feed(polled, qs)
    s.finish()
    b = s.store.bars("UP", 5, pd.Timestamp("2026-10-06 10:00"))
    assert b.index[0] == pd.Timestamp("2026-10-06 09:15") and b.index[-1] == pd.Timestamp("2026-10-06 09:55") and len(b) == 9
    assert (b["high"] >= b[["open", "close"]].max(axis=1)).all() and (b["low"] <= b[["open", "close"]].min(axis=1)).all()
    assert abs(b["volume"].iloc[1] - 5 * 5000) < 1e-6  # one 5-minute bar of 5000/min
    res = {a["id"]: a for a in s.results()["agents"]}
    lt, st_, dp = res["orb_long"]["trade_list"], res["orb_short"]["trade_list"], res["dip_long"]["trade_list"]
    assert [x["sym"] for x in lt] == ["UP"] and lt[0]["t_entry"].startswith("2026-10-06 10:0"), lt
    assert lt[0]["reason"] in ("target", "square-off") and lt[0]["pnl"] > 0, lt
    assert [x["sym"] for x in st_] == ["DN"] and st_[0]["side"] == "short" and st_[0]["pnl"] > 0, st_
    assert dp and dp[0]["reason"] == "stop" and dp[0]["t_exit"].startswith("2026-10-06 11:15"), dp  # dip between snapshots
    assert all(not a.st.positions for a in s.agents)
    assert all(x["t_exit"] <= "2026-10-06 15:15:59" for a in s.results()["agents"] for x in a["trade_list"])


def test_intraday_resume_matches_one_run():
    """A GitHub job hands off mid-day: state + saved snapshots must reproduce the single-run result exactly."""
    import json as _json

    from tradeos.live.intraday import Session
    polls = _synthetic_day()
    one = Session("2026-10-06", _intraday_specs(), {})
    for polled, qs in polls:
        one.feed(polled, qs)
    one.finish()
    a = Session("2026-10-06", _intraday_specs(), {})
    for polled, qs in polls[:200]:
        a.feed(polled, qs)
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "ticks.csv.gz"
        a.store.frame().to_csv(f, index=False)
        state = _json.loads(_json.dumps(a.state()))
        b = Session("2026-10-06", _intraday_specs(), {}, state, pd.read_csv(f))
    for polled, qs in polls[200:]:
        b.feed(polled, qs)
    b.finish()
    assert _json.dumps(one.results(), sort_keys=True) == _json.dumps(b.results(), sort_keys=True)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("PASS", name)


def test_intraday_app_engine_matches_python():
    """Agents built in the app run live with "engine": "js" (lab/engine.js via scripts/intraday_eval.mjs): same trades."""
    import shutil

    from tradeos.live.intraday import Session
    if not shutil.which("node"):
        return
    polls = _synthetic_day()
    out = {}
    for eng in ("py", "js"):
        specs = [{**s, **({"engine": "js"} if eng == "js" else {})} for s in _intraday_specs()]
        s = Session("2026-10-06", specs, {})
        for polled, qs in polls:
            s.feed(polled, qs)
        s.finish()
        out[eng] = s.results()["agents"]
    assert out["py"] == out["js"], (out["py"], out["js"])
