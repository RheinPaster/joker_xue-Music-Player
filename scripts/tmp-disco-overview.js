"use strict";
// 概览 discography.json：区分正式专辑 / EP / 单曲
const fs = require("fs");
const all = JSON.parse(fs.readFileSync("discography.json", "utf8"));
const norm = (s) => String(s || "").replace(/\s*-\s*(Single|EP|Live)\s*$/i, "").replace(/[\s\-_·•.'"()（）【】\[\]]/g, "").toLowerCase();

console.log("=== 曲目数 >= 3 的发行物（可能是专辑/EP）===");
const big = all.filter(a => a.tracks.length >= 3).sort((a, b) => a.date.localeCompare(b.date));
for (const a of big) {
  console.log(`  ${a.date}  ${String(a.tracks.length).padStart(2)} 首  《${a.name}》`);
}
console.log(`\n=== 曲目数 <= 2 的发行物（单曲）共 ${all.length - big.length} 个 ===`);
const singles = all.filter(a => a.tracks.length <= 2).sort((a, b) => a.date.localeCompare(b.date));
for (const a of singles) {
  console.log(`  ${a.date}  《${a.name}》  ->  ${a.tracks.map(t => t.title).join(" / ")}`);
}

// 汇总所有曲名（去重）
const titles = new Map();
for (const a of all) for (const t of a.tracks) {
  const k = norm(t.title);
  if (!titles.has(k)) titles.set(k, { title: t.title, inAlbums: [] });
  if (a.tracks.length >= 3) titles.get(k).inAlbums.push(a.name);
}
console.log(`\n全部去重曲目: ${titles.size} 首`);
const onlySingles = [...titles.values()].filter(v => v.inAlbums.length === 0);
console.log(`只出现在单曲中的: ${onlySingles.length} 首`);
console.log("  " + onlySingles.map(v => v.title).join(" / "));
