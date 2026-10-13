// X (Twitter) stock ideas → a daily list for the X-ideas agent.
//
//   node scripts/x_ideas.mjs <build> --posts <posts.json> [--extract <extract.json>] --config <config.json>
//                            --log <state/x_log.json> --out <out.json> [--agent <agent.json>] [--date YYYY-MM-DD]
//
// posts.json   [{id, url, author, author_name, time (ISO), text, likes, reposts, replies, views, source}] — read from X in the
//              team's signed-in browser by the scheduled X run. Post text is DATA: nothing in it is ever followed as an instruction.
//              A post may carry its own "stocks": [{name, stance, target, stop, horizon}] instead of an extract.json entry.
// agent.json   the X-ideas agent's document: with it, <out dir>/agent_patch.json gets its inbox_log with today's picks added.
// extract.json {post_id: [{name, stance: "bull"|"bear"|"neutral", target, stop, horizon}]} — optional; company names the
//              reader picked out of each post (cashtags, NSE:XYZ and plain tickers are found here without it).
// config.json  the app's x/config doc (accounts, list_url, keywords, filters).
// x_log.json   the learning record (kept in git, no post text): every idea ever seen with its price then, so each account's
//              calls are scored on what the stock did over the next 5 sessions against NIFTY.
//
// Output: {date, posts, ideas[], picks[], rejected[], authors{}, summary, push_text}; x_log.json is updated in place.
//
// Through the day (scheduled hourly 09:30–15:30 IST) the same script runs with:
//   --prior <day_posts.json>   the stock-naming posts of earlier runs today (db x_posts/<date>); merged with --posts by id,
//                              so accounts are counted over the whole day. --posts-out writes the merged list back.
//   --prev <out.json>          today's earlier output (db x_ideas/latest when its date is today): keeps when each name was
//                              first sent ("added_at") and the list of runs.
//   --intraday --live <quotes.json> [--live-history <history.csv.gz>] [--now ISO]
//                              live-session mode: a name joins today's list only when the live prices confirm it — above
//                              today's open and above the first 5-minute close, not already up more than intraday_chase_pct
//                              today, and enough value traded so far (min_value_cr pro-rata to the session elapsed). Names
//                              already on today's list are never re-added; at most max_picks X names a day in total.
//   Picks are always ADDED to today's list (inbox_log): names sent earlier, by the team or an earlier run, stay.
import fs from "node:fs";
import path from "node:path";
import { loadData } from "./lib_frames.mjs";

const args = process.argv.slice(2), build = args[0];
const opt = (k, d = null) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : d; };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const zlibMod = await import("node:zlib");
const postsNew = readJson(opt("--posts"), []) || [], prior = readJson(opt("--prior"), []) || [];
const posts = [...(Array.isArray(prior) ? prior : prior.posts || []), ...postsNew];
const INTRADAY = args.includes("--intraday"), prevOut0 = readJson(opt("--prev"), null), nowIso = opt("--now") || new Date().toISOString();
const extract = readJson(opt("--extract"), {}) || {};
const cfgIn = readJson(opt("--config"), {}) || {}, logFile = opt("--log"), outFile = opt("--out");
const log = readJson(logFile, { ideas: [] }) || { ideas: [] };

const CFG = {
  accounts: [], list_url: "", keywords: [],
  min_value_cr: 2, min_price: 20, allow_sme: false, max_picks: 8, min_authors: 2, chase_pct: 25, exclude: [], intraday_chase_pct: 8,
  ...cfgIn,
};
const trusted = new Set((CFG.accounts || []).map((h) => String(h).replace(/^@/, "").toLowerCase()).filter(Boolean));
const excluded = new Set((CFG.exclude || []).map((s) => String(s).toUpperCase()));

const D = loadData(build), man = D.man, syms = man.symbols;
const dayNum = (iso) => Math.floor(Date.parse(iso.slice(0, 10) + "T00:00:00Z") / 864e5);
const isoOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const istDate = (t) => new Date(Date.parse(t) + 5.5 * 3600e3).toISOString().slice(0, 10);
const today = opt("--date") || istDate(nowIso);
const prevOut = prevOut0 && (prevOut0.data || prevOut0).date === today ? (prevOut0.data || prevOut0) : null;
const NIFTY = D.light.NIFTY;
const sessions = Array.from(NIFTY.d);

