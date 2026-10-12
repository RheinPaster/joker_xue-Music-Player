"use strict";
// 按播放器完全相同的匹配规则，从 LRCLIB 抓取歌词并保存为 .lrc。
// 用法: node scripts/fetch-lrc.js <歌名> [<歌名2> ...] [--dir music]
// 只写文件，不打印歌词正文。

const fs = require("fs");
const path = require("path");
const https = require("https");
const { isAcceptable, pickBest } = require("../lib/lyrics-match");

function httpsJSON(url) {
  return new Promise((r) => {
    const req = https.get(url, { headers: { "User-Agent": "joker-xue-player/1.0" }, timeout: 15000 }, (s) => {
      if (s.statusCode !== 200) { s.resume(); return r(null); }
      let d = "";
      s.setEncoding("utf8");
      s.on("data", (c) => (d += c));
      s.on("end", () => { try { r(JSON.parse(d)); } catch { r(null); } });
    });
    req.on("timeout", () => { req.destroy(); r(null); });
    req.on("error", () => r(null));
  });
}

(async () => {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : "music";
  const titles = args.filter((a, i) => i !== dirIdx && i !== dirIdx + 1);
  if (!titles.length) { console.error("用法: node scripts/fetch-lrc.js <歌名> [...] [--dir music]"); process.exit(1); }

  let ok = 0;
  for (const title of titles) {
    let picked = null;
    for (const term of ["薛之谦 " + title, title]) {
      const list = await httpsJSON("https://lrclib.net/api/search?q=" + encodeURIComponent(term));
      const good = (Array.isArray(list) ? list : []).filter((x) => isAcceptable(x, "薛之谦", title, 0));
      if (good.length) { picked = pickBest(good, 0); break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!picked || !picked.syncedLyrics) {
      console.log(`  ✗ ${title}  未找到带时间轴的歌词`);
      continue;
    }
    const out = path.join(dir, title + ".lrc");
    fs.writeFileSync(out, picked.syncedLyrics, "utf8");
    const lines = picked.syncedLyrics.split(/\r?\n/).filter((l) => /^\[\d/.test(l)).length;
    console.log(`  ✓ ${title}  ← ${picked.artistName}/${picked.trackName}  时间轴行 ${lines}  → ${out}`);
    ok++;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`完成：${ok}/${titles.length}`);
})();
