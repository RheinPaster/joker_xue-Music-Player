// 主逻辑：状态、队列、播放、歌词同步、搜索、收藏、历史、本地音频识别。
import { SONGS, albumGroups } from "../data/songs.js";
import { Player, MODE_LABEL, SPECTRUM_BARS } from "./audio.js";
import { store } from "./store.js";
import { fmtTime, grad, renderAlbumList, renderSongList, renderDetail, setLyricActive,
         chibiSVG, setKaraokeProgress, resetKaraoke } from "./ui.js";

const byId = new Map(SONGS.map(s => [s.id, s]));
const groups = albumGroups();
const player = new Player();

// 未收录进曲目库的本地音频，统一归到「本地音乐」
const localTracks = [];
const localById = new Map();
function allSongs() { return SONGS.concat(localTracks); }
function getTrack(id) { return byId.get(id) || localById.get(id) || null; }

function paletteFor(name) {
  const pool = [["#2b3550", "#7fa8d9"], ["#3b2f4a", "#a86ed9"], ["#4a2f3b", "#d96e9e"], ["#3b4a2f", "#9ed96e"], ["#4a3b2a", "#d9a86e"], ["#2f3b4a", "#6e9ed9"]];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

function dynamicGroups() {
  let g = albumGroups();
  if (localTracks.length) g.push({ name: "本地音乐", year: "", songs: localTracks.map(t => t.id) });
  if (onlyOwned) {
    g = g.map(x => Object.assign({}, x, { songs: x.songs.filter(id => hasAudio(getTrack(id))) }))
         .filter(x => x.songs.length);
  }
  return g;
}

// ---- 状态 ----
let view = "all";            // all | fav | history | album:NAME
let search = "";
let detailOpen = false;
let currentId = null;
let queue = [];              // 当前上下文内的歌曲 id 列表
let queueIndex = -1;
let favSet = new Set();
let history = [];
let fileMap = new Map();     // id -> { src, lrcLines? }
let coverMap = new Map();    // id -> 封面 media URL
let lyricLines = { list: [], source: "preview" };
let lyricsMode = "panel";    // panel（侧栏大段） | cover（封面沉浸）
let onlyOwned = true;        // 只显示本地已有的歌（避免目录里一堆放不了的）
let currentDurBaseline = 0;  // 预览歌词时间轴基准（合成=track.dur；真实音频=实际时长）

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const els = {
  listView: $("listView"), detailView: $("detailView"), albumList: $("albumList"),
  headTitle: $("headTitle"), searchInput: $("searchInput"), playAllBtn: $("playAllBtn"),
  playerTitle: $("playerTitle"), playerAlbum: $("playerAlbum"), playerCover: $("playerCover"),
  playerCoverImg: $("playerCoverImg"), coverIcon: document.querySelector(".cover-icon"),
  favBtn: $("favBtn"), playBtn: $("playBtn"), prevBtn: $("prevBtn"), nextBtn: $("nextBtn"),
  modeBtn: $("modeBtn"), lyricsBtn: $("lyricsBtn"),
  curTime: $("curTime"), durTime: $("durTime"), seekBar: $("seekBar"), seekFill: $("seekFill"),
  seekThumb: $("seekThumb"),
  volumeBar: $("volumeBar"), volumeFill: $("volumeFill"), volumeBtn: $("volumeBtn"),
  openFolderBtn: $("openFolderBtn"), batchCoverBtn: $("batchCoverBtn"),
  batchLyricsBtn: $("batchLyricsBtn"), ownedFilterBtn: $("ownedFilterBtn"),
  localStatus: $("localStatus"), localStatusText: $("localStatusText"),
  content: $("content"), player: $("player")
};

function norm(s) {
  return String(s).toLowerCase().replace(/[\s\-_·•.'"()（）【】\[\]!！?？,，、:：/\\]/g, "");
}

// ---- 本地音频发现 ----
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

function tsToSec(mm) {
  const frac = mm[3] ? +mm[3] / Math.pow(10, mm[3].length) : 0;
  return (+mm[1]) * 60 + (+mm[2]) + frac;
}

// 解析增强型 LRC 的逐字时间标签：<mm:ss.xx>字
function parseWords(body) {
  const wordRe = /<(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  const words = [];
  let m, lastIndex = 0, lastT = null;
  while ((m = wordRe.exec(body))) {
    const seg = body.slice(lastIndex, m.index);
    const t = tsToSec(m);
    if (lastT !== null && seg) words.push({ t: lastT, text: seg });
    lastT = t;
    lastIndex = wordRe.lastIndex;
  }
  const tail = body.slice(lastIndex);
  if (lastT !== null && tail) words.push({ t: lastT, text: tail });
  return words.length ? words : null;
}

function parseLrc(text) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const wordRe = /<(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  for (const raw of text.split(/\r?\n/)) {
    const matches = [...raw.matchAll(re)];
    if (!matches.length) continue;
    const body = raw.replace(re, "");
    const words = body.includes("<") ? parseWords(body) : null;
    const content = body.replace(wordRe, "").trim();
    if (!content) continue;
    for (const mm of matches) {
      lines.push({ t: tsToSec(mm), text: content, words });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  // 是否"人工打轴"的歌词：只有人工打轴过的才启用逐字填充，
  // 自动对齐的逐字时间不够准，仅做整句高亮（避免看起来乱跳）。
  lines.manual = /手动打轴|\[by:\s*manual/i.test(text);
  return lines;
}

function matchSong(base) {
  const bn = norm(base);
  if (!bn) return null;
  for (const s of SONGS) if (norm(s.title) === bn) return s; // 精确匹配（含单字歌名）
  if (bn.length < 2) return null;
  for (const s of SONGS) {
    const tn = norm(s.title);
    if ((bn.includes(tn) && tn.length >= 2) || (tn.includes(bn) && bn.length >= 2)) return s;
  }
  return null;
}

async function tryLoadLrc(dir, name) {
  try {
    const r = await fetch("/media?dir=" + encodeURIComponent(dir) + "&name=" + encodeURIComponent(name));
    if (!r.ok) return null;
    const txt = await r.text();
    return parseLrc(txt);
  } catch { return null; }
}

async function mergeFileList(dir, files) {
  let added = 0;
  for (const f of files) {
    const song = matchSong(f.base);
    const src = "/media?dir=" + encodeURIComponent(dir) + "&name=" + encodeURIComponent(f.name);
    if (song) {
      const lrcLines = (await tryLoadLrc(dir, f.base + ".lrc")) || (await tryLoadLrc(dir, song.title + ".lrc")) || null;
      fileMap.set(song.id, { src, lrcLines, dir, base: f.base });
    } else {
      // 未收录：作为「本地音乐」曲目
      const id = "local:" + (norm(f.base) || f.base);
      if (!localById.has(id)) {
        const track = {
          id, title: f.base, album: "本地音乐", year: null, dur: 0,
          palette: paletteFor(f.base), lyrics: [], isLocal: true
        };
        localTracks.push(track);
        localById.set(id, track);
        const lrcLines = await tryLoadLrc(dir, f.base + ".lrc");
        fileMap.set(id, { src, lrcLines, dir, base: f.base });
      }
    }
    added++;
  }
  return added;
}

async function scanDefault() {
  try {
    const data = await fetchJSON("/api/music");
    await mergeFileList(data.dir, data.files);
  } catch { /* 纯浏览器环境或服务不可用：仅演示音源 */ }
}

// ---- 封面发现 ----
function getCover(song) { return song ? coverMap.get(song.id) || null : null; }

async function scanCovers() {
  coverMap.clear();
  try {
    const data = await fetchJSON("/api/covers");
    const albums = [...new Set(SONGS.map(s => s.album))];
    for (const f of data.files) {
      const bn = norm(f.base);
      if (!bn) continue;
      const src = "/media?dir=" + encodeURIComponent(data.dir) + "&name=" + encodeURIComponent(f.name);
      // 歌名匹配（含本地曲目）
      const byTitle = SONGS.find(s => norm(s.title) === bn) || localTracks.find(s => norm(s.title) === bn);
      if (byTitle) coverMap.set(byTitle.id, src);
      // 专辑名匹配（整张专辑共用）
      // 这里不能因为歌名匹配过就 continue：很多专辑的同名主打歌与专辑同名
      // （《意外》《渡》《尘》《怪咖》…），一旦 continue，整张专辑其它歌就没封面了。
      const album = albums.find(a => norm(a) === bn);
      if (album) SONGS.filter(s => s.album === album).forEach(s => { if (!coverMap.has(s.id)) coverMap.set(s.id, src); });
    }
  } catch { /* 网页模式无 covers 服务 */ }
}

async function setCover(id) {
  const track = getTrack(id);
  if (!track) return;
  if (!window.JX) {
    alert("网页模式下请手动把封面图片命名为《" + track.title + "》或《" + track.album + "》放到 covers 文件夹。");
    return;
  }
  const r = await window.JX.chooseCover({ songId: track.id, title: track.title });
  if (!r) return;
  await scanCovers();
  renderList();
  updatePlayerBar();
  if (detailOpen && currentId) openDetail(track);
}

// 封面存盘用的名字：专辑曲目按专辑名（一张专辑共用），单曲/本地曲目按歌名
function coverKeyFor(track) {
  if (!track) return "";
  if (track.isLocal) return track.title;
  if (!track.album || track.album === "个人单曲") return track.title;
  return track.album;
}

// 从 iTunes 搜索并下载官方无水印封面
async function fetchCoverFor(track, opts = {}) {
  if (!track) return false;
  if (!window.JX || !window.JX.fetchCover) {
    setCoverStatus("网页模式不支持自动获取封面");
    return false;
  }
  const key = coverKeyFor(track);
  setCoverStatus("正在获取封面…");
  console.log("[cover] fetching key=" + key);
  const res = await window.JX.fetchCover({
    title: track.title,
    album: track.isLocal ? "" : track.album,
    year: track.isLocal ? "" : track.year,
    artist: track.artist || (track.isLocal ? "" : "薛之谦"),
    key
  });
  if (!res) { setCoverStatus("未找到匹配封面"); console.log("[cover] no match for " + key); return false; }
  await scanCovers();
  renderList();
  updatePlayerBar();
  if (detailOpen && currentId) openDetail(getTrack(currentId));
  setCoverStatus("已获取封面：" + key);
  console.log("[cover] fetched: " + res.name + " matched=" + res.matched + " " + Math.round((res.size || 0) / 1024) + "KB");
  return true;
}

// 批量获取：按专辑/单曲去重，逐个下载（iTunes 有频率限制，故加间隔）
let batchRunning = false;
async function fetchAllCovers() {
  if (batchRunning) return;
  if (!window.JX || !window.JX.fetchCover) { alert("网页模式不支持自动获取封面。"); return; }
  const seen = new Set();
  const targets = [];
  for (const s of allSongs()) {
    if (coverMap.has(s.id)) continue;
    const key = coverKeyFor(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    targets.push(s);
  }
  if (!targets.length) { setCoverStatus("所有曲目都已有封面"); return; }

  batchRunning = true;
  let ok = 0, fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    els.localStatusText.textContent = "获取封面 " + (i + 1) + "/" + targets.length + "…";
    const r = await window.JX.fetchCover({
      title: t.title,
      album: t.isLocal ? "" : t.album,
      year: t.isLocal ? "" : t.year,
      artist: t.artist || (t.isLocal ? "" : "薛之谦"),
      key: coverKeyFor(t)
    });
    if (r) ok++; else fail++;
    await scanCovers();
    await new Promise(res => setTimeout(res, 2200)); // 避免触发 iTunes 频率限制
  }
  batchRunning = false;
  refreshLocalStatus();
  renderList();
  updatePlayerBar();
  if (detailOpen && currentId) openDetail(getTrack(currentId));
  setCoverStatus("封面获取完成：成功 " + ok + "，失败 " + fail);
  console.log("[cover] batch done: ok=" + ok + " fail=" + fail);
}

function setCoverStatus(text) {
  setLyricsStatus(text);
}

// ---- 歌词：项目 lyrics 目录 + 在线获取（LRCLIB）----
let lyricsDir = null;
let lyricsIndex = new Set();          // lyrics 目录里已有的 .lrc（按 base 规范化）
const onlineLyrics = new Map();       // 已获取到的在线歌词，避免重复请求
let lyricsStatus = "";
let autoFetchLyrics = true;

function setLyricsStatus(text) {
  lyricsStatus = text || "";
  const el = document.getElementById("lyricsStatus");
  if (el) el.textContent = lyricsStatus;
}

async function scanLyricsDir() {
  lyricsIndex.clear();
  try {
    const data = await fetchJSON("/api/lyrics");
    lyricsDir = data.dir;
    for (const f of data.files) lyricsIndex.add(norm(f.base));
  } catch { /* 网页模式无该服务 */ }
}

async function tryProjectLrc(track) {
  if (!lyricsDir) return null;
  if (!lyricsIndex.has(norm(track.title))) return null;
  return await tryLoadLrc(lyricsDir, track.title + ".lrc");
}

// 只有纯文本歌词时，按音频时长把每行大致均匀铺开成 LRC
function plainToLrc(plain, dur) {
  const lines = String(plain || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return "";
  const total = Math.max(30, Number(dur) || lines.length * 6);
  const head = Math.min(12, total * 0.06);
  const span = Math.max(1, total - head - 6);
  const step = span / lines.length;
  const stamp = (t) => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return "[" + String(m).padStart(2, "0") + ":" + s.toFixed(2).padStart(5, "0") + "]";
  };
  return lines.map((l, i) => stamp(head + i * step) + l).join("\n");
}

function saveTargetFor(track) {
  const file = fileMap.get(track.id);
  if (file && file.dir) return { dir: file.dir, name: file.base + ".lrc" };
  if (lyricsDir) return { dir: lyricsDir, name: track.title + ".lrc" };
  return null;
}

// 等音频真实时长就绪（最多 timeout 毫秒）；拿不到就返回 0，交给严格校验处理
async function waitRealDuration(track, timeout) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (currentId !== track.id) return 0;       // 已经切歌
    if (player.kind !== "real") return 0;       // 合成演示音源，没有真实时长
    const d = player.realDuration();
    if (d > 0) return Math.round(d);
    await new Promise(r => setTimeout(r, 150));
  }
  return 0;
}

async function fetchLyricsFor(track, opts = {}) {
  if (!window.JX || !window.JX.fetchLyrics) {
    setLyricsStatus("网页模式不支持自动获取，请手动放 .lrc 文件");
    return false;
  }
  const isCurrent = (currentId === track.id);
  const note = (m) => { if (!opts.silent) setLyricsStatus(m); };
  // 关键：用音频的真实时长做校验；拿不到真实时长时传 0（不参与时长比对，改为按歌名+歌手锁定）
  let durSec = 0;
  if (isCurrent) durSec = await waitRealDuration(track, 4000);
  note("正在获取歌词…");
  const res = await window.JX.fetchLyrics({
    title: track.title,
    artist: track.artist || "薛之谦",                    // 为他人创作时按原唱检索；别名由主进程处理（Joker Xue / 薛之謙）
    album: track.isLocal ? "" : track.album,
    duration: durSec
  });
  if (!res || (!res.synced && !res.plain)) {
    note("未找到可信匹配");
    if (opts.verbose) console.log("[lyrics] no match: " + track.title);
    return false;
  }
  const content = res.synced || plainToLrc(res.plain, durSec || track.dur);
  const lines = parseLrc(content);
  if (!lines.length) { note("返回的歌词无法解析"); return false; }

  onlineLyrics.set(track.id, lines);
  console.log("[lyrics] got " + track.title + " <- " + res.trackName + "/" + res.artistName +
    " lines=" + lines.length + " synced=" + !!res.synced + " lrcDur=" + res.duration +
    " audioDur=" + durSec);
  if (opts.verbose) console.log("[lyrics] VERBOSE " + track.title + " :: " + content.length + " chars");

  if (isCurrent) {
    lyricLines = { list: lines, source: "online" };
    if (detailOpen) openDetail(track);
  }

  if (opts.save !== false) {
    const target = saveTargetFor(track);
    if (target) {
      const ok = await window.JX.saveLrc({ dir: target.dir, name: target.name, content });
      if (ok) {
        const f = fileMap.get(track.id);
        if (f) f.lrcLines = lines;
        lyricsIndex.add(norm(target.name.replace(/\.lrc$/i, "")));
        note("已获取并保存 " + target.name);
      } else note("已获取歌词（保存失败）");
    } else note("已获取歌词");
  } else note("已获取歌词");

  return true;
}

// 批量获取全部歌曲歌词（顺序执行，避免触发接口频率限制）
let batchLyricsRunning = false;
async function fetchAllLyrics() {
  if (batchLyricsRunning) return;
  if (!window.JX || !window.JX.fetchLyrics) { alert("网页模式不支持自动获取歌词。"); return; }
  const targets = allSongs().filter(s => {
    const f = fileMap.get(s.id);
    return !(f && f.lrcLines && f.lrcLines.length);
  });
  if (!targets.length) { setLyricsStatus("所有歌曲都已有歌词"); return; }
  batchLyricsRunning = true;
  let ok = 0, miss = 0;
  for (let i = 0; i < targets.length; i++) {
    els.localStatusText.textContent = "获取歌词 " + (i + 1) + "/" + targets.length + "…";
    const done = await fetchLyricsFor(targets[i], { save: true, silent: true });
    if (done) ok++; else miss++;
    await new Promise(r => setTimeout(r, 500));
  }
  batchLyricsRunning = false;
  refreshLocalStatus();
  renderList();
  if (detailOpen && currentId) openDetail(getTrack(currentId));
  setLyricsStatus("歌词获取完成：成功 " + ok + "，未找到 " + miss);
  console.log("[lyrics] batch done: ok=" + ok + " miss=" + miss + " total=" + targets.length);
}

function applyLyrics(track, lines, source) {
  lyricLines = { list: lines, source };
  if (detailOpen && currentId === track.id) openDetail(track);
}

// 播放后异步升级歌词：项目 lyrics 目录 → 在线获取
async function resolveLyricsUpgrade(track, file) {
  if (file && file.lrcLines && file.lrcLines.length) { setLyricsStatus(""); return; }
  if (onlineLyrics.has(track.id)) { applyLyrics(track, onlineLyrics.get(track.id), "online"); return; }
  const proj = await tryProjectLrc(track);
  if (proj && proj.length) { applyLyrics(track, proj, "local"); setLyricsStatus("已加载 lyrics 目录歌词"); return; }
  if (!autoFetchLyrics) { setLyricsStatus(""); return; }
  await fetchLyricsFor(track, { save: true });
}

async function openFolder() {
  if (!window.JX) {
    alert("当前以网页方式运行，请把音频放进 music 文件夹后刷新。");
    return;
  }
  const dir = await window.JX.selectFolder();
  if (!dir) return;
  try {
    const data = await fetchJSON("/api/list?dir=" + encodeURIComponent(dir));
    await mergeFileList(data.dir, data.files);
    await scanCovers();
    refreshLocalStatus();
    renderList();
  } catch { alert("读取文件夹失败。"); }
}

function refreshLocalStatus() {
  if (fileMap.size > 0) {
    els.localStatus.style.background = "#7fd98a";
    els.localStatus.style.boxShadow = "0 0 8px #7fd98a";
    els.localStatusText.textContent = "已识别 " + fileMap.size + " 首本地歌曲";
  } else {
    els.localStatus.style.background = "var(--accent)";
    els.localStatus.style.boxShadow = "0 0 8px var(--accent)";
    els.localStatusText.textContent = "内置演示音源";
  }
}

// ---- 视图/列表 ----
// 是否有本地音频（本地音乐曲目必然有；曲目库歌曲看是否匹配到文件）
function hasAudio(song) {
  if (!song) return false;
  if (song.isLocal) return true;
  return fileMap.has(song.id);
}

function visibleSongs() {
  let list = allSongs();
  if (onlyOwned) list = list.filter(hasAudio);
  if (view === "fav") list = list.filter(s => favSet.has(s.id));
  else if (view === "history") list = history.map(id => getTrack(id)).filter(Boolean);
  else if (view.startsWith("album:")) {
    const name = view.slice(6);
    list = list.filter(s => s.album === name);
  }
  if (search.trim()) {
    const q = norm(search.trim());
    list = list.filter(s => norm(s.title).includes(q) || norm(s.album).includes(q) || String(s.year || "").includes(q));
  }
  return list;
}

function viewLabel() {
  if (view === "all") return "全部歌曲";
  if (view === "fav") return "我的收藏";
  if (view === "history") return "最近播放";
  if (view.startsWith("album:")) return "专辑 · " + view.slice(6);
  return "歌曲";
}

function renderList() {
  const songs = visibleSongs();
  renderSongList(songs, { playingId: currentId, favSet, fileSet: new Set(fileMap.keys()), coverMap });
  const total = allSongs().length;
  els.headTitle.textContent = viewLabel() + " · " + songs.length +
    (onlyOwned && songs.length !== total ? " / " + total : "");
  els.ownedFilterBtn.classList.toggle("on", onlyOwned);
  els.ownedFilterBtn.textContent = onlyOwned ? "仅显示已有" : "显示全部目录";
  renderAlbumList(dynamicGroups(), view.startsWith("album:") ? view : "", onAlbumSelect);
  // 导航高亮
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === view));
  els.listView.hidden = detailOpen;
  els.detailView.hidden = !detailOpen;
}

function setView(v) {
  view = v;
  search = "";
  els.searchInput.value = "";
  detailOpen = false;
  renderList();
}

function onAlbumSelect(name) {
  setView("album:" + name);
}

// ---- 播放 ----
function lyricListFor(track, file) {
  if (file && file.lrcLines && file.lrcLines.length) return { list: file.lrcLines, source: "local" };
  return { list: (track.lyrics || []).map(([t, text]) => ({ t, text })), source: "preview" };
}

function loadAndPlay(track, file, fromSec) {
  player.load({
    id: track.id, title: track.title, dur: track.dur,
    src: file ? file.src : null
  });
  currentId = track.id;
  lyricLines = lyricListFor(track, file);
  currentDurBaseline = track.dur;
  player.play(fromSec || 0);
  pushHistory(track.id);
  updatePlayerBar();
  lyricsStatus = "";
  resolveLyricsUpgrade(track, file);
}

function playId(id) {
  const track = getTrack(id);
  if (!track) return;
  const list = visibleSongs();
  queue = list.map(s => s.id);
  queueIndex = queue.indexOf(id);
  if (queueIndex === -1) { queue = allSongs().map(s => s.id); queueIndex = queue.indexOf(id); }
  const file = fileMap.get(id) || null;
  loadAndPlay(track, file, 0);
  openDetail(track);
}

function playQueueAt(i) {
  if (!queue.length) return;
  i = (i + queue.length) % queue.length;
  queueIndex = i;
  const track = getTrack(queue[i]);
  const file = fileMap.get(track.id) || null;
  loadAndPlay(track, file, 0);
  if (detailOpen) openDetail(track);
  else renderList();
}

function next(auto) {
  if (!currentId) return;
  if (auto && player.mode === "one") { player.seek(0); player.play(); return; }
  if (auto && player.mode === "shuffle") {
    let idx = queueIndex;
    if (queue.length > 1) { do { idx = Math.floor(Math.random() * queue.length); } while (idx === queueIndex); }
    playQueueAt(idx);
    return;
  }
  playQueueAt(queueIndex + 1);
}
function prev() { playQueueAt(queueIndex - 1); }

function pushHistory(id) {
  history = [id, ...history.filter(x => x !== id)].slice(0, 50);
  store.data.history = history;
  store.save();
}

function toggleFav(id) {
  if (!id) return;
  if (favSet.has(id)) favSet.delete(id); else favSet.add(id);
  store.data.favs = [...favSet];
  store.save();
  updatePlayerBar();
  if (detailOpen && currentId) openDetail(getTrack(currentId));
  else renderList();
}

// ---- 详情 ----
function charLen(text) { return [...String(text || "")].length; }

// 每首歌的歌词偏移（秒）：正值 = 歌词整体延后
function lyricOffsetFor(id) {
  const m = store.data.lyricOffset || {};
  return Number(m[id]) || 0;
}
function setLyricOffset(id, v) {
  if (!id) return;
  const m = Object.assign({}, store.data.lyricOffset || {});
  const val = Math.round(v * 10) / 10;
  if (Math.abs(val) < 0.05) delete m[id]; else m[id] = val;
  store.data.lyricOffset = m;
  store.save();
}

// 详情页里的歌词偏移微调
function shiftLyricOffset(delta, reset) {
  if (!currentId || !detailOpen) return;
  const val = reset ? 0 : lyricOffsetFor(currentId) + delta;
  setLyricOffset(currentId, val);
  setLyricsStatus(val === 0
    ? "歌词偏移已复位"
    : "歌词偏移 " + (val > 0 ? "＋" : "−") + Math.abs(val).toFixed(1) + "s（正=歌词延后）");
  openDetail(getTrack(currentId));
}

// 预览歌词在真实音频上的时间缩放（合成音源 / 本地 LRC 不需要缩放）
function lyricScale() {
  if (player.kind === "real" && lyricLines.source === "preview") {
    const d = player.duration();
    return d > 0 ? d / currentDurBaseline : 1;
  }
  return 1;
}

function activeIndexAt(t) {
  const lines = lyricLines.list;
  const scale = lyricScale();
  const tq = t - lyricOffsetFor(currentId);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].t * scale <= tq) idx = i; else break; }
  return idx;
}

