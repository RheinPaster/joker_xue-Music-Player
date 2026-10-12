"use strict";
// 依据 discography.json 重新生成 renderer/data/songs.js
//
// 规则：
//   - 以 15 张正式专辑/EP 为「专辑」，曲目与顺序以 iTunes 官方曲目为准
//   - 排除 Live / 综艺 / 翻唱 / 伴奏版本
//   - 不属于任何专辑的原创歌曲归入「个人曲目」
//   - 保留同名歌曲原有的 id（这样收藏/播放历史/歌词偏移不会丢）、原有歌词节选
//   - 调色板按专辑统一（同一张专辑同一配色）
//
// 用法: node scripts/gen-songs.js            # 预演，打印统计
//       node scripts/gen-songs.js --write    # 写入 renderer/data/songs.js

const fs = require("fs");
const path = require("path");

const WRITE = process.argv.includes("--write");
const DATA = path.join(__dirname, "..", "renderer", "data", "songs.js");
const DISCO = path.join(__dirname, "..", "discography.json");
// 薛之谦「为他人创作」的歌曲清单（他作词/作曲、由别的歌手演唱）。
// 与 discography.json 一样属于构建输入，缺文件时该分类为空。
const WRITTEN_FOR = path.join(__dirname, "..", "_written_for.json");

// ---- 读取现有曲目（保留 id / 歌词）----
let src = fs.readFileSync(DATA, "utf8").replace(/^export\s+/gm, "");
const mod = { exports: {} };
new Function("module", "exports", src + "\nmodule.exports = { SONGS };")(mod, mod.exports);
const OLD = mod.exports.SONGS;

