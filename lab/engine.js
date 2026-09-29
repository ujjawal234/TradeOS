/* TradeOS browser engine — a faithful port of tradeos/{rules,indicators,backtest}.py,
   agents/rotation.py and agents/option_selling.py. Works in the browser (window.TradeEngine)
   and in Node (module.exports) so it can be checked against the Python engine. */
(function (root) {
  "use strict";
  const NaNv = NaN;
  const isNum = (x) => typeof x === "number";
  const isSeries = (x) => x instanceof Float64Array || x instanceof Uint8Array;

  // ----------------------------------------------------------------- symbols
  const INDEX_KEYS = new Set(["NIFTY", "NIFTY50", "BANKNIFTY", "NIFTYBANK", "SENSEX", "INDIAVIX", "NIFTYIT",
    "NIFTYPHARMA", "NIFTYFMCG", "NIFTYAUTO", "NIFTYMETAL", "NIFTYREALTY", "NIFTYENERGY", "NIFTYPSUBANK",
    "NIFTYMEDIA", "NIFTYINFRA", "NIFTYFIN"]);
  const isIndex = (s) => INDEX_KEYS.has(s) || s.startsWith("^");

  // ----------------------------------------------------------------- series helpers
  function f64(n, v = NaNv) { const a = new Float64Array(n); if (v !== 0) a.fill(v); return a; }
  function toF(x, n) {
    if (x instanceof Float64Array) return x;
    if (x instanceof Uint8Array) { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = x[i]; return a; }
    return f64(n, Number(x));
  }
  function toB(x, n) {
    if (x instanceof Uint8Array) return x;
    const a = new Uint8Array(n);
    if (x instanceof Float64Array) { for (let i = 0; i < n; i++) a[i] = (x[i] === x[i] && x[i] !== 0) ? 1 : 0; return a; }
    a.fill(Number(x) ? 1 : 0); return a;
  }
  function rolling(x, n, fn) { // fn(windowValues[]) on windows with n valid values, else NaN
    n = Math.trunc(n); const L = x.length, out = f64(L);
    for (let i = n - 1; i < L; i++) {
      let ok = true; const w = new Array(n);
      for (let j = 0; j < n; j++) { const v = x[i - n + 1 + j]; if (v !== v) { ok = false; break; } w[j] = v; }
      if (ok) out[i] = fn(w);
    }
    return out;
  }
  const mean = (w) => { let s = 0; for (const v of w) s += v; return s / w.length; };
  const std1 = (w) => { if (w.length < 2) return NaNv; const m = mean(w); let s = 0; for (const v of w) s += (v - m) * (v - m); return Math.sqrt(s / (w.length - 1)); };
  function shift(x, k) { k = Math.trunc(k); const L = x.length, o = f64(L); for (let i = 0; i < L; i++) { const j = i - k; if (j >= 0 && j < L) o[i] = x[j]; } return o; }

  // pandas ewm(adjust=False, min_periods=mp) with NaNs skipped (ignore_na-like; inputs here have leading NaNs only)
  function ewm(x, alpha, mp = 0) {
    const L = x.length, o = f64(L); let s = NaNv, cnt = 0;
    for (let i = 0; i < L; i++) {
      const v = x[i];
      if (v === v) { s = (s !== s) ? v : (1 - alpha) * s + alpha * v; cnt++; }
      if (s === s && cnt >= Math.max(mp, 1)) o[i] = s;
    }
    return o;
  }

  // ----------------------------------------------------------------- indicators
  const IND = {
    sma: (x, n) => rolling(x, n, mean),
    ema: (x, n) => ewm(x, 2 / (Math.trunc(n) + 1), Math.trunc(n)),
    wma: (x, n) => { n = Math.trunc(n); let ws = 0; for (let k = 1; k <= n; k++) ws += k; return rolling(x, n, (w) => { let s = 0; for (let k = 0; k < n; k++) s += w[k] * (k + 1); return s / ws; }); },
    rsi: (x, n = 14) => {
      n = Math.trunc(n); const L = x.length, up = f64(L), dn = f64(L);
      for (let i = 1; i < L; i++) { const d = x[i] - x[i - 1]; if (d === d) { up[i] = d > 0 ? d : 0; dn[i] = d < 0 ? -d : 0; } }
      const au = ewm(up, 1 / n, n), ad = ewm(dn, 1 / n, n), o = f64(L);
      for (let i = 0; i < L; i++) { if (au[i] !== au[i]) continue; o[i] = ad[i] === 0 ? 100 : 100 - 100 / (1 + au[i] / ad[i]); }
      return o;
    },
    atr: (df, n = 14) => {
      n = Math.trunc(n); const L = df.c.length, tr = f64(L);
      for (let i = 0; i < L; i++) {
        let m = df.h[i] - df.l[i];
        if (i > 0) { const pc = df.c[i - 1]; m = Math.max(m, Math.abs(df.h[i] - pc), Math.abs(df.l[i] - pc)); }
        tr[i] = m;
      }
      return ewm(tr, 1 / n, n);
    },
    macd: (x, f = 12, s = 26) => { const a = ewm(x, 2 / (Math.trunc(f) + 1)), b = ewm(x, 2 / (Math.trunc(s) + 1)); return a.map((v, i) => v - b[i]); },
    bbu: (x, n = 20, k = 2) => { const m = IND.sma(x, n), sd = rolling(x, n, std1); return m.map((v, i) => v + k * sd[i]); },
    bbl: (x, n = 20, k = 2) => { const m = IND.sma(x, n), sd = rolling(x, n, std1); return m.map((v, i) => v - k * sd[i]); },
    crossA: (a, b) => { const L = a.length, o = new Uint8Array(L); for (let i = 1; i < L; i++) o[i] = (a[i] > b[i] && a[i - 1] <= b[i - 1]) ? 1 : 0; return o; },
    crossB: (a, b) => { const L = a.length, o = new Uint8Array(L); for (let i = 1; i < L; i++) o[i] = (a[i] < b[i] && a[i - 1] >= b[i - 1]) ? 1 : 0; return o; },
  };

  // ----------------------------------------------------------------- DSL parser (Python-like expressions)
  class RuleError extends Error {}
  const FUNCS = ["sma", "ema", "wma", "rsi", "atr", "atr_pct", "macd", "macd_signal", "bb_upper", "bb_lower", "highest", "lowest",
    "shift", "prev", "change", "roc", "stdev", "zscore", "volatility", "cross_above", "cross_below", "count_true", "abs", "max", "min"];
  const VARS = ["open", "high", "low", "close", "volume", "hl2", "dow"];

  function tokenize(src) {
    const t = []; let i = 0;
    const two = [">=", "<=", "==", "!=", "**", "&&", "||"];
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) { let j = i; while (j < src.length && /[0-9.eE]/.test(src[j])) { if (/[eE]/.test(src[j]) && /[+-]/.test(src[j + 1])) j++; j++; } const v = Number(src.slice(i, j)); if (!isFinite(v)) throw new RuleError(`Bad number '${src.slice(i, j)}'`); t.push({ k: "num", v }); i = j; continue; }
      if (/[A-Za-z_]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++; t.push({ k: "id", v: src.slice(i, j) }); i = j; continue; }
      const p2 = src.slice(i, i + 2);
      if (two.includes(p2)) { t.push({ k: "op", v: p2 === "&&" ? "and" : p2 === "||" ? "or" : p2 }); i += 2; continue; }
      if ("+-*/%()<>,=!".includes(c)) { t.push({ k: "op", v: c === "!" ? "not" : c }); i++; continue; }
      throw new RuleError(`Unexpected character '${c}'`);
    }
    return t;
  }
  function parse(src) {
    if (!src || !String(src).trim()) throw new RuleError("Empty expression");
    const t = tokenize(String(src)); let p = 0;
    const peek = () => t[p], next = () => t[p++];
    const isOp = (v) => t[p] && ((t[p].k === "op" && t[p].v === v) || (t[p].k === "id" && t[p].v === v && ["and", "or", "not"].includes(v)));
    const expect = (v) => { if (!isOp(v)) throw new RuleError(`Expected '${v}' in '${src}'`); p++; };
    function orE() { let n = andE(); while (isOp("or")) { p++; n = { t: "bool", op: "or", a: n, b: andE() }; } return n; }
    function andE() { let n = notE(); while (isOp("and")) { p++; n = { t: "bool", op: "and", a: n, b: notE() }; } return n; }
    function notE() { if (isOp("not")) { p++; return { t: "not", a: notE() }; } return cmp(); }
    function cmp() {
      const first = add(); const parts = [];
      while (t[p] && t[p].k === "op" && [">", "<", ">=", "<=", "==", "!="].includes(t[p].v)) { const op = next().v; parts.push([op, add()]); }
      return parts.length ? { t: "cmp", first, parts } : first;
    }
    function add() { let n = mul(); while (t[p] && t[p].k === "op" && (t[p].v === "+" || t[p].v === "-")) { const op = next().v; n = { t: "bin", op, a: n, b: mul() }; } return n; }
    function mul() { let n = unary(); while (t[p] && t[p].k === "op" && ["*", "/", "%"].includes(t[p].v)) { const op = next().v; n = { t: "bin", op, a: n, b: unary() }; } return n; }
    function unary() { if (t[p] && t[p].k === "op" && (t[p].v === "-" || t[p].v === "+")) { const op = next().v; const a = unary(); return op === "-" ? { t: "neg", a } : a; } return pow(); }
    function pow() { const b = prim(); if (t[p] && t[p].k === "op" && t[p].v === "**") { p++; return { t: "bin", op: "**", a: b, b: unary() }; } return b; }
    function prim() {
      const tk = next();
      if (!tk) throw new RuleError(`Unexpected end of '${src}'`);
      if (tk.k === "num") return { t: "num", v: tk.v };
      if (tk.k === "op" && tk.v === "(") { const n = orE(); expect(")"); return n; }
      if (tk.k === "id") {
        if (tk.v === "True" || tk.v === "true") return { t: "num", v: 1 };
        if (tk.v === "False" || tk.v === "false") return { t: "num", v: 0 };
        if (isOp("(")) {
          p++; const args = [], kw = {};
          if (!isOp(")")) {
            for (;;) {
              if (t[p] && t[p].k === "id" && t[p + 1] && t[p + 1].k === "op" && t[p + 1].v === "=") { const name = next().v; p++; kw[name] = orE(); }
              else args.push(orE());
              if (isOp(",")) { p++; continue; }
              break;
            }
          }
          expect(")");
          if (!FUNCS.includes(tk.v)) throw new RuleError(`Unknown function '${tk.v}'. Allowed: ${FUNCS.join(", ")}`);
          return { t: "call", f: tk.v, args, kw };
        }
        if (!VARS.includes(tk.v)) throw new RuleError(`Unknown variable '${tk.v}'. Allowed: ${VARS.join(", ")}`);
        return { t: "var", v: tk.v };
      }
      throw new RuleError(`Unexpected '${tk.v}' in '${src}'`);
    }
    const ast = orE();
    if (p < t.length) throw new RuleError(`Unexpected '${t[p].v}' in '${src}'`);
    return ast;
  }

  function evaluate(ast, df) {
    const L = df.c.length;
    const vars = { open: df.o, high: df.h, low: df.l, close: df.c, volume: df.v };
    const S = (x) => toF(x, L), B = (x) => toB(x, L);
    const bin = (op, a, b) => {
      if (isNum(a) && isNum(b)) return binNum(op, a, b);
      const A = S(a), Bb = S(b), o = f64(L); for (let i = 0; i < L; i++) o[i] = binNum(op, A[i], Bb[i]); return o;
    };
    function binNum(op, a, b) {
      switch (op) {
        case "+": return a + b; case "-": return a - b; case "*": return a * b;
        case "/": return b === 0 ? (a === 0 || a !== a ? NaNv : (a > 0 ? Infinity : -Infinity)) : a / b;
        case "%": return b === 0 ? NaNv : a - Math.floor(a / b) * b; case "**": return Math.pow(a, b);
      }
    }
    const cmpNum = (op, a, b) => op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : op === "<=" ? a <= b : op === "==" ? a === b : a !== b;
    function arg(a, kw, i, name, def) { if (a.length > i) return a[i]; if (kw[name] !== undefined) return kw[name]; if (def !== undefined) return def; throw new RuleError(`Missing argument '${name}'`); }
    const num = (x) => { if (!isNum(x)) throw new RuleError("Window lengths and multipliers must be plain numbers"); return x; };
    function call(f, a, kw) {
      switch (f) {
        case "sma": return IND.sma(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n")));
        case "ema": return IND.ema(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n")));
        case "wma": return IND.wma(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n")));
        case "rsi": return IND.rsi(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n", 14)));
        case "atr": return IND.atr(df, num(arg(a, kw, 0, "n", 14)));
        case "atr_pct": { const r = IND.atr(df, num(arg(a, kw, 0, "n", 14))); return r.map((v, i) => v / df.c[i] * 100); }
        case "macd": return IND.macd(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "fast", 12)), num(arg(a, kw, 2, "slow", 26)));
        case "macd_signal": { const m = IND.macd(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "fast", 12)), num(arg(a, kw, 2, "slow", 26))); return ewm(m, 2 / (Math.trunc(num(arg(a, kw, 3, "signal", 9))) + 1)); }
        case "bb_upper": return IND.bbu(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n", 20)), num(arg(a, kw, 2, "k", 2)));
        case "bb_lower": return IND.bbl(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n", 20)), num(arg(a, kw, 2, "k", 2)));
        case "highest": return rolling(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n")), (w) => Math.max(...w));
        case "lowest": return rolling(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n")), (w) => Math.min(...w));
        case "shift": return shift(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n", 1)));
        case "prev": return shift(S(arg(a, kw, 0, "x")), 1);
        case "change": { const x = S(arg(a, kw, 0, "x")), s = shift(x, num(arg(a, kw, 1, "n", 1))); return x.map((v, i) => v - s[i]); }
        case "roc": { const x = S(arg(a, kw, 0, "x")), s = shift(x, num(arg(a, kw, 1, "n", 1))); return x.map((v, i) => (v / s[i] - 1) * 100); }
        case "stdev": return rolling(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n")), std1);
        case "zscore": { const x = S(arg(a, kw, 0, "x")), n = num(arg(a, kw, 1, "n")), m = IND.sma(x, n), sd = rolling(x, n, std1); return x.map((v, i) => (v - m[i]) / sd[i]); }
        case "volatility": { const x = S(arg(a, kw, 0, "x")), n = num(arg(a, kw, 1, "n", 20)); const lr = f64(L); for (let i = 1; i < L; i++) lr[i] = Math.log(x[i]) - Math.log(x[i - 1]); return rolling(lr, n, std1).map((v) => v * Math.sqrt(252) * 100); }
        case "cross_above": return IND.crossA(S(arg(a, kw, 0, "a")), S(arg(a, kw, 1, "b")));
        case "cross_below": return IND.crossB(S(arg(a, kw, 0, "a")), S(arg(a, kw, 1, "b")));
        case "count_true": { const c = B(arg(a, kw, 0, "cond")), n = Math.trunc(num(arg(a, kw, 1, "n"))), o = f64(L); let s = 0; for (let i = 0; i < L; i++) { s += c[i]; if (i >= n) s -= c[i - n]; o[i] = s; } return o; }
        case "abs": { const x = arg(a, kw, 0, "x"); return isNum(x) ? Math.abs(x) : S(x).map(Math.abs); }
        case "max": case "min": { const A = S(arg(a, kw, 0, "a")), Bb = S(arg(a, kw, 1, "b")); return A.map((v, i) => (v !== v || Bb[i] !== Bb[i]) ? NaNv : (f === "max" ? Math.max(v, Bb[i]) : Math.min(v, Bb[i]))); }
      }
      throw new RuleError(`Unknown function ${f}`);
    }
    function ev(n) {
      switch (n.t) {
        case "num": return n.v;
        case "var":
          if (n.v === "hl2") return df.h.map((v, i) => (v + df.l[i]) / 2);
          if (n.v === "dow") return Float64Array.from(df.d, (d) => (new Date(d * 864e5).getUTCDay() + 6) % 7);
          return vars[n.v];
        case "neg": { const a = ev(n.a); return isNum(a) ? -a : S(a).map((v) => -v); }
        case "not": { const a = B(ev(n.a)), o = new Uint8Array(L); for (let i = 0; i < L; i++) o[i] = a[i] ? 0 : 1; return o; }
        case "bool": { const a = B(ev(n.a)), b = B(ev(n.b)), o = new Uint8Array(L); for (let i = 0; i < L; i++) o[i] = n.op === "and" ? (a[i] & b[i]) : (a[i] | b[i]); return o; }
        case "bin": return bin(n.op, ev(n.a), ev(n.b));
        case "cmp": {
          let left = ev(n.first), res = null;
          for (const [op, rn] of n.parts) {
            const right = ev(rn), A = S(left), Bb = S(right), o = new Uint8Array(L);
            for (let i = 0; i < L; i++) o[i] = cmpNum(op, A[i], Bb[i]) ? 1 : 0;
            if (res) for (let i = 0; i < L; i++) res[i] &= o[i]; else res = o;
            left = right;
          }
          return res;
        }
        case "call": return call(n.f, n.args.map(ev), Object.fromEntries(Object.entries(n.kw).map(([k, v]) => [k, ev(v)])));
      }
    }
    return ev(ast);
  }
  function condition(expr, df) { return toB(evaluate(parse(expr), df), df.c.length); }
  function validate(expr) {
    const n = 300, d = new Float64Array(n), c = new Float64Array(n);
    let x = 100; for (let i = 0; i < n; i++) { x *= 1 + Math.sin(i) * 0.01; c[i] = x; d[i] = 18000 + i; }
    condition(expr, { d, o: c, h: c.map((v) => v * 1.01), l: c.map((v) => v * 0.99), c, v: c.map(() => 1000) });
  }

  // ----------------------------------------------------------------- data frames
  // raw JSON: {d0, dd:[day offsets], o,h,l,c,v}. Dates are integer days since 1970-01-01.
  function frame(raw) {
    const n = raw.c.length, d = new Float64Array(n); let acc = raw.d0;
    for (let i = 0; i < n; i++) { acc += raw.dd[i]; d[i] = acc; }
    return { d, o: Float64Array.from(raw.o), h: Float64Array.from(raw.h), l: Float64Array.from(raw.l), c: Float64Array.from(raw.c), v: Float64Array.from(raw.v) };
  }
  function sliceFrame(df, fromDay, toDay) {
    let a = 0, b = df.d.length;
    if (fromDay != null) while (a < b && df.d[a] < fromDay) a++;
    if (toDay != null) while (b > a && df.d[b - 1] > toDay) b--;
    const s = (x) => x.slice(a, b);
    return { d: s(df.d), o: s(df.o), h: s(df.h), l: s(df.l), c: s(df.c), v: s(df.v) };
  }
  const dayOf = (iso) => Math.floor(Date.parse(iso + "T00:00:00Z") / 864e5);
  const isoOf = (day) => new Date(day * 864e5).toISOString().slice(0, 10);

  // ----------------------------------------------------------------- metrics
  function computeMetrics(days, eq, trades, rf = 0.065) {
    const D = [], E = []; for (let i = 0; i < eq.length; i++) if (eq[i] === eq[i]) { D.push(days[i]); E.push(eq[i]); }
    if (E.length < 2 || E[0] <= 0) return { note: "not enough data" };
    const rets = []; for (let i = 1; i < E.length; i++) rets.push(E[i] / E[i - 1] - 1);
    const years = Math.max((D[D.length - 1] - D[0]) / 365.25, 1e-9);
    const total = E[E.length - 1] / E[0] - 1, cagr = total > -1 ? Math.pow(1 + total, 1 / years) - 1 : -1;
    const m = mean(rets), vol = std1(rets) * Math.sqrt(252);
    const sharpe = vol > 0 ? (m * 252 - rf) / vol : NaNv;
    const neg = rets.filter((r) => r < 0), dvol = std1(neg) * Math.sqrt(252);
    const sortino = dvol > 0 ? (m * 252 - rf) / dvol : NaNv;
    let peak = -Infinity, mdd = 0; for (const v of E) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    const r2 = (x) => Math.round(x * 100) / 100;
    const out = { start: isoOf(D[0]), end: isoOf(D[D.length - 1]), years: r2(years), start_equity: r2(E[0]), end_equity: r2(E[E.length - 1]),
      total_return_pct: r2(total * 100), cagr_pct: r2(cagr * 100), volatility_pct: r2(vol * 100), sharpe: r2(sharpe), sortino: r2(sortino),
      max_drawdown_pct: r2(mdd * 100), calmar: mdd < 0 ? r2(cagr / Math.abs(mdd)) : null };
    if (trades) {
      const pnl = trades.filter((t) => "pnl" in t && !t.open).map((t) => t.pnl);
      if (pnl.length) {
        const w = pnl.filter((p) => p > 0), l = pnl.filter((p) => p <= 0), sw = w.reduce((a, b) => a + b, 0), sl = l.reduce((a, b) => a + b, 0);
        Object.assign(out, { trades: pnl.length, win_rate_pct: Math.round(w.length / pnl.length * 1000) / 10, avg_trade_pnl: r2(mean(pnl)),
          avg_win: w.length ? r2(mean(w)) : 0, avg_loss: l.length ? r2(mean(l)) : 0, profit_factor: sl < 0 ? r2(sw / Math.abs(sl)) : null });
      } else out.trades = 0;
    }
    return out;
  }

  // ----------------------------------------------------------------- rule backtest (port of backtest_signals)
  function backtestSignals(df, en, ex, capital, side, slPct, tpPct, costPct, sizePct, symbol) {
    const { o, h, l, c } = df, n = c.length, cost = costPct / 100, sgn = side === "long" ? 1 : -1;
    let cash = capital, qty = 0, entryPx = 0, entryFee = 0, entryI = 0;
    const trades = [], eq = f64(n, capital);
    const closePos = (i, px, reason) => {
      const fee = Math.abs(qty) * px * cost; cash += qty * px - fee;
      const pnl = qty * (px - entryPx) - fee - entryFee;
      trades.push({ symbol, side, entry_date: isoOf(df.d[entryI]), entry_price: entryPx, exit_date: isoOf(df.d[i]), exit_price: px,
        qty: Math.abs(qty), pnl, return_pct: sgn * (px / entryPx - 1) * 100, reason, bars: i - entryI });
      qty = 0;
    };
    for (let i = 1; i < n; i++) {
      if (qty && ex[i - 1]) closePos(i, o[i], "exit signal");
      else if (!qty && en[i - 1] && !ex[i - 1]) {
        const px = o[i], q = Math.floor(cash * sizePct / 100 / (px * (1 + cost)));
        if (q > 0) { qty = sgn * q; entryPx = px; entryI = i; entryFee = q * px * cost; cash -= qty * px + entryFee; }
      }
      if (qty) {
        if (side === "long") {
          const stop = slPct ? entryPx * (1 - slPct / 100) : null, tgt = tpPct ? entryPx * (1 + tpPct / 100) : null;
          if (stop !== null && l[i] <= stop) closePos(i, Math.min(o[i], stop), "stop loss");
          else if (tgt !== null && h[i] >= tgt) closePos(i, Math.max(o[i], tgt), "take profit");
        } else {
          const stop = slPct ? entryPx * (1 + slPct / 100) : null, tgt = tpPct ? entryPx * (1 - tpPct / 100) : null;
          if (stop !== null && h[i] >= stop) closePos(i, Math.max(o[i], stop), "stop loss");
          else if (tgt !== null && l[i] <= tgt) closePos(i, Math.min(o[i], tgt), "take profit");
        }
      }
      eq[i] = cash + qty * c[i];
    }
    if (qty) trades.push({ symbol, side, entry_date: isoOf(df.d[entryI]), entry_price: entryPx, qty: Math.abs(qty), open: true, unrealized: qty * (c[n - 1] - entryPx) });
    return { days: df.d, eq, trades };
  }
  function combine(curves, caps) {
    const set = new Set(); for (const cv of curves) for (const d of cv.days) set.add(d);
    const days = Float64Array.from([...set].sort((a, b) => a - b)), tot = new Float64Array(days.length);
    curves.forEach((cv, k) => {
      let j = 0, last = NaNv;
      for (let i = 0; i < days.length; i++) {
        while (j < cv.days.length && cv.days[j] <= days[i]) { last = cv.eq[j]; j++; }
        tot[i] += last === last ? last : caps[k];
      }
    });
    return { days, eq: tot };
  }

  // ----------------------------------------------------------------- close matrix (outer join + ffill)
  function closeMatrix(frames, syms) {
    const set = new Set(); for (const s of syms) if (frames[s]) for (const d of frames[s].d) set.add(d);
    const days = Float64Array.from([...set].sort((a, b) => a - b)), cols = {};
    for (const s of syms) {
      const f = frames[s]; if (!f) continue;
      const col = f64(days.length); let j = 0, last = NaNv;
      for (let i = 0; i < days.length; i++) { while (j < f.d.length && f.d[j] <= days[i]) { last = f.c[j]; j++; } col[i] = last; }
      cols[s] = col;
    }
    return { days, cols };
  }

  // ----------------------------------------------------------------- paper broker (port of paper.py)
  class Broker {
    constructor(capital, costPct) { this.cash = capital; this.cost = costPct; this.pos = new Map(); this.trades = []; this.fees = 0; }
    qty(s) { const p = this.pos.get(s); return p ? p.qty : 0; }
    execute(day, sym, qty, price, note, fees, meta) {
      if (Math.abs(qty) < 1e-9) return;
      if (fees == null) fees = Math.abs(qty) * price * this.cost / 100;
      const p = this.pos.get(sym), cq = p ? p.qty : 0, avg = p ? p.avg : 0; let realized = 0, nq, navg, m = p ? p.meta : {};
      if (cq === 0 || (cq > 0) === (qty > 0)) { nq = cq + qty; navg = (cq * avg + qty * price) / nq; if (meta) m = Object.assign({}, m, meta); }
      else {
        const closing = Math.min(Math.abs(qty), Math.abs(cq)); realized = closing * (price - avg) * (cq > 0 ? 1 : -1);
        nq = cq + qty; if (Math.abs(nq) < 1e-9) { nq = 0; navg = 0; } else if ((nq > 0) !== (cq > 0)) { navg = price; m = meta || {}; } else navg = avg;
      }
      this.cash -= qty * price + fees; this.fees += fees;
      if (nq === 0) this.pos.delete(sym); else this.pos.set(sym, { qty: nq, avg: navg, meta: m });
      this.trades.push({ date: isoOf(day), symbol: sym, qty, price, fees, realized: realized - fees, note });
    }
    equity(marks) { let e = this.cash; for (const [s, p] of this.pos) e += p.qty * (marks[s] !== undefined && marks[s] === marks[s] ? marks[s] : p.avg); return e; }
  }

  // ----------------------------------------------------------------- strategies
  function runRule(spec, frames, opt) {
    const syms = spec.symbols.filter((s) => frames[s]), alloc = spec.capital / spec.symbols.length;
    const curves = [], caps = [], trades = [], perSymbol = {};
    const en0 = parse(spec.entry), ex0 = spec.exit ? parse(spec.exit) : null;
    for (const s of syms) {
      let df = sliceFrame(frames[s], null, opt.endDay);
      if (df.c.length < 60) { perSymbol[s] = { note: "not enough data" }; continue; }
      let en = toB(evaluate(en0, df), df.c.length), ex = ex0 ? toB(evaluate(ex0, df), df.c.length) : new Uint8Array(df.c.length);
      if (opt.startDay != null) {
        let a = 0; while (a < df.d.length && df.d[a] < opt.startDay) a++;
        df = sliceFrame(df, opt.startDay, null); en = en.slice(a); ex = ex.slice(a);
      }
      if (df.c.length < 2) { perSymbol[s] = { note: "no data in range" }; continue; }
      const r = backtestSignals(df, en, ex, alloc, spec.side, spec.stop_loss_pct, spec.take_profit_pct, spec.cost_pct, spec.position_size_pct, s);
      curves.push(r); caps.push(alloc); trades.push(...r.trades);
      const m = computeMetrics(r.days, r.eq, r.trades, 0);
      perSymbol[s] = { total_return_pct: m.total_return_pct, cagr_pct: m.cagr_pct, max_drawdown_pct: m.max_drawdown_pct, trades: m.trades, win_rate_pct: m.win_rate_pct };
    }
    const comb = combine(curves, caps);
    return { days: comb.days, eq: comb.eq, trades, metrics: computeMetrics(comb.days, comb.eq, trades, opt.rf), perSymbol };
  }

  function runRotation(spec, frames, opt, universe) {
    const tf = spec.trend_filter, syms = universe.concat(tf ? [tf.symbol] : []);
    const cm = closeMatrix(Object.fromEntries(syms.filter((s) => frames[s]).map((s) => [s, sliceFrame(frames[s], null, opt.endDay)])), syms);
    const { days, cols } = cm, lb = spec.lookback, skip = spec.skip, uni = universe.filter((s) => cols[s]);
    // monthly -> year*100+month; weekly -> the Thursday of the ISO week (unique per ISO week)
    const period = (day) => { if (spec.rebalance === "monthly") { const dt = new Date(day * 864e5); return dt.getUTCFullYear() * 100 + dt.getUTCMonth(); }
      return day - ((new Date(day * 864e5).getUTCDay() + 6) % 7) + 3; };
    function ranking(i) { // uses rows [0, i)
      if (i < lb + skip + 1) return [];
      const out = [];
      for (const s of uni) {
        const a = cols[s][i - 1 - skip], b = cols[s][i - 1 - skip - lb]; let m = a / b - 1;
        if (m !== m) continue;
        if (spec.score === "risk_adj") {
          const r = []; for (let k = Math.max(1, i - lb); k < i; k++) { const x = cols[s][k] / cols[s][k - 1] - 1; if (x === x) r.push(x); }
          const v = std1(r) * Math.sqrt(252); m = m / v; if (!isFinite(m)) continue;
        }
        out.push([s, m]);
      }
      return out.sort((x, y) => y[1] - x[1]);
    }
    function weights(i) {
      if (tf && cols[tf.symbol]) {
        const s = []; for (let k = 0; k < i; k++) { const v = cols[tf.symbol][k]; if (v === v) s.push(v); }
        const n = tf.sma || 200;
        if (s.length >= n && s[s.length - 1] < mean(s.slice(-n))) return {};
      }
      let r = ranking(i);
      if (spec.min_score != null) r = r.filter(([, v]) => v > spec.min_score);
      const w = {}; for (const [s] of r.slice(0, spec.top_n)) w[s] = 1 / spec.top_n; return w;
    }
    const b = new Broker(spec.capital, spec.cost_pct), eqD = [], eqV = [];
    let lastPer = null, rebals = 0;
    const startI = lb + skip + 2;
    for (let i = startI; i < days.length; i++) {
      if (opt.startDay != null && days[i] < opt.startDay) continue;
      const marks = {}; for (const s of syms) if (cols[s] && cols[s][i] === cols[s][i]) marks[s] = cols[s][i];
      const per = period(days[i]);
      if (per !== lastPer) {
        const w = weights(i), equity = b.equity(marks), band = equity * spec.rebalance_band_pct / 100, orders = [];
        for (const s of new Set([...b.pos.keys(), ...Object.keys(w)])) {
          const p = marks[s]; if (!p || p <= 0) continue;
          let tq = equity * (w[s] || 0) * 0.995 / p; if (!isIndex(s)) tq = Math.floor(tq);
          const dq = tq - b.qty(s);
          if (Math.abs(dq) < 1e-9 || (tq !== 0 && Math.abs(dq * p) < band)) continue;
          orders.push([s, dq, p]);
        }
        orders.sort((x, y) => x[1] - y[1]);
        for (const [s, dq, p] of orders) b.execute(days[i], s, dq, p, "rebalance");
        lastPer = per; rebals++;
      }
      eqD.push(days[i]); eqV.push(b.equity(marks));
    }
    const m = computeMetrics(eqD, eqV, null, opt.rf);
    Object.assign(m, { rebalances: rebals, executions: b.trades.length, total_fees: Math.round(b.fees * 100) / 100 });
    const cur = ranking(days.length).slice(0, 10).map(([s, v]) => [s, Math.round(v * 10000) / 100]);
    return { days: Float64Array.from(eqD), eq: Float64Array.from(eqV), trades: b.trades, metrics: m, ranking: cur };
  }

  // ---- option selling (port of agents/option_selling.py)
  function erf(x) { // W. J. Cody-grade rational approximation via complementary error function (|err| < 1.2e-7)
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? 1 - r : r - 1;
  }
  const ncdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  const intrinsic = (S, K, k) => k === "CE" ? Math.max(0, S - K) : Math.max(0, K - S);
  function bsPrice(S, K, T, r, sg, k) {
    if (T <= 0 || sg <= 0) return intrinsic(S, K, k);
    const st = sg * Math.sqrt(T), d1 = (Math.log(S / K) + (r + 0.5 * sg * sg) * T) / st, d2 = d1 - st;
    return k === "CE" ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2) : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
  }
  function bsDelta(S, K, T, r, sg, k) {
    if (T <= 0 || sg <= 0) { const itm = k === "CE" ? S > K : S < K; return itm ? (k === "CE" ? 1 : -1) : 0; }
    const d1 = (Math.log(S / K) + (r + 0.5 * sg * sg) * T) / (sg * Math.sqrt(T));
    return k === "CE" ? ncdf(d1) : ncdf(d1) - 1;
  }
  const wd = (day) => (new Date(day * 864e5).getUTCDay() + 6) % 7;
  function lastWeekdayOfMonth(y, m, w) { const last = Date.UTC(y, m + 1, 0) / 864e5; return last - ((wd(last) - w + 7) % 7); }
  function nextExpiry(day, w, monthly) {
    if (!monthly) return day + ((w - wd(day) + 7) % 7);
    const dt = new Date(day * 864e5); let e = lastWeekdayOfMonth(dt.getUTCFullYear(), dt.getUTCMonth(), w);
    if (e < day) { const y = dt.getUTCMonth() === 11 ? dt.getUTCFullYear() + 1 : dt.getUTCFullYear(), m = (dt.getUTCMonth() + 1) % 12; e = lastWeekdayOfMonth(y, m, w); }
    return e;
  }
  const UNDERLYINGS = { NIFTY: { lot_size: 65, strike_step: 50, expiry: "weekly" }, BANKNIFTY: { lot_size: 30, strike_step: 100, expiry: "monthly" }, NIFTYFIN: { lot_size: 60, strike_step: 50, expiry: "monthly" } };
  function pyRound(x) { const f = Math.floor(x), d = x - f; if (d > 0.5) return f + 1; if (d < 0.5) return f; return f % 2 === 0 ? f : f + 1; }

  function runOptions(spec, frames, opt) {
    const sp = spec, r = opt.rf, und = sp.underlying;
    const cm = closeMatrix({ [und]: sliceFrame(frames[und], opt.startDay, opt.endDay), [sp.vix_symbol]: sliceFrame(frames[sp.vix_symbol], opt.startDay, opt.endDay) }, [und, sp.vix_symbol]);
    const T = (d, e) => ((e - d) + 0.25) / 365, price = (S, K, t, sg, k) => bsPrice(S, K, t, r, sg, k);
    const expiryFor = (d) => { let cand = d; for (let k = 0; k < 60; k++) { const e = nextExpiry(cand, sp.expiry_weekday, sp.expiry === "monthly"); if (e - d >= sp.min_dte) return e; cand = e + 1; } throw new Error("no expiry"); };
    function strike(S, t, sg, kind) {
      const step = sp.strike_step, atm = pyRound(S / step) * step;
      if (sp.strike_mode === "otm_pct") return pyRound((kind === "CE" ? S * (1 + sp.otm_pct / 100) : S * (1 - sp.otm_pct / 100)) / step) * step;
      let K = atm; for (let i = 0; i < 400; i++) { K = kind === "CE" ? atm + i * step : atm - i * step; if (Math.abs(bsDelta(S, K, t, r, sg, kind)) <= sp.delta) break; } return K;
    }
    function legs(S, t, sg) {
      const st = sp.structure, step = sp.strike_step, atm = pyRound(S / step) * step;
      if (st === "straddle") return [["CE", atm, -1], ["PE", atm, -1]];
      const L = [];
      if (["strangle", "iron_condor", "short_call"].includes(st)) L.push(["CE", strike(S, t, sg, "CE"), -1]);
      if (["strangle", "iron_condor", "short_put"].includes(st)) L.push(["PE", strike(S, t, sg, "PE"), -1]);
      if (st === "iron_condor") L.push(["CE", L[0][1] + sp.wing_width, 1], ["PE", L[1][1] - sp.wing_width, 1]);
      return L;
    }
    const fees = (q, px) => sp.fee_per_order + Math.abs(q) * px * sp.cost_pct_premium / 100;
    const b = new Broker(sp.capital, 0), st = {}, cycles = [], eqD = [], eqV = [];
    const { days, cols } = cm, Sx = cols[und], Vx = cols[sp.vix_symbol];
    for (let i = 0; i < days.length; i++) {
      const d = days[i], S = Sx[i], vix = Vx[i]; if (S !== S || vix !== vix) continue;
      const sg = vix / 100 * sp.iv_mult; let marks = {}, done = false;
      if (b.pos.size) {
        const meta = b.pos.values().next().value.meta, exp = meta.expiry, credit = meta.credit; let reason = null;
        if (d >= exp) { for (const [s, p] of b.pos) marks[s] = intrinsic(S, p.meta.strike, p.meta.kind); reason = "expiry settlement"; }
        else {
          const t = T(d, exp); let ctc = 0;
          for (const [s, p] of b.pos) { marks[s] = price(S, p.meta.strike, t, sg, p.meta.kind); ctc -= p.qty * marks[s]; }
          if (sp.stop_loss_mult && ctc >= credit * sp.stop_loss_mult) reason = "stop loss";
          else if (sp.profit_target_pct && ctc <= credit * (1 - sp.profit_target_pct / 100)) reason = "profit target";
          else if (sp.exit_dte && (exp - d) <= sp.exit_dte) reason = "time exit";
        }
        if (!reason) done = true;
        else {
          for (const [s, p] of [...b.pos]) b.execute(d, s, -p.qty, marks[s], reason, fees(p.qty, marks[s]));
          cycles.push({ entry_date: st.cycleEntry, exit_date: isoOf(d), expiry: isoOf(exp), credit, pnl: b.cash - st.cycleCash, reason });
          st.cooldown = reason === "expiry settlement" ? null : exp; marks = {};
        }
      }
      if (!done) {
        const blocked = (st.cooldown != null && d <= st.cooldown) || (sp.min_vix && vix < sp.min_vix) || (sp.max_vix && vix > sp.max_vix);
        if (!blocked) {
          const exp = expiryFor(d), t = T(d, exp), units = sp.lots * sp.lot_size;
          const priced = legs(S, t, sg).map(([k, K, sgn]) => [k, K, sgn, price(S, K, t, sg, k)]);
          const credit = priced.reduce((a, [, , sgn, px]) => a - sgn * units * px, 0);
          if (credit > 0) {
            st.cycleCash = b.cash; st.cycleEntry = isoOf(d);
            for (const [k, K, sgn, px] of priced) {
              const sym = `${und} ${isoOf(exp)} ${K} ${k}`, q = sgn * units;
              b.execute(d, sym, q, px, "open", fees(q, px), { kind: k, strike: K, expiry: exp, credit });
              marks[sym] = px;
            }
          }
        }
      }
      eqD.push(d); eqV.push(b.equity(marks));
    }
    const m = computeMetrics(eqD, eqV, cycles, r), reasons = {};
    for (const c of cycles) reasons[c.reason] = (reasons[c.reason] || 0) + 1;
    Object.assign(m, { cycles: cycles.length, exit_reasons: reasons });
    return { days: Float64Array.from(eqD), eq: Float64Array.from(eqV), trades: cycles, metrics: m };
  }

  // ----------------------------------------------------------------- spec normalisation
  const RULE_DEF = { symbols: [], entry: "", exit: "", side: "long", stop_loss_pct: null, take_profit_pct: null, capital: 1000000, position_size_pct: 100, cost_pct: 0.12 };
  const ROT_DEF = { universe: "nifty50", lookback: 126, skip: 21, top_n: 5, rebalance: "monthly", score: "momentum", min_score: 0.0,
    trend_filter: { symbol: "NIFTY", sma: 200 }, rebalance_band_pct: 1.0, capital: 1000000, cost_pct: 0.12 };
  const OPT_DEF = { underlying: "NIFTY", structure: "strangle", expiry: null, expiry_weekday: 1, strike_mode: "delta", delta: 0.15, otm_pct: 2.0,
    wing_width: 500, strike_step: null, lot_size: null, lots: 1, min_dte: 2, stop_loss_mult: 2.0, profit_target_pct: 50, exit_dte: 0,
    min_vix: null, max_vix: null, iv_mult: 1.0, capital: 500000, fee_per_order: 20, cost_pct_premium: 0.15, vix_symbol: "INDIAVIX" };
  function normalize(spec, universes) {
    const type = spec.type || "rule";
    const clean = (o) => { const x = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") x[k] = v; return x; };
    if (type === "rule") {
      const s = Object.assign({}, RULE_DEF, clean(spec), { type });
      if (typeof s.symbols === "string") s.symbols = s.symbols.split(/[\s,]+/).filter(Boolean);
      s.symbols = [...new Set(s.symbols.flatMap((x) => universes[String(x).toLowerCase()] || [String(x).toUpperCase()]))].sort();
      if (!s.symbols.length) throw new RuleError("Add at least one symbol");
      if (!["long", "short"].includes(s.side)) throw new RuleError("side must be long or short");
      validate(s.entry); if (s.exit) validate(s.exit); else if (!s.stop_loss_pct && !s.take_profit_pct) throw new RuleError("Give an exit rule or a stop-loss / take-profit");
      for (const k of ["stop_loss_pct", "take_profit_pct"]) s[k] = s[k] ? Number(s[k]) : null;
      return s;
    }
    if (type === "rotation") {
      const s = Object.assign({}, ROT_DEF, clean(spec), { type });
      if (spec.trend_filter === null || spec.trend_filter === false) s.trend_filter = null;
      for (const k of ["lookback", "skip", "top_n"]) s[k] = Math.trunc(Number(s[k]));
      if (!["weekly", "monthly"].includes(s.rebalance)) throw new RuleError("rebalance must be weekly or monthly");
      if (!["momentum", "risk_adj"].includes(s.score)) throw new RuleError("score must be momentum or risk_adj");
      if (s.top_n < 1 || s.lookback < 5) throw new RuleError("top_n >= 1 and lookback >= 5 required");
      return s;
    }
    if (type === "option_selling") {
      const s = Object.assign({}, OPT_DEF, clean(spec), { type });
      s.underlying = String(s.underlying).toUpperCase();
      const base = UNDERLYINGS[s.underlying] || { lot_size: 1, strike_step: 50, expiry: "monthly" };
      for (const k of ["lot_size", "strike_step", "expiry"]) if (s[k] == null) s[k] = base[k];
      if (!["strangle", "straddle", "iron_condor", "short_put", "short_call"].includes(s.structure)) throw new RuleError("Unknown option structure");
      if (!(s.delta > 0 && s.delta < 0.5)) throw new RuleError("delta must be between 0 and 0.5");
      return s;
    }
    throw new RuleError(`Unknown strategy type '${type}'`);
  }
  function symbolsNeeded(s, universes) {
    if (s.type === "rule") return s.symbols;
    if (s.type === "rotation") { const u = Array.isArray(s.universe) ? s.universe.map((x) => String(x).toUpperCase()) : (universes[String(s.universe).toLowerCase()] || []); return u.concat(s.trend_filter ? [s.trend_filter.symbol] : []); }
    return [s.underlying, s.vix_symbol];
  }
  function run(spec, frames, universes, opt = {}) {
    const o = { rf: 0.065, startDay: opt.start ? dayOf(opt.start) : null, endDay: opt.end ? dayOf(opt.end) : null };
    let res;
    if (spec.type === "rule") res = runRule(spec, frames, o);
    else if (spec.type === "rotation") res = runRotation(spec, frames, o, Array.isArray(spec.universe) ? spec.universe.map((x) => String(x).toUpperCase()) : universes[String(spec.universe).toLowerCase()]);
    else res = runOptions(spec, frames, o);
    // benchmark: NIFTY buy & hold on the same dates
    if (frames.NIFTY && res.days.length > 1) {
      const n = frames.NIFTY, bench = f64(res.days.length); let j = 0, last = NaNv;
      for (let i = 0; i < res.days.length; i++) { while (j < n.d.length && n.d[j] <= res.days[i]) { last = n.c[j]; j++; } bench[i] = last; }
      let first = 0; while (first < bench.length && bench[first] !== bench[first]) first++;
      const scale = res.eq[0] / bench[first];
      res.bench = bench.map((v) => v * scale);
      const bm = computeMetrics(res.days.slice(first), res.bench.slice(first), null, o.rf);
      res.benchMetrics = { total_return_pct: bm.total_return_pct, cagr_pct: bm.cagr_pct, sharpe: bm.sharpe, max_drawdown_pct: bm.max_drawdown_pct };
    }
    return res;
  }

  const api = { parse, evaluate, condition, validate, frame, run, normalize, symbolsNeeded, computeMetrics, isoOf, dayOf, RuleError, FUNCS, VARS, bsPrice };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TradeEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