// 当前行的逐字进度（浮点数）：3.4 表示第 4 个字已填充 40%
// 有逐字时间轴时，用相邻两字的真实时间插值出"字内"进度 → 连续填充而非整字跳变
function charProgressAt(idx, t) {
  const lines = lyricLines.list;
  const line = lines[idx];
  if (!line) return 0;
  const scale = lyricScale();
  const tq = t - lyricOffsetFor(currentId);
  const total = charLen(line.text);
  if (total <= 0) return 0;

  if (line.words && line.words.length) {
    const times = [];
    for (const w of line.words) {
      const n = charLen(w.text);
      const ws = w.t * scale;
      for (let k = 0; k < n; k++) times.push(ws);
    }
    let i = 0;
    while (i < times.length && times[i] <= tq) i++;
    if (i >= total) return total;
    const t0 = i > 0 ? times[i - 1] : (line.t * scale);
    const t1 = (times[i] !== undefined && times[i] > t0) ? times[i] : t0 + 0.25;
    const frac = Math.min(1, Math.max(0, (tq - t0) / (t1 - t0)));
    return i + frac;
  }

  const t0 = line.t * scale;
  const next = lines[idx + 1];
  const gap = next ? (next.t * scale - t0) : Math.max(2.5, total * 0.32);
  const est = Math.max(total * 0.30, 1.2);
  const span = Math.max(1.0, Math.min(gap > 0 ? gap : est, est));
  const ratio = Math.min(1, Math.max(0, (tq - t0) / span));
  return ratio * total;
}

