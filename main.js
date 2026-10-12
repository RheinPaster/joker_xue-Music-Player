"use strict";
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const https = require("https");
const { normSimple, isArtistMatch, isAcceptable, pickBest } = require("./lib/lyrics-match");

let mainWindow = null;
let server = null;
let serverPort = 37914;

const RENDERER_DIR = path.join(__dirname, "renderer");
const MUSIC_DIR = path.join(__dirname, "music");
const COVERS_DIR = path.join(__dirname, "covers");
const LYRICS_DIR = path.join(__dirname, "lyrics");

// 允许播放器读取的目录（仅这些目录内的文件会通过 /media 流式返回）
const allowedDirs = new Set();
if (fs.existsSync(MUSIC_DIR)) allowedDirs.add(MUSIC_DIR);
if (fs.existsSync(COVERS_DIR)) allowedDirs.add(COVERS_DIR);
if (fs.existsSync(LYRICS_DIR)) allowedDirs.add(LYRICS_DIR);

const AUDIO_EXT = new Set([
  ".mp3", ".wav", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".mp4", ".webm", ".wma"
]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const MIME = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4",
  ".aac": "audio/aac", ".opus": "audio/ogg", ".mp4": "audio/mp4",
  ".webm": "audio/webm", ".wma": "audio/x-ms-wma", ".js": "text/javascript",
  ".css": "text/css", ".html": "text/html", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp",
  ".lrc": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8"
};

function stateFile() {
  return path.join(app.getPath("userData"), "player-state.json");
}

// 读存档：解析失败【必须】先备份再返回空对象 —— 渲染进程拿到默认值后会立刻
// save 回去，等于把收藏和历史一次性清空（一个 UTF-8 BOM 就够触发）。
function readStateFile() {
  const f = stateFile();
  try {
    const raw = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");   // 有些编辑器会写 BOM
    const j = JSON.parse(raw);
    return (j && typeof j === "object" && !Array.isArray(j)) ? j : {};
  } catch (e) {
    try {
      if (fs.existsSync(f)) {
        const bak = f + ".bad-" + Date.now() + ".bak";
        fs.copyFileSync(f, bak);
        console.error("[state] 存档解析失败，已备份：" + bak + "（" + e.message + "）");
      }
    } catch {}
    return {};
  }
}

function ensureDirs() {
  if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
  if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });
  if (!fs.existsSync(LYRICS_DIR)) fs.mkdirSync(LYRICS_DIR, { recursive: true });
  allowedDirs.add(MUSIC_DIR);
  allowedDirs.add(COVERS_DIR);
  allowedDirs.add(LYRICS_DIR);
  const hint = path.join(MUSIC_DIR, "说明-把歌曲放进这里.txt");
  if (!fs.existsSync(hint)) {
    fs.writeFileSync(
      hint,
      "把 mp3 / flac / wav 等音频文件放进这个 music 文件夹，播放器会自动识别并播放。\n" +
      "想要完整歌词，请放一个同名的《歌名.lrc》文件（歌词由你自行准备，即可自动加载）。\n\n" +
      "若没有喜欢的用途，也可在播放器里点「打开本地文件夹」选择其他音乐目录。\n"
    );
  }
  const coverHint = path.join(COVERS_DIR, "说明-封面放这里.txt");
  if (!fs.existsSync(coverHint)) {
    fs.writeFileSync(
      coverHint,
      "把封面图片（jpg / png / webp）放到这个 covers 文件夹即可自动识别：\n" +
      "- 按歌名命名：演员.jpg、认真的雪.png（仅该歌曲使用）\n" +
      "- 按专辑命名：意外.jpg、初学者.jpg（整张专辑共用）\n\n" +
      "也可以直接在播放器详情页点「更换封面」选择图片。\n"
    );
  }
  const lyricHint = path.join(LYRICS_DIR, "说明-歌词放这里.txt");
  if (!fs.existsSync(lyricHint)) {
    fs.writeFileSync(
      lyricHint,
      "把歌词文件按《歌名.lrc》命名放进这个 lyrics 文件夹，播放器会自动加载。\n" +
      "音频旁边的同名 .lrc 优先级更高。\n\n" +
      "也可以在播放器详情页点「获取歌词」，自动从公开歌词库（LRCLIB）匹配并保存到这里。\n"
    );
  }
}

function safeDecode(v) {
  try { return decodeURIComponent(v || ""); } catch { return v || ""; }
}
function ext(p) { return path.extname(p).toLowerCase(); }

function isAllowedDir(dir) {
  if (!dir) return false;
  const normalized = path.resolve(dir).replace(/[\\/]+$/, "");
  const nlower = normalized.toLowerCase();
  for (const d of allowedDirs) {
    const nd = path.resolve(d).replace(/[\\/]+$/, "");
    const nnd = nd.toLowerCase();
    if (nlower === nnd || nlower.startsWith(nnd + path.sep)) return true;
  }
  return false;
}