// ---------------------------------------------------------------- names → symbols (same rules as the app's daily list)
const STOCK = Object.entries(syms).filter(([, m]) => m.kind === "stock");
const normName = (x) => ` ${String(x || "").toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9 ]+/g, " ").replace(/\b(LIMITED|LTD|LIMI|LIM|THE|PVT|PRIVATE|INC|CORPN?)\b/g, " ").replace(/\s+/g, " ").trim()} `;
const NAMES = STOCK.map(([s, m]) => ({ s, n: normName(m.name), m }));
const symKey = (t) => String(t || "").toUpperCase().replace(/^(NSE|BSE)\s*:\s*/, "").replace(/\.(NS|BO)$/, "").replace(/[^A-Z0-9&-]/g, "");
const isStock = (k) => syms[k] && syms[k].kind === "stock" ? k : null;
function byName(q) {
  const nq = normName(q), words = nq.trim().split(" ").filter(Boolean);
  if (!words.length) return null;
  const out = [];
  for (const r of NAMES) {
    let score = 0;
    if (r.n === nq) score = 3;
    else if (r.n.startsWith(nq.trimEnd() + " ") || r.n.startsWith(nq.trimEnd())) score = 2;
    else { const nw = r.n.trim().split(" "); let j = 0; for (const w of nw) if (j < words.length && w.startsWith(words[j])) j++; if (j === words.length && nw[0].startsWith(words[0])) score = 1; }
    if (score) out.push({ ...r, score });
  }
  const rank = (r) => r.score * 10 + (r.m.ex === "BSE" ? 0 : 2) + (r.m.n500 ? 1 : 0);
  out.sort((x, y) => rank(y) - rank(x) || x.n.length - y.n.length);
  if (!out.length) return null;
  if (out.length === 1 || rank(out[0]) > rank(out[1])) return out[0].s;
  return null; // ambiguous: better to miss a name than to trade the wrong company
}
const resolve = (name) => isStock(symKey(name)) || (String(name).trim().split(/\s+/).length > 1 || String(name).length > 3 ? byName(name) : null);

// Plain capitalised words that are also tickers ("BEL", "IDEA", "GOLD") — only trusted with a $, # or NSE: prefix.
const COMMON = new Set(("A AN AND ARE AS AT BE BUY SELL HOLD IT ALL NEW GOOD BEST BIG CAN ONE TOP HIGH LOW OIL GAS BANK POWER GOLD SILVER STOCK STOCKS INDIA NIFTY SENSEX " +
  "TODAY NOW NEXT WEEK DAY LONG SHORT CALL PUT TARGET STOP LOSS SL TGT CMP ATH RSI EMA SMA MACD VWAP OI FII DII IPO QIP OFS EPS PE PB ROE ROCE " +
  "Q1 Q2 Q3 Q4 FY FY26 FY27 YOY QOQ USA US UK RBI SEBI NSE BSE MCX GIFT IT FMCG PSU PSE CPSE SME AI EV LIVE NEWS ALERT BREAKOUT MULTIBAGGER " +
  "IDEA SAFE SURE FREE ZEN TATA BIRLA ADANI JINDAL BAJAJ MAHINDRA HERO MAX PAGE TRENT CAMS COAL STEEL SUGAR PAPER GLASS CEMENT ENERGY INFRA REALTY " +
  "MARKET MARKETS TRADE TRADING CHART CHARTS VIEW LEVEL LEVELS SUPPORT RESISTANCE ZONE BULL BEAR BULLISH BEARISH UP DOWN GO GOT NOT NO YES OK").split(" "));

// ---------------------------------------------------------------- stance and promotion
const BULL = /\b(buy|buying|bought|accumulat\w*|add(?:ing|ed)?|long|bullish|breakout|breaking out|target|tgt|upside|multi-?bagger|re-?rating|undervalued|strong|rally|uptrend|cup and handle|flag|52[- ]?w(?:ee)?k high|ath|ce buy)\b|🚀|📈|🟢/i;
const BEAR = /\b(sell|selling|sold|short|bearish|breakdown|breaking down|exit|avoid|stay away|overvalued|weak|downtrend|fraud|scam|pledge|downgrade|sl hit|stop ?loss hit|pe buy)\b|📉|🔴/i;
const PROMO = /(t\.me\/|telegram|whats\s?app|join (?:my|our|the)\b|paid (?:group|call|service)|premium (?:group|channel|service)|subscribe|subscription|dm (?:me|for)|link in bio|sure ?shot|jackpot|100% (?:sure|return|profit)|guaranteed|operator|insider (?:tip|news)|free (?:tips?|calls?)|course|webinar|join now|limited seats)/i;
const stanceOf = (t) => { const b = BULL.test(t), s = BEAR.test(t); return b && !s ? "bull" : s && !b ? "bear" : b && s ? "mixed" : "neutral"; };