function openDetail(track) {
  detailOpen = true;
  const file = fileMap.get(track.id);
  const scale = lyricScale();
  const now = player.currentTime();
  const displayLines = { list: lyricLines.list.map(l => ({ t: l.t * scale, text: l.text })), source: lyricLines.source };
  const idx = activeIndexAt(now);
  renderDetail(track, displayLines, {
    isFav: favSet.has(track.id), hasFile: !!file, cover: getCover(track),
    status: lyricsStatus, autoFetch: autoFetchLyrics,
    mode: lyricsMode, activeIndex: idx, offset: lyricOffsetFor(track.id),
    playing: player.isPlaying()
  });
  lastActiveLine = idx;
  resetKaraoke();
  if (idx >= 0) {
    // 同样是"只有人工打轴过才逐字"
    if (lyricLines.list.manual) setKaraokeProgress(idx, charProgressAt(idx, now));
    else setKaraokeProgress(-1, 0);
  }
  if (player.isPlaying()) startKaraokeLoop();
  renderList();
  // 当前句的高亮/居中要等 detailView 真正显示出来才有效
  if (idx >= 0) setLyricActive(idx);
  // 全屏播放页需要自己的 rAF（画频谱），离开就停
  if (lyricsMode === "cover") { updateProgress(player.currentTime()); startStageLoop(); }
  else stopStageLoop();
}