// 标题归一化：去括号后缀（版本/推广曲等）、去空白、繁体转简体、统一大小写
const TRAD_SIMP = {
  "個": "个", "們": "们", "來": "来", "說": "说", "説": "说", "誰": "谁", "愛": "爱",
  "讓": "让", "歡": "欢", "憂": "忧", "會": "会", "沒": "没", "這": "这", "裡": "里",
  "邊": "边", "為": "为", "與": "与", "從": "从", "對": "对", "開": "开", "關": "关",
  "時": "时", "實": "实", "現": "现", "點": "点", "擊": "击", "帶": "带", "還": "还",
  "過": "过", "覺": "觉", "樣": "样", "麼": "么", "陽": "阳", "雲": "云", "長": "长",
  "門": "门", "風": "风", "馬": "马", "鳥": "鸟", "龍": "龙", "灣": "湾", "臺": "台",
  "體": "体", "髮": "发", "麵": "面", "葉": "叶", "夢": "梦", "緣": "缘", "舊": "旧",
  "聲": "声", "萬": "万", "銀": "银", "鋒": "锋", "號": "号", "顏": "颜", "髮": "发"
};
// 同一首歌在不同发行里的不同写法 → 统一到官方定名（归一化时先做替换）
const TITLE_ALIAS = {
  "了表心意": "聊表心意"   // 《无限歌谣季》Live 版；正式收录《尘》2019 时定名《聊表心意》
};
function normTitle(t) {
  let s = String(t || "");
  const base = s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "").trim();
  if (TITLE_ALIAS[base]) s = TITLE_ALIAS[base];
  return s
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "")   // 去括号及其内容
    .replace(/\s*(feat|ft)\..*$/i, "")
    .replace(/[\s\-_·•.'"《》“”]/g, "")
    .toLowerCase()
    .replace(/[個們來說説誰愛讓歡憂會沒這裡邊為與從對開關時實現點擊帶還過覺樣麼陽雲長門風馬鳥龍灣臺體髮麵葉夢緣舊聲萬銀鋒號顏]/g,
      (c) => TRAD_SIMP[c] || c);
}
// 展示用歌名：剥掉"版本后缀"与"影视/综艺说明"，只留正式曲名
// 例：方圆几里 (吉他版)→方圆几里；深深爱过你(前世)→深深爱过你；
//     野心(電影《緝魂》推廣曲)→野心；了表心意 (Live)→了表心意
function displayTitle(t) {
  return String(t || "")
    .replace(/[（(][^）)]*(版|前世|今生|Live|现场|伴奏|重唱|电影|電影|电视剧|网剧|推广曲|主题曲|片尾曲|插曲)[^）)]*[）)]/gi, "")
    .replace(/\s*-\s*(Single|EP)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
const oldByTitle = new Map(OLD.map((s) => [s.title, s]));
const oldByNorm = new Map(OLD.map((s) => [normTitle(s.title), s]));
console.error(`现有曲目 ${OLD.length} 首`);

// ---- 本地文件时长：有本地文件的以文件为准（界面显示的就是你将听到的）----
const { mp3Duration } = require("../lib/mp3-duration");
const MUSIC_DIR = path.join(__dirname, "..", "music");
const fileDur = new Map();   // normTitle(文件名) -> 秒
if (fs.existsSync(MUSIC_DIR)) {
  for (const f of fs.readdirSync(MUSIC_DIR)) {
    if (!/\.mp3$/i.test(f)) continue;
    try {
      const d = mp3Duration(fs.readFileSync(path.join(MUSIC_DIR, f)));
      if (d > 0) fileDur.set(normTitle(path.basename(f, path.extname(f))), d);
    } catch { /* 忽略坏文件 */ }
  }
}
console.error(`本地文件时长已读取 ${fileDur.size} 个`);

// ---- 正式专辑定义（iTunes 名称 -> 展示名）----
const ALBUMS = [
  { match: "薛之谦", name: "薛之谦" },
  { match: "你过得好吗", name: "你过得好吗" },
  { match: "深深爱过你", name: "深深爱过你" },
  { match: "未完成的歌", name: "未完成的歌" },
  { match: "几个薛之谦", name: "几个薛之谦" },
  { match: "意外", name: "意外" },
  { match: "绅士", name: "绅士" },
  { match: "一半", name: "一半" },
  { match: "初学者", name: "初学者" },
  { match: "渡", name: "渡" },
  { match: "怪咖", name: "怪咖" },
  { match: "尘", name: "尘" },
  { match: "天外来物", name: "天外来物" },
  { match: "无数", name: "无数" },
  { match: "守村人", name: "守村人" }
];

// 需要人工补入的曲目（iTunes 该专辑条目缺漏，但官方曲目里有）
const MANUAL_ADD = [
  { album: "天外来物", title: "小尖尖", sec: 233, note: "百度百科曲目表第 9 首" }
];

// 单曲里需要排除的（Live / 综艺 / 翻唱 / 伴奏）
const EXCLUDE_PAT = /\(Live\)|（Live）|\(现场|现场即兴|伴奏|Live\)$/i;
const EXCLUDE_ALBUM_PAT = /嗨,唱起来|跨年演唱会|金曲捞|无限歌谣季/;

// ---- 现场与翻唱：只收录"没有正式版"的 Live / 翻唱 ----
// 规则：某首歌若已有正式专辑版，就不再把它的 Live 版塞进来（避免混乱）；
//       只有专辑里没有、纯属翻唱或节目首唱的，才单列到这个分类。
const LIVE_COVERS = [
  { title: "友情提示 (Live)", year: 2025, sec: 339, note: "原创，2025-12-19《音乐缘计划第二季》首唱" },
  { title: "农民与土地 (Live)", year: 2025, sec: 220, note: "《音乐缘计划》现场版" },
  { title: "爱好 (Live)", year: 2024, sec: 177, note: "原创（词曲：薛之谦），2024-08-25《音乐缘计划》首唱，未正式发行；本地音频为纯享剪辑版 2:57" },
  // ---- 翻唱 / 合唱（来源：iTunes 官方 Live 单曲 + 百科正文）----
  // original = 原唱，会写进 songs.js 的 artist 字段，界面显示「原唱：XXX」。
  // 不填的表示这首歌就是他自己的作品（如友情提示、农民与土地、爱好）。
  { title: "越来越 (Live)", year: 2024, sec: 232, original: "刘惜君", note: "薛之谦词曲；江苏卫视《音乐缘计划》收官曲，现场由刘惜君演唱。本地音频为剪辑版 2:06（官方完整版 3:52）" },
  { title: "粉钻 (Live)", year: 2026, sec: 0, original: "戚薇", note: "薛之谦词曲；戚薇原唱。他在「万兽之王」巡回演唱会现场演唱（长沙站等）" },
  { title: "总会 (Live)", year: 2023, sec: 0, original: "刘惜君", note: "薛之谦作词；刘惜君原唱。他以嘉宾身份在刘惜君巡回演唱会收官场演唱" },
  { title: "达拉崩吧 (Live)", year: 2019, sec: 207, original: "洛天依 / ilem", note: "2019 江苏卫视跨年演唱会，与虚拟歌手洛天依合作" },
  { title: "安和桥 (Live)", year: 2017, sec: 0, original: "宋冬野", note: "2017 上海演唱会「十年之约」现场" },
  { title: "江南 (Live)", year: 2018, sec: 233, original: "林俊杰", note: "《嗨，唱起来》第11期" },
  { title: "因为爱情 (Live)", year: 2018, sec: 234, original: "陈奕迅、王菲", note: "《嗨，唱起来》第11期" },
  { title: "她来听我的演唱会 (Live)", year: 2018, sec: 279, original: "张学友", note: "《嗨，唱起来》第11期" },
  { title: "霸王别姬 (Live)", year: 2025, sec: 231, original: "姚晓棠、刘端端", note: "与张靓颖合作翻唱；原曲 2024 年《音乐缘计划第一季》第9期首现" },
  { title: "只字不提 (Live)", year: 2024, sec: 0, original: "周深", note: "与周深合唱，《音乐缘计划》现场版" },
  { title: "天后 (Live)", year: 2017, sec: 260, original: "陈势安" },
  { title: "为了遇见你 (Live)", year: 2016, sec: 260 },
  { title: "哑巴 (Live)", year: 2018, sec: 250 },
  { title: "醒来 (Live)", year: 2018, sec: 250 },
  { title: "怪咖 (Live)", year: 2018, sec: 268 },
  { title: "我不想毕业 (现场即兴创作版)", year: 2018, sec: 188 },
  { title: "了表心意 (Live)", year: 2018, sec: 341 },
  { title: "独角戏 (Live)", year: 2018, sec: 250 },
  { title: "违背的青春 (Live)", year: 2018, sec: 280 },
  { title: "让我欢喜让我忧 (Live)", year: 2024, sec: 237, original: "周华健" }
];

// 明确排除：音源难找，用户要求移除。
// 必须显式列出，否则会被"旧库遗留"逻辑从上一轮输出里复活。
const DROP = ["Love movie", "One-man show", "有没有一首歌会让你想起我"];

const disco = JSON.parse(fs.readFileSync(DISCO, "utf8"));
const normName = (s) => String(s || "").replace(/\s*-\s*(Single|EP|Live)\s*$/i, "").trim();

// ---- 组装专辑 ----
const albumMap = new Map();   // 展示名 -> {name, year, date, tracks:[{title,sec}]}
for (const def of ALBUMS) {
  const hit = disco
    .filter((a) => a.tracks.length >= 3 && !EXCLUDE_ALBUM_PAT.test(a.name))
    .filter((a) => normName(a.name).replace(/ The Crossing$/i, "") === def.match)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!hit) { console.error(`⚠️ 未匹配到专辑: ${def.name}`); continue; }
  albumMap.set(def.name, {
    name: def.name, year: Number(hit.date.slice(0, 4)), date: hit.date,
    tracks: hit.tracks.map((t) => ({ title: t.title, sec: t.sec }))
  });
}

