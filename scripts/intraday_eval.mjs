// Rule evaluation for the live intraday paper runner with the app's own engine (lab/engine.js), so an agent built and
// backtested in the app is traded live by exactly the same rule language. Started once by tradeos/live/intraday.py;
// one JSON request per line on stdin, one JSON reply per line on stdout.
//   request: {"m": bar_minutes, "or": opening_range_minutes, "exprs": {"entry": "...", "exit": "...", "rank_by": "..."},
//             "bars": {"SYM": {"k": [bar index since 09:15], "o":[], "h":[], "l":[], "c":[], "v":[], "vwap":[], "day_open":[], "prev_close":[], "day_high":[], "day_low":[]}}}
//   reply:   {"ok": true, "out": {"SYM": {"entry": 0|1, "exit": 0|1, "rank_by": number|null}}}  (values at the last bar)
// ref("SYMBOL", ...) and vix use daily closes from data/prices/<SYMBOL>.csv as of yesterday (same as the backtest).
import fs from "node:fs"; import path from "node:path"; import readline from "node:readline"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const E = require(path.join(root, "lab", "engine.js"));
const daily = {};
function frameOf(sym) {
  if (sym in daily) return daily[sym];
  const f = path.join(root, "data", "prices", `${sym}.csv`);
  if (!fs.existsSync(f)) return (daily[sym] = null);
  const rows = fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const col = (i) => Float64Array.from(rows, (r) => Number(r[i]));
  return (daily[sym] = { d: Float64Array.from(rows, (r) => E.dayOf(r[0])), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5), sym });
}
const ast = new Map(); const P = (x) => { if (!ast.has(x)) ast.set(x, E.parse(x)); return ast.get(x); };
function handle(req) {
  const m = req.m, orMin = req.or ?? 15, today = E.dayOf(new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10));
  const refs = Object.values(req.exprs || {}).filter(Boolean).flatMap((x) => E.refSymbols(x));
  const frames = {}; for (const s of refs) { const f = frameOf(s); if (f) frames[s] = f; }
  const out = {};
  for (const [sym, b] of Object.entries(req.bars || {})) {
    const n = b.c.length; if (!n) continue;
    const F = (a) => Float64Array.from(a, (x) => x == null ? NaN : x);
    const df = { d: new Float64Array(n).fill(req.day ?? today), o: F(b.o), h: F(b.h), l: F(b.l), c: F(b.c), v: F(b.v), sym };
    const mins = Float64Array.from(b.k, (k) => Math.min(375, (k + 1) * m)), orh = new Float64Array(n).fill(NaN), orl = new Float64Array(n).fill(NaN);
    let hi = -Infinity, lo = Infinity, have = false;
    for (let i = 0; i < n; i++) if (mins[i] <= orMin) { hi = Math.max(hi, df.h[i]); lo = Math.min(lo, df.l[i]); have = true; }
    for (let i = 0; i < n; i++) if (have && mins[i] >= orMin) { orh[i] = hi; orl[i] = lo; }
    const pc = F(b.prev_close);
    const intra = { vwap: F(b.vwap), day_open: F(b.day_open), prev_close: pc, day_high: F(b.day_high), day_low: F(b.day_low), or_high: orh, or_low: orl, minutes: mins,
      day_ret: df.c.map((x, i) => (x / pc[i] - 1) * 100) };
    const ctx = { frames, intra, intraday: true }, r = {};
    for (const [k, x] of Object.entries(req.exprs || {})) {
      if (!x) continue;
      const v = E.evaluate(P(x), df, ctx), last = typeof v === "number" ? v : v[n - 1];
      r[k] = k === "rank_by" ? (isFinite(last) ? last : null) : (last && last === last ? 1 : 0);
    }
    out[sym] = r;
  }
  return out;
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let reply;
  try { reply = { ok: true, out: handle(JSON.parse(line)) }; } catch (e) { reply = { ok: false, error: String(e && e.message || e) }; }
  process.stdout.write(JSON.stringify(reply) + "\n");
});