function closeDetail() {
  detailOpen = false;
  // 沉浸页铺满整窗（position:fixed）并且会隐藏底部播放条，
  // 关掉详情时必须把痕迹清干净，否则回到列表就没有播放条了。
  document.body.classList.remove("stage-mode");
  stopStageLoop();
  renderList();
}

// ---- 播放条 UI ----
function updatePlayerBar() {
  const track = currentId ? getTrack(currentId) : null;
  if (track) {
    els.playerTitle.textContent = track.title;
    els.playerAlbum.textContent = track.isLocal ? "本地音乐" : "薛之谦 · " + track.album + " · " + track.year;
    const cover = getCover(track);
    if (cover) {
      els.playerCoverImg.src = cover;
      els.playerCoverImg.hidden = false;
      els.coverIcon.hidden = true;
      els.playerCover.style.background = "none";
    } else {
      els.playerCoverImg.hidden = true;
      els.coverIcon.hidden = false;
      els.playerCover.style.background = grad(track.palette);
      els.playerCover.style.color = "#fff";
    }
  } else {
    els.playerTitle.textContent = "未在播放";
    els.playerAlbum.textContent = "选择一首歌开始";
    els.playerCoverImg.hidden = true;
    els.coverIcon.hidden = false;
  }
  els.favBtn.classList.toggle("on", !!track && favSet.has(track.id));
  const playing = player.isPlaying();
  els.playBtn.querySelector(".i-play").hidden = playing;
  els.playBtn.querySelector(".i-pause").hidden = !playing;
  els.seekBar.classList.toggle("playing", playing);
  syncStagePlayIcon(playing);
  if (playing) startKaraokeLoop(); else stopKaraokeLoop();
  if (playing && lyricsMode === "cover") startStageLoop();
  updateModeUI();
}

