// Company-fundamentals variables on hand-made filings: point in time (no look-ahead), TTM, growth, splits, P/E.
//   node tests/fund_check.mjs
import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const E = require(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "lab", "engine.js"));
let fail = 0;
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const check = (label, ok, info = "") => { if (!ok) fail++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : "  " + info}`); };
const D = E.dayOf;
// 9 quarters (Mar-2023 .. Mar-2025); revenue +10% y/y, profit 100 -> 120; a 1:1 bonus in Dec-2024 (shares 10 mn -> 20 mn); results filed 40 days after quarter end
const qs = ["2023-03-31", "2023-06-30", "2023-09-30", "2023-12-31", "2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31"];
const rev = [1000, 1000, 1000, 1000, 1100, 1100, 1100, 1100, 1210], pat = [100, 100, 100, 100, 120, 120, 120, 120, 150];
const fund = { q: qs.map(D), k: qs.map((x) => D(x) + 41), b: qs.map(() => 1), sh: [10, 10, 10, 10, 10, 10, 10, 20, 20], rev, pat, pbt: pat.map((x) => x * 1.3), fin: qs.map(() => 5), dep: qs.map(() => 10), oi: qs.map(() => 2),
  shp: [[D("2024-01-20"), 55.5], [D("2024-04-20"), 54.0]] };
E.setFundamentals("XYZ", fund);
// daily frame: every calendar day from 2023-01-01 to 2025-06-30, adjusted price 100 after the bonus (=200 before it, adjusted to 100)
const d0 = D("2023-01-01"), n = D("2025-06-30") - d0 + 1, d = Float64Array.from({ length: n }, (_, i) => d0 + i), c = new Float64Array(n).fill(100);
const df = { d, o: c, h: c, l: c, c, v: c, sym: "XYZ" };
const ev = (x) => E.evaluate(E.parse(x), df, {}), at = (arr, iso) => arr[D(iso) - d0];
const st = ev("sales_ttm"), pt = ev("profit_ttm");
check("nothing known before the first filing (Mar-23 result filed 10 May)", Number.isNaN(at(ev("sales"), "2023-05-10")) && at(ev("sales"), "2023-05-11") === 1000);
check("TTM needs 4 quarters", Number.isNaN(at(st, "2023-11-09")) && at(st, "2024-02-10") === 4000, `${at(st, "2023-11-09")} ${at(st, "2024-02-10")}`);
check("Mar-24 result invisible the day it was filed", at(st, "2024-05-10") === 4000 && at(st, "2024-05-11") === 4100, `${at(st, "2024-05-10")} ${at(st, "2024-05-11")}`);
check("sales growth y/y 10%", near(at(ev("sales_growth"), "2024-06-01"), 10));
check("profit growth TTM after 4 quarters of 120: 20%", near(at(ev("profit_growth_ttm"), "2025-02-15"), 20), at(ev("profit_growth_ttm"), "2025-02-15"));
// P/E: price 100 on today's basis, shares on today's basis 20 mn -> mcap 200 cr; profit TTM 480 (Dec-24) -> pe 0.4167; before the bonus the 10 mn shares are doubled too
check("P/E uses split-adjusted shares before the bonus", near(at(ev("pe"), "2024-12-01"), 100 * 20e6 / 1e7 / 460), at(ev("pe"), "2024-12-01"));
check("P/E after the bonus", near(at(ev("pe"), "2025-03-01"), 200 / 480), at(ev("pe"), "2025-03-01"));
check("mcap ₹ crore", near(at(ev("mcap"), "2025-03-01"), 200));
check("EBITDA margin", near(at(ev("opm"), "2023-06-01"), (130 + 5 + 10 - 2) / 1000 * 100));
check("promoter holding and change", at(ev("promoter"), "2024-04-21") === 54 && near(at(ev("promoter_chg"), "2024-04-21"), -1.5) && Number.isNaN(at(ev("promoter"), "2024-01-19")));
const rd = ev("result_day"), ds = ev("days_since_result");
check("result_day = 1 on the first day a new result is known", at(rd, "2024-05-11") === 1 && at(rd, "2024-05-12") === 0 && at(ds, "2024-05-15") === 4);
// a late filing for an OLD quarter must not replace the newer one
const f2 = JSON.parse(JSON.stringify(fund)); f2.k[2] = D("2024-08-01"); E.setFundamentals("XYZ", f2);
check("late filing of an older quarter doesn't override newer data", at(E.evaluate(E.parse("sales"), df, {}), "2024-08-02") === 1100);
// daily rules can use them; validate accepts them
let ok = true; try { E.normalize({ type: "rotation", universe: ["XYZ", "ABC"], factors: [{ name: "earnings_yield" }, { name: "profit_growth_ttm" }], top_n: 1 }, {}); E.validate("pe < 30 and profit_growth > 15"); } catch (e) { ok = false; console.log(e.message); }
check("fundamental variables validate in rules and rotation factors", ok);
console.log(fail ? `${fail} failure(s)` : "all good"); process.exit(fail ? 1 : 0);