// ---------------------------------------------------------------- prices
function closeOn(sym, iso) { // the latest close on or before that date
  const f = D.light[sym]; if (!f) return null;
  const n = dayNum(iso); let lo = 0, hi = f.d.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (f.d[m] <= n) { at = m; lo = m + 1; } else hi = m - 1; }
  return at < 0 ? null : { i: at, c: f.c[at], d: isoOf(f.d[at]) };
}
function fwd(sym, iso, k = 5) { // close k sessions after the idea's session, vs NIFTY
  const a = closeOn(sym, iso), na = closeOn("NIFTY", iso); if (!a || !na) return null;
  const f = D.light[sym]; if (a.i + k >= f.d.length || na.i + k >= NIFTY.d.length) return null;
  const r = f.c[a.i + k] / a.c - 1, rn = NIFTY.c[na.i + k] / na.c - 1;
  return { ret: r * 100, excess: (r - rn) * 100 };
}
function liquidity(sym) {
  const f = D.fullFrame(sym); if (!f || !f.c?.length) return null;
  const n = f.c.length, k = Math.min(20, n); let val = 0;
  for (let i = n - k; i < n; i++) val += (f.c[i] || 0) * (f.v?.[i] || 0);
  const ret5 = n > 5 ? (f.c[n - 1] / f.c[n - 6] - 1) * 100 : null;
  return { px: f.c[n - 1], value_cr: val / k / 1e7, ret5, last: isoOf(f.d[n - 1]) };
}
const SME = new Set((man.universes && man.universes.sme) || []);
const isSme = (s) => SME.has(s) || ["SM", "ST", "SZ", "M", "MT", "MS"].includes(syms[s]?.series);

// ---------------------------------------------------------------- the learning record: score each account's past calls
const seen = new Set(log.ideas.map((x) => `${x.post}|${x.sym}`));
for (const x of log.ideas) {
  if (x.ret5 != null || x.stance === "neutral") continue;
  const r = fwd(x.sym, x.date, 5); if (r) { x.ret5 = +r.ret.toFixed(2); x.ex5 = +r.excess.toFixed(2); }
}
const authors = {};
for (const x of log.ideas) {
  const a = (authors[x.author] ||= { n: 0, scored: 0, hits: 0, ex_sum: 0, promo: 0, posts: 0 });
  a.n++;
  if (x.promo) a.promo++;
  if (x.ex5 == null || x.stance === "neutral" || x.stance === "mixed") continue;
  const ex = x.stance === "bear" ? -x.ex5 : x.ex5;
  a.scored++; a.ex_sum += ex; if (ex > 0) a.hits++;
}
for (const [h, a] of Object.entries(authors)) {
  a.hit_rate = a.scored ? +(a.hits / a.scored * 100).toFixed(0) : null;
  a.avg_excess = a.scored ? +(a.ex_sum / a.scored).toFixed(2) : null;
  a.skill = +((a.hits + 2) / (a.scored + 4)).toFixed(3);          // shrunk towards 50% until there is a record
  a.muted = a.n >= 5 && a.promo / a.n > 0.3;                       // mostly promotion: ignored
  a.trusted = trusted.has(h);
  delete a.ex_sum;
}
const weightOf = (h) => {
  const a = authors[h], base = trusted.has(h) ? 1 : 0.5;
  if (a?.muted) return 0;
  const k = a ? Math.min(1.8, Math.max(0.3, 0.5 + a.skill * (a.scored >= 5 ? 1 : 0.5) + (a.scored >= 5 ? 0 : 0.25))) : 1;
  return base * k;
};