// 全屏播放页的播放/暂停图标（和底部播放条保持同步）
function syncStagePlayIcon(playing) {
  const btn = document.getElementById("stagePlay");
  if (!btn) return;
  const p = btn.querySelector(".i-play"), q = btn.querySelector(".i-pause");
  if (p) p.hidden = playing;
  if (q) q.hidden = !playing;
}

function updateModeUI() {
  const m = player.mode;
  els.modeBtn.title = "播放模式：" + MODE_LABEL[m];
  els.modeBtn.classList.toggle("on", m !== "list");
}

function updateProgress(t) {
  const d = player.duration();
  const dur = d > 0 ? d : currentDurBaseline;
  els.curTime.textContent = fmtTime(t);
  els.durTime.textContent = fmtTime(dur);
  const ratio = d > 0 ? Math.min(1, Math.max(0, t / d)) : 0;
  els.seekFill.style.width = (ratio * 100) + "%";
  els.seekThumb.style.left = (ratio * 100) + "%";
  // 全屏播放页的进度条在封面正下方（DOM 每次渲染重建，所以现查现用）
  const fill = document.getElementById("stageFill");
  if (fill) {
    fill.style.width = (ratio * 100) + "%";
    const thumb = document.getElementById("stageThumb");
    if (thumb) thumb.style.left = (ratio * 100) + "%";
    const time = document.getElementById("stageTime");
    if (time) time.textContent = fmtTime(t) + " / " + fmtTime(dur);
  }
}

let lastActiveLine = -1;
function updateLyric(t) {
  if (!detailOpen) return;
  const lines = lyricLines.list;
  if (!lines.length) return;
  const idx = activeIndexAt(t);
  if (lyricsMode === "cover") {
    // 全屏播放页里也有完整歌词列表，需要同样的高亮与滚动
    if (idx !== lastActiveLine) {
      lastActiveLine = idx;
      resetKaraoke();
      setLyricActive(idx);
    }
  } else if (idx !== lastActiveLine) {
    lastActiveLine = idx;
    setLyricActive(idx);
  }
  // 逐字填充只在"人工打轴过"的歌词上启用；否则只做整句高亮
  const perChar = !!lines.manual;
  if (idx >= 0 && perChar) setKaraokeProgress(idx, charProgressAt(idx, t));
  else setKaraokeProgress(-1, 0);   // 清掉逐字填充
}

