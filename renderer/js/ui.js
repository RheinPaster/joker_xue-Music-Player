// UI 辅助与渲染函数：剪影 SVG、时间格式化、歌单/专辑/详情渲染。
import { SONGS } from "../data/songs.js";

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

export function grad(palette) {
  const p = palette || ["#2b3550", "#7fa8d9"];
  return `linear-gradient(135deg, ${p[0]}, ${p[1]})`;
}

// 艺术剪影：一个背对聚光灯、微微颔首歌唱的人物 + 麦架（原创矢量）。
export function silhouetteSVG() {
  return `
  <svg viewBox="0 0 260 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="jxSil" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#20273c"/>
        <stop offset="1" stop-color="#08090f"/>
      </linearGradient>
      <linearGradient id="jxBeam" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e9b96a" stop-opacity=".18"/>
        <stop offset="1" stop-color="#e9b96a" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="60,0 200,0 258,320 6,320" fill="url(#jxBeam)"/>
    <g fill="url(#jxSil)" stroke="none">
      <circle cx="96" cy="62" r="19"/>
      <path d="M82 92 C80 118 77 162 82 202 L116 202 C121 162 118 118 116 92 Z"/>
      <path d="M104 104 C126 98 142 86 151 68 L160 74 C150 94 132 108 110 114 Z"/>
      <path d="M88 110 C74 132 72 152 74 172 L84 170 C82 152 84 134 95 118 Z"/>
      <path d="M82 200 L78 292 L90 294 L94 202 Z"/>
      <path d="M114 200 L118 292 L106 294 L103 202 Z"/>
      <path d="M74 292 C74 300 88 304 96 304 C104 304 120 300 120 292 L120 300 L74 300 Z"/>
    </g>
    <g stroke="url(#jxSil)" stroke-width="5" stroke-linecap="round">
      <line x1="196" y1="84" x2="196" y2="282"/>
      <line x1="178" y1="282" x2="214" y2="282"/>
    </g>
    <rect x="180" y="52" width="34" height="26" rx="7" fill="url(#jxSil)"/>
    <path d="M196 78 L196 84" stroke="url(#jxSil)" stroke-width="5" stroke-linecap="round"/>
  </svg>`;
}

const HEART = `<svg viewBox="0 0 24 24" width="17" height="17"><path d="M12 20s-7-4.6-9-9c-1.4-3 .6-6.4 4-6.4 2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.4 0 5.4 3.4 4 6.4-2 4.4-9 9-9 9z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
const PLAYROW = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5l12 7-12 7z" fill="currentColor"/></svg>`;

export function renderAlbumList(groups, activeKey, onSelect) {
  const root = document.getElementById("albumList");
  if (!root) return;
  root.innerHTML = groups.map(g => {
    const key = "album:" + g.name;
    const first = SONGS.find(s => s.id === g.songs[0]);
    const c = first ? first.palette[1] : "#e9b96a";
    return `<button class="album-item ${key === activeKey ? "active" : ""}" data-album="${esc(g.name)}">
      <span class="swatch" style="background:${c}"></span>
      <span class="aname">${esc(g.name)}</span>
      <span class="ayear">${g.year}</span>
    </button>`;
  }).join("");
  root.querySelectorAll(".album-item").forEach(el => {
    el.addEventListener("click", () => onSelect(el.dataset.album));
  });
}

