# TradeOS

**The team app** (Claude artifact, private until shared): Main Agent · Agents · Agent rooms · Today's signals.
Open it from claude.ai → Artifacts → "TradeOS". Everything runs in the cloud; no local install needed.

How it runs every weekday
1. 16:00 IST — GitHub Actions `Fetch market data` refreshes Yahoo prices (indices, VIX, world markets; stock fallback),
   NSE index files, constituent lists and lot sizes. 19:00 IST — `Point-in-time universe` downloads NSE's bhavcopy,
   which is the source of every stock price in the app. 19:10 IST — `Option prices` (NSE F&O bhavcopy).
2. 20:38 IST — a scheduled Claude task makes sure all three are fresh (requesting a run if not), rebuilds and republishes
   the app data, runs every paper-trading agent with `scripts/daily_run.mjs` (same engine as the app: `lab/engine.js`),
   writes results to the app database and `paper/<date>.json`, updates `alerts/latest.json` (→ Telegram) and sends a
   phone push when there are buy/sell signals.

Data timing safeguards
* A fetch while a market is open never stores that day's half-finished bar (`drop_unfinished` in
  `tradeos/data/yahoo.py`); the bar is added by the next run after the close. `data/manifest.json` records `fetched_at`
  (UTC) so the daily task can tell a post-close refresh from a midday one.
* `daily_run.mjs` checks every series an agent uses against the latest session. If a source is late (e.g. NSE's stock
  bhavcopy not published yet while index data is), that agent's signals are held back and the alert says why
  (`data_check` in the output). A single late stock in a large universe (suspension, delisting) is only a warning.

Intraday (paper) on NSE's live data
* GitHub Actions `Intraday paper trading (NSE live)` starts ~09:08 IST on weekdays and polls NSE's official MCP server
  (`https://mcp.nseindia.in/cmmkt/mcp`, no key) once a minute until 15:31. NSE's data refreshes once a minute and runs
  1-3 minutes behind the market, so the agents work on 3-5 minute bars, not ticks.
* Agents: `intraday/agents.json` (opening-range breakout long/short, EMA trend; edit or add). Rules use the normal
  expression language plus `vwap`, `or_high`, `or_low`, `day_open`, `prev_close`, `day_high`, `day_low`, `day_ret`,
  `minutes`. Stops/targets are checked on every snapshot (including moves between snapshots); everything is squared
  off at `square_off` (default 15:15). Costs and slippage are charged per side.
* Each day: entries/exits go to Telegram as they happen; `data/intraday/<date>.csv.gz` keeps every snapshot (replay any
  day with `python scripts/intraday_run.py --replay data/intraday/<date>.csv.gz`), `intraday/results/<date>.json` the
  trades and P&L. Test the connection with the workflow's "probe" option or `python scripts/intraday_run.py --probe`.
* NSE allows this data for informational/educational use only. Paper trading only.

Telegram (optional): create a bot with @BotFather, then in this repo add Settings → Secrets and variables → Actions →
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Paper trading and research only. Not investment advice.

---

## Python toolkit (CLI)

Agentic research, backtesting and **paper-trading** system for Indian markets (NSE).
A Claude-powered **Main Agent** creates, runs and destroys sub-agents — alerts, rule strategies,
momentum/sector rotation, option selling, and report readers — backtests each one and paper-trades it daily.

> Paper trading and research only. Nothing here is investment advice.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full design, execution model and roadmap.

## Setup (5 minutes)

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                   # add ANTHROPIC_API_KEY (+ Telegram, optional)
python -m tradeos init
python -m tradeos check-data                           # confirms NSE/index symbols resolve on Yahoo
python -m tradeos demo                                 # offline walkthrough on synthetic data
python -m pytest -q                                    # tests (no network needed)
```

## Talk to the Main Agent

```bash
python -m tradeos chat
you> Alert me when Tata Steel closes above 180 and when Nifty RSI drops below 30
you> Build a 55-day breakout strategy on HDFCBANK, ICICIBANK, SBIN, AXISBANK with a 6% stop and backtest from 2018
you> Which sectors are leading? Set up a weekly sector rotation holding the top 3
you> Sell Nifty weekly 0.15-delta strangles, stop at 2x credit, skip weeks when VIX > 22
you> Add TITAN and TRENT to the breakout agent
you> I dropped Q2 results PDFs in the inbox — what should we focus on?
you> Destroy the strangle agent
```
One-shot (for scripts): `python -m tradeos ask "how did my agents do this week?"`

## Or drive it directly

```bash
python -m tradeos types                                   # agent types, defaults, examples
python -m tradeos create rule --name "EMA trend" --spec examples/ema_trend.json --backtest
python -m tradeos create alert --name "Levels" --spec examples/alerts.json
python -m tradeos add-alert <id> --symbol RELIANCE --above 3000
python -m tradeos add-symbols <id> TITAN TRENT
python -m tradeos backtest <id> --start 2018-01-01        # metrics + chart in tradeos_data/backtests/
python -m tradeos daily                                   # run paper cycle, write report
python -m tradeos list | show <id> | pause <id> | resume <id> | destroy <id>
python -m tradeos rank --universe sectors                 # which sectors are strong now
python -m tradeos quote INFY
```

## Schedule the daily run (after market close)

Linux/macOS `crontab -e` (IST machine):
```
50 15 * * 1-5  cd /path/to/tradeos && .venv/bin/python -m tradeos daily >> tradeos_data/cron.log 2>&1
```
Windows Task Scheduler: action `C:\path\to\tradeos\.venv\Scripts\python.exe -m tradeos daily`,
start in `C:\path\to\tradeos`, weekdays 15:50.

## Research inbox

Drop PDF / TXT / MD / CSV / DOCX reports into `tradeos_data/inbox/` (or any folder you name in the
agent's `inputs`). The research agent re-reads when files change and posts overweight/underweight views,
cross-checked against sector momentum, plus suggested follow-up agents.

## Data

* `yahoo` (default): free end-of-day NSE data, cached. Good for research and paper trading.
* `csv`: put `<SYMBOL>.csv` (date,open,high,low,close,volume) in `tradeos_data/csv/` — e.g. broker exports.
* `synthetic`: fake prices for demos/tests.
* Broker APIs (Kite/Upstox/Dhan) for intraday and real option chains are Phase 2.

Check and edit `tradeos/data/universe.py` when the Nifty 50 changes.
