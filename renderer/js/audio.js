// 音频引擎：统一封装「真实音频文件」与「WebAudio 合成演示旋律」两个后端。
// 接口：play/pause/stop/seek/setVolume/currentTime/duration；通过 onTime/onEnded 回调驱动 UI 与歌词。

function noteFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

// 每个 id 哈希出一个调性根音，保证不同歌有不同“感觉”。
function rootFor(id) {
  const pool = [55, 57, 60, 62, 64, 65, 67];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

// ---------------- 频谱（沉浸页进度条律动用） ----------------
export const SPECTRUM_BARS = 56;   // 与 app.js 共用一个条数常量，别各写各的

// 把 analyser 的 FFT 数据压成 N 根条：低频分箱密、高频分箱疏（听感上才对），
// 再做一个轻微的对比度提升，否则安静段落几乎看不见跳动。
// 返回 true 表示这次拿到的是实时数据。
function readBands(analyser, freqBuf, out) {
  analyser.getByteFrequencyData(freqBuf);
  const bins = analyser.frequencyBinCount;
  const usable = Math.max(8, Math.floor(bins * 0.72));   // 高频区基本是空的，别浪费条数
  const N = out.length;
  for (let i = 0; i < N; i++) {
    const lo = Math.floor(Math.pow(i / N, 1.7) * usable) + 1;
    const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / N, 1.7) * usable) + 1);
    let sum = 0, n = 0;
    for (let k = lo; k < hi && k < bins; k++) { sum += freqBuf[k]; n++; }
    const v = n ? sum / n / 255 : 0;
    out[i] = Math.min(1, Math.pow(v, 0.78) * 1.25);
  }
  return true;
}

// ---------------- 真实音频后端 ----------------
class RealEngine {
  constructor(onTime, onEnded) {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.fallbackDuration = 0;
    // 频谱用：第一次真正需要时才建 AudioContext 并把 <audio> 接进分析图，
    // 免得白白多一个音频线程；失败就永久放弃（绝不影响播放）。
    this._ctx = null; this._analyser = null; this._freq = null; this._src = null;
    this._specDead = false;
    let lastT = -1;
    this.audio.addEventListener("timeupdate", () => {
      const t = this.audio.currentTime;
      if (Math.abs(t - lastT) > 0.2) { lastT = t; onTime(t); }
    });
    this.audio.addEventListener("ended", () => onEnded());
    this.audio.addEventListener("error", () => onEnded()); // 播放失败也视为结束，交给上层切换演示
  }
  load(url, fallbackDuration) {
    this.fallbackDuration = fallbackDuration || 0;
    this.audio.src = url;
    this.audio.load();
  }
  play() {
    const p = this.audio.play(); if (p && p.catch) p.catch(() => {});
    if (this._ctx && this._ctx.state === "suspended") { try { this._ctx.resume(); } catch {} }
  }
  pause() { this.audio.pause(); }
  stop() { this.audio.pause(); this.audio.currentTime = 0; }
  seek(t) { try { this.audio.currentTime = t; } catch {} }
  setVolume(v) { this.audio.volume = v; }
  currentTime() { return this.audio.currentTime || 0; }
  duration() { return (this.audio.duration && isFinite(this.audio.duration)) ? this.audio.duration : this.fallbackDuration; }
  get hasMedia() { return !!(this.audio.src && !this.audio.error); }

  // 懒建分析图：<audio> -> MediaElementSource -> analyser -> destination
  // （必须接回 destination，否则声音会被"抽走"变成静音）
  _ensureAnalyser() {
    if (this._analyser || this._specDead) return this._analyser;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaElementSource(this.audio);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.74;
      src.connect(an);
      an.connect(ctx.destination);
      this._ctx = ctx; this._src = src; this._analyser = an;
      this._freq = new Uint8Array(an.frequencyBinCount);
      if (ctx.state === "suspended") { try { ctx.resume(); } catch {} }
    } catch (e) {
      this._specDead = true;
      this._analyser = null;
    }
    return this._analyser;
  }
  spectrum(out) {
    const an = this._ensureAnalyser();
    if (!an || this.audio.paused || this.audio.error) return false;
    if (this._ctx.state === "suspended") { try { this._ctx.resume(); } catch {} }
    return readBands(an, this._freq, out);
  }
  destroy() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this._ctx) { try { this._ctx.close(); } catch {} }
    this._ctx = null; this._analyser = null; this._src = null; this._freq = null;
  }
}