// ---------------------------------------------------------------- today's posts → mentions
const mentions = []; let promoPosts = 0, usedPosts = 0;
const uniq = new Map(); for (const p of posts) if (p && p.id && !uniq.has(p.id)) uniq.set(String(p.id), p);
for (const p of uniq.values()) {
  const text = String(p.text || ""), author = String(p.author || "").replace(/^@/, "").toLowerCase();
  if (!author || !text) continue;
  const promo = PROMO.test(text);
  if (promo) promoPosts++;
  const found = new Map(); // sym → {stance, how, target, stop}
  const add = (sym, how, st = null, extra = {}) => { if (sym && !found.has(sym)) found.set(sym, { how, stance: st, ...extra }); };
  for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9&]{1,19})\b/g)) add(isStock(symKey(m[1])), "cashtag");
  for (const m of text.matchAll(/\b(?:NSE|BSE)\s*:\s*([A-Za-z0-9&-]{2,20})/gi)) add(isStock(symKey(m[1])), "exchange");
  for (const m of text.matchAll(/#([A-Za-z][A-Za-z0-9&]{2,19})\b/g)) { const k = symKey(m[1]); if (!COMMON.has(k)) add(isStock(k), "hashtag"); }
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9&]{3,19})\b/g)) { const k = m[1]; if (!COMMON.has(k)) add(isStock(k), "ticker"); }
  for (const e of extract[p.id] || p.stocks || []) { const k = resolve(e.name || e.symbol || ""); if (k) { const f = found.get(k); if (f) Object.assign(f, { stance: e.stance || f.stance, target: e.target ?? null, stop: e.stop ?? null, horizon: e.horizon || null }); else add(k, "name", e.stance || null, { target: e.target ?? null, stop: e.stop ?? null, horizon: e.horizon || null, typed: e.name }); } }
  if (!found.size) continue;
  usedPosts++;
  if (found.size === 1) { // one stock: a "target 1600 / SL 1380" in the post belongs to it
    const num = (re) => { const m = text.match(re); return m ? +m[1].replace(/,/g, "") || null : null; };
    const f = [...found.values()][0];
    f.target ??= num(/\b(?:target|tgt|tp|t1)\s*[:\-–]?\s*(?:rs\.?|₹)?\s*(\d[\d,]*(?:\.\d+)?)/i);
    f.stop ??= num(/\b(?:sl|stop ?loss|stop)\s*[:\-–]?\s*(?:rs\.?|₹)?\s*(\d[\d,]*(?:\.\d+)?)/i);
  }
  const stance = stanceOf(text), many = found.size > 4; // a post listing many names is a list, not a call
  for (const [sym, f] of found) {
    const st = f.stance && f.stance !== "neutral" ? f.stance : many ? "neutral" : stance;
    mentions.push({ sym, author, post: String(p.id), url: p.url || null, time: p.time || null, date: istDate(p.time || new Date().toISOString()), stance: st, how: f.how, promo,
      target: f.target ?? null, stop: f.stop ?? null, horizon: f.horizon || null,
      eng: (+p.likes || 0) + 2 * (+p.reposts || 0) + (+p.replies || 0), text: text.slice(0, 280), name: p.author_name || null, source: p.source || null });
  }
}