async function listAudio(dir) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const e = ext(ent.name);
    if (AUDIO_EXT.has(e)) out.push({ name: ent.name, base: path.basename(ent.name, e), ext: e });
  }
  out.sort((a, b) => a.base.localeCompare(b.base, "zh"));
  return out;
}

async function listImages(dir) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const e = ext(ent.name);
    if (IMAGE_EXT.has(e)) out.push({ name: ent.name, base: path.basename(ent.name, e), ext: e });
  }
  out.sort((a, b) => a.base.localeCompare(b.base, "zh"));
  return out;
}

// 歌词文件清单（只列名字，内容由渲染端按需通过 /media 取）
async function listLyrics(dir) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (ext(ent.name) !== ".lrc") continue;
    out.push({ name: ent.name, base: path.basename(ent.name, ".lrc") });
  }
  out.sort((a, b) => a.base.localeCompare(b.base, "zh"));
  return out;
}

// ---- LRCLIB 公开歌词库查询（主进程发起，避免渲染端 CSP 限制）----
function httpsJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { "User-Agent": "joker-xue-music-player/1.0 (personal use)" },
      timeout: 9000
    }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      let d = "";
      r.setEncoding("utf8");
      r.on("data", (c) => { d += c; if (d.length > 2_000_000) { req.destroy(); resolve(null); } });
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

const LRCLIB = "https://lrclib.net/api/";

async function fetchLyricsFromLRCLIB(q) {
  const title = String((q && q.title) || "").trim();
  const artist = String((q && q.artist) || "").trim();
  const album = String((q && q.album) || "").trim();
  const duration = Math.round(Number((q && q.duration) || 0));
  if (!title) return null;
  if (!artist && !duration) return null;   // 缺少确认依据，不猜

  // 1) 精确查询（只在拿到真实音频时长时才带上 duration）
  //    LRCLIB 里薛之谦多为英文名 Joker Xue，两种署名都试一遍
  let hit = null;
  if (duration > 0) {
    const names = [];
    if (artist) names.push(artist);
    if (isArtistMatch("Joker Xue", artist)) names.push("Joker Xue");
    for (const nm of names) {
      let url = LRCLIB + "get?artist_name=" + encodeURIComponent(nm) +
        "&track_name=" + encodeURIComponent(title);
      if (album) url += "&album_name=" + encodeURIComponent(album);
      url += "&duration=" + duration;
      const exact = await httpsJSON(url);
      if (isAcceptable(exact, artist, title, duration)) { hit = exact; break; }
    }
  }

  // 2) 搜索兜底：必须先通过校验，再挑最佳
  if (!hit) {
    const terms = [];
    if (artist) terms.push(artist + " " + title);
    terms.push(title);
    for (const term of terms) {
      const list = await httpsJSON(LRCLIB + "search?q=" + encodeURIComponent(term));
      const ok = (Array.isArray(list) ? list : []).filter(x => isAcceptable(x, artist, title, duration));
      if (ok.length) { hit = pickBest(ok, duration); break; }
    }
  }
  if (!hit) return null;

  return {
    synced: hit.syncedLyrics || "",
    plain: hit.plainLyrics || "",
    trackName: hit.trackName || title,
    artistName: hit.artistName || artist,
    albumName: hit.albumName || "",
    duration: hit.duration || 0
  };
}

