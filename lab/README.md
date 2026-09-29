# Strategy Lab (browser backtester)

`engine.js` is a JavaScript port of the Python engine (rules DSL, rule backtests, rotation,
option selling, metrics). It is cross-checked against Python: identical results on real data.

Rebuild the page:
```
python scripts/build_lab_data.py lab/build            # data/prices/*.csv -> lab/build/data/*.json
python - <<'PY'
t=open('lab/template.html').read(); e=open('lab/engine.js').read()
open('lab/build/index.html','w').write(t.replace('/*__ENGINE__*/', e))
PY
```
Publish `lab/build/index.html` with the `data/` folder alongside it.
