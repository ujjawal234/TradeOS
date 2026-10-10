// Shared data loading for the Node scripts (book_run.mjs): the app build's manifest, closes, full OHLCV bundles,
// point-in-time data, option summaries/chains, intraday bars and company results, the same way the app loads them.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
export const E = require(path.join(here, "..", "lab", "engine.js"));
export const readJ = (f) => { const js = JSON.parse(fs.readFileSync(f, "utf8")); return js && typeof js.b64gz === "string" ? JSON.parse(zlib.gunzipSync(Buffer.from(js.b64gz, "base64")).toString("utf8")) : js; };

export function loadData(dir) {
  const data = path.join(dir, "data");
  const man = JSON.parse(fs.readFileSync(path.join(data, "manifest.json"), "utf8"));
  const light = E.framesFromPack(JSON.parse(fs.readFileSync(path.join(data, "closes.json"), "utf8")));
  const lastDay = Object.values(man.symbols).map((s) => s.last).sort().pop();
  let shares = null; try { shares = JSON.parse(fs.readFileSync(path.join(data, "shares.json"), "utf8")); } catch (e) { /* optional */ }
  E.setData({ meta: man.symbols, shares, frames: light, ...(man.options ? { optIndex: man.options.underlyings } : {}) });
  const optLoaded = { c: new Set(), s: new Set() }, optFiles = {};
  function ensureOptions(syms, kind) {
    const U = (man.options && man.options.underlyings) || {};
    for (const x of new Set(syms)) {
      if (!U[x] || !U[x][kind] || optLoaded[kind].has(x)) continue;
      const k = U[x][kind], js = (optFiles[k] ||= readJ(path.join(data, "opt", `${k}.json`)));
      for (const [y, p] of Object.entries(js)) { if (kind === "c") E.setOptions(y, p); else E.setOptionSummary(y, p); optLoaded[kind].add(y); }
    }
  }
  const intraLoaded = new Set();
  function ensureIntraday(spec) {
    const I = man.intraday; if (!I) throw new Error("no intraday bars in this build");
    const kind = spec.bar_minutes % 5 === 0 ? "5m" : "1m";
    for (const k of new Set(spec.symbols.filter((s) => I.symbols[s] && I.symbols[s][kind]).map((s) => I.symbols[s][kind]))) {
      if (intraLoaded.has(k)) continue; intraLoaded.add(k);
      for (const [s, p] of Object.entries(readJ(path.join(data, "intra", `${k}.json`)))) E.setIntraday(s, p);
    }
  }
  const fundLoaded = new Set();
  function ensureFund(syms) {
    const C = (man.fund && man.fund.companies) || {};
    for (const k of new Set(syms.filter((s) => C[s] && !fundLoaded.has(s)).map((s) => C[s].f))) {
      for (const [s, p] of Object.entries(readJ(path.join(data, "fund", `${k}.json`)))) { if (!fundLoaded.has(s)) { E.setFundamentals(s, p); fundLoaded.add(s); } }
    }
  }
  const specExprs = (spec) => spec.type === "watchlist" ? E.watchExprs(spec) : spec.type === "rule" || spec.type === "intraday" ? [spec.entry, spec.exit, spec.rank_by] : spec.type === "rotation" ? E.exprsOf(spec) : [spec.entry, spec.exit];
  const full = {}, bundleCache = {};
  function fullFrame(s) {
    if (full[s]) return full[s];
    const meta = man.symbols[s]; if (!meta || ["basket", "series"].includes(meta.kind)) return light[s] || null;
    try {
      if (meta.pb) { const js = (bundleCache[meta.pb] ||= readJ(path.join(data, "pit", "full", `${meta.pb}.json`))); full[s] = E.frame(js[s]); }
      else full[s] = E.frame(JSON.parse(fs.readFileSync(path.join(data, "p", `${s}.json`), "utf8")));
    } catch (e) { return light[s] || null; }
    full[s].sym = s; return full[s];
  }
  const pitDir = path.join(data, "pit");
  let pitLight = null, pitBundles = {}; const pitFull = {};
  if (man.pit && fs.existsSync(path.join(pitDir, "membership.json"))) {
    const mem = JSON.parse(fs.readFileSync(path.join(pitDir, "membership.json"), "utf8"));
    E.setPit(mem); pitBundles = mem.bundles || {}; pitLight = E.framesFromPack(readJ(path.join(pitDir, "closes.json")));
  }
  const pitSyms = new Set(Object.entries(man.universes).filter(([k]) => /pit$/.test(k)).flatMap(([, v]) => v));
  function pitFrame(s) {
    if (!pitFull[s] && pitBundles[s]) for (const [k, raw] of Object.entries(readJ(path.join(pitDir, "full", `${pitBundles[s]}.json`)))) pitFull[k] = E.frame(raw);
    return pitFull[s] || (pitLight && pitLight[s]) || null;
  }
  // extra: more names to load (a daily list); tolerant: skip names without data instead of failing
  function framesFor(spec, extra = [], tolerant = false) {
    const pk = E.usesPit(spec), need = [...new Set(E.symbolsNeeded(spec, man.universes).concat(["NIFTY"], extra.map(E.symKey)))];
    if (man.options) {
      if (spec.type === "option_selling") ensureOptions([spec.underlying], "c");
      if (specExprs(spec).some(E.usesOptionVars)) { E.initOptionSummaries(); ensureOptions(need.concat(specExprs(spec).flatMap((x) => E.refSymbols(x))), "s"); }
    }
    if (spec.type === "intraday") ensureIntraday(spec);
    if (man.fund && specExprs(spec).some(E.usesFundVars)) ensureFund(need.concat(spec.type === "intraday" ? spec.symbols : []));
    const out = {};
    for (const s of need) {
      if (pk && pitSyms.has(s)) { if (!pitLight) throw new Error("point-in-time data missing"); out[s] = E.needsFull(spec) ? pitFrame(s) : pitLight[s]; continue; }
      if (!man.symbols[s]) { if (tolerant) continue; throw new Error(`no data for ${s}`); }
      out[s] = E.needsFull(spec) && !["basket", "series"].includes(man.symbols[s].kind) ? fullFrame(s) : light[s];
    }
    return out;
  }
  // a symbol's best frame with opens (stocks outside today's lists come from the point-in-time data)
  const priceFrame = (s) => (man.symbols[s] ? fullFrame(s) : null) || (pitSyms.has(s) ? pitFrame(s) : null) || light[s] || null;
  return { man, light, lastDay, framesFor, fullFrame, pitFrame, priceFrame, pitSyms, ensureFund, data };
}
