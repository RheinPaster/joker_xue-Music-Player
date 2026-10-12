"use strict";
// MP3 时长解析（逐帧累加，CBR/VBR 都准确）。
// 供 scripts/gen-songs.js 与 scripts/verify-library.js 共用。

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
  // 跳过 ID3v2
  if (len > 10 && buf.toString("latin1", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }
  let sec = 0, frames = 0;
  while (i + 4 <= len) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const verBits = (buf[i + 1] >> 3) & 0x03;
    const layerBits = (buf[i + 1] >> 1) & 0x03;
    if (verBits === 1 || layerBits === 0) { i++; continue; }
    const version = verBits === 3 ? 1 : 2;
    const layer = 4 - layerBits;
    const brIdx = (buf[i + 2] >> 4) & 0x0f;
    const srIdx = (buf[i + 2] >> 2) & 0x03;
    const pad = (buf[i + 2] >> 1) & 0x01;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }
    const bitrate = (BR[version + "-" + layer] || BR["1-3"])[brIdx] * 1000;
    const sampleRate = SR[verBits][srIdx];
    if (!bitrate || !sampleRate) { i++; continue; }
    const spf = layer === 1 ? (version === 1 ? 384 : 192) : (version === 1 ? 1152 : 576);
    const frameLen = Math.floor((spf / 8) * bitrate / sampleRate) + pad;
    if (frameLen < 24) { i++; continue; }
    sec += spf / sampleRate;
    frames++;
    i += frameLen;
  }
  return frames > 20 ? Math.round(sec) : 0;
}

module.exports = { mp3Duration };
