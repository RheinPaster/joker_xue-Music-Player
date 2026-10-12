"use strict";
// 审计：模拟播放器 scanCovers 的逻辑，找出真正拿不到封面的歌。
// 播放器规则：先按「歌名」匹配 covers 文件名（归一化比较），再按「专辑名」匹配。
const fs = require("fs");
const path = require("path");

const norm = (s) => String(s).toLowerCase()
  .replace(/[\s\-_·•.'"()（）【】\[\]!！?？,，、:：/\\]/g, "");

let src = fs.readFileSync(path.join(__dirname, "..", "renderer", "data", "songs.js"), "utf8")
  .replace(/^export\s+/gm, "");
const mod = { exports: {} };
new Function("module", "exports", src + "\nmodule.exports = { SONGS, albumGroups };")(mod, mod.exports);
const { SONGS, albumGroups } = mod.exports;

const IMG = /\.(jpg|jpeg|png|webp|gif|bmp)$/i;
const coverFiles = fs.readdirSync(path.join(__dirname, "..", "covers")).filter((f) => IMG.test(f));
const byBase = new Map(coverFiles.map((f) => [norm(f.replace(/\.[^.]+$/, "")), f]));

// 复刻 scanCovers
const coverMap = new Map();
const albums = [...new Set(SONGS.map((s) => s.album))];
for (const f of coverFiles) {
  const base = f.replace(/\.[^.]+$/, "");
  const bn = norm(base);
  if (!bn) continue;
  const byTitle = SONGS.find((s) => norm(s.title) === bn);
  if (byTitle) coverMap.set(byTitle.id, f);
  // 与播放器一致：歌名匹配后仍要继续做专辑匹配
  const album = albums.find((a) => norm(a) === bn);
  if (album) SONGS.filter((s) => s.album === album).forEach((s) => { if (!coverMap.has(s.id)) coverMap.set(s.id, f); });
}

const missing = SONGS.filter((s) => !coverMap.has(s.id));
console.log(`封面文件 ${coverFiles.length} 个；曲目 ${SONGS.length} 首`);
console.log(`拿不到封面的：${missing.length} 首`);
if (missing.length) {
  const byAlbum = {};
  for (const s of missing) (byAlbum[s.album] = byAlbum[s.album] || []).push(s.title);
  for (const [al, ts] of Object.entries(byAlbum)) {
    console.log(`  《${al}》(${ts.length}): ${ts.join(" / ")}`);
  }
}

// 反向：哪些封面文件没被任何曲目用到
const used = new Set(coverMap.values());
const unused = coverFiles.filter((f) => !used.has(f) && /\.(jpg|jpeg|png|webp)$/i.test(f));
console.log(`\n未被使用的封面文件 ${unused.length} 个：`);
if (unused.length) console.log("  " + unused.join(" / "));
