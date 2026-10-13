// Smoke test for an app build: serves <build>/ locally, opens every page (and every Research tab) in headless
// Chromium with the app's built-in local database, and fails on any page error or console error.
//   node scripts/smoke_test.mjs build [--shots <dir>] [--extra "#hash1,#hash2"]
// Exit code 0 = clean. The builder runs this before every publish; a failing build is never published.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2), root = path.resolve(args[0] || "build");
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const shots = opt("--shots"), extra = (opt("--extra") || "").split(",").map((s) => s.trim()).filter(Boolean);
let chromium;
for (const p of ["playwright", "/opt/node-tools/node_modules/playwright/index.mjs"]) { try { ({ chromium } = await import(p)); break; } catch (e) { /* next */ } }
if (!chromium) { console.error("playwright not found (npm i -g playwright, or use /opt/node-tools)"); process.exit(2); }

const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/index.html`;
const errs = [], ignore = /favicon|fonts\.g|TUNNEL|net::ERR_|Failed to load resource/;
const b = await chromium.launch();
const pages = ["#home", "#cio", "#markets", "#sym-RELIANCE", "#book", "#orders", "#desks", "#alerts", "#research", "#system", ...extra];
const report = [];
for (const [w, h] of [[1440, 1000], [400, 860]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  p.on("pageerror", (e) => errs.push(`${w}px ${p.url().split("#")[1] || ""}: ${e}`));
  p.on("console", (m) => { if (m.type() === "error" && !ignore.test(m.text())) errs.push(`${w}px ${p.url().split("#")[1] || ""}: ${m.text()}`); });
  await p.goto(base + "#home"); await p.waitForTimeout(5000);
  for (const hash of pages) {
    await p.evaluate((x) => { location.hash = x; }, hash); await p.waitForTimeout(1500);
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    if (sw > w + 2) errs.push(`${w}px ${hash}: page scrolls sideways (${sw}px)`);
    if (hash === "#research") for (const t of await p.$$eval("#researchTabs button", (bs) => bs.map((x) => x.dataset.rtab))) {
      await p.click(`#researchTabs button[data-rtab="${t}"]`); await p.waitForTimeout(1200);
      if (shots && w > 500) await p.screenshot({ path: path.join(shots, `research_${t}.png`), fullPage: false });
    }
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await p.screenshot({ path: path.join(shots, `${w}_${hash.replace(/[^a-z0-9-]/gi, "_")}.png`), fullPage: false }); }
    report.push(`${w}px ${hash} ok`);
  }
  await p.close();
}
await b.close(); server.close();
console.log(JSON.stringify({ pages: report.length, errors: errs }, null, 1));
process.exit(errs.length ? 1 : 0);