// ---- 专辑封面：iTunes Search API（免费、无需密钥、官方无水印图）----
function httpsBuffer(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { "User-Agent": "joker-xue-music-player/1.0 (personal use)" },
      timeout: 15000
    }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      const chunks = [];
      let size = 0;
      r.on("data", (c) => {
        size += c.length;
        if (size > 8_000_000) { req.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      r.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function safeFileName(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, "_").trim();
}

async function itunesSearch(term, entity) {
  const url = "https://itunes.apple.com/search?term=" + encodeURIComponent(term) +
    "&entity=" + (entity || "album") + "&limit=15&country=us";
  return await httpsJSON(url);
}

// 查询并下载封面到 covers/<key>.jpg
async function fetchCoverFor(q) {
  const title = String((q && q.title) || "").trim();
  const album = String((q && q.album) || "").trim();
  const year = String((q && q.year) || "").trim();
  const artist = String((q && q.artist) || "薛之谦").trim();
  const key = safeFileName((q && q.key) || album || title);
  if (!key || (!title && !album)) return null;

  const wantAlbum = normSimple(album);
  const wantTitle = normSimple(title);

  let pick = null;
  let matched = "";
  // 1) 按专辑搜
  if (album) {
    const j = await itunesSearch(artist + " " + album, "album");
    const list = (j && Array.isArray(j.results)) ? j.results : [];
    pick = list.find(r => wantAlbum && normSimple(r.collectionName) === wantAlbum) ||
           list.find(r => wantAlbum && normSimple(r.collectionName).includes(wantAlbum)) ||
           (year ? list.find(r => String(r.releaseDate || "").startsWith(year)) : null) ||
           list[0] || null;
    if (pick) matched = pick.collectionName || "";
  }
  // 2) 兜底：按歌名搜单曲
  if (!pick && title) {
    const j2 = await itunesSearch(artist + " " + title, "song");
    const list2 = (j2 && Array.isArray(j2.results)) ? j2.results : [];
    pick = list2.find(r => wantTitle && normSimple(r.trackName) === wantTitle) || list2[0] || null;
    if (pick) matched = pick.trackName || "";
  }
  if (!pick || !pick.artworkUrl100) return null;

  const bigUrl = String(pick.artworkUrl100).replace(/100x100bb/, "1400x1400bb");
  const buf = await httpsBuffer(bigUrl);
  if (!buf || buf.length < 1000) return null;
  try {
    await fsp.mkdir(COVERS_DIR, { recursive: true });
    await fsp.writeFile(path.join(COVERS_DIR, key + ".jpg"), buf);
  } catch (e) {
    console.error("[cover] save failed", e);
    return null;
  }
  return { name: key + ".jpg", matched, size: buf.length };
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
function sendText(res, code, text, ctype) {
  res.writeHead(code, { "Content-Type": ctype || "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function setCSP(res) {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; font-src 'self' data:;");
}

async function handleMedia(req, res, params) {
  const dir = safeDecode(params.get("dir") || "");
  const name = safeDecode(params.get("name") || "");
  if (!dir || !name || !isAllowedDir(dir)) { sendText(res, 400, "bad request"); return; }
  const abs = path.join(path.resolve(dir), name);
  if (!isAllowedDir(path.dirname(path.resolve(abs)))) { sendText(res, 403, "forbidden"); return; }
  let stat;
  try { stat = await fsp.stat(abs); } catch { sendText(res, 404, "not found"); return; }
  const total = stat.size;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", MIME[ext(abs)] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = 0, end = total - 1;
    if (m) {
      if (m[1] === "" && m[2] !== "") { start = Math.max(0, total - parseInt(m[2], 10)); end = total - 1; }
      else {
        start = parseInt(m[1], 10) || 0;
        end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
      }
    }
    if (start > end || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": end - start + 1
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": total });
    fs.createReadStream(abs).pipe(res);
  }
}

async function staticServe(res, urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p === "/" || p === "") p = "/index.html";
  const abs = path.normalize(path.join(RENDERER_DIR, p));
  if (!abs.toLowerCase().startsWith(RENDERER_DIR.toLowerCase())) { sendText(res, 403, "forbidden"); return; }
  let stat;
  try { stat = await fsp.stat(abs); } catch {
    res.writeHead(302, { Location: "/index.html" });
    res.end();
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(302, { Location: "/index.html" });
    res.end();
    return;
  }
  const mime = MIME[ext(abs)] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", mime.startsWith("text/") || mime.includes("javascript") ? "no-cache" : "private, max-age=3600");
  fs.createReadStream(abs).pipe(res);
}

function handleApi(req, res) {
  const u = new URL(req.url, "http://127.0.0.1");

  if (u.pathname === "/api/music") {
    listAudio(MUSIC_DIR).then(list => sendJSON(res, 200, { dir: MUSIC_DIR, files: list }))
      .catch(() => sendJSON(res, 200, { dir: MUSIC_DIR, files: [] }));
    return;
  }
  if (u.pathname === "/api/list") {
    const dir = safeDecode(u.searchParams.get("dir") || "");
    if (!isAllowedDir(dir)) return sendJSON(res, 403, { error: "forbidden" });
    listAudio(dir).then(list => sendJSON(res, 200, { dir, files: list }))
      .catch(() => sendJSON(res, 200, { dir, files: [] }));
    return;
  }
  if (u.pathname === "/api/covers") {
    listImages(COVERS_DIR).then(list => sendJSON(res, 200, { dir: COVERS_DIR, files: list }))
      .catch(() => sendJSON(res, 200, { dir: COVERS_DIR, files: [] }));
    return;
  }
  if (u.pathname === "/api/lyrics") {
    listLyrics(LYRICS_DIR).then(list => sendJSON(res, 200, { dir: LYRICS_DIR, files: list }))
      .catch(() => sendJSON(res, 200, { dir: LYRICS_DIR, files: [] }));
    return;
  }
  sendJSON(res, 404, { error: "not found" });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api")) return handleApi(req, res);
      if (req.url.startsWith("/media")) {
        const u = new URL(req.url, "http://127.0.0.1");
        return handleMedia(req, res, u.searchParams);
      }
      setCSP(res);
      await staticServe(res, req.url);
    } catch (e) {
      try { sendText(res, 500, "server error"); } catch {}
    }
  });
}

