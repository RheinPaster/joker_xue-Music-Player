// 收藏 / 历史 / 音量 / 播放模式 的持久化：优先走主进程 JSON 文件，浏览器兜底用 localStorage。

const LS_KEY = "jokerxue:state";
const defaults = { favs: [], history: [], volume: 0.8, mode: "list" };

export const store = {
  data: { ...defaults },
  async init() {
    let loaded = null;
    if (window.JX) {
      try { loaded = await window.JX.loadState(); } catch {}
    }
    if (!loaded || typeof loaded !== "object") {
      try { loaded = JSON.parse(localStorage.getItem(LS_KEY)); } catch { loaded = null; }
    }
    this.data = { ...defaults, ...(loaded || {}) };
    if (!Array.isArray(this.data.favs)) this.data.favs = [];
    if (!Array.isArray(this.data.history)) this.data.history = [];
    return this.data;
  },
  save() {
    const payload = JSON.stringify(this.data);
    if (window.JX) { try { window.JX.saveState(this.data); } catch {} }
    try { localStorage.setItem(LS_KEY, payload); } catch {}
  }
};
