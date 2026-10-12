// Read-only collector for one X timeline page (search, List or profile), run in the browser tab with the
// javascript tool by the scheduled X run. It scrolls a few screens, reads the posts that are rendered and returns
// [{id, url, author, author_name, time, text, likes, reposts, replies, views}]. It never clicks, posts, likes or follows.
// Set window.__X_SCROLLS / window.__X_SINCE (ISO time; older posts are skipped) before running to change the defaults.
(async () => {
  const scrolls = window.__X_SCROLLS || 5, since = window.__X_SINCE ? Date.parse(window.__X_SINCE) : 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (s) => { const m = String(s || "").replace(/,/g, "").match(/([\d.]+)\s*([KkMm]?)/); if (!m) return 0; return Math.round(+m[1] * (m[2] && /k/i.test(m[2]) ? 1e3 : m[2] ? 1e6 : 1)); };
  const seen = new Map();
  const grab = () => {
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      const a = art.querySelector('a[href*="/status/"] time')?.closest("a"); if (!a) continue;
      const m = a.getAttribute("href").match(/^\/([^/]+)\/status\/(\d+)/); if (!m) continue;
      const [, author, id] = m; if (seen.has(id)) continue;
      const time = art.querySelector("time")?.getAttribute("datetime") || null;
      if (since && time && Date.parse(time) < since) continue;
      const text = Array.from(art.querySelectorAll('[data-testid="tweetText"]')).map((e) => e.innerText).join("\n— quoted: ").slice(0, 600);
      if (!text) continue;
      const lab = (t) => art.querySelector(`[data-testid="${t}"]`)?.getAttribute("aria-label") || "";
      const name = art.querySelector('[data-testid="User-Name"]')?.innerText.split("\n")[0] || null;
      const views = art.querySelector('a[href$="/analytics"]')?.getAttribute("aria-label") || "";
      seen.set(id, { id, url: `https://x.com/${author}/status/${id}`, author, author_name: name, time, text, likes: num(lab("like") || lab("unlike")), reposts: num(lab("retweet") || lab("unretweet")), replies: num(lab("reply")), views: num(views) });
    }
  };
  grab();
  for (let i = 0; i < scrolls; i++) { window.scrollBy(0, Math.round(window.innerHeight * 1.6)); await sleep(1800 + Math.random() * 900); grab(); }
  const signedOut = !!document.querySelector('a[href="/login"], a[href*="/i/flow/login"]') && !document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  return { page: location.href, signed_out: signedOut, count: seen.size, posts: [...seen.values()] };
})();