// 人工补漏
for (const add of MANUAL_ADD) {
  const al = albumMap.get(add.album);
  if (al && !al.tracks.some((t) => t.title === add.title)) {
    al.tracks.push({ title: add.title, sec: add.sec });
    console.error(`补入《${add.album}》→ ${add.title}（${add.note}）`);
  }
}

const inAlbum = new Set();
for (const al of albumMap.values()) for (const t of al.tracks) inAlbum.add(normTitle(t.title));

// ---- 个人曲目：单曲里的原创 + 旧库中未被专辑收录的 ----
// 「现场与翻唱」清单里的曲目一律交给那个分类重建，不能被当成个人原创吞进来
// （例如《霸王别姬》是合作翻唱，之前就因此被错分到「个人曲目」）。
const liveNorm = new Set(LIVE_COVERS.map((x) => normTitle(x.title)));
const singlesOrder = [];
const singlesSeen = new Set();
for (const a of disco.sort((x, y) => x.date.localeCompare(y.date))) {
  if (a.tracks.length >= 3) continue;                     // 专辑/EP 跳过
  if (EXCLUDE_ALBUM_PAT.test(a.name)) continue;
  for (const t of a.tracks) {
    const nt = normTitle(t.title);
    if (inAlbum.has(nt)) continue;                        // 已收录进专辑
    if (EXCLUDE_PAT.test(t.title)) continue;              // Live/伴奏 跳过
    if (liveNorm.has(nt)) continue;                       // 归「现场与翻唱」
    if (singlesSeen.has(nt)) continue;
    singlesSeen.add(nt);
    // 优先沿用旧库里的歌名（用户本地文件是按旧歌名命名的）
    const old = oldByNorm.get(nt);
    singlesOrder.push({ title: old ? old.title : displayTitle(t.title), sec: t.sec, year: Number(a.date.slice(0, 4)) });
  }
}
// 读取「为他人创作」清单。必须在这里就读 —— 它参与下面的"旧库遗留"判定，
// 否则像《越来越》这种曾经进过旧库的歌会被重新吞进「个人曲目」，
// 与「为他人创作」形成两条同 id 的重复条目。
let writtenForList = [];
let writtenForRemoved = [];
let writtenForErr = "";
try {
  const wf = JSON.parse(fs.readFileSync(WRITTEN_FOR, "utf8").replace(/^\uFEFF/, ""));
  writtenForList = Array.isArray(wf.songs) ? wf.songs : [];
  writtenForRemoved = Array.isArray(wf.removed) ? wf.removed : [];
} catch (e) { writtenForErr = e.message; }
// removed 里的曲目要显式排除。否则它们会被下面的"旧库遗留"逻辑从上一轮生成结果里
// 复活并塞进「个人曲目」——实测把 8 首移入 removed 后，「个人曲目」从 7 首涨到了 15 首。
const wfRemovedNorm = new Set(writtenForRemoved.map((x) => normTitle(x.title || "")));