// 用 requestAnimationFrame 驱动逐字填充，才能做到 60fps 的顺滑（时间事件只有 ~5fps）
let karaokeRAF = null;
function karaokeLoop() {
  karaokeRAF = null;
  if (!detailOpen || !currentId || !player.isPlaying()) return;
  updateLyric(player.currentTime());
  karaokeRAF = requestAnimationFrame(karaokeLoop);
}
function startKaraokeLoop() {
  if (!karaokeRAF) karaokeRAF = requestAnimationFrame(karaokeLoop);
}
function stopKaraokeLoop() {
  if (karaokeRAF) { cancelAnimationFrame(karaokeRAF); karaokeRAF = null; }
}

// ---- 全屏播放页：进度条上方的频谱（跟着音乐律动） ----
const SPECTRUM_N = SPECTRUM_BARS;
const specBuf = new Float32Array(SPECTRUM_N);
let stageRAF = null;

function stageLoop() {
  stageRAF = null;
  if (!detailOpen || lyricsMode !== "cover") return;   // 离开全屏页就自动停
  drawSpectrum();
  stageRAF = requestAnimationFrame(stageLoop);
}
function startStageLoop() { if (!stageRAF) stageRAF = requestAnimationFrame(stageLoop); }
function stopStageLoop() { if (stageRAF) { cancelAnimationFrame(stageRAF); stageRAF = null; } }

function drawSpectrum() {
  const cv = document.getElementById("stageSpectrum");
  if (!cv) return;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (w < 4 || h < 4) return;                 // 页面还没布局好，下一帧再说
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  // 有信号就画实时频谱；暂停 / 解码失败时让旧值自己落下去，别硬切成空白
  const live = player.spectrum(specBuf);
  if (!live) for (let i = 0; i < SPECTRUM_N; i++) specBuf[i] = Math.max(0, specBuf[i] - 0.045);

  const slot = w / SPECTRUM_N;
  const gap = Math.max(2, slot * 0.34);
  const bw = Math.max(2, slot - gap);
  const grad = g.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, "rgba(255,107,91,.95)");
  grad.addColorStop(.55, "rgba(255,152,112,.9)");
  grad.addColorStop(1, "rgba(255,216,152,.95)");
  g.fillStyle = grad;
  let sum = 0;
  for (let i = 0; i < SPECTRUM_N; i++) {
    const v = Math.max(0, Math.min(1, specBuf[i]));
    sum += v;
    const bh = Math.max(2, v * h);
    const x = i * slot + gap / 2, y = h - bh;
    const r = Math.min(bw / 2, bh / 2);
    if (g.roundRect) { g.beginPath(); g.roundRect(x, y, bw, bh, r); g.fill(); }
    else g.fillRect(x, y, bw, bh);
  }
  // 进度条的光晕跟着整体响度呼吸
  const wrap = document.querySelector(".stage-progress");
  if (wrap) wrap.style.setProperty("--level", (sum / SPECTRUM_N).toFixed(3));
}

// ---- 进度/音量拖拽 ----
function bindSlider(bar, onRatio) {
  let dragging = false;
  const ratioFromEvent = (e) => {
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  bar.addEventListener("pointerdown", (e) => {
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    onRatio(ratioFromEvent(e));
  });
  bar.addEventListener("pointermove", (e) => { if (dragging) onRatio(ratioFromEvent(e)); });
  bar.addEventListener("pointerup", (e) => { dragging = false; });
  bar.addEventListener("pointercancel", () => { dragging = false; });
}

// ---- 事件绑定 ----
function bindEvents() {
  // 列表：事件委托
  els.listView.addEventListener("click", (e) => {
    const row = e.target.closest("[data-action]");
    if (!row) return;
    const action = row.dataset.action;
    const id = row.dataset.id;
    if (action === "play") playId(id);
    else if (action === "fav") { toggleFav(id); }
  });

  // 详情：返回/收藏
  els.detailView.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const a = btn.dataset.action;
    if (a === "back") closeDetail();
    else if (a === "fav-detail") toggleFav(currentId);
    else if (a === "set-cover") setCover(currentId);
    else if (a === "get-cover") { if (currentId) fetchCoverFor(getTrack(currentId)); }
    else if (a === "get-lyrics") { if (currentId) fetchLyricsFor(getTrack(currentId)); }
    // 全屏播放页的控制键（DOM 每次渲染重建，所以必须走事件委托）
    else if (a === "stage-play") {
      if (!currentId) { const list = visibleSongs(); if (list.length) playId(list[0].id); return; }
      if (player.isPlaying()) player.pause(); else player.play();
      updatePlayerBar();
    }
    else if (a === "stage-prev") prev();
    else if (a === "stage-next") next(false);
    else if (a === "toggle-mode") {
      lyricsMode = lyricsMode === "cover" ? "panel" : "cover";
      store.data.lyricsMode = lyricsMode;
      store.save();
      if (currentId) openDetail(getTrack(currentId));
    }
    else if (a === "offset-minus") { shiftLyricOffset(-0.5); }
    else if (a === "offset-plus") { shiftLyricOffset(0.5); }
    else if (a === "offset-reset") { shiftLyricOffset(0, true); }
    else if (a === "toggle-auto") {
      autoFetchLyrics = !autoFetchLyrics;
      store.data.autoFetchLyrics = autoFetchLyrics;
      store.save();
      if (currentId) openDetail(getTrack(currentId));
    }
  });

  // 导航
  document.querySelectorAll(".nav-item").forEach(n =>
    n.addEventListener("click", () => setView(n.dataset.view)));

  // 搜索
  els.searchInput.addEventListener("input", () => {
    search = els.searchInput.value;
    detailOpen = false;
    renderList();
  });

  // 播放全部
  els.playAllBtn.addEventListener("click", () => {
    const list = visibleSongs();
    if (!list.length) return;
    queue = list.map(s => s.id);
    queueIndex = 0;
    const t = list[0], f = fileMap.get(t.id) || null;
    loadAndPlay(t, f, 0);
    openDetail(t);
  });

  // 播放控制
  els.playBtn.addEventListener("click", () => {
    if (!currentId) {
      const list = visibleSongs();
      if (list.length) playId(list[0].id);
      return;
    }
    if (player.isPlaying()) player.pause(); else player.play();
    updatePlayerBar();
  });
  els.prevBtn.addEventListener("click", prev);
  els.nextBtn.addEventListener("click", () => next(false));
  els.modeBtn.addEventListener("click", () => { player.cycleMode(); store.data.mode = player.mode; store.save(); });
  els.lyricsBtn.addEventListener("click", () => {
    if (!currentId) return;
    const track = getTrack(currentId);
    if (detailOpen) closeDetail(); else openDetail(track);
  });
  els.favBtn.addEventListener("click", () => toggleFav(currentId));
  els.openFolderBtn.addEventListener("click", openFolder);
  els.batchCoverBtn.addEventListener("click", fetchAllCovers);
  els.batchLyricsBtn.addEventListener("click", fetchAllLyrics);
  els.ownedFilterBtn.addEventListener("click", () => {
    onlyOwned = !onlyOwned;
    store.data.onlyOwned = onlyOwned;
    store.save();
    renderList();
  });

  // 音量
  bindSlider(els.volumeBar, (r) => {
    player.setVolume(r);
    store.data.volume = r;
    store.save();
    els.volumeFill.style.width = (r * 100) + "%";
  });
  els.volumeBtn.addEventListener("click", () => {
    const next = player.volume > 0 ? 0 : 0.8;
    player.setVolume(next);
    store.data.volume = next; store.save();
    els.volumeFill.style.width = (next * 100) + "%";
  });

  // 进度
  bindSlider(els.seekBar, (r) => {
    const d = player.duration();
    if (d > 0) { player.seek(r * d); updateProgress(r * d); }
  });

  // 全屏播放页的进度条：元素是渲染时新建的，用委托 + 指针捕获实现拖动
  let stageDragging = false;
  const stageSeekTo = (bar, e) => {
    const d = player.duration();
    if (!(d > 0)) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    player.seek(ratio * d);
    updateProgress(ratio * d);
  };
  els.detailView.addEventListener("pointerdown", (e) => {
    const bar = e.target.closest("#stageSeek");
    if (!bar) return;
    stageDragging = true;
    try { bar.setPointerCapture(e.pointerId); } catch {}
    stageSeekTo(bar, e);
  });
  els.detailView.addEventListener("pointermove", (e) => {
    if (!stageDragging) return;
    const bar = e.target.closest("#stageSeek") || document.getElementById("stageSeek");
    if (bar) stageSeekTo(bar, e);
  });
  const endStageDrag = () => { stageDragging = false; };
  els.detailView.addEventListener("pointerup", endStageDrag);
  els.detailView.addEventListener("pointercancel", endStageDrag);
  window.addEventListener("pointerup", endStageDrag);

  // 键盘
  window.addEventListener("keydown", (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); els.playBtn.click(); }
    else if (e.code === "ArrowRight") els.nextBtn.click();
    else if (e.code === "ArrowLeft") els.prevBtn.click();
  });

  player.onTime = (t) => { updateProgress(t); updateLyric(t); };
  player.onEnded = () => next(true);
  player.onModeChange = updateModeUI;
}