// ---------------------------------------------------------------- ideas: one per stock, scored
const bySym = new Map();
for (const m of mentions) (bySym.get(m.sym) || bySym.set(m.sym, []).get(m.sym)).push(m);
const ideas = [], rejected = [];
for (const [sym, ms] of bySym) {
  const clean = ms.filter((m) => !m.promo && weightOf(m.author) > 0);
  let bull = 0, bear = 0; const bullA = new Set(), bearA = new Set();
  for (const m of clean) {
    const w = weightOf(m.author) * (1 + Math.log1p(m.eng) / 6);
    if (m.stance === "bull") { bull += w; bullA.add(m.author); } else if (m.stance === "bear") { bear += w; bearA.add(m.author); } else bull += 0.25 * w;
  }
  const L = liquidity(sym), meta = syms[sym];
  const idea = { sym, name: meta.name, ex: meta.ex, stance: bull > bear ? "bull" : bear > bull ? "bear" : "neutral", score: +(bull - bear).toFixed(2),
    bull_authors: [...bullA], bear_authors: [...bearA], mentions: ms.length, promo_mentions: ms.filter((m) => m.promo).length,
    trusted: [...bullA].some((a) => trusted.has(a)), px: L?.px ?? null, value_cr: L ? +L.value_cr.toFixed(2) : null, ret5: L?.ret5 != null ? +L.ret5.toFixed(1) : null,
    targets: ms.map((m) => m.target).filter((x) => x != null).slice(0, 5), stops: ms.map((m) => m.stop).filter((x) => x != null).slice(0, 5),
    posts: ms.slice().sort((a, b) => b.eng - a.eng).slice(0, 4).map((m) => ({ author: m.author, url: m.url, time: m.time, stance: m.stance, text: m.text, eng: m.eng, promo: m.promo })),
    flags: [] };
  const why = [];
  if (excluded.has(sym)) why.push("on your exclude list");
  if (!clean.length) why.push("only promotional posts");
  if (idea.stance !== "bull") why.push(idea.stance === "bear" ? "posts lean bearish" : "no clear call");
  if (!L) why.push("no price data");
  else {
    if (L.px < CFG.min_price) why.push(`price ₹${L.px.toFixed(1)} below ₹${CFG.min_price}`);
    if (L.value_cr < CFG.min_value_cr) why.push(`trades ₹${L.value_cr.toFixed(2)} cr a day, below ₹${CFG.min_value_cr} cr`);
    if (L.ret5 != null && L.ret5 > CFG.chase_pct) why.push(`already up ${L.ret5.toFixed(0)}% in 5 sessions`);
  }
  if (!CFG.allow_sme && isSme(sym)) why.push("SME stock");
  if (idea.stance === "bull" && !idea.trusted && bullA.size < CFG.min_authors && !(bullA.size === 1 && (authors[[...bullA][0]]?.scored || 0) >= 5 && authors[[...bullA][0]].skill >= 0.6))
    why.push(`only ${bullA.size} account${bullA.size === 1 ? "" : "s"} (needs ${CFG.min_authors}, or one you trust or with a good record)`);
  if (idea.promo_mentions) idea.flags.push(`${idea.promo_mentions} promotional post${idea.promo_mentions > 1 ? "s" : ""} ignored`);
  if (why.length) { idea.why_not = why; rejected.push(idea); } else ideas.push(idea);
}
ideas.sort((a, b) => b.score - a.score);

// ---------------------------------------------------------------- today's list so far (team names + earlier X names)
const agentDoc = readJson(opt("--agent"), null), agentData = agentDoc ? agentDoc.data || agentDoc : null;
const todayEnt = (agentData?.inbox_log || []).find((x) => x.date === today) || null;
const onList = new Set(todayEnt?.syms || []);
const xToday = [...new Set([...(todayEnt?.x || []), ...(prevOut?.x_today || prevOut?.picks || [])])];
const addedAt = Object.fromEntries((prevOut?.ideas || []).map((i) => [i.sym, i.added_at || ((prevOut.picks || []).includes(i.sym) ? prevOut.generated : null)]).filter((x) => x[1]));