// 旧库里存在、但 iTunes 没给的原创（保留，标为个人曲目）
// 注意：LIVE_COVERS / WRITTEN_FOR 里的曲目一律交给后面统一重建，否则会被误吞进个人曲目
const forNorm = new Set(writtenForList.map((x) => normTitle(x.title || "")));
const dropNorm = new Set(DROP.map((x) => normTitle(x)));
for (const s of OLD) {
  if (liveNorm.has(normTitle(s.title))) continue;
  if (forNorm.has(normTitle(s.title))) continue;    // 为他人创作，交给那个分类
  if (wfRemovedNorm.has(normTitle(s.title))) continue; // 已从清单移除，防止复活
  if (dropNorm.has(normTitle(s.title))) continue;   // 明确排除的，防止复活
  const nt = normTitle(s.title);
  if (inAlbum.has(nt) || singlesSeen.has(nt)) continue;
  if (EXCLUDE_PAT.test(s.title)) continue;
  singlesSeen.add(nt);
  singlesOrder.push({ title: s.title, sec: s.dur, year: s.year || 0 });
}

// ---- 生成 id ----
const usedIds = new Set();
function hashId(title) {
  let h = 2166136261;
  for (const ch of title) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return "s" + h.toString(36);
}
function idFor(title) {
  const old = oldByTitle.get(title);
  if (old && old.id && !usedIds.has(old.id)) { usedIds.add(old.id); return old.id; }
  let id = hashId(title), n = 1;
  while (usedIds.has(id)) id = hashId(title) + "_" + (n++);
  usedIds.add(id);
  return id;
}

