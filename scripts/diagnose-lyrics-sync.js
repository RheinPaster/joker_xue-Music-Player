"use strict";
// 用播放器实际使用的匹配规则，检查每个本地音频能否找到可信歌词。
// 用法: node scripts/diagnose-lyrics-sync.js "<音乐文件夹>"
// 只输出元数据（时长/歌手/歌名/命中与否），不输出歌词正文。

const fs = require("fs");
const path = require("path");
const https = require("https");
const { isAcceptable, pickBest, normSimple } = require("../lib/lyrics-match");

// ---- MP3 时长（逐帧累加，CBR/VBR 都准）----
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
  let seconds = 0, frames = 0;
  while (i + 4 <= len) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const verBits = (buf[i + 1] >> 3) & 0x03;
    const layerBits = (buf[i + 1] >> 1) & 0x03;
    if (verBits === 1 || layerBits === 0) { i++; continue; }
    const version = verBits === 3 ? 1 : 2;
    const layer = 4 - layerBits;
    const brIdx = (buf[i + 2] >> 4) & 0x0f;
    const srIdx = (buf[i + 2] >> 2) & 0x03;
    const padding = (buf[i + 2] >> 1) & 0x01;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }
    const table = BR[version + "-" + layer] || BR["1-3"];
    const bitrate = table[brIdx] * 1000;
    const sampleRate = SR[verBits][srIdx];
    if (!bitrate || !sampleRate) { i++; continue; }
    const spf = layer === 1 ? (version === 1 ? 384 : 192) : (version === 1 ? 1152 : 576);
    const frameLen = Math.floor((spf / 8) * bitrate / sampleRate) + padding;
    if (frameLen < 24) { i++; continue; }
    seconds += spf / sampleRate;
    frames++;
    i += frameLen;
  }
  return frames > 20 ? seconds : 0;
}

function httpsJSON(url) {
  return new Promise((r) => {
    const req = https.get(url, { headers: { "User-Agent": "joker-xue-player/1.0" }, timeout: 12000 }, (s) => {
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

const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");

(async () => {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) { console.error("用法: node scripts/diagnose-lyrics-sync.js <音乐文件夹>"); process.exit(1); }
  const files = fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f)).sort((a, b) => a.localeCompare(b, "zh"));
  console.log("共 " + files.length + " 个 mp3（使用与播放器完全相同的匹配规则）\n");
  console.log("结果   本地     命中条目                          差值      歌名");
  console.log("-".repeat(92));

  let hit = 0, miss = 0;
  const missed = [];
  for (const f of files) {
    const title = path.basename(f, path.extname(f));
    const dur = Math.round(mp3Duration(fs.readFileSync(path.join(dir, f))));
    // 与主进程一致的查询顺序：先带歌手，再只用歌名
    let picked = null;
    for (const term of ["薛之谦 " + title, title]) {
      const list = await httpsJSON("https://lrclib.net/api/search?q=" + encodeURIComponent(term));
      const ok = (Array.isArray(list) ? list : []).filter((x) => isAcceptable(x, "薛之谦", title, dur));
      if (ok.length) { picked = pickBest(ok, dur); break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (picked) {
      const delta = Math.round(picked.duration - dur);
      console.log("命中   " + fmt(dur).padEnd(8) + (picked.artistName + "/" + picked.trackName).padEnd(35) +
        ((delta >= 0 ? "+" : "") + delta + "s").padEnd(9) + title);
      hit++;
    } else {
      console.log("未命中 " + fmt(dur).padEnd(8) + "—".padEnd(35) + "".padEnd(9) + title);
      miss++;
      missed.push(title);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("-".repeat(92));
  console.log("命中 " + hit + " / " + files.length + "，未命中 " + miss);
  if (missed.length) console.log("未命中：" + missed.join("、"));
})();