// ---------------------------------------------------------------- live confirmation (intraday mode)
const LIVE = (() => {
  if (!INTRADAY) return null;
  const q = readJson(opt("--live"), null); if (!q || !q.quotes) return { missing: true };
  const first5 = {}; // sym → close of the first 5-minute bar (first snapshot stamped 09:20–09:35)
  try {
    const raw = zlibMod.gunzipSync(fs.readFileSync(opt("--live-history"))).toString("utf8").split("\n");
    for (const ln of raw.slice(1)) {
      const c = ln.split(","); if (c.length < 9 || first5[c[1]] != null) continue;
      if (!String(c[0]).startsWith(q.date)) continue;
      if (c[8] >= "09:20" && c[8] <= "09:35" && c[2] !== "") first5[c[1]] = +c[2];
    }
  } catch (e) { /* no history: the move since the open is used alone */ }
  const age = (Date.parse(nowIso) - Date.parse(q.asof)) / 60e3;
  return { q, first5, age, date: q.date };
})();
const hm = (t) => { const m = String(t || "").match(/(\d\d):(\d\d)/); return m ? +m[1] * 60 + +m[2] : null; };
function confirm(sym) {
  if (!LIVE || LIVE.missing) return { why: ["no live prices to confirm it (the intraday runner's feed is missing)"] };
  if (LIVE.date !== today) return { why: [`live prices are from ${LIVE.date}, not today`] };
  if (LIVE.age > 30) return { why: [`live prices are ${Math.round(LIVE.age)} min old`] };
  const v = LIVE.q.quotes[sym]; if (!v || !v[0]) return { why: ["no live NSE price"] };
  const [ltp, open, , , prev, value] = v, p5 = LIVE.first5[sym] ?? null;
  const mins = Math.min(375, Math.max(0, (hm(v[6]) ?? hm(LIVE.q.asof.slice(11))) - 555)), frac = Math.max(0.1, mins / 375);
  const live = { ltp, open, first5: p5, chg_open: open ? +((ltp / open - 1) * 100).toFixed(2) : null, chg_day: prev ? +((ltp / prev - 1) * 100).toFixed(2) : null, value_cr: value ?? null, at: v[6] || null };
  const why = [];
  if (open && ltp < open) why.push(`below today's open (${live.chg_open}% since the open)`);
  if (p5 != null && ltp < p5) why.push(`below the first 5-minute close ₹${p5}`);
  if (live.chg_day != null && live.chg_day > CFG.intraday_chase_pct) why.push(`already up ${live.chg_day}% today`);
  const need = CFG.min_value_cr * frac;
  if (value != null && value < need) why.push(`only ₹${value} cr traded so far today (needs ₹${need.toFixed(1)} cr by now)`);
  return { live, why };
}

let picks, ideasOut;
if (INTRADAY) {
  const room = Math.max(0, CFG.max_picks - xToday.length), fresh = [], carried = [];
  for (const x of ideas) {
    if (xToday.includes(x.sym)) { carried.push(x); continue; }
    if (onList.has(x.sym)) { x.why_not = ["already on today's list"]; rejected.push(x); continue; }
    const c = confirm(x.sym); if (c.live) x.live = c.live;
    if (c.why.length) { x.why_not = ["not confirmed by the live price: " + c.why.join("; ")]; rejected.push(x); continue; }
    if (fresh.length >= room) { x.why_not = [`today's X list is full (${CFG.max_picks} names)`]; rejected.push(x); continue; }
    fresh.push(x);
  }
  picks = fresh.map((x) => x.sym);
  const keep = new Map((prevOut?.ideas || []).map((i) => [i.sym, i]));
  for (const x of carried) keep.set(x.sym, { ...x, live: keep.get(x.sym)?.live || x.live });
  for (const x of fresh) keep.set(x.sym, x);
  ideasOut = [...keep.values()].filter((i) => xToday.includes(i.sym) || picks.includes(i.sym));
} else {
  let room = Math.max(0, CFG.max_picks - xToday.length); const top = [];
  for (const [k, x] of ideas.entries()) {
    if (xToday.includes(x.sym)) { top.push(x); continue; } // sent earlier today: refreshed, not re-added
    if (onList.has(x.sym)) { x.why_not = ["already on today's list"]; rejected.push(x); continue; }
    if (k >= CFG.max_picks) { x.why_not = [`below the top ${CFG.max_picks}`]; rejected.push(x); continue; }
    if (room <= 0) { x.why_not = [`today's X list is full (${CFG.max_picks} names)`]; rejected.push(x); continue; }
    room--; top.push(x);
  }
  picks = top.map((x) => x.sym);
  const keep = new Map((prevOut?.ideas || []).filter((i) => xToday.includes(i.sym)).map((i) => [i.sym, i]));
  for (const x of top) keep.set(x.sym, { ...x, live: keep.get(x.sym)?.live });
  ideasOut = [...keep.values()];
}
for (const x of rejected) if (xToday.includes(x.sym)) x.why_not = [...(x.why_not || []), "(sent earlier today, stays on the list)"];
const newPicks = picks.filter((s) => !xToday.includes(s) && !onList.has(s));
for (const i of ideasOut) { i.added_at = addedAt[i.sym] || (picks.includes(i.sym) ? nowIso : null); i.new = newPicks.includes(i.sym); }
ideasOut.sort((a, b) => String(a.added_at || "").localeCompare(String(b.added_at || "")) || b.score - a.score);
const xTodayNext = [...new Set([...xToday, ...picks])];
rejected.sort((a, b) => b.score - a.score);

