"""The Main Agent's brain: Claude with tools over the Manager.

You talk to it in plain language ("alert me when Tata Steel closes above 180",
"build a momentum strategy on bank stocks and backtest it", "read these results PDFs and tell me
which sectors to focus on"). It decides which sub-agents to create, validates rules, backtests,
and reports back — all through the same Manager methods the CLI uses.
"""
from __future__ import annotations

import json

import pandas as pd

from .data.universe import INDICES, SECTORS, UNIVERSES
from .manager import Manager, today_ist
from .rules import docs as rule_docs
from .rules import validate

MAX_TOOL_CHARS = 15000

TOOLS = [
    {"name": "list_agent_types", "description": "Describe every sub-agent type with defaults and an example spec.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "list_agents", "description": "List current sub-agents with status and paper equity.",
     "input_schema": {"type": "object", "properties": {"include_destroyed": {"type": "boolean"}}}},
    {"name": "create_agent", "description": "Create a sub-agent. Unspecified spec fields take the type's defaults.",
     "input_schema": {"type": "object", "properties": {
         "type": {"type": "string"}, "name": {"type": "string"}, "spec": {"type": "object"}},
         "required": ["type", "name", "spec"]}},
    {"name": "update_agent", "description": "Change fields of an agent's spec (merged into the existing spec).",
     "input_schema": {"type": "object", "properties": {
         "agent_id": {"type": "string"}, "spec_patch": {"type": "object"}}, "required": ["agent_id", "spec_patch"]}},
    {"name": "set_agent_status", "description": "Pause or resume an agent.",
     "input_schema": {"type": "object", "properties": {
         "agent_id": {"type": "string"}, "status": {"type": "string", "enum": ["active", "paused"]}},
         "required": ["agent_id", "status"]}},
    {"name": "destroy_agent", "description": "Destroy an agent (closes its paper positions unless liquidate=false). "
                                             "Confirm with the user before destroying anything they did not ask to remove.",
     "input_schema": {"type": "object", "properties": {
         "agent_id": {"type": "string"}, "liquidate": {"type": "boolean"}}, "required": ["agent_id"]}},
    {"name": "add_symbols", "description": "Add symbols to a rule agent (or a rotation agent with a custom list).",
     "input_schema": {"type": "object", "properties": {
         "agent_id": {"type": "string"}, "symbols": {"type": "array", "items": {"type": "string"}}},
         "required": ["agent_id", "symbols"]}},
    {"name": "remove_symbols", "description": "Remove symbols from a rule/rotation agent.",
     "input_schema": {"type": "object", "properties": {
         "agent_id": {"type": "string"}, "symbols": {"type": "array", "items": {"type": "string"}}},
         "required": ["agent_id", "symbols"]}},
    {"name": "add_alert", "description": "Add one alert to an alert agent. alert = {symbol, and one of expr/above/"
                                        "below/touch_above/touch_below/move_pct, optional message}.",
     "input_schema": {"type": "object", "properties": {
         "agent_id": {"type": "string"}, "alert": {"type": "object"}}, "required": ["agent_id", "alert"]}},
    {"name": "validate_rule", "description": "Check that a DSL expression parses and evaluates.",
     "input_schema": {"type": "object", "properties": {"expr": {"type": "string"}}, "required": ["expr"]}},
    {"name": "backtest_agent", "description": "Backtest an agent. Dates YYYY-MM-DD, optional.",
     "input_schema": {"type": "object", "properties": {
         "agent_id": {"type": "string"}, "start": {"type": "string"}, "end": {"type": "string"}},
         "required": ["agent_id"]}},
    {"name": "agent_report", "description": "Paper account, positions, trades, signals, last backtest, status.",
     "input_schema": {"type": "object", "properties": {"agent_id": {"type": "string"}}, "required": ["agent_id"]}},
    {"name": "run_daily", "description": "Run the daily paper cycle for all active agents (or given ids).",
     "input_schema": {"type": "object", "properties": {
         "date": {"type": "string"}, "agent_ids": {"type": "array", "items": {"type": "string"}}}}},
    {"name": "price_summary", "description": "Returns, 52w range, SMA50/200, RSI, ATR% and last closes for a symbol.",
     "input_schema": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]}},
    {"name": "rank_universe", "description": "Relative-strength ranking of a universe (sectors, nifty50, indices "
                                            "or a list of symbols) by 1m/3m/6m returns.",
     "input_schema": {"type": "object", "properties": {
         "universe": {"anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
         "top": {"type": "integer"}}}},
]


