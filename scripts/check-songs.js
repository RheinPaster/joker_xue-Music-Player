"use strict";
// 曲目库数据自检：重复 id、缺少专辑/年份、专辑分组统计。
// 用法: node scripts/check-songs.js
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "renderer", "data", "songs.js");
let src = fs.readFileSync(file, "utf8");

// songs.js 是 ES module，这里把 export 去掉后当 CJS 求值（只依赖纯数据）
src = src.replace(/^export\s+/gm, "");
const mod = { exports: {} };
new Function("module", "exports", src + "\nmodule.exports = { SONGS, albumGroups };")(mod, mod.exports);
const { SONGS, albumGroups } = mod.exports;

console.log(`曲目总数: ${SONGS.length}`);

// 1) 重复 id / 重复歌名
const idMap = new Map(), titleMap = new Map();
const dupIds = [], dupTitles = [];
for (const s of SONGS) {
  if (idMap.has(s.id)) dupIds.push(s.id); else idMap.set(s.id, s);
  const k = s.title;
  if (titleMap.has(k)) dupTitles.push(k); else titleMap.set(k, s);
}
console.log(`重复 id: ${dupIds.length ? dupIds.join(", ") : "无 ✓"}`);
console.log(`重复歌名: ${dupTitles.length ? dupTitles.join(", ") : "无 ✓"}`);

// 2) 缺失字段
const bad = SONGS.filter(s => !s.title || !s.album || !s.dur || !Array.isArray(s.palette));
console.log(`字段缺失: ${bad.length ? bad.map(s => s.title || s.id).join(", ") : "无 ✓"}`);
const noYear = SONGS.filter(s => !s.year);
console.log(`无年份: ${noYear.length ? noYear.map(s => s.title).join(", ") : "无 ✓"}`);

// 3) 专辑分组
const groups = albumGroups();
console.log(`\n专辑数: ${groups.length}`);
for (const g of groups) {
  const ids = new Set(g.songs);
  console.log(`  ${String(g.year).padEnd(6)} ${g.name.padEnd(12)} ${String(g.songs.length).padStart(2)} 首` +
    (ids.size !== g.songs.length ? "  ⚠️ 组内有重复" : ""));
}

// 4) 每个专辑的曲目（方便核对）
console.log("\n各专辑曲目：");
for (const g of groups) {
  const titles = g.songs.map(id => (idMap.get(id) || {}).title || id);
  console.log(`  《${g.name}》${g.year}：${titles.join(" / ")}`);
}
