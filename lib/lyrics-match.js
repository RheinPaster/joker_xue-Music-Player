"use strict";
// 歌词候选的匹配规则（主进程与诊断脚本共用，保证"测过的就是跑着的"）。
// 纯函数，无外部依赖。

function normSimple(s) {
  return String(s || "").toLowerCase().replace(/[\s\-_·•.'"()（）【】\[\]!！?？,，、:：/\\]/g, "");
}

// 歌手别名：LRCLIB 把薛之谦主要登记为英文名 Joker Xue，也存在繁体「薛之謙」
function isArtistMatch(candName, wantName) {
  const a = normSimple(candName);
  if (!a) return false;
  const w = normSimple(wantName);
  const isJx = (s) => s.includes("jokerxue") || s.includes("joker") ||
    s.includes("薛之谦") || s.includes("薛之謙");
  if (w && (a.includes(w) || w.includes(a))) return true;
  const wIsJx = !w || isJx(w);
  if (wIsJx && isJx(a)) return true;
  return false;
}

// 候选是否可信：歌名要像、歌手要像（含别名）、时长不能离谱
function isAcceptable(x, artist, title, duration) {
  if (!x || x.instrumental) return false;

  const nt = normSimple(x.trackName), ntq = normSimple(title);
  if (!nt || !ntq) return false;
  if (!(nt === ntq || nt.includes(ntq) || ntq.includes(nt))) return false;

  if (artist && !isArtistMatch(x.artistName, artist)) return false;

  // 时长只用来排除"明显不是同一版本"的和排序：歌名+歌手已能锁定歌曲，
  // 不同版本（Live / 重制 / 二创）时长有出入，仍应给出歌词。
  if (duration > 0) {
    if (!x.duration) return false;
    const tol = Math.max(20, duration * 0.10);
    if (Math.abs(x.duration - duration) > tol) return false;
  } else if (!artist) {
    return false; // 既没时长也没歌手，无从确认
  }
  return true;
}

// 从通过校验的候选里挑最佳：优先带时间轴，其次时长最接近
function pickBest(list, duration) {
  if (!Array.isArray(list) || !list.length) return null;
  const scored = list
    .map((x) => ({
      x,
      synced: x.syncedLyrics ? 1 : 0,
      diff: (duration > 0 && x.duration) ? Math.abs(x.duration - duration) : 999
    }))
    .sort((a, b) => (b.synced - a.synced) || (a.diff - b.diff));
  return scored.length ? scored[0].x : null;
}

module.exports = { normSimple, isArtistMatch, isAcceptable, pickBest };