def system_prompt(m: Manager) -> str:
    types = json.dumps(m.agent_types(), indent=1, default=str)
    return f"""You are the Main Agent of TradeOS, a research, backtesting and PAPER-trading system for Indian markets (NSE/BSE).
You own all data access and a fleet of sub-agents. You create, modify, pause, destroy, backtest and monitor them.
Today is {today_ist().date()} (IST). Data is end-of-day.

HOW TO HANDLE A REQUEST
1. Work out the intent: an alert/indication, a systematic strategy, a ranking/rotation (momentum, sectors), option selling,
   research on reports, or a question you can answer directly with price_summary / rank_universe.
2. Map it onto one or more sub-agents. Compound requests become several agents (e.g. "find strong sectors from these reports
   and alert me when their leaders break out" = research agent + rotation/rank + alert agent).
3. validate_rule every DSL expression before create_agent. Fix errors yourself.
4. After creating a rule, rotation or option_selling agent, ALWAYS backtest it and report: CAGR, max drawdown, Sharpe,
   trades, win rate, versus the NIFTY benchmark. Point out weaknesses (few trades, big drawdown, cost drag, overfit risk).
5. Keep rules simple and explainable. Do not silently grid-search parameters. At most propose one or two variations and say so.
6. When the user gives stocks to track "regularly", add them with add_symbols / add_alert to the right existing agent
   instead of creating duplicates. Check list_agents first.
7. Everything is paper trading. Never promise returns. You are not a SEBI-registered adviser; say so when giving views.
8. Be concise. Report ids of agents you create so the user can refer to them.

SYMBOLS: NSE tickers without suffix (RELIANCE, TCS, HDFCBANK, M&M, BAJAJ-AUTO). Indices: {', '.join(INDICES)}, INDIAVIX.
Sector indices: {', '.join(SECTORS)}. Named universes: {', '.join(UNIVERSES)} (or pass a list).

EXPRESSION DSL (for rule entry/exit and alert expr):
{rule_docs()}
Examples:
  cross_above(close, 2500)                      # price crosses a level
  close > shift(highest(high, 55), 1)           # 55-day breakout
  rsi(close, 2) < 10 and close > sma(close, 200)  # pullback in uptrend
  close < bb_lower(close, 20, 2)

SUB-AGENT TYPES:
{types}
"""


class MainAgent:
    def __init__(self, manager: Manager, llm=None):
        self.m = manager
        self.llm = llm or manager.get_llm()
        self.messages: list = []
        self.system = system_prompt(manager)

    def dispatch(self, name: str, a: dict):
        m = self.m
        if name == "list_agent_types":
            return m.agent_types()
        if name == "list_agents":
            return m.list_agents(a.get("include_destroyed", False))
        if name == "create_agent":
            return m.create_agent(a["type"], a["name"], a.get("spec", {}))
        if name == "update_agent":
            return m.update_agent(a["agent_id"], a["spec_patch"])
        if name == "set_agent_status":
            return m.set_status(a["agent_id"], a["status"])
        if name == "destroy_agent":
            return m.destroy_agent(a["agent_id"], a.get("liquidate", True))
        if name == "add_symbols":
            return m.add_symbols(a["agent_id"], a["symbols"])
        if name == "remove_symbols":
            return m.remove_symbols(a["agent_id"], a["symbols"])
        if name == "add_alert":
            return m.add_alert(a["agent_id"], a["alert"])
        if name == "validate_rule":
            validate(a["expr"])
            return {"ok": True}
        if name == "backtest_agent":
            return m.backtest(a["agent_id"], a.get("start"), a.get("end"))
        if name == "agent_report":
            return m.agent_report(a["agent_id"])
        if name == "run_daily":
            return m.run_daily(a.get("date"), a.get("agent_ids"))
        if name == "price_summary":
            return m.price_summary(a["symbol"])
        if name == "rank_universe":
            return m.rank(a.get("universe", "sectors"), top=a.get("top"))
        raise ValueError(f"unknown tool {name}")

    def ask(self, text: str, on_tool=None, max_steps: int = 25) -> str:
        self.messages.append({"role": "user", "content": text})
        for _ in range(max_steps):
            resp = self.llm.create(self.system, self.messages, tools=TOOLS)
            self.messages.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason != "tool_use":
                return "".join(getattr(b, "text", "") for b in resp.content).strip()
            results = []
            for block in resp.content:
                if getattr(block, "type", None) != "tool_use":
                    continue
                if on_tool:
                    on_tool(block.name, block.input)
                try:
                    out, err = self.dispatch(block.name, dict(block.input or {})), False
                except Exception as e:
                    out, err = {"error": f"{type(e).__name__}: {e}"}, True
                payload = json.dumps(out, default=_json_default)
                if len(payload) > MAX_TOOL_CHARS:
                    payload = payload[:MAX_TOOL_CHARS] + "...(truncated)"
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": payload,
                                "is_error": err})
            self.messages.append({"role": "user", "content": results})
        return "Stopped after too many tool steps; ask me to continue."


def _json_default(o):
    if isinstance(o, (pd.Timestamp,)):
        return str(o.date())
    if hasattr(o, "item"):
        return o.item()
    return str(o)
