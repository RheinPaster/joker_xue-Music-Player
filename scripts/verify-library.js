"use strict";
// 复查：music 文件夹里的每个音频，匹配到曲目库的哪首歌、专辑/年份是否正确。
// 用法: node scripts/verify-library.js ["music"]
//
// 检查点：
//   1. 是否匹配上了（匹配不上会落到「本地音乐」）
//   2. 匹配方式（精确 / 子串）——子串匹配有张冠李戴风险
//   3. 文件时长 vs 曲目库时长（差太多说明可能匹配错歌）
//   4. 该曲目的专辑归属（人工复核用）

const fs = require("fs");
const path = require("path");

const dir = process.argv[2] || "music";

// ---- 载入曲目库 ----
let src = fs.readFileSync(path.join(__dirname, "..", "renderer", "data", "songs.js"), "utf8")
  .replace(/^export\s+/gm, "");
const mod = { exports: {} };
new Function("module", "exports", src + "\nmodule.exports = { SONGS, albumGroups };")(mod, mod.exports);
const { SONGS, albumGroups } = mod.exports;

// ---- 与 app.js 一致的归一化与匹配规则 ----
const norm = (s) => String(s).toLowerCase().replace(/[\s\-_·•.'"()（）【】\[\]!！?？,，、:：/\\]/g, "");
function matchSong(base) {
  const bn = norm(base);
  if (!bn) return { song: null, how: "空" };
  for (const s of SONGS) if (norm(s.title) === bn) return { song: s, how: "精确" };
  if (bn.length < 2) return { song: null, how: "太短" };
  for (const s of SONGS) {
    const tn = norm(s.title);
    if ((bn.includes(tn) && tn.length >= 2) || (tn.includes(bn) && bn.length >= 2)) return { song: s, how: "子串" };
  }
  return { song: null, how: "无" };
}

// ---- MP3 时长 ----
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const BR = {
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
};
function mp3Duration(buf) {
  const len = buf.length;
  let i = 0;
  if (len > 10 && buf.toString("latin1", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }
  let sec = 0, frames = 0;
  while (i + 4 <= len) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const verBits = (buf[i + 1] >> 3) & 0x03, layerBits = (buf[i + 1] >> 1) & 0x03;
    if (verBits === 1 || layerBits === 0) { i++; continue; }
    const version = verBits === 3 ? 1 : 2, layer = 4 - layerBits;
    const brIdx = (buf[i + 2] >> 4) & 0x0f, srIdx = (buf[i + 2] >> 2) & 0x03, pad = (buf[i + 2] >> 1) & 0x01;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }
    const bitrate = (BR[version + "-" + layer] || BR["1-3"])[brIdx] * 1000;
    const sampleRate = SR[verBits][srIdx];
    if (!bitrate || !sampleRate) { i++; continue; }
    const spf = layer === 1 ? (version === 1 ? 384 : 192) : (version === 1 ? 1152 : 576);
    const fl = Math.floor((spf / 8) * bitrate / sampleRate) + pad;
    if (fl < 24) { i++; continue; }
    sec += spf / sampleRate; frames++; i += fl;
  }
  return frames > 20 ? sec : 0;
}

const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");

// ---- 主流程 ----
const files = fs.readdirSync(dir).filter((f) => /\.(mp3|flac|wav|m4a|ogg)$/i.test(f))
  .sort((a, b) => a.localeCompare(b, "zh"));

const albumOf = new Map();          // songId -> 所有归属专辑（含 alsoIn）
for (const g of albumGroups()) for (const id of g.songs) {
  if (!albumOf.has(id)) albumOf.set(id, []);
  albumOf.get(id).push(g.name + "(" + g.year + ")");
}

let exact = 0, sub = 0, none = 0, durWarn = 0;
const problems = [];

console.log(`复查 ${files.length} 个音频（曲目库 ${SONGS.length} 首 / ${albumGroups().length} 个分类）\n`);
console.log("文件".padEnd(26) + "匹配曲目".padEnd(22) + "专辑(年份)".padEnd(24) + "时长 文件/曲目  匹配方式");
console.log("-".repeat(112));

for (const f of files) {
  const base = path.basename(f, path.extname(f));
  const { song, how } = matchSong(base);
  if (how === "精确") exact++; else if (how === "子串") sub++; else none++;

  if (!song) {
    console.log(base.padEnd(26) + "（未匹配）".padEnd(22) + "—".padEnd(24) + "             " + how);
    problems.push(`${base}：未匹配到曲目库（会落到「本地音乐」）`);
    continue;
  }
  let dur = 0;
  if (/\.mp3$/i.test(f)) dur = Math.round(mp3Duration(fs.readFileSync(path.join(dir, f))));
  const diff = dur && song.dur ? Math.abs(dur - song.dur) : 0;
  const tol = Math.max(12, (song.dur || 200) * 0.08);
  const warn = diff > tol;
  if (warn) { durWarn++; problems.push(`${base}：时长差 ${diff}s（文件 ${fmt(dur)} / 曲目 ${fmt(song.dur)}），可能匹配错歌`); }

  const albums = (albumOf.get(song.id) || ["?"]).join("+");
  console.log(
    base.padEnd(26) +
    song.title.padEnd(22) +
    albums.padEnd(24) +
    ((dur ? fmt(dur) : "?") + "/" + fmt(song.dur)).padEnd(14) +
    how + (warn ? "  ⚠️时长" : "")
  );
  if (how === "子串") problems.push(`${base}：靠**子串**匹配到「${song.title}」，请确认是否正确`);
}

console.log("-".repeat(112));
console.log(`精确匹配 ${exact}，子串匹配 ${sub}，未匹配 ${none}，时长存疑 ${durWarn}`);
if (problems.length) {
  console.log("\n需要确认的问题：");
  for (const p of problems) console.log("  · " + p);
} else {
  console.log("\n未发现问题 ✓");
}

// ---- 反向检查：用户的每首歌在库里的专辑归属 ----
console.log("\n=== 每首歌的专辑归属（用于人工复核）===");
for (const f of files) {
  const base = path.basename(f, path.extname(f));
  const { song } = matchSong(base);
  if (song) console.log(`  ${song.title.padEnd(22)} → 《${song.album}》${song.year}`);
}