// ---- 按专辑统一调色板 ----
const PALETTES = [
  ["#2b3550", "#7fa8d9"], ["#3b2f4a", "#a86ed9"], ["#4a2f3b", "#d96e9e"],
  ["#3b4a2f", "#9ed96e"], ["#4a3b2a", "#d9a86e"], ["#2f3b4a", "#6e9ed9"]
];
function paletteFor(key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTES[h % PALETTES.length];
}

// ---- 输出 ----
const out = [];
const stat = [];
const emitted = new Map();   // title -> out 数组下标（用于 alsoIn 去重与互引）

function emit(rawTitle, albumName, year, sec, paletteKey, opts) {
  const nt = normTitle(rawTitle);
  // opts.ns：「为他人创作」这类独立分类用独立去重命名空间。
  // 必须有——否则《哑巴》（他的现场版）会把刘维的原唱版顶掉，同名两版要能共存。
  const key = ((opts && opts.ns) ? opts.ns + "\u0000" : "") + nt;
  const prev = emitted.get(key);
  // 同一首歌只保留一行：
  //   - 跨专辑重收录（如《初学者》含两张 EP 曲目）→ 记 alsoIn，让那张专辑也显示完整
  //   - 同一张专辑内的变体（吉他版 / 前世版…）→ 直接跳过，避免列表混乱
  if (prev) {
    if (prev.album !== albumName) {
      const line = out[prev.idx];
      if (!line.alsoIn.includes(albumName)) line.alsoIn.push(albumName);
    }
    return false;
  }

  const old = oldByNorm.get(nt);
  // 标题一律以 iTunes 官方名为准（避免多次重跑时旧标题漂移，例如把
  // 「方圆几里 (吉他版)」的后缀传染给「方圆几里」）；id 仍沿用旧库以保住收藏
  const disp = displayTitle(rawTitle);
  const title = disp;
  const idSeed = title + ((opts && opts.idSeed) ? "|" + opts.idSeed : "") + (prev ? "#" + out.length : "");
  // 复用旧 id 时必须登记进 usedIds：否则同一个旧 id 会被两条不同条目各复用一次，
  // 撞出重复 id（实测《越来越》同时进「个人曲目」和「为他人创作」时正是如此）。
  const reuse = !!(old && old.id && !prev && !usedIds.has(old.id));
  if (reuse) usedIds.add(old.id);
  const id = reuse ? old.id : idFor(idSeed);
  // 本地文件时长只在"和官方时长量级相符"时采用：
  // 残缺文件（如 1:29 的截断文件）或整期节目（如 31:59 的综艺整期）会被挡掉，
  // 避免把错误时长写进曲库。
  const fd = fileDur.get(nt);
  const useFile = fd && sec && fd >= sec * 0.6 && fd <= sec * 1.6;
  const dur = (useFile ? fd : 0) || sec || (old && old.dur) || ((opts && opts.keepZeroDur) ? 0 : 240);
  const pal = (old && old.palette) ? old.palette : paletteFor(paletteKey);
  const lyr = (old && old.lyrics) ? old.lyrics : [];
  const yearVal = year || (old && old.year) || 0;
  const rec = { idx: out.length, album: albumName, raw: rawTitle, disp };
  if (!prev) emitted.set(key, rec);
  emitted.set(key + "#dup" + out.length, rec);
  const row = { id, title, album: albumName, year: yearVal, dur, palette: pal, lyrics: lyr, alsoIn: [] };
  // 为他人创作：记下原唱歌手，播放器里显示「原唱：XXX」
  if (opts && opts.artist) row.artist = opts.artist;
  out.push(row);
  return true;
}