// ================= 手动逐字打轴 =================
// 自动对齐有它的上限：唱歌的咬字、长音、转音，模型给不出稳定边界。
// 要做到 100% 准确，只有人工打轴——边听边按空格，把每个字的播放
// 位置直接写进逐字 LRC。下面就是这套工作流。
const sync = { on: false, line: 0, char: 0, data: [], title: "", dir: null };

function syncEsc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtLrc(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return String(m).padStart(2, "0") + ":" + s.toFixed(2).padStart(5, "0");
}

function syncStart() {
  const track = currentId ? getTrack(currentId) : null;
  if (!track) { setLyricsStatus("先播放一首歌再打轴"); return; }
  if (!lyricLines.list.length) { setLyricsStatus("这首歌没有歌词，无法打轴"); return; }
  if (!window.JX) { setLyricsStatus("网页模式无法保存打轴结果"); return; }
  sync.on = true;
  sync.title = track.title;
  sync.dir = lyricsDir;
  sync.line = 0; sync.char = 0;
  // 预填：把歌词里已有的逐字时间（自动对齐的结果）直接载入，
  // 这样用户只需"修不对的地方"，不必从零把每个字重打一遍。
  sync.data = lyricLines.list.map(l => {
    const chars = [...String(l.text)];
    const arr = new Array(chars.length).fill(null);
    if (l.words && l.words.length) {
      let k = 0;
      for (const w of l.words) {
        const n = [...String(w.text)].length;
        for (let j = 0; j < n && k < chars.length; j++, k++) arr[k] = w.t;
      }
    }
    return arr;
  });
  sync.prefilled = sync.data.some(a => a.some(t => t != null));
  document.addEventListener("keydown", syncKey, true);
  if (!detailOpen) openDetail(track);
  syncRender();
  setLyricsStatus("打轴模式：空格=给高亮字打点 · 退格=撤销 · 回车=跳过本行 · Esc=退出");
  if (!player.isPlaying()) player.play();
}

function syncStop() {
  sync.on = false;
  document.removeEventListener("keydown", syncKey, true);
  const el = document.getElementById("syncPanel");
  if (el) el.remove();
}

function syncKey(e) {
  if (!sync.on) return;
  if (e.code === "Space") { e.preventDefault(); e.stopPropagation(); syncTap(); }
  else if (e.code === "Backspace") { e.preventDefault(); e.stopPropagation(); syncUndo(); }
  else if (e.code === "Enter") { e.preventDefault(); e.stopPropagation(); syncSkipLine(); }
  else if (e.code === "Escape") { e.preventDefault(); e.stopPropagation(); syncStop(); openDetail(getTrack(currentId)); }
}

function syncTap() {
  const line = lyricLines.list[sync.line];
  const chars = [...String(line ? line.text : "")];
  if (!chars.length) { syncSkipLine(); return; }
  sync.data[sync.line][sync.char] = player.currentTime();
  sync.char++;
  if (sync.char >= chars.length) { sync.line++; sync.char = 0; }
  if (sync.line >= lyricLines.list.length) { syncFinish(); return; }
  syncRender();
}

function syncUndo() {
  if (sync.char > 0) {
    sync.char--;
    sync.data[sync.line][sync.char] = null;
  } else if (sync.line > 0) {
    sync.line--;
    sync.char = Math.max(0, sync.data[sync.line].length - 1);
    sync.data[sync.line][sync.char] = null;
  }
  syncRender();
}

function syncSkipLine() {
  sync.line++; sync.char = 0;
  if (sync.line >= lyricLines.list.length) { syncFinish(); return; }
  syncRender();
}