export function renderSongList(songs, opts) {
  const root = document.getElementById("listView");
  if (!root) return;
  const { playingId, favSet, fileSet, coverMap } = opts;
  if (!songs.length) {
    root.innerHTML = `<div class="empty"><div class="big">♫</div><div>这里还没有歌曲</div><div style="font-size:12px">换个筛选条件，或把音频放进 music 文件夹</div></div>`;
    return;
  }
  root.innerHTML = songs.map((s, i) => {
    const fav = favSet.has(s.id);
    const playing = playingId === s.id;
    const hasFile = fileSet.has(s.id);
    const cover = coverMap ? coverMap.get(s.id) : null;
    return `<div class="song-row ${playing ? "playing" : ""}${hasFile ? "" : " unowned"}" data-id="${esc(s.id)}" data-action="play" role="button" tabindex="0">
      <div class="idx">${playing ? "▶" : (i + 1)}</div>
      <div class="thumb" style="background:${grad(s.palette)}">${cover ? `<img src="${esc(cover)}" alt="">` : esc(s.title[0])}</div>
      <div class="meta">
        <div class="title">${esc(s.title)}${hasFile ? "" : `<span class="badge">未拥有</span>`}</div>
        <div class="sub">${s.isLocal ? "本地音乐" : (s.artist ? "原唱：" + esc(s.artist) : "薛之谦")}${hasFile ? " · 本地音源" : " · 演示音源"}</div>
      </div>
      <div class="album">${esc(s.album)}</div>
      <div class="year">${s.year || ""}</div>
      <div class="dur">${s.isLocal ? "本地" : fmtTime(s.dur)}</div>
      <div class="row-actions">
        <button class="heart ${fav ? "on" : ""}" data-action="fav" data-id="${esc(s.id)}" title="收藏">${HEART}</button>
        <button class="play-row" data-action="play" data-id="${esc(s.id)}" title="播放">${PLAYROW}</button>
      </div>
    </div>`;
  }).join("");
}

// Q 版小人（原创矢量）：进度条上的「当前时间点」标记
export function chibiSVG() {
  return `
  <svg viewBox="0 0 44 52" width="26" height="31" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="22" cy="49" rx="11" ry="2.2" fill="rgba(0,0,0,.45)"/>
    <rect x="17" y="36" width="4.4" height="9" rx="2.2" fill="#2c3242"/>
    <rect x="22.6" y="36" width="4.4" height="9" rx="2.2" fill="#2c3242"/>
    <rect x="15.2" y="44" width="7.2" height="3.6" rx="1.8" fill="#161922"/>
    <rect x="21.6" y="44" width="7.2" height="3.6" rx="1.8" fill="#161922"/>
    <path d="M15.6 30.5 C15.6 27.4 18.2 25.8 22 25.8 C25.8 25.8 28.4 27.4 28.4 30.5 L29.4 38.4 C25 40.2 19 40.2 14.6 38.4 Z" fill="#3c4460"/>
    <path d="M19.4 26.1 L22 29.6 L24.6 26.1 Z" fill="#e9b96a"/>
    <path d="M15.9 29.6 C13.7 32.1 13.3 34.6 13.7 36.7" stroke="#3c4460" stroke-width="4" stroke-linecap="round" fill="none"/>
    <path d="M28.1 29.6 C31 30.6 33 28.6 33.6 25.6" stroke="#3c4460" stroke-width="4" stroke-linecap="round" fill="none"/>
    <rect x="31.5" y="18.4" width="4.6" height="8" rx="2.3" fill="#7b8296"/>
    <circle cx="33.8" cy="17.9" r="2.9" fill="#e9b96a"/>
    <rect x="20" y="24.6" width="4" height="3.4" fill="#f0c9a6"/>
    <circle cx="22" cy="17.6" r="11" fill="#ffd9b8"/>
    <path d="M11.1 17.2 C11.1 9.4 16 5.8 22 5.8 C28 5.8 32.9 9.4 32.9 17.2 C32.9 17.2 30.9 14.3 27.4 14 C24.4 13.8 23 15.4 20 15 C16.6 14.5 13.5 15.4 11.1 17.2 Z" fill="#242938"/>
    <path d="M20.4 7 C21.4 4.4 24.4 4 25.8 6" stroke="#242938" stroke-width="2.4" stroke-linecap="round" fill="none"/>
    <ellipse cx="18.2" cy="18.6" rx="1.5" ry="1.9" fill="#242938"/>
    <ellipse cx="25.8" cy="18.6" rx="1.5" ry="1.9" fill="#242938"/>
    <circle cx="15.3" cy="21.2" r="1.8" fill="#f7a9a0" opacity=".7"/>
    <circle cx="28.7" cy="21.2" r="1.8" fill="#f7a9a0" opacity=".7"/>
    <path d="M20.5 22.3 C21.4 23.3 22.6 23.3 23.5 22.3" stroke="#8a5a44" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </svg>`;
}