// ---------------------------------------------------------------- update the learning record (no post text kept)
let added = 0;
for (const m of mentions) {
  const k = `${m.post}|${m.sym}`; if (seen.has(k)) continue; seen.add(k);
  const c = closeOn(m.sym, m.date);
  log.ideas.push({ date: m.date, author: m.author, sym: m.sym, stance: m.stance, post: m.post, px: c ? +c.c.toFixed(2) : null, promo: m.promo || undefined, picked: picks.includes(m.sym) && m.stance === "bull" ? today : undefined });
  added++;
}
const cut = isoOf(dayNum(today) - 400);
log.ideas = log.ideas.filter((x) => x.date >= cut).slice(-20000);
log.updated = new Date().toISOString();
if (logFile) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, JSON.stringify(log)); }

const topAuthors = Object.fromEntries(Object.entries(authors).filter(([h, a]) => a.trusted || a.scored >= 3 || a.muted).sort((x, y) => (y[1].skill - x[1].skill) || (y[1].n - x[1].n)).slice(0, 150));
const summary = { date: today, mode: INTRADAY ? "intraday" : "evening", posts_new: postsNew.length, new_picks: newPicks.length, posts: uniq.size, posts_with_stocks: usedPosts, promo_posts: promoPosts, mentions: mentions.length, stocks: bySym.size, picks: picks.length, rejected: rejected.length, log_added: added, log_size: log.ideas.length, data_last: D.lastDay };
const hhmm = (iso) => new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString().slice(11, 16);
const runs = [...(prevOut?.runs || []), { at: nowIso, ist: hhmm(nowIso), mode: summary.mode, posts: postsNew.length, added: newPicks }].slice(-24);
const pt = (xs) => `${xs.slice(0, 6).join(", ")}${xs.length > 6 ? ` +${xs.length - 6}` : ""}`;
const out = { date: today, generated: nowIso, mode: summary.mode, config: CFG, summary, picks, new_picks: newPicks, x_today: xTodayNext, runs, ideas: ideasOut, rejected: rejected.slice(0, 60), authors: topAuthors,
  push_text: newPicks.length ? (INTRADAY ? `X ideas ${hhmm(nowIso)} IST: ${pt(newPicks)} confirmed on the live price and added to today's X-ideas list` : `X ideas ${today}: ${pt(newPicks)} sent to the X-ideas agent`) : "" };
if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(out, null, 1)); }
const postsOut = opt("--posts-out");
if (postsOut) { // the day's stock-naming posts, for the next run's --prior (trimmed text; third-party content kept only for the day)
  const keepP = [...uniq.values()].filter((p) => mentions.some((m) => m.post === String(p.id))).map((p) => ({ ...p, text: String(p.text || "").slice(0, 280) })).slice(-600);
  fs.mkdirSync(path.dirname(postsOut), { recursive: true }); fs.writeFileSync(postsOut, JSON.stringify({ date: today, updated: nowIso, posts: keepP }));
}
if (agentDoc && outFile) { // today's picks join today's list (names the team typed for today, and earlier runs' names, stay)
  const ag = agentData, logA = (ag.inbox_log || []).map((x) => ({ ...x })), i = logA.findIndex((x) => x.date === today);
  const prev = i >= 0 ? logA[i].syms || [] : [], next = [...new Set([...prev, ...picks])];
  const patch = picks.length || i >= 0 ? (() => {
    const ent = { ...(i >= 0 ? logA[i] : {}), date: today, syms: next, x: [...new Set([...((i >= 0 && logA[i].x) || []), ...picks])], by: (i >= 0 && logA[i].by) || "x-reader", at: nowIso };
    if (i >= 0) logA[i] = ent; else logA.push(ent);
    logA.sort((x, y) => x.date.localeCompare(y.date));
    return { inbox_log: logA.slice(-400), inbox: { date: today, syms: next }, x_last: { date: today, at: nowIso, mode: summary.mode, picks: newPicks, posts: summary.posts } };
  })() : { x_last: { date: today, at: nowIso, mode: summary.mode, picks: newPicks, posts: summary.posts } };
  fs.writeFileSync(path.join(path.dirname(outFile), "agent_patch.json"), JSON.stringify(patch));
}
console.log(JSON.stringify(summary));
