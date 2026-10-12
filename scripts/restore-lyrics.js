"use strict";
// 评估并修复歌词缺失：把 music/ 里每个 mp3 对应的歌词补齐到 lyrics/ 目录。
// 用法: node scripts/restore-lyrics.js            # 只评估
//       node scripts/restore-lyrics.js --fix      # 缺失的从 LRCLIB 重新抓取
//
// 匹配规则与播放器一致（lib/lyrics-match.js）。

const fs = require("fs");
const path = require("path");
const https = require("https");
const { isAcceptable, pickBest } = require("../lib/lyrics-match");
const { mp3Duration } = require("../lib/mp3-duration");

const FIX = process.argv.includes("--fix");
const MUSIC = path.join(__dirname, "..", "music");
const LYRICS = path.join(__dirname, "..", "lyrics");

let src = fs.readFileSync(path.join(__dirname, "..", "renderer", "data", "songs.js"), "utf8")
  .replace(/^export\s+/gm, "");
const mod = { exports: {} };
new Function("module", "exports", src + "\nmodule.exports = { SONGS };")(mod, mod.exports);
const { SONGS } = mod.exports;

const norm = (s) => String(s).toLowerCase()
  .replace(/[\s\-_·•.'"()（）【】\[\]!！?？,，、:：/\\]/g, "");

function getJSON(url) {
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
  const have = new Set(fs.readdirSync(LYRICS).filter((f) => /\.lrc$/i.test(f))
    .map((f) => norm(f.replace(/\.lrc$/i, ""))));
  const files = fs.readdirSync(MUSIC).filter((f) => /\.mp3$/i.test(f));

  const missing = [];
  for (const f of files) {
    const base = path.basename(f, ".mp3");
    const nb = norm(base);
    if (have.has(nb)) continue;
    const song = SONGS.find((x) => norm(x.title) === nb) ||
                 SONGS.find((x) => norm(x.title).length >= 2 && nb.includes(norm(x.title)));
    if (song && have.has(norm(song.title))) continue;
    missing.push({ base, title: song ? song.title : base, song });
  }

  console.log(`音频 ${files.length} 个，lyrics/ 现有 ${have.size} 个`);
  console.log(`缺歌词 ${missing.length} 首：`);
  for (const x of missing) console.log("  " + x.base);

  if (!FIX) { console.log("\n（加 --fix 才会重新抓取）"); return; }

  console.log("\n开始重新抓取…");
  let ok = 0, fail = 0;
  for (const x of missing) {
    let dur = 0;
    try { dur = mp3Duration(fs.readFileSync(path.join(MUSIC, x.base + ".mp3"))); } catch {}
    let picked = null;
    for (const term of ["薛之谦 " + x.title, x.title]) {
      const list = await getJSON("https://lrclib.net/api/search?q=" + encodeURIComponent(term));
      const good = (Array.isArray(list) ? list : []).filter((y) => isAcceptable(y, "薛之谦", x.title, dur));
      if (good.length) { picked = pickBest(good, dur); break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!picked || !picked.syncedLyrics) { console.log("  ✗ " + x.title + "（无带时间轴的歌词）"); fail++; await new Promise((r) => setTimeout(r, 200)); continue; }
    fs.writeFileSync(path.join(LYRICS, x.title + ".lrc"), picked.syncedLyrics, "utf8");
    const n = picked.syncedLyrics.split(/\r?\n/).filter((l) => /^\[\d/.test(l)).length;
    console.log(`  ✓ ${x.title}  ← ${picked.artistName}/${picked.trackName}  ${n} 行`);
    ok++;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`\n恢复完成：成功 ${ok}，失败 ${fail}`);
  console.log("提示：这些是「整行」歌词；如需逐字对齐，用 tools/align-lyrics.py 重跑。");
})();
