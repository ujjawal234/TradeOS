# TradeOS engine (browser + Node)

`engine.js` is the engine behind the team app, the daily paper run (`scripts/daily_run.mjs`) and this lab page.
It started as a port of the Python engine; the app engine is now a superset of it (the extras below are JS-only —
the Python CLI still runs the original rule / rotation / option-selling specs).

## What it can run

**Rule strategies** — entry/exit expressions per symbol; fixed %, trailing %, ATR and time exits; long or short.
Portfolio mode (`max_positions`, `rank_by`) shares one pot of capital across symbols and ranks competing signals.

**Rotation / portfolio engine** — ranks any universe (stocks, sector/factor/thematic indices, debt indices, custom lists):
- scores: `momentum`, `risk_adj`, `nse_momentum` (NSE momentum-index recipe), any rule-language expression, or several
  `factors` (momentum, risk_adj, volatility/low_vol, trend, high_52w, reversal, liquidity, expressions) z-scored and averaged
- `filters`, `min_history_days`, `exclude`, `top_n` / `top_pct`, `buffer_rank`, `max_per_sector`, long-short (`short_n`)
- weights: equal, score (NSE normalised), inverse_vol, mcap, mcap_score, rank, or an expression; `max_weight_pct` caps
- schedules: daily … annual, or `rebalance_months` (e.g. [6, 12])
- risk: trend filter, `regime` expression with cash / reduce / defensive action, volatility targeting, idle cash parked in
  the overnight-rate index (`cash_symbol`) or a flat `cash_yield_pct`, slippage
- stats: orders, rebalances, round trips and win rate, turnover, average holdings and holding period

**Option selling** — model-priced short strangles, straddles, iron condors and single legs on the F&O indices.

Every type takes `benchmark` (any symbol, default NIFTY). Rule language: see `FUNCS` / `VARS` in `engine.js`
(indicators, statistics, oscillators, `ref("SYMBOL", expr)` for cross-symbol conditions).

Old specs are untouched: new fields are only written when given, and results for older specs are identical.

## Checks
```
python app/build.py build && python scripts/build_app_data.py build
git show <older commit>:lab/engine.js > /tmp/old_engine.js
node tests/engine_check.mjs build /tmp/old_engine.js     # feature + edge cases, and identical legacy results
```

## Lab page
```
python scripts/build_lab_data.py lab/build            # data/prices/*.csv -> lab/build/data/*.json
python - <<'PY'
t=open('lab/template.html').read(); e=open('lab/engine.js').read()
open('lab/build/index.html','w').write(t.replace('/*__ENGINE__*/', e))
PY
```
Publish `lab/build/index.html` with the `data/` folder alongside it.
