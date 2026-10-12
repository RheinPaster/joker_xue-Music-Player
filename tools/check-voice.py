#!/usr/bin/env python3
"""判断一首歌里的人声是男声还是女声。

流程：Demucs 分离人声 -> 对纯人声轨做 YIN 基频估计 -> 取浊音帧中位数。
必须先用已知歌手的录音做自检，自检不过就不给结论。

用法:
    python tools/check-voice.py --selftest                # 只跑参照集
    python tools/check-voice.py a.mp3 b.mp3 [--keep]      # 判定指定文件
"""
import sys, os, glob, shutil, subprocess, tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np

SR = 16000
FRAME = 1024
HOP = 256
F0_MIN, F0_MAX = 70.0, 400.0
# 自检用的已知歌手参照（薛之谦男声）
REFS = ["music/演员.mp3", "music/认真的雪.mp3"]


# ---------------- 人声分离 ----------------
def separate_vocals(path, outdir):
    """用 demucs 抽出人声轨，返回 wav 路径（失败返回 None）。"""
    cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals",
           "-n", "htdemucs", "-o", outdir, path]
    try:
        # 注意：不能用 text=True —— 子进程输出含非 GBK 字节，会按本地编码解码失败。
        p = subprocess.run(cmd, capture_output=True, timeout=1800)
    except Exception as e:
        print("    demucs 调用失败: %s" % e)
        return None
    if p.returncode != 0:
        print("    demucs 退出码 %s" % p.returncode)
        tail = (p.stderr or b"")[-400:].decode("utf-8", "replace")
        if tail.strip():
            print("    " + tail.replace("\n", "\n    "))
        return None
    stem = os.path.splitext(os.path.basename(path))[0]
    hits = glob.glob(os.path.join(outdir, "**", stem, "vocals.*"), recursive=True)
    if not hits:
        hits = glob.glob(os.path.join(outdir, "**", "vocals.*"), recursive=True)
    return hits[0] if hits else None


def load_mono(path):
    try:
        import soundfile as sf
        a, sr = sf.read(path, dtype="float32", always_2d=True)
        a = a.mean(axis=1)
    except Exception:
        from faster_whisper.audio import decode_audio
        a = np.asarray(decode_audio(path, sampling_rate=SR), dtype=np.float32)
        sr = SR
    if sr != SR:
        n = int(len(a) * SR / sr)
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
    return a


# ---------------- YIN ----------------
def yin_f0(a):
    """YIN 法逐帧基频。返回浊音帧的 F0 数组。"""
    if len(a) < FRAME * 2:
        return np.array([])
    tau_min = int(SR / F0_MAX)
    tau_max = int(SR / F0_MIN)
    W = FRAME + tau_max
    n = 1 + (len(a) - W) // HOP
    if n < 5:
        return np.array([])
    idx = np.arange(W)[None, :] + HOP * np.arange(n)[:, None]
    fr = a[idx].astype(np.float64)
    fr = fr - fr.mean(axis=1, keepdims=True)
    energy = np.sqrt((fr ** 2).mean(axis=1))

    # 差函数 d(tau)
    d = np.empty((n, tau_max + 1))
    for tau in range(tau_max + 1):
        diff = fr[:, :FRAME] - fr[:, tau:tau + FRAME]
        d[:, tau] = (diff ** 2).sum(axis=1)
    # 累积均值归一化
    cmnd = np.ones_like(d)
    run = np.cumsum(d[:, 1:], axis=1)
    run[run == 0] = 1e-12
    cmnd[:, 1:] = d[:, 1:] * np.arange(1, tau_max + 1)[None, :] / run

    f0 = np.full(n, np.nan)
    for i in range(n):
        row = cmnd[i]
        # 先取全局最小值所在的周期。直接取"第一个低于阈值的谷"会咬到二次谐波，
        # 导致基频成倍偏高（实测男声参照被读成 ~232 Hz，正好是真实值的 2 倍）。
        cand = tau_min + int(np.argmin(row[tau_min:tau_max + 1]))
        # 八度校正：若 2×/3× 周期处同样低（甚至更低），真实周期就是那个更长的
        for mult in (2, 3):
            t2 = cand * mult
            if t2 <= tau_max and row[t2] < row[cand] * 1.15:
                cand = t2
                break
        if row[cand] < 0.45:
            f0[i] = SR / cand
    ok = ~np.isnan(f0) & (energy > np.percentile(energy, 55))
    return f0[ok]


def verdict_of(med):
    if med < 155:
        return "男声"
    if med > 185:
        return "女声"
    return "临界"


def analyse(path, outdir):
    name = os.path.basename(path)
    v = separate_vocals(path, outdir)
    if not v:
        print("  %-26s 人声分离失败，跳过" % name)
        return None
    a = load_mono(v)
    f0 = yin_f0(a)
    if len(f0) < 30:
        print("  %-26s 浊音帧不足(%d)，无法判断" % (name, len(f0)))
        return None
    med = float(np.median(f0))
    p25, p75 = float(np.percentile(f0, 25)), float(np.percentile(f0, 75))
    lo = float(((f0 >= 70) & (f0 < 165)).mean())
    print("  %-26s 浊音帧%5d  中位 F0=%6.1f Hz  [%4.0f-%4.0f]  低音区%3.0f%%  -> %s"
          % (name, len(f0), med, p25, p75, lo * 100, verdict_of(med)))
    return med


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    selftest = "--selftest" in sys.argv or not args
    outdir = tempfile.mkdtemp(prefix="voxsep_")
    try:
        if selftest:
            print("=== 自检：这两首确定是薛之谦本人演唱，应判为男声 ===")
            ok = True
            for r in REFS:
                if not os.path.exists(r):
                    print("  %-26s 参照文件不存在" % r)
                    continue
                m = analyse(r, outdir)
                if m is None or m >= 155:
                    ok = False
            print("  自检结果: %s" % ("通过 —— 方法可信" if ok else "**未通过 —— 方法不可信，不给结论**"))
            if not args:
                sys.exit(0 if ok else 2)
            if not ok:
                print("\n自检未通过，不对下面的文件下结论。")
                sys.exit(2)
        print("\n=== 判定 ===")
        for p in args:
            if not os.path.exists(p):
                print("  %-26s 文件不存在" % os.path.basename(p))
                continue
            analyse(p, outdir)
    finally:
        if "--keep" not in sys.argv:
            shutil.rmtree(outdir, ignore_errors=True)
