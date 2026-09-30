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
  // indices and sector baskets are held in fractional units; stocks in whole shares ("BSE" alone is BSE Ltd, a stock)
  const isIndex = (s) => INDEX_KEYS.has(s) || s.startsWith("^") || s.startsWith("SEC_") || s.startsWith("NIFTY") || (s.startsWith("BSE") && s.length > 3) || s === "BANKEX" || s === "SENSEX" || s === "FINNIFTY" || s === "MIDCPNIFTY";

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
    "shift", "prev", "change", "roc", "stdev", "zscore", "volatility", "cross_above", "cross_below", "count_true", "abs", "max", "min",
    // added: returns, statistics, oscillators, trend and volume indicators, maths, cross-symbol reference
    "ret", "sum", "median", "pct_rank", "slope", "drawdown", "days_since", "corr", "beta",
    "adx", "plus_di", "minus_di", "stoch_k", "stoch_d", "cci", "mfi", "williams_r", "obv", "vwap", "supertrend", "keltner_upper", "keltner_lower",
    "log", "sqrt", "sign", "iff", "clip", "ref"];
  const VARS = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "dow", "dom", "month", "year", "pe", "pb", "dy"];

  function tokenize(src) {
    const t = []; let i = 0;
    const two = [">=", "<=", "==", "!=", "**", "&&", "||"];
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) { let j = i; while (j < src.length && /[0-9.eE]/.test(src[j])) { if (/[eE]/.test(src[j]) && /[+-]/.test(src[j + 1])) j++; j++; } const v = Number(src.slice(i, j)); if (!isFinite(v)) throw new RuleError(`Bad number '${src.slice(i, j)}'`); t.push({ k: "num", v }); i = j; continue; }
      if (c === '"' || c === "'") { const j = src.indexOf(c, i + 1); if (j < 0) throw new RuleError("Unclosed quote"); t.push({ k: "str", v: src.slice(i + 1, j) }); i = j + 1; continue; }
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
      if (tk.k === "str") return { t: "str", v: tk.v };
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
        if (!VARS.includes(tk.v)) throw new RuleError(`Unknown variable '${tk.v}'. Allowed: ${VARS.join(", ")}${/^[A-Z0-9_&-]{2,}$/.test(tk.v) ? `. To use another symbol's data write ref("${tk.v}", close)` : ""}`);
        return { t: "var", v: tk.v };
      }
      throw new RuleError(`Unexpected '${tk.v}' in '${src}'`);
    }
    const ast = orE();
    if (p < t.length) throw new RuleError(`Unexpected '${t[p].v}' in '${src}'`);
    return ast;
  }

  // shared data context: set once by the app / runner (E.setData) so ref() can reach other symbols,
  // and rotation can use industries (sector caps) and share counts (market-cap weights)
  const DATA = { frames: null, meta: null, shares: null };
  function setData(o) { Object.assign(DATA, o || {}); }
  function alignTo(days, src, vals) { // value of src series at or before each day (forward fill)
    const o = f64(days.length); let j = 0, last = NaNv;
    for (let i = 0; i < days.length; i++) { while (j < src.length && src[j] <= days[i]) { last = vals[j]; j++; } o[i] = last; }
    return o;
  }
  function rolling2(A, B, n, fn) {
    n = Math.trunc(n); const L = A.length, out = f64(L);
    for (let i = n - 1; i < L; i++) {
      const xs = [], ys = []; let ok = true;
      for (let j = i - n + 1; j <= i; j++) { if (!(isFinite(A[j]) && isFinite(B[j]))) { ok = false; break; } xs.push(A[j]); ys.push(B[j]); }
      if (ok) out[i] = fn(xs, ys);
    }
    return out;
  }
  const cov1 = (x, y) => { const mx = mean(x), my = mean(y); let s = 0; for (let k = 0; k < x.length; k++) s += (x[k] - mx) * (y[k] - my); return s / (x.length - 1); };

  function evaluate(ast, df, ctx = {}) {
    const L = df.c.length;
    const nanArr = () => new Float64Array(L).fill(NaN);
    const vars = { open: df.o, high: df.h, low: df.l, close: df.c, volume: df.v, pe: df.pe || nanArr(), pb: df.pb || nanArr(), dy: df.dy || nanArr() };
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
        // ---- added functions
        case "ret": { const x = S(arg(a, kw, 0, "x")), s = shift(x, num(arg(a, kw, 1, "n", 1))); return x.map((v, i) => v / s[i] - 1); }
        case "sum": return rolling(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n")), (w) => { let s = 0; for (const v of w) s += v; return s; });
        case "median": return rolling(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n")), (w) => { const s = w.slice().sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; });
        case "pct_rank": return rolling(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n", 252)), (w) => { const v = w[w.length - 1]; let c = 0; for (const u of w) if (u <= v) c++; return c / w.length * 100; });
        case "slope": return rolling(S(arg(a, kw, 0, "x")), num(arg(a, kw, 1, "n", 20)), (w) => { const k = w.length, mx = (k - 1) / 2, my = mean(w); let sxy = 0, sxx = 0; for (let j = 0; j < k; j++) { sxy += (j - mx) * (w[j] - my); sxx += (j - mx) ** 2; } return sxy / sxx; });
        case "drawdown": { const x = S(arg(a, kw, 0, "x", df.c)); let pk = -Infinity; return x.map((v) => { if (v !== v) return NaNv; pk = Math.max(pk, v); return (v / pk - 1) * 100; }); }
        case "days_since": { const c = B(arg(a, kw, 0, "cond")), o = f64(L); let last = -1; for (let i = 0; i < L; i++) { if (c[i]) last = i; o[i] = last < 0 ? NaNv : i - last; } return o; }
        case "corr": return rolling2(S(arg(a, kw, 0, "a")), S(arg(a, kw, 1, "b")), num(arg(a, kw, 2, "n", 63)), (x, y) => cov1(x, y) / (std1(x) * std1(y)));
        case "beta": return rolling2(S(arg(a, kw, 0, "a")), S(arg(a, kw, 1, "b")), num(arg(a, kw, 2, "n", 252)), (x, y) => cov1(x, y) / (std1(y) ** 2));
        case "adx": case "plus_di": case "minus_di": {
          const n = Math.trunc(num(arg(a, kw, 0, "n", 14))), tr = f64(L), pdm = f64(L), mdm = f64(L);
          for (let i = 0; i < L; i++) {
            if (i === 0) { tr[i] = df.h[i] - df.l[i]; pdm[i] = 0; mdm[i] = 0; continue; }
            const pc = df.c[i - 1], up = df.h[i] - df.h[i - 1], dn = df.l[i - 1] - df.l[i];
            tr[i] = Math.max(df.h[i] - df.l[i], Math.abs(df.h[i] - pc), Math.abs(df.l[i] - pc));
            pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0;
          }
          const at = ewm(tr, 1 / n, n), p = ewm(pdm, 1 / n, n), m = ewm(mdm, 1 / n, n);
          const pdi = p.map((v, i) => 100 * v / at[i]), mdi = m.map((v, i) => 100 * v / at[i]);
          if (f === "plus_di") return pdi; if (f === "minus_di") return mdi;
          const dx = pdi.map((v, i) => { const s = v + mdi[i]; return s > 0 ? 100 * Math.abs(v - mdi[i]) / s : (s === 0 ? 0 : NaNv); });
          return ewm(dx, 1 / n, n);
        }
        case "stoch_k": case "williams_r": {
          const n = num(arg(a, kw, 0, "n", 14)), hh = rolling(df.h, n, (w) => Math.max(...w)), ll = rolling(df.l, n, (w) => Math.min(...w));
          return f === "stoch_k" ? df.c.map((v, i) => hh[i] > ll[i] ? (v - ll[i]) / (hh[i] - ll[i]) * 100 : 50) .map((v, i) => hh[i] === hh[i] ? v : NaNv)
            : df.c.map((v, i) => hh[i] > ll[i] ? (hh[i] - v) / (hh[i] - ll[i]) * -100 : (hh[i] === hh[i] ? -50 : NaNv));
        }
        case "stoch_d": { const n = num(arg(a, kw, 0, "n", 14)), k = num(arg(a, kw, 1, "k", 3)); return IND.sma(call("stoch_k", [n], {}), k); }
        case "cci": { const n = num(arg(a, kw, 0, "n", 20)), tp = df.h.map((v, i) => (v + df.l[i] + df.c[i]) / 3), m = IND.sma(tp, n);
          const md = rolling(tp, n, (w) => { const mu = mean(w); let s = 0; for (const v of w) s += Math.abs(v - mu); return s / w.length; });
          return tp.map((v, i) => md[i] > 0 ? (v - m[i]) / (0.015 * md[i]) : (md[i] === 0 ? 0 : NaNv)); }
        case "mfi": { const n = Math.trunc(num(arg(a, kw, 0, "n", 14))), tp = df.h.map((v, i) => (v + df.l[i] + df.c[i]) / 3), pos = f64(L), neg = f64(L);
          for (let i = 1; i < L; i++) { const mf = tp[i] * df.v[i]; pos[i] = tp[i] > tp[i - 1] ? mf : 0; neg[i] = tp[i] < tp[i - 1] ? mf : 0; }
          const sp = rolling(pos, n, (w) => w.reduce((p, q) => p + q, 0)), sn = rolling(neg, n, (w) => w.reduce((p, q) => p + q, 0));
          return sp.map((v, i) => sn[i] === 0 ? (v > 0 ? 100 : 50) : 100 - 100 / (1 + v / sn[i])); }
        case "obv": { const o = f64(L); let s = 0; for (let i = 0; i < L; i++) { if (i > 0) s += df.c[i] > df.c[i - 1] ? df.v[i] : df.c[i] < df.c[i - 1] ? -df.v[i] : 0; o[i] = s; } return o; }
        case "vwap": { const n = num(arg(a, kw, 0, "n", 20)), pv = df.c.map((v, i) => (df.h[i] + df.l[i] + v) / 3 * df.v[i]);
          const a1 = rolling(pv, n, (w) => w.reduce((p, q) => p + q, 0)), b1 = rolling(df.v, n, (w) => w.reduce((p, q) => p + q, 0));
          return a1.map((v, i) => b1[i] > 0 ? v / b1[i] : NaNv); }
        case "supertrend": {
          const n = num(arg(a, kw, 0, "n", 10)), m = num(arg(a, kw, 1, "mult", 3)), at = IND.atr(df, n), o = f64(L);
          let fu = NaNv, fl = NaNv, dir = 1;
          for (let i = 0; i < L; i++) {
            if (at[i] !== at[i]) continue;
            const mid = (df.h[i] + df.l[i]) / 2, bu = mid + m * at[i], bl = mid - m * at[i], pc = i ? df.c[i - 1] : df.c[i];
            fu = (fu !== fu || bu < fu || pc > fu) ? bu : fu; fl = (fl !== fl || bl > fl || pc < fl) ? bl : fl;
            if (dir === 1 && df.c[i] < fl) dir = -1; else if (dir === -1 && df.c[i] > fu) dir = 1;
            o[i] = dir === 1 ? fl : fu;
          }
          return o;
        }
        case "keltner_upper": case "keltner_lower": { const n = num(arg(a, kw, 0, "n", 20)), m = num(arg(a, kw, 1, "mult", 2)), e = IND.ema(df.c, n), at = IND.atr(df, n);
          return e.map((v, i) => f === "keltner_upper" ? v + m * at[i] : v - m * at[i]); }
        case "log": case "sqrt": case "sign": { const x = arg(a, kw, 0, "x"), fn = f === "log" ? Math.log : f === "sqrt" ? Math.sqrt : Math.sign; return isNum(x) ? fn(x) : S(x).map(fn); }
        case "iff": { const c = B(arg(a, kw, 0, "cond")), A = S(arg(a, kw, 1, "a")), Bb = S(arg(a, kw, 2, "b")); return A.map((v, i) => c[i] ? v : Bb[i]); }
        case "clip": { const x = S(arg(a, kw, 0, "x")), lo = S(arg(a, kw, 1, "lo")), hi = S(arg(a, kw, 2, "hi")); return x.map((v, i) => v !== v ? NaNv : Math.min(Math.max(v, lo[i]), hi[i])); }
      }
      throw new RuleError(`Unknown function ${f}`);
    }
    function ev(n) {
      switch (n.t) {
        case "num": return n.v;
        case "var":
          if (n.v === "hl2") return df.h.map((v, i) => (v + df.l[i]) / 2);
          if (n.v === "dow") return Float64Array.from(df.d, (d) => (new Date(d * 864e5).getUTCDay() + 6) % 7);
          if (n.v === "hlc3") return df.h.map((v, i) => (v + df.l[i] + df.c[i]) / 3);
          if (n.v === "dom") return Float64Array.from(df.d, (d) => new Date(d * 864e5).getUTCDate());
          if (n.v === "month") return Float64Array.from(df.d, (d) => new Date(d * 864e5).getUTCMonth() + 1);
          if (n.v === "year") return Float64Array.from(df.d, (d) => new Date(d * 864e5).getUTCFullYear());
          return vars[n.v];
        case "str": return n.v;
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
        case "call": {
          if (n.f === "ref") { // ref("SYMBOL", expression): the expression evaluated on another symbol, aligned to these dates
            const sn = n.args[0] || n.kw.symbol, en = n.args[1] || n.kw.x;
            if (!sn || sn.t !== "str") throw new RuleError('ref needs a quoted symbol first, e.g. ref("NIFTY", close > sma(close,200))');
            if (!en) throw new RuleError("ref needs an expression second");
            const sym = symKey(sn.v), frames = ctx.frames || DATA.frames;
            if (ctx.validating) return evaluate(en, df, ctx);
            const other = frames && frames[sym];
            if (!other) throw new RuleError(`ref: no data loaded for ${sym}`);
            const key = sym + "|" + unparse(en), cache = ctx.refCache || (ctx.refCache = new Map());
            let v = cache.get(key);
            if (!v) { v = toF(evaluate(en, other, ctx), other.c.length); cache.set(key, v); }
            return alignTo(df.d, other.d, v);
          }
          const args = n.args.map(ev), kw = Object.fromEntries(Object.entries(n.kw).map(([k, v]) => [k, ev(v)]));
          if ([...args, ...Object.values(kw)].some((x) => typeof x === "string")) throw new RuleError(`Quoted text is only allowed as ref()'s symbol (in ${n.f})`);
          return call(n.f, args, kw);
        }
      }
    }
    return ev(ast);
  }
  function condition(expr, df, ctx) { return toB(evaluate(typeof expr === "string" ? parse(expr) : expr, df, ctx), df.c.length); }
  function validate(expr) {
    const n = 300, d = new Float64Array(n), c = new Float64Array(n);
    let x = 100; for (let i = 0; i < n; i++) { x *= 1 + Math.sin(i) * 0.01; c[i] = x; d[i] = 18000 + i; }
    condition(expr, { d, o: c, h: c.map((v) => v * 1.01), l: c.map((v) => v * 0.99), c, v: c.map(() => 1000) }, { validating: true });
  }
  // symbols named inside ref("...") anywhere in an expression
  function refSymbols(expr) { const out = []; const rx = /ref\s*\(\s*["']([^"']+)["']/g; let m; while ((m = rx.exec(String(expr || "")))) out.push(symKey(m[1])); return out; }

  // ----------------------------------------------------------------- data frames
  // raw JSON: {d0, dd:[day offsets], o,h,l,c,v}. Dates are integer days since 1970-01-01.
  function frame(raw) {
    const n = raw.c.length, d = new Float64Array(n); let acc = raw.d0;
    for (let i = 0; i < n; i++) { acc += raw.dd[i]; d[i] = acc; }
    if (raw.f === 2) { // compact: close as cumulative deltas in paise; o/h/l as offsets from close
      const c = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n);
      let cc = raw.c0; for (let i = 0; i < n; i++) { if (i) cc += raw.c[i]; c[i] = cc / 100; o[i] = (cc + raw.o[i]) / 100; h[i] = (cc + raw.h[i]) / 100; l[i] = (cc + raw.l[i]) / 100; }
      const val = (a) => a ? Float64Array.from(a, (x) => x == null ? NaN : x) : null;
      return { d, o, h, l, c, v: Float64Array.from(raw.v), pe: val(raw.pe), pb: val(raw.pb), dy: val(raw.dy) };
    }
    return { d, o: Float64Array.from(raw.o), h: Float64Array.from(raw.h), l: Float64Array.from(raw.l), c: Float64Array.from(raw.c), v: Float64Array.from(raw.v) };
  }
  // closes pack -> light frames (open = high = low = close, volume 0): enough for rotation, options, benchmarks
  function framesFromPack(pack) {
    const N = pack.dd.length, cal = new Float64Array(N); let acc = pack.d0;
    for (let i = 0; i < N; i++) { acc += pack.dd[i]; cal[i] = acc; }
    const out = {};
    for (const [s, x] of Object.entries(pack.s)) {
      const n = x.c.length, d = cal.slice(x.i0, x.i0 + n), c = new Float64Array(n); let cc = x.c0;
      for (let i = 0; i < n; i++) { if (i) cc += x.c[i]; c[i] = cc / 100; }
      out[s] = { d, o: c, h: c, l: c, c, v: new Float64Array(n), light: true };
    }
    return out;
  }
  function sliceFrame(df, fromDay, toDay) {
    let a = 0, b = df.d.length;
    if (fromDay != null) while (a < b && df.d[a] < fromDay) a++;
    if (toDay != null) while (b > a && df.d[b - 1] > toDay) b--;
    const s = (x) => x.slice(a, b);
    const out = { d: s(df.d), o: s(df.o), h: s(df.h), l: s(df.l), c: s(df.c), v: s(df.v) };
    for (const k of ["pe", "pb", "dy"]) if (df[k]) out[k] = s(df[k]);  // index valuation series travel with the slice
    return out;
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
  // x (all optional): trailPct, maxBars, stopAtr, tgtAtr, atr (series) — added exits; with none of them the result is unchanged
  function backtestSignals(df, en, ex, capital, side, slPct, tpPct, costPct, sizePct, symbol, x = {}) {
    const { o, h, l, c } = df, n = c.length, cost = costPct / 100, sgn = side === "long" ? 1 : -1;
    let cash = capital, qty = 0, entryPx = 0, entryFee = 0, entryI = 0, entryAtr = NaNv, peak = 0;
    const trades = [], eq = f64(n, capital);
    const closePos = (i, px, reason) => {
      const fee = Math.abs(qty) * px * cost; cash += qty * px - fee;
      const pnl = qty * (px - entryPx) - fee - entryFee;
      trades.push({ symbol, side, entry_date: isoOf(df.d[entryI]), entry_price: entryPx, exit_date: isoOf(df.d[i]), exit_price: px,
        qty: Math.abs(qty), pnl, return_pct: sgn * (px / entryPx - 1) * 100, reason, bars: i - entryI });
      qty = 0;
    };
    const levels = () => exitLevels(side, entryPx, peak, entryAtr, slPct, tpPct, x);
    for (let i = 1; i < n; i++) {
      const flatAtOpen = !qty;
      if (qty && ex[i - 1]) closePos(i, o[i], "exit signal");
      else if (qty && x.maxBars && i - entryI >= x.maxBars) closePos(i, o[i], "time exit");
      else if (flatAtOpen && en[i - 1] && !ex[i - 1]) {
        const px = o[i], q = Math.floor(cash * sizePct / 100 / (px * (1 + cost)));
        if (q > 0) { qty = sgn * q; entryPx = px; entryI = i; entryFee = q * px * cost; cash -= qty * px + entryFee; peak = px; entryAtr = x.atr ? x.atr[i - 1] : NaNv; }
      }
      if (qty) {
        const { stop, tgt, stopWhy } = levels();
        if (side === "long") {
          if (stop !== null && l[i] <= stop) closePos(i, Math.min(o[i], stop), stopWhy);
          else if (tgt !== null && h[i] >= tgt) closePos(i, Math.max(o[i], tgt), "take profit");
        } else {
          if (stop !== null && h[i] >= stop) closePos(i, Math.max(o[i], stop), stopWhy);
          else if (tgt !== null && l[i] <= tgt) closePos(i, Math.min(o[i], tgt), "take profit");
        }
      }
      if (qty) peak = side === "long" ? Math.max(peak, h[i]) : Math.min(peak, l[i]);
      eq[i] = cash + qty * c[i];
    }
    if (qty) trades.push({ symbol, side, entry_date: isoOf(df.d[entryI]), entry_price: entryPx, qty: Math.abs(qty), open: true, unrealized: qty * (c[n - 1] - entryPx) });
    const last = n - 1, lastTrade = trades.length ? trades[trades.length - 1] : null, lv = qty ? levels() : null;
    const state = { symbol, side, lastDate: isoOf(df.d[last]), close: c[last], inPosition: !!qty, qty: Math.abs(qty),
      entryPrice: qty ? entryPx : null, entryDate: qty ? isoOf(df.d[entryI]) : null,
      pendingBuy: !qty && !!en[last] && !ex[last], pendingSell: !!qty && !!ex[last],
      exitedToday: !qty && lastTrade && !lastTrade.open && lastTrade.exit_date === isoOf(df.d[last]) ? lastTrade.reason : null,
      stopLevel: lv ? lv.stop : null, targetLevel: lv ? lv.tgt : null, atrNow: x.atr ? x.atr[last] : null };
    return { days: df.d, eq, trades, state };
  }
  // tightest stop and nearest target among: fixed %, ATR multiples at entry, trailing % from the best price since entry
  function exitLevels(side, entryPx, peak, entryAtr, slPct, tpPct, x) {
    const long = side === "long"; let stop = null, tgt = null, stopWhy = "stop loss";
    const better = (a, b) => a === null ? b : b === null ? a : (long ? Math.max(a, b) : Math.min(a, b));
    if (slPct) stop = entryPx * (long ? 1 - slPct / 100 : 1 + slPct / 100);
    if (x.stopAtr && entryAtr === entryAtr) stop = better(stop, long ? entryPx - x.stopAtr * entryAtr : entryPx + x.stopAtr * entryAtr);
    if (x.trailPct) { const tr = long ? peak * (1 - x.trailPct / 100) : peak * (1 + x.trailPct / 100); const b = better(stop, tr); if (b === tr && tr !== stop) stopWhy = "trailing stop"; stop = b; }
    if (tpPct) tgt = entryPx * (long ? 1 + tpPct / 100 : 1 - tpPct / 100);
    if (x.tgtAtr && entryAtr === entryAtr) { const t = long ? entryPx + x.tgtAtr * entryAtr : entryPx - x.tgtAtr * entryAtr; tgt = tgt === null ? t : (long ? Math.min(tgt, t) : Math.max(tgt, t)); }
    return { stop, tgt, stopWhy };
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
  function ruleExtras(spec) {
    return { trailPct: spec.trailing_stop_pct || null, maxBars: spec.max_hold_days || null, stopAtr: spec.stop_atr_mult || null, tgtAtr: spec.target_atr_mult || null };
  }
  function runRule(spec, frames, opt) {
    if (spec.max_positions) return runRulePortfolio(spec, frames, opt);
    const syms = spec.symbols.filter((s) => frames[s]), alloc = spec.capital / spec.symbols.length;
    const curves = [], caps = [], trades = [], perSymbol = {}, states = [];
    const en0 = parse(spec.entry), ex0 = spec.exit ? parse(spec.exit) : null, X = ruleExtras(spec), ctx = { frames };
    for (const s of syms) {
      let df = sliceFrame(frames[s], null, opt.endDay);
      if (df.c.length < 60) { perSymbol[s] = { note: "not enough data" }; continue; }
      let en = toB(evaluate(en0, df, ctx), df.c.length), ex = ex0 ? toB(evaluate(ex0, df, ctx), df.c.length) : new Uint8Array(df.c.length);
      let atr = X.stopAtr || X.tgtAtr ? IND.atr(df, spec.atr_period || 14) : null;
      if (opt.startDay != null) {
        let a = 0; while (a < df.d.length && df.d[a] < opt.startDay) a++;
        df = sliceFrame(df, opt.startDay, null); en = en.slice(a); ex = ex.slice(a); if (atr) atr = atr.slice(a);
      }
      if (df.c.length < 2) { perSymbol[s] = { note: "no data in range" }; continue; }
      const r = backtestSignals(df, en, ex, alloc, spec.side, spec.stop_loss_pct, spec.take_profit_pct, spec.cost_pct, spec.position_size_pct, s, { ...X, atr });
      curves.push(r); caps.push(alloc); trades.push(...r.trades); states.push(r.state);
      const m = computeMetrics(r.days, r.eq, r.trades, 0);
      perSymbol[s] = { total_return_pct: m.total_return_pct, cagr_pct: m.cagr_pct, max_drawdown_pct: m.max_drawdown_pct, trades: m.trades, win_rate_pct: m.win_rate_pct };
    }
    const comb = combine(curves, caps);
    return { days: comb.days, eq: comb.eq, trades, metrics: computeMetrics(comb.days, comb.eq, trades, opt.rf), perSymbol, states };
  }

  // Portfolio mode: one shared pot of capital, at most max_positions open at once; when more symbols signal than there
  // are free slots, the highest rank_by value (as of the signal close) wins. Each new position gets position_size_pct of equity.
  function runRulePortfolio(spec, frames, opt) {
    const ctx = { frames }, en0 = parse(spec.entry), ex0 = spec.exit ? parse(spec.exit) : null, rk0 = parse(spec.rank_by || "roc(close,63)");
    const X = ruleExtras(spec), long = spec.side === "long", sgn = long ? 1 : -1, cost = spec.cost_pct / 100;
    const size = (spec.position_size_pct && spec.position_size_pct < 100 ? spec.position_size_pct : 100 / spec.max_positions) / 100;
    const S = {}, perSymbol = {};
    for (const s of spec.symbols) {
      if (!frames[s]) continue;
      const df = sliceFrame(frames[s], null, opt.endDay);
      if (df.c.length < 60) { perSymbol[s] = { note: "not enough data" }; continue; }
      const L = df.c.length, row = new Map(); for (let i = 0; i < L; i++) row.set(df.d[i], i);
      S[s] = { df, row, en: toB(evaluate(en0, df, ctx), L), ex: ex0 ? toB(evaluate(ex0, df, ctx), L) : new Uint8Array(L), rank: toF(evaluate(rk0, df, ctx), L),
        atr: X.stopAtr || X.tgtAtr ? IND.atr(df, spec.atr_period || 14) : null, qty: 0, entryPx: 0, entryFee: 0, entryR: 0, entryAtr: NaNv, peak: 0, last: NaNv };
    }
    const syms = Object.keys(S), set = new Set();
    for (const s of syms) for (const d of S[s].df.d) if (opt.startDay == null || d >= opt.startDay) set.add(d);
    const days = Float64Array.from([...set].sort((a, b) => a - b)), eq = new Float64Array(days.length), trades = [];
    let cash = spec.capital, openN = 0;
    for (const s of syms) { const st = S[s]; if (opt.startDay != null) { let a = 0; while (a < st.df.d.length && st.df.d[a] < opt.startDay) a++; if (a > 0) st.last = st.df.c[a - 1]; } }
    const closePos = (s, r, px, reason) => {
      const st = S[s], fee = Math.abs(st.qty) * px * cost; cash += st.qty * px - fee;
      trades.push({ symbol: s, side: spec.side, entry_date: isoOf(st.df.d[st.entryR]), entry_price: st.entryPx, exit_date: isoOf(st.df.d[r]), exit_price: px,
        qty: Math.abs(st.qty), pnl: st.qty * (px - st.entryPx) - fee - st.entryFee, return_pct: sgn * (px / st.entryPx - 1) * 100, reason, bars: r - st.entryR });
      st.qty = 0; openN--;
    };
    const equityAt = () => { let e = cash; for (const s of syms) { const st = S[s]; if (st.qty) e += st.qty * (st.last === st.last ? st.last : st.entryPx); } return e; };
    for (let k = 0; k < days.length; k++) {
      const d = days[k], today = [];
      for (const s of syms) { const r = S[s].row.get(d); if (r !== undefined && r >= 1) today.push([s, r]); }
      const flat = new Set();
      for (const [s, r] of today) {
        const st = S[s];
        if (!st.qty) { flat.add(s); continue; }
        if (st.ex[r - 1]) closePos(s, r, st.df.o[r], "exit signal");
        else if (X.maxBars && r - st.entryR >= X.maxBars) closePos(s, r, st.df.o[r], "time exit");
      }
      const cands = today.filter(([s, r]) => flat.has(s) && S[s].en[r - 1] && !S[s].ex[r - 1])
        .sort((a, b) => { const x = S[a[0]].rank[a[1] - 1], y = S[b[0]].rank[b[1] - 1]; return (y === y ? y : -Infinity) - (x === x ? x : -Infinity) || a[0].localeCompare(b[0]); });
      const equity = equityAt();
      for (const [s, r] of cands) {
        if (openN >= spec.max_positions) break;
        const st = S[s], px = st.df.o[r], budget = long ? Math.min(equity * size, cash) : equity * size, q = Math.floor(budget / (px * (1 + cost)));
        if (q <= 0) continue;
        st.qty = sgn * q; st.entryPx = px; st.entryR = r; st.entryFee = q * px * cost; cash -= st.qty * px + st.entryFee; st.peak = px;
        st.entryAtr = st.atr ? st.atr[r - 1] : NaNv; openN++;
      }
      for (const [s, r] of today) {
        const st = S[s];
        if (st.qty) {
          const { stop, tgt, stopWhy } = exitLevels(spec.side, st.entryPx, st.peak, st.entryAtr, spec.stop_loss_pct, spec.take_profit_pct, X), o = st.df.o[r], h = st.df.h[r], l = st.df.l[r];
          if (long) { if (stop !== null && l <= stop) closePos(s, r, Math.min(o, stop), stopWhy); else if (tgt !== null && h >= tgt) closePos(s, r, Math.max(o, tgt), "take profit"); }
          else { if (stop !== null && h >= stop) closePos(s, r, Math.max(o, stop), stopWhy); else if (tgt !== null && l <= tgt) closePos(s, r, Math.min(o, tgt), "take profit"); }
          if (st.qty) st.peak = long ? Math.max(st.peak, h) : Math.min(st.peak, l);
        }
        st.last = st.df.c[r];
      }
      for (const s of syms) { const r = S[s].row.get(d); if (r === 0) S[s].last = S[s].df.c[0]; }
      eq[k] = equityAt();
    }
    const states = [];
    for (const s of syms) {
      const st = S[s], L = st.df.c.length, last = L - 1;
      if (st.qty) trades.push({ symbol: s, side: spec.side, entry_date: isoOf(st.df.d[st.entryR]), entry_price: st.entryPx, qty: Math.abs(st.qty), open: true, unrealized: st.qty * (st.df.c[last] - st.entryPx) });
      const lastTrade = trades.filter((t) => t.symbol === s).pop(), lv = st.qty ? exitLevels(spec.side, st.entryPx, st.peak, st.entryAtr, spec.stop_loss_pct, spec.take_profit_pct, X) : null;
      states.push({ symbol: s, side: spec.side, lastDate: isoOf(st.df.d[last]), close: st.df.c[last], inPosition: !!st.qty, qty: Math.abs(st.qty),
        entryPrice: st.qty ? st.entryPx : null, entryDate: st.qty ? isoOf(st.df.d[st.entryR]) : null,
        pendingBuy: !st.qty && !!st.en[last] && !st.ex[last], pendingSell: !!st.qty && !!st.ex[last], rank: st.rank[last],
        exitedToday: !st.qty && lastTrade && !lastTrade.open && lastTrade.exit_date === isoOf(st.df.d[last]) ? lastTrade.reason : null,
        stopLevel: lv ? lv.stop : null, targetLevel: lv ? lv.tgt : null });
      const tr = trades.filter((t) => t.symbol === s && !t.open), w = tr.filter((t) => t.pnl > 0).length;
      perSymbol[s] = { trades: tr.length, win_rate_pct: tr.length ? Math.round(w / tr.length * 1000) / 10 : null, total_pnl: Math.round(tr.reduce((a, t) => a + t.pnl, 0)) };
    }
    // free slots tomorrow: open positions not exiting, and pending entries ranked into the remaining slots
    const staying = states.filter((x) => x.inPosition && !x.pendingSell).length;
    const queue = states.filter((x) => x.pendingBuy).sort((a, b) => (b.rank === b.rank ? b.rank : -Infinity) - (a.rank === a.rank ? a.rank : -Infinity));
    queue.forEach((x, i) => { x.slotOk = i < spec.max_positions - staying; });
    const m = computeMetrics(days, eq, trades, opt.rf);
    m.max_positions = spec.max_positions;
    return { days, eq, trades, metrics: m, perSymbol, states, portfolio: { max_positions: spec.max_positions, open: states.filter((x) => x.inPosition).length } };
  }

  // ---- portfolio / rotation engine
  // Rebalance periods. A new period starts the first trading day whose key differs from the previous day's.
  function periodKey(spec, day) {
    const dt = new Date(day * 864e5), y = dt.getUTCFullYear(), m = dt.getUTCMonth(), thu = day - ((dt.getUTCDay() + 6) % 7) + 3;
    const months = spec.rebalance_months;
    if (months && months.length) { // rebalance on entering any of these calendar months (1-12)
      const ms = months.map((x) => x - 1).sort((a, b) => a - b); let k = -1; for (const x of ms) if (x <= m) k = x;
      return k < 0 ? (y - 1) * 100 + ms[ms.length - 1] : y * 100 + k;
    }
    switch (spec.rebalance) {
      case "daily": return day;
      case "weekly": return thu;            // the Thursday of the ISO week (unique per week)
      case "biweekly": return Math.floor(thu / 14);
      case "quarterly": return y * 10 + Math.floor(m / 3);
      case "semiannual": return y * 10 + Math.floor(m / 6);
      case "annual": return y;
      default: return y * 100 + m;          // monthly
    }
  }
  function nextRebalanceDay(spec, lastDay) {
    const k0 = periodKey(spec, lastDay);
    for (let d = lastDay + 1; d < lastDay + 800; d++) if (((new Date(d * 864e5).getUTCDay() + 6) % 7) <= 4 && periodKey(spec, d) !== k0) return d;
    return lastDay + 1;
  }
  const PRESETS = ["momentum", "risk_adj", "volatility", "trend", "high_52w", "reversal", "liquidity"];
  // the factor list a rotation spec ranks by (old "score" specs map onto one momentum / risk_adj factor)
  function factorList(spec) {
    if (Array.isArray(spec.factors) && spec.factors.length) return spec.factors;
    if (spec.score === "nse_momentum") return [
      { name: "risk_adj", lookback: 126, skip: spec.skip, vol_lookback: 252, weight: 1 },
      { name: "risk_adj", lookback: 252, skip: spec.skip, vol_lookback: 252, weight: 1 }];
    if (spec.score && !PRESETS.includes(spec.score)) return [{ name: spec.score, weight: 1 }]; // expression
    return [{ name: spec.score || "momentum", lookback: spec.lookback, skip: spec.skip, weight: 1 }];
  }
  const isPreset = (f) => PRESETS.includes(f.name);
  function exprsOf(spec) { // every rule-language expression inside a rotation spec
    const out = [];
    for (const f of factorList(spec)) if (!isPreset(f)) out.push(f.name);
    for (const x of spec.filters || []) out.push(x);
    if (spec.regime) out.push(typeof spec.regime === "string" ? spec.regime : spec.regime.expr);
    if (typeof spec.weighting === "string" && !WEIGHTINGS.includes(spec.weighting)) out.push(spec.weighting);
    return out.filter(Boolean);
  }
  const WEIGHTINGS = ["equal", "score", "inverse_vol", "mcap", "mcap_score", "rank"];
  function sharesAt(s, day) {
    const sh = DATA.shares && DATA.shares[s]; if (!sh || !sh.s || !sh.s.length) return NaNv;
    let v = sh.s[0][1]; for (const [d, n] of sh.s) { if (d <= day) v = n; else break; }
    return v * (sh.f || 1);
  }

  function runRotation(spec, frames, opt, universe) {
    const excl = new Set(spec.exclude || []);
    universe = universe.filter((s) => !excl.has(s));
    const tf = spec.trend_filter, reg = spec.regime ? (typeof spec.regime === "string" ? { symbol: "NIFTY", expr: spec.regime } : { symbol: spec.regime.symbol || "NIFTY", expr: spec.regime.expr }) : null;
    const extra = [tf && tf.symbol, reg && reg.symbol, spec.defensive, spec.cash_symbol].filter(Boolean);
    const syms = [...new Set(universe.concat(extra))];
    const sliced = Object.fromEntries(syms.filter((s) => frames[s]).map((s) => [s, sliceFrame(frames[s], null, opt.endDay)]));
    const cm = closeMatrix(sliced, syms);
    const { days, cols } = cm, N = days.length, uni = universe.filter((s) => cols[s]);
    const facs = factorList(spec), ctx = { frames };
    const meta = DATA.meta || {}, notes = [];
    // expression series aligned to the calendar (value known at each day's close)
    const exprCache = new Map();
    function exprSeries(expr, s) {
      const key = expr + "|" + s; let v = exprCache.get(key);
      if (!v) { const df = sliced[s]; v = df ? alignTo(days, df.d, toF(evaluate(parse(expr), df, ctx), df.c.length)) : f64(N); exprCache.set(key, v); }
      return v;
    }
    const firstValid = Object.fromEntries(uni.map((s) => { let k = 0; while (k < N && cols[s][k] !== cols[s][k]) k++; return [s, k]; }));
    const retAt = (s, k) => cols[s][k] / cols[s][k - 1] - 1;
    function volAt(s, i, n) { const r = []; for (let k = Math.max(1, i - n); k < i; k++) { const x = retAt(s, k); if (x === x) r.push(x); } return std1(r) * Math.sqrt(252); }
    // raw factor value for symbol s using data up to row i-1
    function factorRaw(f, s, i) {
      const lb = f.lookback ?? spec.lookback, sk = f.skip ?? spec.skip ?? 0, c = cols[s];
      switch (f.name) {
        case "momentum": case "risk_adj": {
          if (i - 1 - sk - lb < 0) return NaNv;
          let m = c[i - 1 - sk] / c[i - 1 - sk - lb] - 1; if (m !== m) return NaNv;
          if (f.name === "risk_adj" || f.vol_adjust) { m = m / volAt(s, i, f.vol_lookback ?? lb); if (!isFinite(m)) return NaNv; }
          return m;
        }
        case "volatility": { const v = volAt(s, i, lb || 63); return isFinite(v) ? v : NaNv; }
        case "trend": { const n = lb || 200; if (i - n < 0) return NaNv; let t = 0; for (let k = i - n; k < i; k++) t += c[k]; return c[i - 1] / (t / n) - 1; }
        case "high_52w": { const n = lb || 252; if (i - n < 0) return NaNv; let hi = -Infinity; for (let k = i - n; k < i; k++) if (c[k] > hi) hi = c[k]; return c[i - 1] / hi - 1; }
        case "reversal": { const n = lb || 21; return i - 1 - n < 0 ? NaNv : -(c[i - 1] / c[i - 1 - n] - 1); }
        case "liquidity": return exprSeries(`sma(close*volume,${lb || 63})`, s)[i - 1];
        default: return exprSeries(f.name, s)[i - 1];
      }
    }
    const lowerBetter = (f) => f.invert ?? (f.name === "volatility");
    const zs = (vals) => { const ok = vals.filter((v) => v === v); const mu = mean(ok), sd = std1(ok); return vals.map((v) => v !== v ? NaNv : sd > 0 ? Math.max(-3, Math.min(3, (v - mu) / sd)) : 0); };
    const combineZ = facs.length > 1 || spec.combine === "zscore";
    function ranking(i) { // [symbol, score] best first, using rows [0, i)
      const elig = uni.filter((s) => (!spec.min_history_days || i - firstValid[s] >= spec.min_history_days)
        && (spec.filters || []).every((x) => { const v = exprSeries(x, s)[i - 1]; return v === v && v !== 0; }));
      if (!combineZ) {
        const f = facs[0], sg = lowerBetter(f) ? -1 : 1, out = [];
        for (const s of elig) { const v = factorRaw(f, s, i); if (v === v && isFinite(v)) out.push([s, sg * v]); }
        return out.sort((x, y) => y[1] - x[1]);
      }
      const raw = facs.map((f) => elig.map((s) => { const v = factorRaw(f, s, i); return isFinite(v) ? (lowerBetter(f) ? -v : v) : NaNv; }));
      const Z = raw.map(zs), wsum = facs.reduce((a, f) => a + (f.weight ?? 1), 0), out = [];
      elig.forEach((s, j) => { let t = 0; for (let q = 0; q < facs.length; q++) { const z = Z[q][j]; if (z !== z) return; t += (facs[q].weight ?? 1) * z; } out.push([s, t / wsum]); });
      return out.sort((x, y) => y[1] - x[1]);
    }
    function regimeOn(i) {
      if (tf && cols[tf.symbol]) {
        const s = []; for (let k = 0; k < i; k++) { const v = cols[tf.symbol][k]; if (v === v) s.push(v); }
        const n = tf.sma || 200;
        if (s.length >= n && s[s.length - 1] < mean(s.slice(-n))) return false;
      }
      if (reg && sliced[reg.symbol]) { const v = exprSeries(reg.expr, reg.symbol)[i - 1]; if (!(v === v && v !== 0)) return false; }
      return true;
    }
    const mcapAt = (s, i) => sharesAt(s, days[i - 1]) * cols[s][i - 1];
    const normScore = (z) => z >= 0 ? 1 + z : 1 / (1 - z);
    function capWeights(w, cap) {
      for (let it = 0; it < 50; it++) {
        const over = Object.keys(w).filter((s) => w[s] > cap + 1e-12); if (!over.length) break;
        let excess = 0; for (const s of over) { excess += w[s] - cap; w[s] = cap; }
        const free = Object.keys(w).filter((s) => w[s] < cap - 1e-12), tot = free.reduce((a, s) => a + w[s], 0);
        if (!free.length || tot <= 0) break;
        for (const s of free) w[s] += excess * w[s] / tot;
      }
      return w;
    }
    const held = new Set();
    let eqHist = [];
    function weights(i) {
      const on = regimeOn(i), act = spec.regime_action || "cash";
      if (!on && act === "cash") return spec.cash_symbol && cols[spec.cash_symbol] ? { [spec.cash_symbol]: 1 } : {};
      if (!on && act === "defensive") return spec.defensive && cols[spec.defensive] ? { [spec.defensive]: 1 } : {};
      let r = ranking(i);
      if (spec.min_score != null) r = r.filter(([, v]) => v > spec.min_score);
      const nTop = spec.top_pct ? Math.max(1, Math.ceil(r.length * spec.top_pct / 100)) : spec.top_n;
      // selection with optional buffer (keep current holdings while they stay within buffer_rank) and sector caps
      const pick = [], perInd = {}, cap = spec.max_per_sector;
      const indOf = (s) => (meta[s] && meta[s].industry && meta[s].industry !== "Index") ? meta[s].industry : null;
      const take = (s) => { const ind = indOf(s); if (cap && ind && (perInd[ind] || 0) >= cap) return false; pick.push(s); if (ind) perInd[ind] = (perInd[ind] || 0) + 1; return true; };
      if (spec.buffer_rank && spec.buffer_rank > nTop) r.slice(0, spec.buffer_rank).forEach(([s]) => { if (held.has(s) && pick.length < nTop) take(s); });
      for (const [s] of r) { if (pick.length >= nTop) break; if (!pick.includes(s)) take(s); }
      const zr = combineZ ? r.map((x) => x[1]) : zs(r.map((x) => x[1])), zAll = Object.fromEntries(r.map(([s], j) => [s, zr[j]]));
      const wt = spec.weighting || "equal", w = {};
      if (wt === "equal") { const d = spec.underfill === "spread" ? pick.length : nTop; for (const s of pick) w[s] = 1 / d; }
      else {
        const raw = {};
        for (const [j, s] of pick.entries()) {
          let x;
          if (wt === "score") x = normScore(zAll[s]);
          else if (wt === "inverse_vol") x = 1 / volAt(s, i, spec.vol_lookback || 63);
          else if (wt === "mcap" || wt === "mcap_score") { x = mcapAt(s, i); if (wt === "mcap_score") x *= normScore(zAll[s]); }
          else if (wt === "rank") x = pick.length - j;
          else x = Math.max(0, exprSeries(wt, s)[i - 1]);
          raw[s] = isFinite(x) && x > 0 ? x : NaNv;
        }
        const good = pick.filter((s) => raw[s] === raw[s]);
        if (good.length < pick.length) { const msg = `weighting "${wt}" had no data for some names (e.g. ${pick.find((x) => raw[x] !== raw[x])}); they got an equal share instead`; if (!notes.some((x) => x.startsWith(`weighting "${wt}"`))) notes.push(msg); }
        const miss = pick.filter((s) => raw[s] !== raw[s]), totGood = good.reduce((a, s) => a + raw[s], 0), share = pick.length ? good.length / pick.length : 0;
        for (const s of good) w[s] = share * raw[s] / totGood; for (const s of miss) w[s] = 1 / pick.length;
      }
      if (spec.max_weight_pct) capWeights(w, spec.max_weight_pct / 100);
      let expo = on ? 1 : (spec.regime_exposure_pct ?? 50) / 100;
      if (spec.target_vol_pct && eqHist.length > 21) {
        const h = eqHist.slice(-(spec.vol_lookback || 63) - 1), rr = []; for (let k = 1; k < h.length; k++) rr.push(h[k] / h[k - 1] - 1);
        const v = std1(rr) * Math.sqrt(252) * 100; if (v > 0) expo *= Math.min(spec.max_leverage || 1, spec.target_vol_pct / v);
      }
      const longX = (spec.long_exposure_pct ?? 100) / 100;
      for (const s of Object.keys(w)) w[s] *= expo * longX;
      if (spec.short_n) {
        const shorts = r.slice().reverse().map(([s]) => s).filter((s) => !(s in w)).slice(0, spec.short_n), sx = (spec.short_exposure_pct ?? 100) / 100;
        for (const s of shorts) w[s] = -expo * sx / spec.short_n;
      }
      const invested = Object.values(w).filter((x) => x > 0).reduce((a, x) => a + x, 0);
      if (spec.cash_symbol && cols[spec.cash_symbol] && invested < 0.999) w[spec.cash_symbol] = (w[spec.cash_symbol] || 0) + (1 - invested);
      return w;
    }
    const b = new Broker(spec.capital, spec.cost_pct + (spec.slippage_pct || 0)), eqD = [], eqV = [];
    let lastPer = null, rebals = 0, holdSum = 0, traded = 0;
    const maxLb = Math.max(...facs.map((f) => isPreset(f) ? (f.lookback ?? spec.lookback) + (f.skip ?? spec.skip ?? 0) + (f.name === "risk_adj" && f.vol_lookback ? 0 : 0) : 0));
    const startI = facs.length === 1 && isPreset(facs[0]) && !spec.factors ? spec.lookback + spec.skip + 2 : maxLb + 2;
    const cashY = spec.cash_yield_pct ? spec.cash_yield_pct / 100 : 0;
    for (let i = startI; i < N; i++) {
      if (opt.startDay != null && days[i] < opt.startDay) continue;
      if (cashY && eqD.length && b.cash > 0) b.cash *= Math.pow(1 + cashY, (days[i] - eqD[eqD.length - 1]) / 365);
      const marks = {}; for (const s of syms) if (cols[s] && cols[s][i] === cols[s][i]) marks[s] = cols[s][i];
      const per = periodKey(spec, days[i]);
      if (per !== lastPer) {
        eqHist = eqV;
        const w = weights(i), equity = b.equity(marks), band = equity * spec.rebalance_band_pct / 100, orders = [];
        for (const s of new Set([...b.pos.keys(), ...Object.keys(w)])) {
          const p = marks[s]; if (!p || p <= 0) continue;
          let tq = equity * (w[s] || 0) * 0.995 / p; if (!isIndex(s)) tq = tq < 0 ? -Math.floor(-tq) : Math.floor(tq);
          const dq = tq - b.qty(s);
          if (Math.abs(dq) < 1e-9 || (tq !== 0 && Math.abs(dq * p) < band)) continue;
          orders.push([s, dq, p]);
        }
        orders.sort((x, y) => x[1] - y[1]);
        for (const [s, dq, p] of orders) { b.execute(days[i], s, dq, p, "rebalance"); traded += Math.abs(dq * p); }
        lastPer = per; rebals++;
        held.clear(); for (const s of b.pos.keys()) held.add(s);
        holdSum += [...b.pos.keys()].filter((s) => s !== spec.cash_symbol).length;
      }
      eqD.push(days[i]); eqV.push(b.equity(marks));
    }
    const m = computeMetrics(eqD, eqV, null, opt.rf);
    // round trips: from opening a position to flat again (fees included)
    const trips = [], open = {};
    for (const t of b.trades) {
      const o = open[t.symbol] || (open[t.symbol] = { q: 0, pnl: 0, from: t.date });
      if (o.q === 0) { o.from = t.date; o.pnl = 0; }
      o.q += t.qty; o.pnl += t.realized;
      if (Math.abs(o.q) < 1e-9) { trips.push({ symbol: t.symbol, from: o.from, to: t.date, pnl: o.pnl }); o.q = 0; }
    }
    const wins = trips.filter((t) => t.pnl > 0).length, avgEq = eqV.length ? mean(eqV) : spec.capital;
    Object.assign(m, { rebalances: rebals, executions: b.trades.length, orders: b.trades.length, total_fees: Math.round(b.fees * 100) / 100,
      round_trips: trips.length, win_rate_pct: trips.length ? Math.round(wins / trips.length * 1000) / 10 : null,
      avg_hold_days: trips.length ? Math.round(mean(trips.map((t) => (dayOf(t.to) - dayOf(t.from)))) ) : null,
      turnover_pct_yr: m.years ? Math.round(traded / 2 / avgEq / m.years * 1000) / 10 : null,
      avg_holdings: rebals ? Math.round(holdSum / rebals * 10) / 10 : null });
    if (notes.length) m.notes = notes;
    eqHist = eqV;
    const curRank = ranking(N), cur = curRank.slice(0, 10).map(([s, v]) => [s, Math.round(v * 10000) / 100]);
    const lastI = N - 1, lastMarks = {}; for (const s of syms) if (cols[s] && cols[s][lastI] === cols[s][lastI]) lastMarks[s] = cols[s][lastI];
    const holdings = [...b.pos.entries()].map(([s, p]) => ({ symbol: s, qty: p.qty, avg: p.avg, price: lastMarks[s], value: p.qty * (lastMarks[s] ?? p.avg) }));
    const lastDay = days[lastI];
    const rotState = { lastDate: isoOf(lastDay), holdings, nextTargets: weights(N), nextRebalance: isoOf(nextRebalanceDay(spec, lastDay)), equity: b.equity(lastMarks), prices: lastMarks,
      regimeOn: regimeOn(N), ranks: Object.fromEntries(curRank.map(([s], j) => [s, j + 1])) };
    return { days: Float64Array.from(eqD), eq: Float64Array.from(eqV), trades: b.trades, metrics: m, ranking: cur, rotState, roundTrips: trips };
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
  const UNDERLYINGS = { NIFTY: { lot_size: 65, strike_step: 50, expiry: "weekly" }, BANKNIFTY: { lot_size: 30, strike_step: 100, expiry: "monthly" },
    FINNIFTY: { lot_size: 60, strike_step: 50, expiry: "monthly" }, MIDCPNIFTY: { lot_size: 120, strike_step: 25, expiry: "monthly" },
    NIFTYNXT50: { lot_size: 25, strike_step: 100, expiry: "monthly" } };
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
    const li = days.length - 1, lS = Sx[li], lV = Vx[li];
    const openLegs = [...b.pos.entries()].map(([s, p]) => ({ symbol: s, qty: p.qty, entry: p.avg, kind: p.meta.kind, strike: p.meta.strike, expiry: isoOf(p.meta.expiry),
      mark: bsPrice(lS, p.meta.strike, Math.max(0, (p.meta.expiry - days[li]) + 0.25) / 365, r, lV / 100 * sp.iv_mult, p.meta.kind) }));
    const optState = { lastDate: isoOf(days[li]), spot: lS, vix: lV, legs: openLegs, cooldownUntil: st.cooldown != null ? isoOf(st.cooldown) : null,
      credit: openLegs.length ? b.pos.values().next().value.meta.credit : null };
    return { days: Float64Array.from(eqD), eq: Float64Array.from(eqV), trades: cycles, metrics: m, optState };
  }

  // ----------------------------------------------------------------- spec normalisation
  const RULE_DEF = { symbols: [], entry: "", exit: "", side: "long", stop_loss_pct: null, take_profit_pct: null, capital: 1000000, position_size_pct: 100, cost_pct: 0.12 };
  // No hidden filters: a trend filter or score floor exists only when the spec asks for it (omitted = off).
  const ROT_DEF = { universe: "nifty50", lookback: 126, skip: 21, top_n: 5, rebalance: "monthly", score: "momentum", min_score: null,
    trend_filter: null, rebalance_band_pct: 1.0, capital: 1000000, cost_pct: 0.12 };
  const OPT_DEF = { underlying: "NIFTY", structure: "strangle", expiry: null, expiry_weekday: 1, strike_mode: "delta", delta: 0.15, otm_pct: 2.0,
    wing_width: 500, strike_step: null, lot_size: null, lots: 1, min_dte: 2, stop_loss_mult: 2.0, profit_target_pct: 50, exit_dte: 0,
    min_vix: null, max_vix: null, iv_mult: 1.0, capital: 500000, fee_per_order: 20, cost_pct_premium: 0.15, vix_symbol: "INDIAVIX" };
  // Claude (or a person) may write values loosely: "15" for 0.15 delta, "Nifty 50" for nifty50, "RELIANCE.NS",
  // null for "use the default". Normalise all of that here so a sensible strategy never fails on format.
  const NULLABLE = new Set(["stop_loss_pct", "take_profit_pct", "min_score", "trend_filter", "min_vix", "max_vix", "stop_loss_mult", "profit_target_pct", "exit"]);
  const ALIASES = { NIFTY50: "NIFTY", "NIFTY 50": "NIFTY", NIFTY_50: "NIFTY", NSEI: "NIFTY", "BANK NIFTY": "BANKNIFTY", NIFTYBANK: "BANKNIFTY", NIFTY_BANK: "BANKNIFTY", NSEBANK: "BANKNIFTY",
    "INDIA VIX": "INDIAVIX", INDIA_VIX: "INDIAVIX", VIX: "INDIAVIX", NIFTYFIN: "FINNIFTY", NIFTYFINSERVICE: "FINNIFTY", NIFTYFINANCIALSERVICES: "FINNIFTY", NIFTY_FINANCIAL_SERVICES: "FINNIFTY",
    MIDCAPSELECT: "MIDCPNIFTY", NIFTYMIDSELECT: "MIDCPNIFTY", NIFTYMIDCAPSELECT: "MIDCPNIFTY", NIFTY_MIDCAP_SELECT: "MIDCPNIFTY", NIFTYNEXT50: "NIFTYNXT50", NEXT50: "NIFTYNXT50", NIFTY_NEXT_50: "NIFTYNXT50",
    NIFTYIT: "NIFTY_IT", NIFTYPHARMA: "NIFTY_PHARMA", NIFTYAUTO: "NIFTY_AUTO", NIFTYFMCG: "NIFTY_FMCG", NIFTYMETAL: "NIFTY_METAL", NIFTYREALTY: "NIFTY_REALTY",
    NIFTYENERGY: "NIFTY_ENERGY", NIFTYPSUBANK: "NIFTY_PSU_BANK", NIFTYMEDIA: "NIFTY_MEDIA", NIFTYPVTBANK: "NIFTY_PRIVATE_BANK", NIFTY100: "NIFTY_100", NIFTY200: "NIFTY_200", NIFTY500: "NIFTY_500",
    CASH: "NIFTY_1D_RATE_INDEX", LIQUID: "NIFTY_1D_RATE_INDEX", OVERNIGHT: "NIFTY_1D_RATE_INDEX", NIFTY1DRATE: "NIFTY_1D_RATE_INDEX",
    GSEC: "NIFTY_10_YR_BENCHMARK_G_SEC", GSEC10: "NIFTY_10_YR_BENCHMARK_G_SEC", GILT: "NIFTY_10_YR_BENCHMARK_G_SEC", "10YGSEC": "NIFTY_10_YR_BENCHMARK_G_SEC",
    MOMENTUM30: "NIFTY200_MOMENTUM_30", NIFTY200MOMENTUM30: "NIFTY200_MOMENTUM_30",
    BSESN: "SENSEX", ZOMATO: "ETERNAL", TATAMOTORS: "TMPV", "TATA MOTORS": "TMPV", BAJAJAUTO: "BAJAJ-AUTO", "M & M": "M&M", MM: "M&M", MAHINDRA: "M&M" };
  const groupKey = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  function symKey(x) {
    let s = String(x).trim().toUpperCase().replace(/^\^/, "").replace(/\.(NS|BO)$/, "");
    if (ALIASES[s]) return ALIASES[s];
    const squeezed = s.replace(/\s+/g, "");
    return ALIASES[squeezed] || squeezed;
  }
  function expandSymbols(list, universes) {
    if (typeof list === "string") list = universes[groupKey(list)] ? [list] : list.split(/[,;\s]+/).filter(Boolean);
    if (!Array.isArray(list)) list = [];
    const out = [];
    for (const x of list) { const g = universes[groupKey(x)]; if (g) out.push(...g); else out.push(symKey(x)); }
    return [...new Set(out)];
  }
  function clean(o, defaults) {
    const x = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (v === undefined || v === "") continue;
      if (v === null && !NULLABLE.has(k) && defaults[k] !== null) continue; // null -> default
      x[k] = v;
    }
    return x;
  }
  const numOr = (v, d) => { if (v == null || v === "") return d; const n = Number(String(v).replace(/[%x×,\s]/gi, "")); return isFinite(n) ? n : d; };
  const numOrNull = (v) => v == null || v === "" || v === false ? null : numOr(v, null);
  function normalize(spec, universes) {
    if (!spec || typeof spec !== "object") throw new RuleError("No strategy given");
    const t = groupKey(spec.type || "rule");
    const type = t.startsWith("rot") || t.includes("momentum") ? "rotation" : t.includes("option") ? "option_selling" : t === "rule" || t === "" ? "rule" : spec.type;
    if (type === "rule") {
      const s = Object.assign({}, RULE_DEF, clean(spec, RULE_DEF), { type });
      s.symbols = expandSymbols(s.symbols, universes).sort();
      if (!s.symbols.length) throw new RuleError("Add at least one symbol.");
      s.side = /short|sell/i.test(String(s.side)) ? "short" : "long";
      if (!s.entry) throw new RuleError("The strategy needs an entry rule.");
      validate(s.entry);
      if (s.exit) validate(s.exit);
      s.stop_loss_pct = numOrNull(s.stop_loss_pct) || null; s.take_profit_pct = numOrNull(s.take_profit_pct) || null;
      // optional extras are only written when given, so older specs keep exactly their old form
      for (const k of ["trailing_stop_pct", "stop_atr_mult", "target_atr_mult"]) optNum(s, k, (v) => v > 0, `${k} must be positive`);
      for (const k of ["max_hold_days", "atr_period", "max_positions"]) optNum(s, k, (v) => v >= 1, `${k} must be at least 1`, true);
      if (s.rank_by != null) { if (!s.max_positions) delete s.rank_by; else validate(s.rank_by); }
      if (!s.exit && !s.stop_loss_pct && !s.take_profit_pct && !s.trailing_stop_pct && !s.max_hold_days && !s.stop_atr_mult && !s.target_atr_mult)
        throw new RuleError("Give an exit rule or a stop-loss / take-profit / trailing stop / time limit.");
      normBenchmark(s);
      s.position_size_pct = Math.min(100, Math.max(1, numOr(s.position_size_pct, 100)));
      s.capital = numOr(s.capital, RULE_DEF.capital); s.cost_pct = numOr(s.cost_pct, RULE_DEF.cost_pct);
      return s;
    }
    if (type === "rotation") {
      const s = Object.assign({}, ROT_DEF, clean(spec, ROT_DEF), { type });
      const rebRaw = String(s.rebalance).toLowerCase();
      if (Array.isArray(s.universe)) s.universe = expandSymbols(s.universe, universes);
      else if (universes[groupKey(s.universe)]) s.universe = groupKey(s.universe);
      else { const list = expandSymbols(String(s.universe), universes); if (list.length > 1) s.universe = list; else throw new RuleError(`Unknown universe '${s.universe}'. Use one of: ${Object.keys(universes).join(", ")}, or a list of symbols.`); }
      if (spec.trend_filter === null || spec.trend_filter === false) s.trend_filter = null;
      else if (spec.trend_filter === true) s.trend_filter = { symbol: "NIFTY", sma: 200 };
      else if (typeof s.trend_filter === "number") s.trend_filter = { symbol: "NIFTY", sma: s.trend_filter };
      else if (s.trend_filter) s.trend_filter = { symbol: symKey(s.trend_filter.symbol || "NIFTY"), sma: Math.trunc(numOr(s.trend_filter.sma, 200)) };
      s.lookback = Math.trunc(numOr(s.lookback, 126)); s.skip = Math.max(0, Math.trunc(numOr(s.skip, 21))); s.top_n = Math.trunc(numOr(s.top_n, 5));
      s.rebalance = /bi.?week|fortnight|2.?week/.test(rebRaw) ? "biweekly" : /week/.test(rebRaw) ? "weekly" : /dai|day/.test(rebRaw) ? "daily"
        : /quarter|3.?month/.test(rebRaw) ? "quarterly" : /semi|half|6.?month/.test(rebRaw) ? "semiannual" : /annual|year|12.?month/.test(rebRaw) ? "annual" : "monthly";
      if (s.rebalance_months != null) {
        const MN = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        const arr = (Array.isArray(s.rebalance_months) ? s.rebalance_months : String(s.rebalance_months).split(/[,;\s]+/)).map((x) => { const t = String(x).toLowerCase().slice(0, 3); return MN.includes(t) ? MN.indexOf(t) + 1 : Math.trunc(Number(x)); });
        s.rebalance_months = [...new Set(arr.filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b);
        if (!s.rebalance_months.length) delete s.rebalance_months;
      }
      const sc = String(s.score);
      const exprScore = /[()<>*\/+]/.test(sc);
      s.score = /nse/i.test(sc) ? "nse_momentum" : exprScore ? sc : /risk|sharpe|vol/i.test(sc) ? "risk_adj" : "momentum";
      if (exprScore) validate(s.score);
      if (s.factors != null) {
        const FA = { mom: "momentum", momentum: "momentum", return: "momentum", risk_adj: "risk_adj", riskadj: "risk_adj", sharpe: "risk_adj", risk_adjusted_momentum: "risk_adj",
          volatility: "volatility", vol: "volatility", low_vol: "volatility", lowvol: "volatility", low_volatility: "volatility", trend: "trend", high_52w: "high_52w", "52w_high": "high_52w",
          near_high: "high_52w", reversal: "reversal", liquidity: "liquidity", turnover: "liquidity" };
        const list = Array.isArray(s.factors) ? s.factors : [s.factors];
        s.factors = list.map((f) => {
          if (typeof f === "string") f = { name: f };
          const nm = String(f.name ?? f.expr ?? f.factor ?? ""); const key = nm.toLowerCase().replace(/[\s-]+/g, "_");
          const o = { name: FA[key] || nm };
          if (!PRESETS.includes(o.name)) validate(o.name);
          for (const k of ["lookback", "skip", "vol_lookback"]) if (f[k] != null) o[k] = Math.max(0, Math.trunc(numOr(f[k], 0)));
          o.weight = numOr(f.weight, 1);
          if (f.vol_adjust != null) o.vol_adjust = !!f.vol_adjust;
          if (f.invert != null || /low_?vol/.test(key)) o.invert = f.invert != null ? !!f.invert : true;
          return o;
        }).filter((f) => f.name);
        if (!s.factors.length) delete s.factors;
      }
      const zScored = (s.factors && s.factors.length > 1) || s.combine === "zscore" || s.score === "nse_momentum" || exprScore;
      s.min_score = numOrNull(s.min_score); if (!zScored && s.min_score != null && Math.abs(s.min_score) >= 1) s.min_score /= 100;
      if (s.combine != null) s.combine = /z/i.test(String(s.combine)) ? "zscore" : null;
      if (!s.combine) delete s.combine;
      if (s.filters != null) { s.filters = (Array.isArray(s.filters) ? s.filters : [s.filters]).map(String).filter((x) => x.trim()); s.filters.forEach(validate); if (!s.filters.length) delete s.filters; }
      if (s.exclude != null) s.exclude = expandSymbols(s.exclude, universes);
      for (const k of ["top_pct", "max_weight_pct", "regime_exposure_pct", "cash_yield_pct", "target_vol_pct", "max_leverage", "slippage_pct", "long_exposure_pct", "short_exposure_pct"])
        optNum(s, k, (v) => v >= 0, `${k} can't be negative`);
      for (const k of ["buffer_rank", "max_per_sector", "short_n", "min_history_days", "vol_lookback"]) optNum(s, k, (v) => v >= 1, `${k} must be at least 1`, true);
      if (s.weighting != null) {
        const w = String(s.weighting), k = w.toLowerCase().replace(/[\s-]+/g, "_");
        const WA = { equal: "equal", equal_weight: "equal", score: "score", momentum: "score", score_weighted: "score", inverse_vol: "inverse_vol", inverse_volatility: "inverse_vol", risk_parity: "inverse_vol",
          mcap: "mcap", market_cap: "mcap", marketcap: "mcap", free_float: "mcap", mcap_score: "mcap_score", market_cap_score: "mcap_score", nse: "mcap_score", rank: "rank" };
        if (WA[k]) s.weighting = WA[k]; else { validate(w); s.weighting = w; }
        if (s.weighting === "equal") delete s.weighting;
      }
      if (s.underfill != null) { if (/spread|fill|redistrib/i.test(String(s.underfill))) s.underfill = "spread"; else delete s.underfill; }
      if (s.regime != null) {
        if (typeof s.regime === "string") { validate(s.regime); s.regime = { symbol: "NIFTY", expr: s.regime }; }
        else if (s.regime && s.regime.expr) { validate(s.regime.expr); s.regime = { symbol: symKey(s.regime.symbol || "NIFTY"), expr: String(s.regime.expr) }; }
        else delete s.regime;
      }
      if (s.regime_action != null) s.regime_action = /def/i.test(String(s.regime_action)) ? "defensive" : /reduc|scale|half|partial/i.test(String(s.regime_action)) ? "reduce" : "cash";
      for (const k of ["defensive", "cash_symbol"]) if (s[k] != null) s[k] = symKey(s[k]);
      if (s.regime_action === "defensive" && !s.defensive) throw new RuleError('regime_action "defensive" needs a "defensive" symbol (e.g. GSEC or NIFTY_LOW_VOLATILITY_50).');
      if (s.short_n) { for (const k of ["short_exposure_pct"]) if (s[k] == null) s[k] = 100; }
      normBenchmark(s);
      s.rebalance_band_pct = numOr(s.rebalance_band_pct, 1); s.capital = numOr(s.capital, ROT_DEF.capital); s.cost_pct = numOr(s.cost_pct, ROT_DEF.cost_pct);
      if (s.top_n < 1 || (s.lookback < 5 && !s.factors && !exprScore)) throw new RuleError("Hold at least 1 name and rank over at least 5 days.");
      return s;
    }
    if (type === "option_selling") {
      const s = Object.assign({}, OPT_DEF, clean(spec, OPT_DEF), { type });
      s.underlying = symKey(s.underlying);
      if (!UNDERLYINGS[s.underlying]) throw new RuleError(`Option selling works on NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY or NIFTYNXT50 here, not '${s.underlying}'.`);
      const base = UNDERLYINGS[s.underlying];
      for (const k of ["lot_size", "strike_step"]) s[k] = Math.trunc(numOr(s[k], base[k]));
      s.expiry = /week/i.test(String(s.expiry)) ? "weekly" : /month/i.test(String(s.expiry)) ? "monthly" : base.expiry;
      const st = groupKey(s.structure);
      s.structure = st.includes("condor") ? "iron_condor" : st.includes("straddle") ? "straddle" : st.includes("put") ? "short_put" : st.includes("call") ? "short_call" : "strangle";
      // strikes: delta written as 0.15 or 15 both mean 15 delta
      if (!/otm|pct|percent/i.test(String(s.strike_mode)) && !(spec.strike_mode == null && spec.delta == null && spec.otm_pct != null)) {
        s.strike_mode = "delta"; let d = numOr(s.delta, 0.15); if (d >= 1 && d < 50) d /= 100;
        if (!(d > 0 && d < 0.5)) throw new RuleError("Delta should be between 1 and 49 (e.g. 15 delta = 0.15).");
        s.delta = d;
      } else { s.strike_mode = "otm_pct"; s.otm_pct = numOr(s.otm_pct, 2); if (!(s.otm_pct > 0 && s.otm_pct < 30)) throw new RuleError("% out of the money should be between 0 and 30."); }
      s.lots = Math.max(1, Math.trunc(numOr(s.lots, 1))); s.wing_width = numOr(s.wing_width, 500); s.min_dte = Math.trunc(numOr(s.min_dte, 2)); s.exit_dte = Math.trunc(numOr(s.exit_dte, 0));
      s.expiry_weekday = Math.trunc(numOr(s.expiry_weekday, 1));
      s.stop_loss_mult = numOrNull(s.stop_loss_mult); s.profit_target_pct = numOrNull(s.profit_target_pct);
      if (s.profit_target_pct != null && s.profit_target_pct > 0 && s.profit_target_pct <= 1) s.profit_target_pct *= 100;
      s.min_vix = numOrNull(s.min_vix); s.max_vix = numOrNull(s.max_vix); s.iv_mult = numOr(s.iv_mult, 1);
      s.capital = numOr(s.capital, OPT_DEF.capital); s.fee_per_order = numOr(s.fee_per_order, 20); s.cost_pct_premium = numOr(s.cost_pct_premium, 0.15);
      normBenchmark(s);
      return s;
    }
    throw new RuleError(`Unknown strategy type '${spec.type}'. Use rule, rotation or option_selling.`);
  }
  function optNum(s, k, ok, msg, int) {
    if (s[k] == null || s[k] === false) { delete s[k]; return; }
    let v = numOr(s[k], NaNv); if (int) v = Math.trunc(v);
    if (!(v === v)) { delete s[k]; return; }
    if (!ok(v)) throw new RuleError(msg);
    if (v === 0 && !int) { delete s[k]; return; }
    s[k] = v;
  }
  function normBenchmark(s) { if (s.benchmark == null || s.benchmark === "") { delete s.benchmark; return; } s.benchmark = symKey(s.benchmark); if (s.benchmark === "NIFTY") delete s.benchmark; }
  function symbolsNeeded(s, universes) {
    const extra = [s.benchmark].filter(Boolean);
    if (s.type === "rule") return [...new Set(s.symbols.concat(refSymbols(s.entry), refSymbols(s.exit), refSymbols(s.rank_by), extra))];
    if (s.type === "rotation") {
      const u = Array.isArray(s.universe) ? s.universe : (universes[s.universe] || []);
      const refs = exprsOf(s).flatMap(refSymbols);
      return [...new Set(u.concat(s.trend_filter ? [s.trend_filter.symbol] : [], s.regime ? [s.regime.symbol] : [], [s.defensive, s.cash_symbol].filter(Boolean), refs, extra))];
    }
    return [s.underlying, s.vix_symbol, ...extra];
  }
  // does this spec need full OHLCV (open/high/low/volume/valuation) rather than closes only?
  const OHLCV_RX = /\b(open|high|low|volume|hl2|hlc3|pe|pb|dy|atr|atr_pct|adx|plus_di|minus_di|stoch_k|stoch_d|cci|mfi|williams_r|obv|vwap|supertrend|keltner_upper|keltner_lower)\b/;
  function needsFull(s) {
    if (s.type === "rule") return true;
    if (s.type === "rotation") return exprsOf(s).some((e) => OHLCV_RX.test(e)) || factorList(s).some((f) => f.name === "liquidity");
    return false;
  }
  function run(spec, frames, universes, opt = {}) {
    const o = { rf: 0.065, startDay: opt.start ? dayOf(opt.start) : null, endDay: opt.end ? dayOf(opt.end) : null };
    let res;
    if (spec.type === "rule") res = runRule(spec, frames, o);
    else if (spec.type === "rotation") res = runRotation(spec, frames, o, Array.isArray(spec.universe) ? spec.universe : universes[spec.universe]);
    else res = runOptions(spec, frames, o);
    // benchmark: NIFTY (or spec.benchmark) buy & hold on the same dates
    const bsym = spec.benchmark || "NIFTY"; res.benchName = bsym;
    if (frames[bsym] && res.days.length > 1) {
      const n = frames[bsym], bench = f64(res.days.length); let j = 0, last = NaNv;
      for (let i = 0; i < res.days.length; i++) { while (j < n.d.length && n.d[j] <= res.days[i]) { last = n.c[j]; j++; } bench[i] = last; }
      let first = 0; while (first < bench.length && bench[first] !== bench[first]) first++;
      const scale = res.eq[0] / bench[first];
      res.bench = bench.map((v) => v * scale);
      const bm = computeMetrics(res.days.slice(first), res.bench.slice(first), null, o.rf);
      res.benchMetrics = { total_return_pct: bm.total_return_pct, cagr_pct: bm.cagr_pct, sharpe: bm.sharpe, max_drawdown_pct: bm.max_drawdown_pct };
    }
    return res;
  }

  // ================================================================= analysis layer
  const r2 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;

  // ---- today's actions
  function signals(spec, res) {
    const out = [];
    if (spec.type === "rule") {
      const sl = spec.stop_loss_pct, tp = spec.take_profit_pct, long = spec.side === "long";
      const lv = (p, pct, dir) => pct ? p * (1 + dir * pct / 100) : null;
      for (const st of res.states || []) {
        let action, note;
        if (st.pendingSell) { action = long ? "SELL" : "COVER"; note = "Exit rule triggered at today's close — exit at next open"; }
        else if (st.pendingBuy) { action = long ? "BUY" : "SHORT"; note = "Entry rule triggered at today's close — enter at next open"; }
        else if (st.exitedToday) { action = "EXITED"; note = `Position closed today (${st.exitedToday})`; }
        else if (st.inPosition) { action = "HOLD"; note = `In position since ${st.entryDate}`; }
        else { action = "WAIT"; note = "No position, entry rule not met"; }
        if (st.pendingBuy && st.slotOk === false) { action = "WAIT"; note = `Entry rule met, but all ${spec.max_positions} portfolio slots are taken (ranked lower)`; }
        const ref = st.inPosition ? st.entryPrice : st.close;
        let stop = (st.inPosition || st.pendingBuy) ? lv(ref, sl, long ? -1 : 1) : null, target = (st.inPosition || st.pendingBuy) ? lv(ref, tp, long ? 1 : -1) : null;
        if (st.inPosition && st.stopLevel != null) stop = st.stopLevel;
        if (st.inPosition && st.targetLevel != null) target = st.targetLevel;
        if (st.pendingBuy && st.atrNow === st.atrNow && st.atrNow != null) {
          if (spec.stop_atr_mult) { const x = ref + (long ? -1 : 1) * spec.stop_atr_mult * st.atrNow; stop = stop == null ? x : (long ? Math.max(stop, x) : Math.min(stop, x)); }
          if (spec.target_atr_mult) { const x = ref + (long ? 1 : -1) * spec.target_atr_mult * st.atrNow; target = target == null ? x : (long ? Math.min(target, x) : Math.max(target, x)); }
        }
        out.push({ symbol: st.symbol, action, price: r2(st.close), date: st.lastDate, note,
          entry: st.inPosition ? r2(st.entryPrice) : null,
          stop: r2(stop),
          target: r2(target),
          pnl_pct: st.inPosition ? r2((long ? 1 : -1) * (st.close / st.entryPrice - 1) * 100) : null });
      }
    } else if (spec.type === "rotation") {
      const rs = res.rotState, held = new Set(rs.holdings.map((h) => h.symbol)), tgt = rs.nextTargets;
      const top = spec.top_pct ? `top ${spec.top_pct}%` : `top ${spec.top_n}`, park = (s) => s === spec.cash_symbol || (s === spec.defensive && rs.regimeOn === false);
      const rank = (s) => rs.ranks && rs.ranks[s] ? ` (rank ${rs.ranks[s]})` : "";
      for (const h of rs.holdings) {
        const t = tgt[h.symbol], shortPos = h.qty < 0;
        let action, note;
        if (!t) { action = shortPos ? "COVER" : "SELL"; note = park(h.symbol) ? `Leave the parking asset — redeploy at next rebalance (${rs.nextRebalance})` : shortPos ? `No longer among the weakest — cover at next rebalance (${rs.nextRebalance})` : `Dropped out of the ${top}${rank(h.symbol)} — sell at next rebalance (${rs.nextRebalance})`; }
        else if ((t < 0) !== shortPos) { action = t < 0 ? "SHORT" : "BUY"; note = `Flip the position at next rebalance (${rs.nextRebalance})`; }
        else { action = shortPos ? "HOLD SHORT" : "HOLD"; note = park(h.symbol) ? "Parking asset for idle cash" : shortPos ? "Still among the weakest (short leg)" : "Still in the top ranks"; }
        out.push({ symbol: h.symbol, action, price: r2(h.price), date: rs.lastDate, note, weight_pct: r2(h.value / rs.equity * 100), target_weight_pct: t ? r2(t * 100) : 0 });
      }
      for (const s of Object.keys(tgt)) if (!held.has(s)) out.push({ symbol: s, action: tgt[s] < 0 ? "SHORT" : "BUY", price: r2(rs.prices[s]), date: rs.lastDate,
        note: park(s) ? `Park idle cash here at next rebalance (${rs.nextRebalance})` : tgt[s] < 0 ? `Among the weakest ${spec.short_n} — short at next rebalance (${rs.nextRebalance})` : `Entered the ${top}${rank(s)} — buy at next rebalance (${rs.nextRebalance})`, weight_pct: r2(tgt[s] * 100) });
      // a change is "due" only when the next session is the rebalance day; until then it is a preview (not an alert)
      let nx = dayOf(rs.lastDate) + 1; while (((new Date(nx * 864e5).getUTCDay() + 6) % 7) > 4) nx++;
      const due = isoOf(nx) === rs.nextRebalance;
      for (const o of out) if (/BUY|SELL|SHORT|COVER/.test(o.action) && !/HOLD/.test(o.action)) o.due = due;
      if (!out.length) out.push({ symbol: "-", action: "CASH", date: rs.lastDate, note: rs.regimeOn === false ? (spec.trend_filter ? `Trend filter off (${spec.trend_filter.symbol} below its ${spec.trend_filter.sma}-day average)` : `Regime filter off (${spec.regime ? spec.regime.expr : ""})`) : spec.trend_filter ? `Trend filter off (${spec.trend_filter.symbol} below its ${spec.trend_filter.sma}-day average) or nothing qualifies` : "Nothing qualifies" });
    } else if (spec.type === "option_selling") {
      const os = res.optState;
      if (os.legs.length) for (const l of os.legs) out.push({ symbol: l.symbol, action: l.qty < 0 ? "HOLD SHORT" : "HOLD LONG", price: r2(l.mark), date: os.lastDate,
        entry: r2(l.entry), note: `${l.kind} ${l.strike} expiring ${l.expiry}; model price ${r2(l.mark)} vs sold at ${r2(l.entry)}` });
      else out.push({ symbol: spec.underlying, action: os.cooldownUntil ? "WAIT" : "SELL NEW", price: r2(os.spot), date: os.lastDate,
        note: os.cooldownUntil ? `Stopped out; next entry after ${os.cooldownUntil}` : `Open a new ${spec.structure.replace("_", " ")} at next session (VIX ${r2(os.vix)})` });
    }
    const order = { BUY: 0, SHORT: 0, SELL: 1, COVER: 1, "SELL NEW": 1, EXITED: 2, HOLD: 3, "HOLD SHORT": 3, "HOLD LONG": 3, CASH: 4, WAIT: 5 };
    return out.sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9) || String(a.symbol).localeCompare(b.symbol));
  }

  // ---- train / test split on one continuous run
  function sliceRes(res, fromDay, toDay) {
    const D = [], E = [], B = [];
    for (let i = 0; i < res.days.length; i++) { const d = res.days[i]; if ((fromDay == null || d >= fromDay) && (toDay == null || d < toDay)) { D.push(d); E.push(res.eq[i]); if (res.bench) B.push(res.bench[i]); } }
    return { D, E, B };
  }
  function tradeInWindow(t, fromIso, toIso) { const d = t.entry_date || t.date; return d && (!fromIso || d >= fromIso) && (!toIso || d < toIso); }
  function splitMetrics(res, splitIso, rf = 0.065) {
    const sd = dayOf(splitIso), out = {};
    for (const [k, a, b, fi, ti] of [["train", null, sd, null, splitIso], ["test", sd, null, splitIso, null]]) {
      const { D, E, B } = sliceRes(res, a, b);
      const hasPnl = (res.trades || []).some((t) => "pnl" in t);
      const tr = hasPnl ? res.trades.filter((t) => "pnl" in t && tradeInWindow(t, fi, ti)) : null;
      out[k] = { strategy: computeMetrics(D, E, tr, rf), nifty: B.length ? computeMetrics(D, B, null, rf) : null };
    }
    const tr = out.train.strategy, te = out.test.strategy;
    const flags = [];
    if (te.sharpe != null && tr.sharpe != null && te.sharpe < tr.sharpe - 0.5) flags.push("Risk-adjusted returns fell sharply out of sample");
    if (tr.cagr_pct > 0 && te.cagr_pct < tr.cagr_pct * 0.4) flags.push("Test-period CAGR is under 40% of the training CAGR");
    if (te.max_drawdown_pct < tr.max_drawdown_pct * 1.5 && te.max_drawdown_pct < -15) flags.push("Drawdowns were much deeper out of sample");
    if ((te.trades ?? 99) < 20 && res.trades && res.trades.length && "pnl" in (res.trades[0] || {})) flags.push("Fewer than 20 trades in the test period — too few to judge");
    out.verdict = flags.length ? "caution" : "consistent"; out.flags = flags;
    return out;
  }

  // ---- risk statistics
  function dailyRets(arr) { const r = []; for (let i = 1; i < arr.length; i++) if (arr[i - 1] > 0 && isFinite(arr[i])) r.push(arr[i] / arr[i - 1] - 1); else r.push(0); return r; }
  function riskStats(res) {
    const rs = dailyRets(res.eq), out = {};
    if (res.bench) {
      const rb = dailyRets(res.bench); let mA = mean(rs), mB = mean(rb), cov = 0, vb = 0, va = 0;
      for (let i = 0; i < rs.length; i++) { cov += (rs[i] - mA) * (rb[i] - mB); vb += (rb[i] - mB) ** 2; va += (rs[i] - mA) ** 2; }
      out.beta = r2(cov / vb); out.correlation = r2(cov / Math.sqrt(va * vb));
      out.nifty_fall_10_impact_pct = r2(-10 * cov / vb);
    }
    const sorted = rs.slice().sort((a, b) => a - b), k = Math.max(1, Math.floor(sorted.length * 0.05));
    out.var95_daily_pct = r2(-sorted[k - 1] * 100); out.cvar95_daily_pct = r2(-mean(sorted.slice(0, k)) * 100);
    out.worst_day_pct = r2(sorted[0] * 100); out.best_day_pct = r2(sorted[sorted.length - 1] * 100);
    const months = new Map(); for (let i = 0; i < res.days.length; i++) { const dt = new Date(res.days[i] * 864e5), key = dt.getUTCFullYear() * 100 + dt.getUTCMonth(); if (!months.has(key)) months.set(key, [res.eq[i], res.eq[i]]); months.get(key)[1] = res.eq[i]; }
    let prev = null; const mret = [];
    for (const [key, [, end]] of months) { if (prev != null) mret.push([key, (end / prev - 1) * 100]); prev = end; }
    mret.sort((a, b) => a[1] - b[1]);
    const lbl = (k) => `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][k % 100]} ${Math.floor(k / 100)}`;
    if (mret.length) { out.worst_month = { month: lbl(mret[0][0]), pct: r2(mret[0][1]) }; out.best_month = { month: lbl(mret[mret.length - 1][0]), pct: r2(mret[mret.length - 1][1]) };
      out.positive_months_pct = r2(mret.filter((m) => m[1] > 0).length / mret.length * 100); }
    // longest time under water
    let pk = -Infinity, pkI = 0, longest = 0; for (let i = 0; i < res.eq.length; i++) { if (res.eq[i] >= pk) { pk = res.eq[i]; pkI = i; } else longest = Math.max(longest, res.days[i] - res.days[pkI]); }
    out.longest_drawdown_days = Math.round(longest);
    return out;
  }

  // ---- crisis replays (windows of the continuous run)
  const CRISES = [
    { name: "2015–16 slowdown", from: "2015-03-02", to: "2016-02-29" },
    { name: "2018 IL&FS / mid-cap crash", from: "2018-01-24", to: "2018-10-26" },
    { name: "2020 Covid crash", from: "2020-01-17", to: "2020-03-24" },
    { name: "2020–21 recovery", from: "2020-03-24", to: "2021-03-31" },
    { name: "2022 rate hikes & war", from: "2022-01-17", to: "2022-06-17" },
    { name: "2024–25 correction", from: "2024-09-27", to: "2025-03-04" },
  ];
  function crises(res) {
    return CRISES.map((c) => {
      const { D, E, B } = sliceRes(res, dayOf(c.from), dayOf(c.to) + 1);
      if (D.length < 5) return { ...c, note: "outside tested period" };
      const dd = (arr) => { let p = -Infinity, m = 0; for (const v of arr) { p = Math.max(p, v); m = Math.min(m, v / p - 1); } return r2(m * 100); };
      return { ...c, strategy_pct: r2((E[E.length - 1] / E[0] - 1) * 100), nifty_pct: B.length ? r2((B[B.length - 1] / B[0] - 1) * 100) : null,
        strategy_max_dd_pct: dd(E), nifty_max_dd_pct: B.length ? dd(B) : null };
    });
  }

  // ---- Monte Carlo: block bootstrap of daily returns (seeded, reproducible)
  function monteCarlo(res, { paths = 1000, horizon = 252, block = 20, seed = 42 } = {}) {
    const rs = dailyRets(res.eq); if (rs.length < block * 3) return null;
    let a = seed >>> 0; const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const R = [], DD = [];
    for (let p = 0; p < paths; p++) {
      let v = 1, pk = 1, mdd = 0, n = 0;
      while (n < horizon) { const s = Math.floor(rnd() * (rs.length - block)); for (let k = 0; k < block && n < horizon; k++, n++) { v *= 1 + rs[s + k]; pk = Math.max(pk, v); mdd = Math.min(mdd, v / pk - 1); } }
      R.push((v - 1) * 100); DD.push(mdd * 100);
    }
    const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return r2(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
    return { paths, horizon_days: horizon, return_p5: q(R, 0.05), return_p50: q(R, 0.5), return_p95: q(R, 0.95),
      max_dd_p50: q(DD, 0.5), max_dd_p5: q(DD, 0.05), prob_loss_pct: r2(R.filter((x) => x < 0).length / R.length * 100),
      prob_dd_worse_20_pct: r2(DD.filter((x) => x < -20).length / DD.length * 100) };
  }

  // ---- expression rewriting for sensitivity tests
  function unparse(n) {
    switch (n.t) {
      case "num": return String(n.v);
      case "var": return n.v;
      case "str": return JSON.stringify(n.v);
      case "neg": return `-(${unparse(n.a)})`;
      case "not": return `not (${unparse(n.a)})`;
      case "bool": return `(${unparse(n.a)}) ${n.op} (${unparse(n.b)})`;
      case "bin": return `(${unparse(n.a)} ${n.op} ${unparse(n.b)})`;
      case "cmp": return unparse(n.first) + n.parts.map(([op, x]) => ` ${op} ${unparse(x)}`).join("");
      case "call": return `${n.f}(${n.args.map(unparse).concat(Object.entries(n.kw).map(([k, v]) => `${k}=${unparse(v)}`)).join(", ")})`;
    }
  }
  const WINDOW_FUNCS = new Set(["sma", "ema", "wma", "rsi", "atr", "atr_pct", "macd", "macd_signal", "bb_upper", "bb_lower", "highest", "lowest", "roc", "stdev", "zscore", "volatility", "count_true", "change",
    "ret", "sum", "median", "pct_rank", "slope", "corr", "beta", "adx", "plus_di", "minus_di", "stoch_k", "stoch_d", "cci", "mfi", "williams_r", "vwap", "supertrend", "keltner_upper", "keltner_lower"]);
  function scaleWindows(expr, f) {
    const walk = (n) => {
      if (!n || typeof n !== "object") return n;
      if (n.t === "call") {
        const scale = (x) => (x.t === "num" && Number.isInteger(x.v) && x.v >= 2 && WINDOW_FUNCS.has(n.f)) ? { t: "num", v: Math.max(2, Math.round(x.v * f)) } : walk(x);
        return { ...n, args: n.args.map(scale), kw: Object.fromEntries(Object.entries(n.kw).map(([k, v]) => [k, scale(v)])) };
      }
      const o = { ...n }; for (const k of ["a", "b", "first"]) if (o[k]) o[k] = walk(o[k]); if (o.parts) o.parts = o.parts.map(([op, x]) => [op, walk(x)]); return o;
    };
    return unparse(walk(parse(expr)));
  }
  function variant(spec, f) {
    const s = JSON.parse(JSON.stringify(spec));
    const sc = (x) => x ? r2(x * f) : x;
    if (s.type === "rule") {
      s.entry = scaleWindows(s.entry, f); if (s.exit) s.exit = scaleWindows(s.exit, f); if (s.stop_loss_pct) s.stop_loss_pct = r2(s.stop_loss_pct * f); if (s.take_profit_pct) s.take_profit_pct = r2(s.take_profit_pct * f);
      for (const k of ["trailing_stop_pct", "stop_atr_mult", "target_atr_mult"]) if (s[k]) s[k] = sc(s[k]);
      if (s.max_hold_days) s.max_hold_days = Math.max(1, Math.round(s.max_hold_days * f));
    }
    else if (s.type === "rotation") {
      s.lookback = Math.max(5, Math.round(s.lookback * f)); s.skip = Math.round(s.skip * f);
      if (s.factors) s.factors = s.factors.map((x) => PRESETS.includes(x.name) ? { ...x, ...(x.lookback ? { lookback: Math.max(5, Math.round(x.lookback * f)) } : {}), ...(x.skip ? { skip: Math.round(x.skip * f) } : {}) } : { ...x, name: scaleWindows(x.name, f) });
      if (s.score && !PRESETS.includes(s.score) && s.score !== "nse_momentum") s.score = scaleWindows(s.score, f);
      if (s.filters) s.filters = s.filters.map((x) => scaleWindows(x, f));
      if (s.regime) s.regime = { ...s.regime, expr: scaleWindows(s.regime.expr, f) };
    }
    else { if (s.strike_mode === "delta") s.delta = Math.min(0.45, r2(s.delta * f)); else s.otm_pct = r2(s.otm_pct / f); if (s.stop_loss_mult) s.stop_loss_mult = r2(1 + (s.stop_loss_mult - 1) * f); }
    return s;
  }
  function sensitivity(spec, frames, universes, opt) {
    return [0.8, 0.9, 1, 1.1, 1.2].map((f) => {
      const s = f === 1 ? spec : variant(spec, f), r = run(s, frames, universes, opt), m = r.metrics;
      return { factor: f, label: f === 1 ? "As designed" : `Parameters ${f > 1 ? "+" : "−"}${Math.round(Math.abs(f - 1) * 100)}%`,
        cagr_pct: m.cagr_pct, max_drawdown_pct: m.max_drawdown_pct, sharpe: m.sharpe, trades: m.trades ?? m.cycles ?? m.executions,
        detail: s.type === "rule" ? `${s.entry}${s.exit ? "  |  exit: " + s.exit : ""}` : s.type === "rotation" ? `lookback ${s.lookback}, skip ${s.skip}` : `delta ${s.delta}, stop ${s.stop_loss_mult}x` };
    });
  }
  function costShock(spec, frames, universes, opt) {
    return [1, 2, 3].map((k) => {
      const s = JSON.parse(JSON.stringify(spec));
      if (s.type === "option_selling") { s.fee_per_order *= k; s.cost_pct_premium *= k; } else s.cost_pct *= k;
      const m = run(s, frames, universes, opt).metrics;
      return { multiple: k, label: k === 1 ? "Current costs" : `${k}× costs & slippage`, cagr_pct: m.cagr_pct, max_drawdown_pct: m.max_drawdown_pct, sharpe: m.sharpe };
    });
  }
  function stressAll(spec, res, frames, universes, opt) {
    return { risk: riskStats(res), crises: crises(res), monteCarlo: monteCarlo(res), sensitivity: sensitivity(spec, frames, universes, opt), costs: costShock(spec, frames, universes, opt) };
  }

  const api = { parse, evaluate, condition, validate, frame, framesFromPack, run, normalize, symbolsNeeded, computeMetrics, isoOf, dayOf, RuleError, FUNCS, VARS, bsPrice,
    signals, splitMetrics, riskStats, crises, monteCarlo, sensitivity, costShock, stressAll, scaleWindows, unparse, CRISES,
    setData, needsFull, refSymbols, periodKey, nextRebalanceDay, factorList, exprsOf, PRESETS, WEIGHTINGS, symKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TradeEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