// 一行歌词：底层暗色 + 上层亮色（被逐字裁剪），形成"从左到右连续填充"的卡拉OK效果
function charsHTML(text) {
  return [...String(text || "")].map(c => `<span class="lchar">${esc(c)}</span>`).join("");
}
function lineBodyHTML(text) {
  const inner = charsHTML(text);
  return `<span class="lwrap"><span class="lbase">${inner}</span>` +
    `<span class="lfill" aria-hidden="true">${inner}</span></span>`;
}
function lyricLineHTML(line, i) {
  return `<div class="lyric-line" data-i="${i}" data-t="${line.t.toFixed(2)}">` +
    `<span class="lmeta">${fmtTime(line.t)}</span>${lineBodyHTML(line.text)}</div>`;
}

export function renderDetail(track, lines, opts) {
  const root = document.getElementById("detailView");
  if (!root) return;
  const { isFav, hasFile, cover, status, autoFetch, mode, activeIndex, offset, playing } = opts;
  const off = Number(offset) || 0;
  const offLabel = off === 0 ? "歌词同步" : (off > 0 ? "＋" : "−") + Math.abs(off).toFixed(1) + "s";
  const isLocal = !!track.isLocal;
  const sourceNote = lines.source === "preview"
    ? "预览歌词（节选）· 点「获取歌词」或放置《" + track.title + ".lrc》可加载完整歌词"
    : (lines.source === "online" ? "歌词来源：公开歌词库 LRCLIB" : "歌词来源：本地 LRC 文件");
  // 「为他人创作」：薛之谦是词曲、唱的是别人 —— 必须标出原唱，否则会误导
  const metaBits = [isLocal ? "本地音乐" : (track.artist ? "原唱：" + track.artist : "薛之谦")];
  if (track.artist) metaBits.push("词曲：薛之谦");
  if (track.album && !isLocal) metaBits.push("《" + track.album + "》");
  if (track.year) metaBits.push(String(track.year));
  if (!isLocal && track.dur) metaBits.push(fmtTime(track.dur));
  root.style.setProperty("--hero-glow", "rgba(233,185,106,.4)");
  // 非人工打轴的歌词不做逐字填充 —— 这时文字要整句亮白，
  // 否则会一直取"底层暗色"，看起来灰蒙蒙的。
  document.body.classList.toggle("no-perchar", !lines.manual);

  const toolbar = `
    <div class="detail-bar">
      <button class="back-btn" data-action="back" title="返回列表">‹ 返回</button>
      <button class="mini-btn" data-action="set-cover" title="从本地选择图片作为封面">更换封面</button>
      <button class="mini-btn" data-action="get-cover" title="从 iTunes 搜索官方无水印封面">获取封面</button>
      <button class="mini-btn" data-action="sync-start" title="手动逐字打轴：边听边按空格，给每个字打上准确时间">✎ 打轴</button>
      <button class="mini-btn ${mode === "cover" ? "on" : ""}" data-action="toggle-mode" title="切换歌词显示方式">
        ${mode === "cover" ? "封面模式" : "侧栏模式"}
      </button>
      <span class="offset-group" title="歌词时间轴微调：＋ 让歌词延后，－ 让歌词提前；点中间数字复位">
        <button class="mini-btn" data-action="offset-minus" title="歌词提前 0.5 秒">−</button>
        <button class="mini-btn offset-val ${off !== 0 ? "on" : ""}" data-action="offset-reset" title="点击复位为 0">${esc(offLabel)}</button>
        <button class="mini-btn" data-action="offset-plus" title="歌词延后 0.5 秒">＋</button>
      </span>
      <span class="lyrics-status" id="lyricsStatus">${esc(status || "")}</span>
      <div class="lyrics-tools">
        <button class="mini-btn ${autoFetch ? "on" : ""}" data-action="toggle-auto" title="播放时自动获取歌词">自动</button>
        <button class="mini-btn" data-action="get-lyrics" title="从公开歌词库（LRCLIB）获取">获取歌词</button>
        <button class="icon-btn ${isFav ? "on" : ""}" data-action="fav-detail" title="${isFav ? "取消收藏" : "收藏"}">${HEART}</button>
      </div>
    </div>`;

  const emptyLyric = `<div class="lyric-line dim"><span class="ltext">暂无歌词数据</span></div>`;
  const listHTML = lines.list.length ? lines.list.map((l, i) => lyricLineHTML(l, i)).join("") : emptyLyric;

  // 沉浸式播放页（参考 QQ 音乐）= 正式的全屏播放视图：
  // 模糊封面铺满整窗 → 左半屏大封面，封面正下方是「频谱 + 进度条」，
  // 右半屏标题 + 滚动歌词（人工打轴过才逐字）+ 底部时间与播放控制。
  if (mode === "cover") {
    document.body.classList.add("stage-mode");
    root.innerHTML = `
      <div class="stage">
        ${cover ? `<div class="stage-bg" style="background-image:url('${esc(cover)}')"></div>`
                : `<div class="stage-bg" style="background:${grad(track.palette)}"></div>`}
        <div class="stage-veil"></div>
        <div class="stage-top">
          <button class="stage-back" data-action="back" title="返回列表">‹</button>
          <div class="stage-tools">
            <button class="mini-btn" data-action="sync-start" title="手动逐字打轴：边听边按空格给每个字打时间">✎ 打轴</button>
            <button class="mini-btn" data-action="get-lyrics" title="从公开歌词库（LRCLIB）获取">获取歌词</button>
            <button class="mini-btn" data-action="get-cover" title="从 iTunes 获取无水印封面">获取封面</button>
            <button class="mini-btn ${isFav ? "on" : ""}" data-action="fav-detail" title="${isFav ? "取消收藏" : "收藏"}">${HEART}</button>
            <button class="mini-btn" data-action="toggle-mode" title="切回侧栏模式">侧栏模式</button>
          </div>
        </div>
        <div class="stage-main">
          <div class="stage-left">
            <div class="stage-cover">
              ${cover ? `<img src="${esc(cover)}" alt="">` : `<div class="stage-cover-fallback">${silhouetteSVG()}</div>`}
            </div>
            <div class="stage-progress">
              <canvas class="stage-spectrum" id="stageSpectrum" aria-hidden="true"></canvas>
              <div class="stage-bar-wrap" id="stageSeek" title="点击或拖动调整播放进度">
                <div class="stage-bar-track"><div class="stage-bar-fill" id="stageFill"></div></div>
                <div class="stage-bar-thumb" id="stageThumb">${chibiSVG()}</div>
              </div>
            </div>
          </div>
          <div class="stage-right">
            <div class="stage-title">${esc(track.title)} <span class="stage-artist">— ${track.artist ? "原唱：" + esc(track.artist) : "薛之谦"}</span></div>
            <div class="stage-lyrics" id="lyricsScroll">${listHTML}</div>
            <div class="stage-bottom">
              <span class="stage-time" id="stageTime">0:00 / 0:00</span>
              <div class="stage-controls">
                <button class="ctrl" data-action="stage-prev" title="上一首">
                  <svg viewBox="0 0 24 24"><path d="M6 5v14M19 6l-9 6 9 6z"/></svg>
                </button>
                <button class="ctrl play" id="stagePlay" data-action="stage-play" title="播放 / 暂停">
                  <svg class="i-play" viewBox="0 0 24 24" ${playing ? "hidden" : ""}><path d="M8 5l12 7-12 7z"/></svg>
                  <svg class="i-pause" viewBox="0 0 24 24" ${playing ? "" : "hidden"}><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>
                </button>
                <button class="ctrl" data-action="stage-next" title="下一首">
                  <svg viewBox="0 0 24 24"><path d="M18 5v14M5 6l9 6-9 6z"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    return;
  }
  document.body.classList.remove("stage-mode");
  const body = `<div class="hero" style="background:${grad(track.palette)}">
         <div class="hero-glow"></div>
         <div class="hero-visual">${cover ? `<img class="hero-cover-img" src="${esc(cover)}" alt="">` : silhouetteSVG()}</div>
         <div class="hero-info">
           <div class="h-tag">正在播放 · ${hasFile ? "本地音源" : "演示音源"}</div>
           <div class="h-title">${esc(track.title)}</div>
           <div class="h-meta">${esc(metaBits.join(" · "))}</div>
         </div>
       </div>
       <div class="lyrics-panel">
         <div class="lyrics-head"><span>歌词</span><span class="lyrics-hint">${lines.manual ? "逐字填充" : "整句高亮"}</span></div>
         <div class="lyrics-scroll" id="lyricsScroll">${listHTML}</div>
         <div class="lyrics-note">${esc(sourceNote)}</div>
       </div>`;

  root.innerHTML = toolbar + `<div class="detail-body">${body}</div>`;
}

// 逐字高亮：每个字用裁剪遮罩做"从左到右连续填充"（卡拉OK 效果）
const HIDE = "inset(0 100% 0 0)";
const SHOW = "inset(0 0 0 0)";
let kLine = -1, kIdx = -1;

export function resetKaraoke() { kLine = -1; kIdx = -1; }

// progress: 浮点字数进度（3.4 表示第 4 个字已填充 40%）
export function setKaraokeProgress(lineIndex, progress) {
  const line = document.querySelector('.lyric-line[data-i="' + lineIndex + '"]');
  if (!line) return;
  const chars = line.querySelectorAll(".lfill .lchar");
  const N = chars.length;
  if (!N) return;

  if (lineIndex !== kLine) {
    if (kLine >= 0) {
      const prev = document.querySelector('.lyric-line[data-i="' + kLine + '"]');
      if (prev) prev.querySelectorAll(".lfill .lchar").forEach(c => { c.style.clipPath = HIDE; });
    }
    chars.forEach(c => { c.style.clipPath = HIDE; });
    kLine = lineIndex; kIdx = -1;
  }

  const p = Math.max(0, Math.min(N, progress));
  const i = Math.floor(p);
  const frac = p - i;

  if (i > kIdx) {
    for (let k = Math.max(0, kIdx); k < i && k < N; k++) chars[k].style.clipPath = SHOW;
  } else if (i < kIdx) {
    for (let k = i; k <= kIdx && k < N; k++) chars[k].style.clipPath = HIDE;
  }
  if (i < N) {
    chars[i].style.clipPath = frac <= 0.001 ? HIDE : `inset(0 ${(1 - frac) * 100}% 0 0)`;
  }
  kIdx = i;
}

// 封面模式：当前行 / 下一行
export function updateCoverLine(idx, lines) {
  const cur = document.getElementById("coverCur");
  const nxt = document.getElementById("coverNext");
  if (!cur) return;
  const line = lines[idx];
  if (!line) { cur.textContent = ""; if (nxt) nxt.textContent = ""; kLine = -1; kIdx = -1; return; }
  cur.dataset.i = String(idx);
  cur.innerHTML = lineBodyHTML(line.text);
  kLine = -1; kIdx = -1;   // DOM 已重建，重置遮罩状态
  if (nxt) nxt.textContent = lines[idx + 1] ? lines[idx + 1].text : "";
}

export function setLyricActive(activeIndex) {
  const sc = document.getElementById("lyricsScroll");
  if (!sc) return;
  const lines = sc.querySelectorAll(".lyric-line");
  lines.forEach((l, i) => l.classList.toggle("active", i === activeIndex));
  const active = sc.querySelector(".lyric-line.active");
  if (!active) return;
  // 用 rect 的相对位移算滚动目标：offsetTop 的参照物是「最近的定位祖先」，
  // 跟滚动容器不是一回事（侧栏模式和全屏页的祖先都不同），会整体偏掉一截。
  const target = sc.scrollTop
    + (active.getBoundingClientRect().top - sc.getBoundingClientRect().top)
    - (sc.clientHeight - active.offsetHeight) / 2;
  sc.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}