// ---------------- 合成演示后端（原创占位旋律） ----------------
class SynthEngine {
  constructor(onTime, onEnded) {
    this.onTime = onTime; this.onEnded = onEnded;
    this.ctx = null; this.master = null;
    this.analyser = null; this._freq = null;
    this.offset = 0; this.startCtx = 0; this.dur = 240;
    this.playing = false;
    this._schedT = 0; this._timer = null; this._check = null;
    this.volume = 0.8;
    this.base = 57;
  }
  _ensureCtx() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.45 * this.volume;
    // 合成引擎天生在 WebAudio 里，直接挂一个分析器就能出频谱
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.74;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this._freq = new Uint8Array(this.analyser.frequencyBinCount);
  }
  load(track) {
    this.base = rootFor(track.id);
    this.dur = track.dur || 240;
  }
  _now() { return this.offset + (this.ctx.currentTime - this.startCtx); }
  play(fromSec) {
    this._ensureCtx();
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.offset = fromSec || 0;
    this.startCtx = this.ctx.currentTime;
    this._schedT = this.offset;
    this.playing = true;
    this._schedule();
    this._timer = setInterval(() => this._schedule(), 220);
    this._check = setInterval(() => {
      if (!this.playing) return;
      const now = this._now();
      this.onTime(now);
      if (now >= this.dur) this._end();
    }, 200);
  }
  _end() {
    if (!this.playing) return;
    this.pause();
    this.onEnded();
  }
  pause() {
    this.playing = false;
    if (this.ctx && this.ctx.state === "running") this.ctx.suspend();
    this._clear();
  }
  stop() {
    this.pause();
    if (this.ctx) { try { this.ctx.close(); } catch {} this.ctx = null; this.master = null; }
    this.analyser = null; this._freq = null;
  }
  _clear() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._check) { clearInterval(this._check); this._check = null; }
  }
  seek(t) {
    this._ensureCtx();
    const newOffset = Math.max(0, Math.min(t, this.dur - 0.05));
    this.offset = newOffset;
    this.startCtx = this.ctx.currentTime;
    this._schedT = newOffset;
    this.onTime(this._now());
  }
  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = 0.45 * v;
  }
  currentTime() { return this.ctx ? this._now() : this.offset; }
  duration() { return this.dur; }
  _schedule() {
    if (!this.playing) return;
    const lookahead = this.ctx.currentTime + 0.6;
    const barLen = 3.2;            // 每小节时长
    const stepLen = barLen / 8;    // 八分音符
    while (this._schedT < this._now() + 0.8) {
      if (this._schedT >= this.dur) break;
      const s = this._schedT;
      const whenCtx = this.startCtx + (s - this.offset);
      if (whenCtx < lookahead) this._noteAt(s, whenCtx);
      this._schedT += stepLen;
    }
    if (this._now() >= this.dur) this._end();
  }
  _noteAt(songSec, when) {
    const barLen = 3.2, stepLen = barLen / 8;
    const bar = Math.floor(songSec / barLen);
    const posInBar = (songSec - bar * barLen) / stepLen; // 0..7
    // 四个和弦（近似 I - vi - IV - V），营造流动感
    const prog = [
      [0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]
    ];
    const chord = prog[bar % prog.length];
    const step = Math.floor(posInBar) % 4;
    let midi = this.base + chord[step % chord.length] + (posInBar >= 4 ? 12 : 0);
    this._pluck(midi, when, 0.16, "triangle", 0.5);
    // 每小节起始加一个柔和低音
    if (posInBar < 0.9) {
      this._pluck(this.base + chord[0] - 12, when, 0.5, "sine", 0.28);
    }
  }
  _pluck(midi, when, dur, type, gain) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.value = noteFreq(midi);
    f.type = "lowpass";
    f.frequency.value = 2400;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(f); f.connect(g); g.connect(this.master);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }
  spectrum(out) {
    if (!this.ctx || !this.analyser || !this.playing) return false;
    return readBands(this.analyser, this._freq, out);
  }
  destroy() { this.stop(); }
}

