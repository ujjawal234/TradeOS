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


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("PASS", name)