function syncRender() {
  if (!sync.on) return;
  let panel = document.getElementById("syncPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "syncPanel";
    panel.className = "sync-panel";
    els.detailView.appendChild(panel);
    panel.addEventListener("click", (e) => {
      // 点某个字 → 光标跳过去（配合预填，只需改不对的地方）
      const ch = e.target.closest(".sync-char");
      if (ch && ch.dataset.k !== undefined) {
        sync.char = Number(ch.dataset.k);
        syncRender();
        return;
      }
      const b = e.target.closest("[data-sync]");
      if (!b) return;
      const a = b.dataset.sync;
      if (a === "tap") syncTap();
      else if (a === "undo") syncUndo();
      else if (a === "skip") syncSkipLine();
      else if (a === "clear") { sync.data[sync.line] = new Array(sync.data[sync.line].length).fill(null); sync.char = 0; syncRender(); }
      else if (a === "finish") syncFinish();
      else if (a === "cancel") { syncStop(); openDetail(getTrack(currentId)); }
    });
  }
  const line = lyricLines.list[sync.line];
  const chars = [...String(line ? line.text : "")];
  const times = sync.data[sync.line] || [];
  const done = times.filter(t => t != null).length;
  const finished = sync.data.filter(a => a.length && a.every(t => t != null)).length;
  panel.innerHTML =
    '<div class="sync-head"><span>打轴 · 第 ' + (sync.line + 1) + "/" + lyricLines.list.length +
    " 行 · 本行 " + done + "/" + chars.length + " 字 · 已完成 " + finished + " 行" +
    (sync.prefilled ? " · 已预填自动结果：点要改的字，再按空格覆盖" : "") + "</span>" +
    '<div class="sync-btns">' +
    '<button class="mini-btn" data-sync="undo">撤销</button>' +
    '<button class="mini-btn" data-sync="clear">清空本行</button>' +
    '<button class="mini-btn" data-sync="skip">跳过本行</button>' +
    '<button class="mini-btn on" data-sync="finish">完成并保存</button>' +
    '<button class="mini-btn" data-sync="cancel">退出</button></div></div>' +
    '<div class="sync-line" data-sync="tap">' +
    (chars.map((c, i) =>
      '<span class="sync-char ' + (times[i] != null ? "done" : "") + (i === sync.char ? " cur" : "") +
      '" data-k="' + i + '">' + syncEsc(c) + "</span>").join("") || "<i>（空行，回车跳过）</i>") +
    "</div>" +
    '<div class="sync-tip">点某个字跳到那里 · 按 <b>空格</b> 覆盖为当前播放位置并前进 · <b>退格</b> 撤销 · <b>回车</b> 跳过本行 · <b>Esc</b> 退出</div>';
}

function syncFinish() {
  const lines = lyricLines.list;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const chars = [...String(lines[i].text)];
    const ts = (sync.data[i] || []).slice();
    const known = ts.map((t, k) => (t != null ? k : -1)).filter(k => k >= 0);
    if (!known.length) { out.push("[" + fmtLrc(lines[i].t) + "]" + chars.join("")); continue; }
    for (let k = 0; k < chars.length; k++) {
      if (ts[k] != null) continue;
      const prev = known.filter(x => x < k).pop();
      const next = known.find(x => x > k);
      if (prev != null && next != null) ts[k] = ts[prev] + (ts[next] - ts[prev]) * (k - prev) / (next - prev);
      else if (prev != null) ts[k] = ts[prev] + 0.25;
      else ts[k] = Math.max(0, ts[next] - 0.25 * (next - k));
    }
    let s = "[" + fmtLrc(ts[0] != null ? ts[0] : lines[i].t) + "]";
    chars.forEach((c, k) => { s += "<" + fmtLrc(ts[k]) + ">" + c; });
    out.push(s);
  }
  // 写入"人工打轴"标记：播放器只有看到这个标记才启用逐字填充
  const content = "[by:手动打轴]\n" + out.join("\n") + "\n";
  const marked = sync.data.filter(a => a.some(t => t != null)).length;
  const target = { dir: sync.dir, name: sync.title + ".lrc" };
  syncStop();
  window.JX.saveLrc({ dir: target.dir, name: target.name, content }).then(ok => {
    const parsed = parseLrc(content);
    if (ok) {
      lyricLines = { list: parsed, source: "local" };
      const f = fileMap.get(currentId);
      if (f) f.lrcLines = parsed;
      setLyricsStatus("已保存人工打轴歌词（" + marked + " 行）→ " + target.name);
    } else {
      setLyricsStatus("保存失败");
    }
    resetKaraoke();
    openDetail(getTrack(currentId));
    console.log("[sync] saved lines=" + marked + " ok=" + ok);
  });
}

// 打轴入口：详情页工具栏的「✎ 打轴」按钮
document.addEventListener("click", (e) => {
  const b = e.target.closest('[data-action="sync-start"]');
  if (b) { e.preventDefault(); syncStart(); }
});

// ---- 启动 ----
async function init() {
  await store.init();
  favSet = new Set(store.data.favs);
  history = store.data.history.slice();
  player.volume = store.data.volume;
  player.mode = store.data.mode || "list";
  autoFetchLyrics = store.data.autoFetchLyrics !== false;
  lyricsMode = store.data.lyricsMode === "cover" ? "cover" : "panel";
  onlyOwned = store.data.onlyOwned !== false;
  els.volumeFill.style.width = (player.volume * 100) + "%";
  els.seekThumb.innerHTML = chibiSVG();

  bindEvents();
  renderList();
  updatePlayerBar();

  await scanDefault();
  await scanCovers();
  await scanLyricsDir();
  refreshLocalStatus();
  renderList();
  updatePlayerBar();
  console.log("[app] ready, songs=" + SONGS.length + ", local=" + fileMap.size +
    ", unmatched=" + localTracks.length + ", owned=" + allSongs().filter(hasAudio).length +
    ", covers=" + coverMap.size + ", lyrics=" + lyricsIndex.size + ", onlyOwned=" + onlyOwned);

  // 测试钩子：/?autoplay=1 自动播放第一首；&mode=cover|panel 指定歌词模式
  const qs = new URLSearchParams(location.search);
  if (qs.get("mode") === "cover") lyricsMode = "cover";
  else if (qs.get("mode") === "panel") lyricsMode = "panel";
  if (qs.get("autoplay") === "1" && SONGS.length) {
    playId(SONGS[0].id);
    console.log("[app] autoplay started:", currentId, "mode:", lyricsMode);
  }
}

window.addEventListener("error", (e) => console.error("[uncaught]", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => console.error("[rejection]", e.reason));

init();
