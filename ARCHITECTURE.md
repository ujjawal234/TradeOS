# TradeOS — Architecture & Build Plan

## 1. What we are building

One **Main Agent** that owns everything — data, storage, notifications, the Claude "brain" — and a fleet of
**sub-agents**, one per strategy or task. The Main Agent can create any sub-agent, change it, pause it and
destroy it. Every sub-agent can be **backtested** and then runs **daily on paper**, producing results you can
compare against its backtest and against NIFTY.

```
                        ┌──────────────────────────────────────────────┐
  you ── chat / CLI ──▶ │  MAIN AGENT                                    │
  (plain language)      │  brain.py  : Claude + 15 tools                 │
                        │  manager.py: create / update / pause / destroy │
                        │              backtest / run_daily / report     │
                        └──────┬───────────────┬───────────────┬────────┘
                               │               │               │
                 ┌─────────────▼───┐   ┌───────▼───────┐  ┌────▼────────────┐
                 │ DATA            │   │ SUB-AGENTS    │  │ OUTPUT          │
                 │ Yahoo (NSE EOD) │   │ alert         │  │ SQLite ledger   │
                 │ CSV (broker)    │   │ rule          │  │ daily report .md│
                 │ synthetic(test) │   │ rotation      │  │ Telegram        │
                 │ [broker API]    │   │ option_selling│  │ backtest charts │
                 └─────────────────┘   │ research      │  └─────────────────┘
                                       │ [+ your own]  │
                                       └───────┬───────┘
                                               │ same PaperBroker for both
                                   backtest ◀──┴──▶ daily paper trading
```

## 2. How your requests map to sub-agents

| You say | Main Agent creates |
|---|---|
| "Tell me when RELIANCE crosses 3000" | `alert` agent (`above: 3000`), edge-triggered, Telegram message |
| "Alert me if Nifty closes below 200 DMA or HDFC Bank RSI < 30" | one `alert` agent with two conditions |
| "Here are 10 stocks, run a 20/50 EMA trend strategy on them" | `rule` agent + backtest; add more stocks later with `add-symbols` |
| "Short weak stocks below 50 DMA with 5% stop" | `rule` agent, `side: short`, `stop_loss_pct: 5` |
| "Which sectors should we focus on?" | `rank_universe` answer now, `rotation` agent on `sectors` to track it |
| "Momentum portfolio of top 5 Nifty stocks" | `rotation` agent on `nifty50`, monthly, trend filter |
| "Sell Nifty weekly strangles / iron condors" | `option_selling` agent (delta or %OTM strikes, SL, target, VIX filter) |
| "Read these reports and tell us what to focus on" | `research` agent over `inbox/*`, then suggested follow-up agents |
| Anything compound | several agents wired together by the Main Agent |

The **expression DSL** is what makes it "handle anything" without writing code per strategy: any condition
on price, volume and ~25 indicators (`cross_above`, `rsi`, `highest`, `bb_lower`, `atr_pct`, `count_true`, …)
combined with `and / or / not`. It is parsed and interpreted, never `eval`'d, so the LLM can write rules
safely. New agent *types* are one Python class each (see §6).

## 3. Execution model (important for trusting results)

* **End-of-day.** Signals are computed on today's close; orders fill at **next day's open** (rule agents)
  or today's close (rotation rebalances, option entries). No look-ahead.
* **Identical accounting.** Backtests and paper accounts use the same `PaperBroker`. The test suite verifies
  paper trading reproduces the backtest's entry/exit dates exactly.
* **Costs.** Equity: 0.12% per side (STT + exchange + stamp + GST, delivery approx). Options: ₹20/order +
  0.15% of premium. All configurable per agent.
* **Idempotent daily runs.** Running `daily` twice doesn't double-trade; missed days are caught up (up to 10 bars).
* **Options are model-priced**: Black-Scholes with India VIX as IV. Real OTM puts carry skew, so real credits
  for puts are higher than modelled; stops are checked on daily closes only (gaps overshoot). Treat option
  backtests as directional until a real option-chain feed is plugged in (Phase 2).
* **NSE defaults (2026):** NIFTY weekly expiry Tuesday, lot 65; BANKNIFTY monthly only (last Tuesday), lot 30;
  FINNIFTY lot 60. Exchange holiday shifts of expiry are not modelled.

## 4. Daily cycle

`python -m tradeos daily` after 15:45 IST (cron / Task Scheduler) →
each active agent processes new bars → fills, stops, new signals, marks to market →
`reports/YYYY-MM-DD.md` + Telegram summary. Individual alerts/signals go to Telegram as they fire.

## 5. Roadmap

**Phase 1 — built now**
Main Agent (Claude tool loop + CLI), 5 sub-agent types, rule DSL, backtester with benchmark & charts,
paper ledger, daily reports, Telegram, Yahoo/CSV/synthetic data, test suite.

**Phase 2 — real-time & real prices (next)**
* Broker data adapter (Zerodha Kite Connect, Upstox, Dhan or Angel SmartAPI — pick one) implementing
  `DataProvider` + an `OptionChainProvider`, replacing Yahoo and Black-Scholes pricing.
* Intraday alert loop (poll every 1–5 min, 09:15–15:30) so level-cross alerts fire during market hours.
* Intraday stop-loss handling for option selling.
* Web dashboard (Streamlit) over the same SQLite ledger: agents, equity curves, signals.
* Walk-forward / out-of-sample testing and parameter-robustness reports so backtests aren't curve-fit.
* Portfolio-level risk: capital per agent, max exposure, correlation between agents.

**Phase 3 — live trading (only after paper track record)**
* Order routing through the broker with a **human-approval gate**, kill switch and per-agent limits.
* SEBI's retail algo framework requires API algos to be approved/registered through your broker — confirm
  the process with the broker before sending any automated orders.
* "Code agents": let the Main Agent write new agent types in a sandbox, auto-tested before activation.

## 6. Extending

```python
# tradeos/agents/my_agent.py
from .base import BaseAgent, register

@register
class MyAgent(BaseAgent):
    type_name = "my_agent"
    description = "What it does (the Main Agent reads this)."
    defaults = {"symbols": [], "capital": 1_000_000}
    example = {"symbols": ["TCS"]}
    def backtest(self, start=None, end=None): ...   # return {"equity": Series, "trades": [...], "metrics": {...}}
    def run_daily(self, asof): ...                   # use self.broker(), self.signal(...); return {"signals": self._emitted}
```
Import it in `agents/__init__.py`; the Main Agent sees it immediately.

## 7. Code map

| File | Role |
|---|---|
| `manager.py` | Main Agent body: agent lifecycle, backtest, daily run, reports |
| `brain.py` | Claude tool-use loop, system prompt, tool definitions |
| `agents/*.py` | Sub-agent types |
| `rules.py`, `indicators.py` | Safe expression DSL |
| `backtest.py`, `paper.py` | Backtest engine/metrics, paper broker |
| `options_math.py` | Black-Scholes, delta, NSE expiry helpers |
| `data/` | Yahoo, CSV, synthetic providers; symbols & universes |
| `analytics.py` | Relative-strength ranking, price summary |
| `storage.py` | SQLite ledger |
| `notify.py`, `report.py` | Telegram/log notifications, daily markdown report |
| `cli.py` | Command line |
