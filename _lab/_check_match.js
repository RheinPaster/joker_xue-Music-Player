"use strict";
// 离线复现渲染进程的「音频 -> 曲目」匹配逻辑，用来核对哪首歌没认上音频。
// 逻辑照抄 renderer/js/app.js 的 norm() 与 matchSong()。
const fs = require("fs");
const path = require("path");

let src = fs.readFileSync(path.join(__dirname, "renderer", "data", "songs.js"), "utf8").replace(/^export\s+/gm, "");
const mod = { exports: {} };
new Function("module", "exports", src + "\nmodule.exports = { SONGS };")(mod, mod.exports);
const SONGS = mod.exports.SONGS;

function norm(s) {
  return String(s).toLowerCase().replace(/[\s\-_·•.'"()（）【】\[\]!！?？,，、:：/\\]/g, "");
}

function matchSong(base) {
  const bn = norm(base);
  if (!bn) return null;
  for (const s of SONGS) if (norm(s.title) === bn) return s; // 精确匹配优先
  if (bn.length < 2) return null;
  for (const s of SONGS) {
    const tn = norm(s.title);
    if ((bn.includes(tn) && tn.length >= 2) || (tn.includes(bn) && bn.length >= 2)) return s;
  }
  return null;
}

const dir = path.join(__dirname, "music");
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".mp3"));
const bySong = new Map();   // song.id -> fileName
const clashes = [];
for (const f of files) {
  const base = path.basename(f, path.extname(f));
  const s = matchSong(base);
  if (!s) { console.log("  未匹配到曲目: " + f); continue; }
  if (bySong.has(s.id)) clashes.push({ file: f, other: bySong.get(s.id), song: s.title });
  bySong.set(s.id, f);
}

console.log("mp3 文件: " + files.length + "，匹配到的曲目: " + bySong.size + "（曲库共 " + SONGS.length + " 首）");
if (clashes.length) {
  console.log("\n多个文件抢同一首歌（后者覆盖前者）:");
  for (const c of clashes) console.log("  《" + c.song + "》: " + c.other + "  <-被覆盖-  " + c.file);
}

const noAudio = SONGS.filter((s) => !bySong.has(s.id));
console.log("\n没有音频的曲目 (" + noAudio.length + " 首):");
for (const s of noAudio) console.log("  [" + s.album + "] " + s.title);

for (const t of ["笑场", "爱好", "越来越", "粉钻"]) {
  const hit = SONGS.find((s) => s.title === t);
  if (!hit) { console.log("\n《" + t + "》 不在曲库"); continue; }
  console.log("\n《" + t + "》 在曲库: album=" + hit.album + " id=" + hit.id + " 音频=" + (bySong.get(hit.id) || "** 无 **"));
}
