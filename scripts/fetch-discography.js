"use strict";
// 通过 iTunes 官方曲库 API 拉取薛之谦的全部专辑与曲目（用于校订曲目库数据）。
// 用法: node scripts/fetch-discography.js [--json]
// 只输出元数据（专辑名/年份/曲名/时长），不涉及歌词。

const https = require("https");
const fs = require("fs");

const ARTIST_ALIASES = ["薛之谦", "joker xue", "jokerxue", "薛之謙"];

function getJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": "joker-xue-player/1.0" }, timeout: 25000 }, (s) => {
      if (s.statusCode !== 200) { s.resume(); return resolve(null); }
      let d = "";
      s.setEncoding("utf8");
      s.on("data", (c) => (d += c));
      s.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

const isJx = (name) => {
  const n = String(name || "").toLowerCase();
  return ARTIST_ALIASES.some((a) => n.includes(a));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const asJson = process.argv.includes("--json");

  // 1) 搜索全部专辑（分国家搜索以覆盖不同区上架情况）
  const byId = new Map();
  for (const [term, country] of [["薛之谦", "us"], ["Joker Xue", "us"], ["薛之谦", "hk"], ["薛之谦", "tw"]]) {
    for (let offset = 0; offset < 200; offset += 200) {
      const url = "https://itunes.apple.com/search?term=" + encodeURIComponent(term) +
        "&entity=album&limit=200&offset=" + offset + "&country=" + country;
      const j = await getJSON(url);
      const list = (j && j.results) || [];
      if (!list.length) break;
      for (const a of list) {
        if (!isJx(a.artistName)) continue;
        if (!byId.has(a.collectionId)) {
          byId.set(a.collectionId, {
            id: a.collectionId,
            name: a.collectionName,
            year: (a.releaseDate || "").slice(0, 4),
            date: (a.releaseDate || "").slice(0, 10),
            trackCount: a.trackCount
          });
        }
      }
      await sleep(1200);
    }
  }

  const albums = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
  console.error(`找到 ${albums.length} 张专辑，正在取曲目…`);

  // 2) 逐专辑取曲目
  for (const al of albums) {
    const url = "https://itunes.apple.com/lookup?id=" + al.id + "&entity=song&limit=200&country=us";
    const j = await getJSON(url);
    const list = (j && j.results) || [];
    al.tracks = list
      .filter((r) => r.wrapperType === "track" && isJx(r.artistName))
      .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber))
      .map((r) => ({
        no: r.trackNumber,
        title: r.trackName,
        sec: Math.round((r.trackTimeMillis || 0) / 1000)
      }));
    await sleep(1500);
  }

  if (asJson) {
    fs.writeFileSync("discography.json", JSON.stringify(albums, null, 2), "utf8");
    console.error("已写入 discography.json");
  }

  console.log("\n===== 薛之谦 专辑与曲目（iTunes 官方曲库）=====\n");
  for (const al of albums) {
    console.log(`《${al.name}》 ${al.date}  专辑曲目 ${al.trackCount} 首 / 实际取到 ${al.tracks.length} 首`);
    for (const t of al.tracks) {
      const m = Math.floor(t.sec / 60), s = t.sec % 60;
      console.log(`    ${String(t.no).padStart(2)}. ${t.title}   ${m}:${String(s).padStart(2, "0")}`);
    }
    console.log("");
  }
  const totalTracks = albums.reduce((n, a) => n + a.tracks.length, 0);
  console.log(`合计：${albums.length} 张专辑 / ${totalTracks} 首曲目`);
})();