// ---------------- 统一播放器 ----------------
export class Player {
  constructor() {
    this.onTime = null;   // (seconds) =>
    this.onEnded = null;
    this.onModeChange = null;
    this.mode = "list";   // list | one | shuffle
    this.volume = 0.8;
    this.engine = null;
    this.kind = null;     // 'real' | 'synth'
    this._throttle = 0;
  }
  _mkReal() { return new RealEngine((t) => this._tick(t), () => this._ended()); }
  _mkSynth() { return new SynthEngine((t) => this._tick(t), () => this._ended()); }
  _tick(t) {
    const now = performance.now();
    if (now - this._throttle < 100) return;
    this._throttle = now;
    if (this.onTime) this.onTime(t);
  }
  _ended() { if (this.onEnded) this.onEnded(); }

  // track: { id, title, dur, src? }  src 存在则用真实音频，否则合成
  load(track) {
    this.unload();
    if (track.src) {
      this.engine = this._mkReal();
      this.engine.load(track.src, track.dur);
      this.engine.setVolume(this.volume);
      this.kind = "real";
    } else {
      this.engine = this._mkSynth();
      this.engine.load(track);
      this.engine.setVolume(this.volume);
      this.kind = "synth";
    }
  }
  play(fromSec) {
    if (!this.engine) return;
    this.engine.play(fromSec || this.engine.currentTime() || 0);
  }
  pause() { if (this.engine) this.engine.pause(); }
  toggle() {
    if (!this.engine) return;
    if (this.isPlaying()) this.pause(); else this.play();
  }
  isPlaying() {
    if (!this.engine) return false;
    if (this.kind === "synth") return this.engine.playing;
    return !this.engine.audio.paused;
  }
  seek(t) { if (this.engine) this.engine.seek(t); }
  setVolume(v) {
    this.volume = v;
    if (this.engine) this.engine.setVolume(v);
  }
  currentTime() { return this.engine ? this.engine.currentTime() : 0; }
  duration() { return this.engine ? this.engine.duration() : 0; }
  // 读取一帧频谱：把 out.length 根条（0..1）写进 out。
  // 返回 false = 这次没有实时信号（暂停中/引擎不支持/解码失败），
  // 此时 out 原样不动，交给调用方自己衰减，别把画面清成一片空白。
  spectrum(out) {
    if (!this.engine || typeof this.engine.spectrum !== "function") return false;
    if (!this.isPlaying()) return false;
    return !!this.engine.spectrum(out);
  }
  // 只返回真实音频文件的时长；元数据未就绪时返回 0，绝不回退到估算值
  realDuration() {
    if (this.kind !== "real" || !this.engine || !this.engine.audio) return 0;
    const d = this.engine.audio.duration;
    return (typeof d === "number" && isFinite(d) && d > 0) ? d : 0;
  }
  stop() { if (this.engine) this.engine.stop(); }
  unload() {
    if (this.engine) { this.engine.destroy(); }
    this.engine = null; this.kind = null;
  }
  cycleMode() {
    this.mode = this.mode === "list" ? "one" : this.mode === "one" ? "shuffle" : "list";
    if (this.onModeChange) this.onModeChange(this.mode);
  }
}

export const MODE_LABEL = { list: "顺序播放", one: "单曲循环", shuffle: "随机播放" };