const orderedAlbums = [...albumMap.values()].sort((a, b) => a.date.localeCompare(b.date));
for (const al of orderedAlbums) {
  // 让"无版本后缀"的正式曲名优先（避免《深深爱过你(前世)》把正式名顶掉）
  const tracks = al.tracks.slice().sort((a, b) => {
    const pa = /[（(]/.test(a.title) ? 1 : 0, pb = /[（(]/.test(b.title) ? 1 : 0;
    return pa - pb;
  });
  let fresh = 0;
  for (const t of tracks) if (emit(t.title, al.name, al.year, t.sec, al.name)) fresh++;
  const dup = al.tracks.length - fresh;
  stat.push(`${String(al.year).padEnd(5)}《${al.name}》 ${al.tracks.length} 首` +
    (dup ? `（其中 ${dup} 首为变体/重收录，只保留一行）` : ""));
}
for (const s of singlesOrder) emit(s.title, "个人曲目", s.year, s.sec, "个人曲目");
stat.push(`${"历年".padEnd(5)}《个人曲目》 ${singlesOrder.length} 首`);

let liveCount = 0;
for (const x of LIVE_COVERS) {
  // 已有正式版（或正式专辑曲目）的 → 不再塞进「现场与翻唱」
  if (emitted.has(normTitle(x.title))) continue;
  if (emit(x.title, "现场与翻唱", x.year, x.sec, "现场与翻唱", { keepZeroDur: true, artist: x.original })) liveCount++;
}
stat.push(`${"历年".padEnd(5)}《现场与翻唱》 ${liveCount} 首（仅收录无正式版的翻唱/现场）`);

// ---- 为他人创作：他作词/作曲、由别的歌手演唱 ----
// （清单已在文件前部读取，因为「旧库遗留」判定需要用到它）
if (writtenForErr) stat.push(`!! _written_for.json 解析失败，该分类为空: ${writtenForErr}`);
else if (!writtenForList.length) stat.push("!! _written_for.json 无条目，「为他人创作」分类为空");
let forCount = 0;
const forSkipped = [];
for (const x of writtenForList) {
  if (!x.title || !x.artist) { if (x.title) forSkipped.push(x.title); continue; }
  const ok = emit(x.title, "为他人创作", x.year || 0, x.sec || 0, "为他人创作", {
    ns: "for", artist: x.artist, idSeed: x.artist, keepZeroDur: true
  });
  if (ok) forCount++;
}
stat.push(`${"历年".padEnd(5)}《为他人创作》 ${forCount} 首（薛之谦词曲、原唱为他人）`);
if (forSkipped.length) stat.push(`   !! 缺演唱者已跳过: ${forSkipped.join(" / ")}`);

// ---- 序列化 ----
function lineFor(s) {
  const parts = [
    `  { id:${JSON.stringify(s.id)}, title:${JSON.stringify(s.title)}, ` +
    `album:${JSON.stringify(s.album)}, year:${s.year}, dur:${s.dur},`,
    `    palette:${JSON.stringify(s.palette)},`
  ];
  if (s.artist) parts.push(`    artist:${JSON.stringify(s.artist)},`);
  if (s.alsoIn.length) parts.push(`    alsoIn:${JSON.stringify(s.alsoIn)},`);
  parts.push(`    lyrics:${JSON.stringify(s.lyrics)} }`);
  return parts.join("\n");
}

const header = `// 薛之谦曲目库：元数据 + 演示音频调性参数 + 预览歌词（节选）。
// 说明：
//   - 专辑与曲目依据公开资料 + iTunes 官方曲库整理，共 ${out.length} 首 / 15 张专辑；
//   - 歌曲归属最早收录它的专辑；被后来专辑重收录的（如《初学者》含两张 EP 全部曲目）
//     记在 alsoIn 里，因此每张专辑都能显示完整官方曲目；
//   - 不属于任何专辑的原创歌曲归入「个人曲目」；
//   - 薛之谦作词/作曲、但由别的歌手演唱的归入「为他人创作」，并用 artist 记原唱；
//   - 内置歌词为「预览节选」；完整歌词请把《歌名.lrc》放到音频旁或 lyrics/ 目录；
//   - 本文件由 scripts/gen-songs.js 生成，重跑会自动保留原有 id 与歌词。
// 每首歌: { id, title, album, year, dur(秒), palette:[#c1,#c2], alsoIn?:[专辑名], lyrics:[[秒,文本],...] }

export const SONGS = [
`;

const body = out.map(lineFor).join(",\n");
const footer = `
];

// 专辑列表（按年份）与检索辅助。
// alsoIn：被后续专辑重收录的歌曲也会出现在那张专辑分组里；
// 分组年份一律取**该专辑自己的年份**（不能取歌曲年份，否则会被拆成多个组）。
export function albumGroups() {
  const map = {};
  // 这几个是"非专辑"分类，各自合并为一组（不按年份拆分）
  const FIXED = { "个人曲目": "历年", "个人单曲": "历年", "现场与翻唱": "历年", "为他人创作": "历年" };
  const albumYear = {};
  for (const s of SONGS) if (FIXED[s.album] === undefined) albumYear[s.album] = s.year;
  const bucket = (name, year) => {
    const fixed = FIXED[name] !== undefined;
    const key = fixed ? "\\u0000fixed\\u0000" + name : name + "\\u0000" + year;
    if (!map[key]) map[key] = { name, year: fixed ? FIXED[name] : year, songs: [] };
    return map[key];
  };
  for (const s of SONGS) {
    const g = bucket(s.album, s.year);
    if (!g.songs.includes(s.id)) g.songs.push(s.id);
    for (const extra of (s.alsoIn || [])) {
      const eg = bucket(extra, albumYear[extra] !== undefined ? albumYear[extra] : s.year);
      if (!eg.songs.includes(s.id)) eg.songs.push(s.id);
    }
  }
  const FIXED_ORDER = ["现场与翻唱", "为他人创作", "个人曲目"];
  return Object.values(map).sort((a, b) => {
    const fa = FIXED_ORDER.indexOf(a.name), fb = FIXED_ORDER.indexOf(b.name);
    if (fa >= 0 || fb >= 0) {
      if (fa < 0) return -1;
      if (fb < 0) return 1;
      return fa - fb;
    }
    return a.year - b.year || a.name.localeCompare(b.name, "zh");
  });
}
`;

console.log("=== 专辑统计 ===");
for (const s of stat) console.log("  " + s);
console.log(`\n合计 ${out.length} 首（原 ${OLD.length} 首）`);
console.log(`带 alsoIn 的歌曲: ${out.filter((s) => s.alsoIn.length).length} 首`);

if (process.argv.includes("--list")) {
  console.log("\n=== 各专辑曲目 ===");
  for (const al of orderedAlbums) {
    const titles = al.tracks.map((t) => {
      const old = oldByNorm.get(normTitle(t.title));
      return (out.find((s) => s.album === al.name && normTitle(s.title) === normTitle(t.title)) || {}).title || t.title;
    });
    console.log(`《${al.name}》${al.year}（${al.tracks.length} 首）`);
    console.log("   " + titles.join(" / "));
  }
  console.log("\n=== 旧库中判定为「已收录进专辑」的 ===");
  const oldInAlbum = OLD.filter((s) => inAlbum.has(normTitle(s.title)));
  console.log("   " + oldInAlbum.map((s) => `${s.title}→${(out.find((o) => normTitle(o.title) === normTitle(s.title)) || {}).album || "?"}`).join(" / "));
  console.log("\n=== 旧库中落到「个人曲目」的 ===");
  console.log("   " + OLD.filter((s) => !inAlbum.has(normTitle(s.title))).map((s) => s.title).join(" / ") || "   （无）");
}

console.log(`\n个人曲目（${singlesOrder.length} 首）:`);
for (const s of singlesOrder) console.log(`  ${s.year || "?"}  ${s.title}`);

if (WRITE) {
  fs.writeFileSync(DATA, header + body + footer, "utf8");
  console.log("\n已写入 " + DATA);
} else {
  console.log("\n（预演模式，未写入。加 --write 才会覆盖）");
}