function startServer() {
  return new Promise((resolve) => {
    const onError = (port) => {
      return (err) => {
        if (err.code === "EADDRINUSE") {
          serverPort = port + 1;
          bind(port + 1);
        } else {
          console.error("[server] start failed:", err);
          process.exit(1);
        }
      };
    };
    const bind = (port) => {
      server = createServer();
      server.once("error", onError(port));
      server.listen(port, "127.0.0.1", () => {
        serverPort = port;
        console.log("[server] listening on http://127.0.0.1:" + port);
        resolve(port);
      });
    };
    bind(serverPort);
  });
}

function createWindow() {
  const isDev = process.argv.includes("--dev");
  const isSmoke = process.argv.includes("--smoke");
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: "#0b0d15",
    title: "薛之谦音乐播放器",
    autoHideMenuBar: true,
    show: !isSmoke,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL("http://127.0.0.1:" + serverPort +
    (isSmoke ? ("/?autoplay=1" + (process.argv.includes("--cover") ? "&mode=cover" : "")) : ""));
  mainWindow.on("closed", () => { mainWindow = null; });

  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.webContents.on("console-message", (e, level, message) => {
    const lvl = typeof level === "number" ? level : (e && e.level);
    const msg = typeof message === "string" ? message : (e && e.message);
    console.log("[renderer:" + lvl + "]", msg || "");
  });

  if (isSmoke) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => { console.log("[smoke] quitting"); app.quit(); }, 15000);
    });
  }
}

function setupIpc() {
  ipcMain.handle("jx:load-state", () => readStateFile());
  ipcMain.handle("jx:save-state", (_e, data) => {
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(data || {}, null, 2), "utf8");
      return true;
    } catch (e) { return false; }
  });
  ipcMain.handle("jx:select-folder", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "选择存放音乐的文件夹",
      properties: ["openDirectory"]
    });
    if (!r.canceled && r.filePaths[0]) {
      const p = r.filePaths[0];
      allowedDirs.add(p);
      return p;
    }
    return null;
  });
  ipcMain.handle("jx:version", () => app.getVersion());
  ipcMain.handle("jx:choose-cover", async (_e, payload) => {
    const songId = typeof payload === "string" ? payload : String((payload && payload.songId) || "");
    const title = typeof payload === "string" ? "" : String((payload && payload.title) || "");
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "选择封面图片",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    // 用歌名命名，才能被 covers 目录的「按歌名匹配」识别到
    const safeName = safeFileName(title) || String(songId || "").replace(/[^\w\u4e00-\u9fa5-]/g, "");
    if (!safeName) return null;
    const newext = ext(src) || ".jpg";
    const dest = path.join(COVERS_DIR, safeName + newext);
    try {
      for (const f of fs.readdirSync(COVERS_DIR)) {
        if (f.startsWith(safeName + ".")) fs.unlinkSync(path.join(COVERS_DIR, f));
      }
      await fsp.copyFile(src, dest);
      return { name: path.basename(dest) };
    } catch (e) {
      console.error("[cover] save failed", e);
      return null;
    }
  });

  // 从 iTunes 搜索并下载官方无水印封面
  ipcMain.handle("jx:fetch-cover", async (_e, query) => {
    try { return await fetchCoverFor(query); }
    catch (e) { console.error("[cover] fetch failed", e); return null; }
  });

  // 从公开歌词库查询（LRCLIB）
  ipcMain.handle("jx:fetch-lyrics", async (_e, query) => {
    try { return await fetchLyricsFromLRCLIB(query); }
    catch (e) { console.error("[lyrics] fetch failed", e); return null; }
  });

  // 保存 .lrc（仅允许写入已授权目录，如 music / lyrics / 用户选择的目录）
  ipcMain.handle("jx:save-lrc", async (_e, payload) => {
    const dir = String((payload && payload.dir) || "");
    const rawName = String((payload && payload.name) || "");
    const content = String((payload && payload.content) || "");
    if (!dir || !rawName || !content) return false;
    if (!isAllowedDir(dir)) return false;
    const name = rawName.replace(/[\\/:*?"<>|]/g, "_").replace(/\.lrc$/i, "") + ".lrc";
    try {
      await fsp.mkdir(path.resolve(dir), { recursive: true });
      await fsp.writeFile(path.join(path.resolve(dir), name), content, "utf8");
      return true;
    } catch (e) {
      console.error("[lyrics] save failed", e);
      return false;
    }
  });
}

app.whenReady().then(async () => {
  ensureDirs();
  setupIpc();
  await startServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (server) { server.close(); server = null; }
  if (process.platform !== "darwin") app.quit();
});
