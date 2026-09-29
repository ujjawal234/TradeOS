# TradeOS

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
