#!/usr/bin/env python
"""逐字歌词强制对齐：把「整行时间轴」的 LRC 升级为「每字带时间戳」的增强型 LRC。

流程：
  ① （可选）Demucs 分离人声 —— 去掉伴奏干扰，显著提升识别质量
  ② faster-whisper 识别，取得每个字/词的粗略时间点
  ③ 用「已知歌词文字」与识别结果做字符序列对齐（序列匹配）
     —— 识别错的字不会带偏整体：匹配上的字用真实时间，没匹配上的字在前后锚点间插值
  ④ 输出增强型 LRC： [00:12.34]<00:12.34>字<00:12.90>字...

用法：
  python tools/align-lyrics.py --audio "music/演员.mp3" --lrc "music/演员.lrc"
  python tools/align-lyrics.py --audio ... --lrc ... --model large-v3 --no-vocals --replace

默认**不覆盖**原 LRC，写为 <原名>.aligned.lrc；加 --replace 才会覆盖（会先备份为 .bak）。
会同时输出 <out>.report.json，内含每行匹配率等统计，便于判断对齐质量。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from difflib import SequenceMatcher

# ---------------------------------------------------------------- 工具函数

LRC_LINE = re.compile(r"\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
# 参与对齐的字符：中日韩汉字、字母数字；标点/空格不唱，排除掉
SUNG = re.compile(r"[\u3400-\u9fff\u3040-\u30ffA-Za-z0-9]")


def ts_to_sec(m):
    frac = 0.0
    if m.group(3):
        frac = int(m.group(3)) / (10 ** len(m.group(3)))
    return int(m.group(1)) * 60 + int(m.group(2)) + frac


def sec_to_ts(s):
    """整行时间标签：方括号 [mm:ss.xx]"""
    if s < 0:
        s = 0.0
    m = int(s // 60)
    rest = s - m * 60
    return f"[{m:02d}:{rest:05.2f}]"


def sec_to_word_ts(s):
    """逐字时间标签：尖括号 <mm:ss.xx>
    注意必须用尖括号 —— 方括号会被播放器当成新的"行时间"，
    导致一行被拆成几十行。"""
    if s < 0:
        s = 0.0
    m = int(s // 60)
    rest = s - m * 60
    return f"<{m:02d}:{rest:05.2f}>"


def parse_lrc(path):
    """解析整行 LRC -> [(time, text), ...]（保留原文，含标点）"""
    lines = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()
    for line in raw.splitlines():
        ms = list(LRC_LINE.finditer(line))
        if not ms:
            continue
        body = LRC_LINE.sub("", line)
        # 去掉可能残留的逐字标签，避免重复对齐
        body = re.sub(r"<\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?>", "", body).strip()
        if not body:
            continue
        for m in ms:
            lines.append((ts_to_sec(m), body))
    lines.sort(key=lambda x: x[0])
    return lines


def load_audio_mono16k(path):
    """读音频为 16kHz 单声道 float32 numpy（用 soundfile，免 ffmpeg）"""
    import numpy as np
    import soundfile as sf
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != 16000:
        import torch
        import torchaudio.functional as AF
        t = torch.from_numpy(mono).unsqueeze(0)
        t = AF.resample(t, sr, 16000)
        mono = t.squeeze(0).numpy()
    return mono


def setup_cuda_dlls():
    """CTranslate2 需要 CUDA 12 的 cuBLAS / cuDNN DLL。
    若通过 pip 装了 nvidia-cublas-cu12 / nvidia-cudnn-cu12，把它们的目录加入 DLL 搜索路径。"""
    import glob
    import site
    import sysconfig
    roots = []
    # 不同发行版 site.getsitepackages() 返回的可能是前缀而不是 Lib/site-packages，
    # 所以把常见的几个位置都试一遍。
    cands = []
    try:
        cands += list(site.getsitepackages())
    except Exception:
        pass
    try:
        cands.append(site.getusersitepackages())
    except Exception:
        pass
    try:
        cands.append(sysconfig.get_paths().get("purelib"))
    except Exception:
        pass
    for c in cands:
        if not c:
            continue
        roots.append(c)
        roots.append(os.path.join(c, "Lib", "site-packages"))
    roots = [r for r in dict.fromkeys(roots) if r and os.path.isdir(r)]

    added = []
    for root in roots:
        for pat in ("nvidia/*/bin", "nvidia/*/lib", "nvidia/*/lib/x64"):
            for d in glob.glob(os.path.join(root, pat)):
                if os.path.isdir(d) and d not in added:
                    added.append(d)
                    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                    try:
                        os.add_dll_directory(d)
                    except Exception:
                        pass
    return added


def separate_vocals(audio_path, workdir):
    """用 demucs 命令行分离人声，返回 vocals 文件路径（失败返回 None）"""
    out = os.path.join(workdir, "demucs_out")
    cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals", "-o", out,
           "-n", "htdemucs", audio_path]
    print("[1/3] 分离人声（Demucs）…", flush=True)
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("      Demucs 失败，改用原始音频：")
        for line in (r.stderr or "").strip().splitlines()[-3:]:
            print("      " + line[:160])
        return None
    base = os.path.splitext(os.path.basename(audio_path))[0]
    cand = os.path.join(out, "htdemucs", base, "vocals.wav")
    print(f"      完成，用时 {time.time() - t0:.1f}s")
    return cand if os.path.exists(cand) else None


def transcribe_words(audio_input, model_path, device, compute_type):
    """faster-whisper 识别，返回 (words, full_text)
    words: [{"start":float,"end":float,"word":str}, ...]"""
    from faster_whisper import WhisperModel
    print(f"[2/3] Whisper 识别（{model_path} / {device} / {compute_type}）…", flush=True)
    t0 = time.time()
    model = WhisperModel(model_path, device=device, compute_type=compute_type)
    segments, info = model.transcribe(
        audio_input, language="zh", word_timestamps=True, vad_filter=False
    )
    words = []
    text_parts = []
    for seg in segments:
        text_parts.append(seg.text)
        for w in (seg.words or []):
            words.append({"start": float(w.start), "end": float(w.end), "word": w.word})
    print(f"      完成，用时 {time.time() - t0:.1f}s；"
          f"识别到 {len(words)} 个词、{sum(len(x['word']) for x in words)} 个字符")
    return words, "".join(text_parts)


def build_asr_chars(words):
    """把识别结果摊平成字符流：[(char, start, end), ...]"""
    chars = []
    for w in words:
        piece = [c for c in w["word"] if SUNG.match(c)]
        if not piece:
            continue
        # 一个"词"含多字时，按字平均分配其时间区间
        span = max(0.0, w["end"] - w["start"])
        step = span / len(piece)
        for i, c in enumerate(piece):
            chars.append((c, w["start"] + i * step, w["start"] + (i + 1) * step))
    return chars


# ---------------------------------------------------------------- 核心对齐

def align_line(known_text, line_t, next_t, asr_chars, search_pad=3.0):
    """把一行歌词的每个字对齐到 ASR 字符流。

    返回: (char_times, matched_ratio)
      char_times: 与 known_text 中"可唱字符"一一对应的时间列表
      matched_ratio: 匹配上的比例（低说明该行对齐不可信）
    """
    sung = [(i, c) for i, c in enumerate(known_text) if SUNG.match(c)]
    if not sung:
        return [], 0.0

    t0 = max(0.0, line_t - search_pad)
    t1 = (next_t + search_pad) if next_t else (line_t + 60.0)
    window = [a for a in asr_chars if t0 <= a[1] <= t1]

    if not window:
        return None, 0.0  # 该行完全没有识别覆盖 -> 交给插值

    kseq = [c for _, c in sung]
    aseq = [a[0] for a in window]
    sm = SequenceMatcher(None, kseq, aseq, autojunk=False)

    times = [None] * len(kseq)
    matched = 0
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            ki = blk.a + k
            ai = blk.b + k
            times[ki] = window[ai][1]
            matched += 1

    ratio = matched / max(1, len(kseq))
    if ratio < 0.25:
        return None, ratio  # 匹配太少，不可信 -> 插值兜底

    # 未匹配到的字：用前后已知锚点线性插值
    known_idx = [i for i, t in enumerate(times) if t is not None]
    if not known_idx:
        return None, ratio
    for i in range(len(times)):
        if times[i] is not None:
            continue
        prev = [j for j in known_idx if j < i]
        nxt = [j for j in known_idx if j > i]
        if prev and nxt:
            a, b = prev[-1], nxt[0]
            frac = (i - a) / (b - a)
            times[i] = times[a] + (times[b] - times[a]) * frac
        elif prev:
            times[i] = times[prev[-1]] + 0.25
        elif nxt:
            times[i] = max(0.0, times[nxt[0]] - 0.25 * (nxt[0] - i))
    # 单调化，避免倒流
    last = -1.0
    for i in range(len(times)):
        if times[i] < last:
            times[i] = last
        last = times[i]
    # 行首锚定到 LRC 的整行时间（LRC 行时间通常比 ASR 更可信）
    if times[0] > line_t + 1.0:
        shift = times[0] - line_t
        times = [t - shift for t in times]
    return times, ratio


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(description="逐字歌词强制对齐（生成增强型 LRC）")
    ap.add_argument("--audio", required=True, help="音频文件")
    ap.add_argument("--lrc", required=True, help="已有的整行 LRC")
    ap.add_argument("--out", default=None, help="输出路径（默认 <lrc>.aligned.lrc）")
    ap.add_argument("--model", default=None,
                    help="模型：本地目录（推荐，如 models/faster-whisper-large-v3）或 large-v3 等名称")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--compute-type", default=None, help="如 float16 / int8_float16 / int8")
    ap.add_argument("--no-vocals", action="store_true", help="跳过人声分离（更快、精度略低）")
    ap.add_argument("--replace", action="store_true", help="覆盖原 LRC（先备份 .bak）")
    args = ap.parse_args()

    # 模型：优先用本地已下载的目录，避免联网
    if args.model:
        model_path = args.model
    else:
        local = os.path.join("models", "faster-whisper-large-v3")
        model_path = local if os.path.isdir(local) else "large-v3"
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    print("模型: " + model_path)

    if not os.path.exists(args.audio):
        sys.exit("找不到音频：" + args.audio)
    if not os.path.exists(args.lrc):
        sys.exit("找不到 LRC：" + args.lrc)

    lines = parse_lrc(args.lrc)
    if not lines:
        sys.exit("LRC 里没有解析到任何带时间的歌词行")

    # 设备
    import torch
    dll_dirs = setup_cuda_dlls()
    if dll_dirs:
        print(f"CUDA 运行库目录: {len(dll_dirs)} 个已加入搜索路径")
    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = args.compute_type or ("float16" if device == "cuda" else "int8")
    if device == "cuda":
        print("GPU: " + torch.cuda.get_device_name(0))

    with tempfile.TemporaryDirectory(prefix="jxalign_") as workdir:
        # ① 人声分离
        vocal_path = None
        if not args.no_vocals:
            vocal_path = separate_vocals(args.audio, workdir)
        audio_input = vocal_path or args.audio
        if not vocal_path:
            print("[1/3] 跳过人声分离，直接用原始音频")

        # ② 识别
        words, _ = transcribe_words(audio_input, model_path, device, compute_type)
        asr_chars = build_asr_chars(words)
        if not asr_chars:
            sys.exit("识别结果为空，无法对齐（可尝试 --model medium 或去掉 --no-vocals）")

        # ③ 逐行对齐
        print(f"[3/3] 字符级对齐（{len(lines)} 行）…", flush=True)
        out_lines = []
        stats = {"lines": 0, "anchored_lines": 0, "fallback_lines": 0,
                 "chars": 0, "anchored_chars": 0, "ratios": []}
        for i, (t, text) in enumerate(lines):
            next_t = lines[i + 1][0] if i + 1 < len(lines) else None
            times, ratio = align_line(text, t, next_t, asr_chars)
            sung_idx = [j for j, c in enumerate(text) if SUNG.match(c)]

            if times is None:
                # 兜底：整行按字数平均铺开（即原有插值行为），不倒退
                span = (next_t - t) if next_t else max(2.5, len(sung_idx) * 0.32)
                span = max(0.8, min(span, max(len(sung_idx) * 0.30, 1.2)))
                step = span / max(1, len(sung_idx))
                times = [t + i2 * step for i2 in range(len(sung_idx))]
                stats["fallback_lines"] += 1
            else:
                stats["anchored_lines"] += 1
                stats["ratios"].append(round(ratio, 3))

            stats["lines"] += 1
            stats["chars"] += len(sung_idx)
            if ratio > 0:
                stats["anchored_chars"] += int(len(sung_idx) * ratio)

            # 拼装增强型 LRC
            buf = [sec_to_ts(t)]
            k = 0
            for ch in text:
                if SUNG.match(ch):
                    buf.append(sec_to_word_ts(times[k]))
                    k += 1
                buf.append(ch)
            out_lines.append("".join(buf))

    out_path = args.out or (args.lrc + ".aligned.lrc")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")

    if args.replace:
        bak = args.lrc + ".bak"
        if not os.path.exists(bak):
            import shutil
            shutil.copy2(args.lrc, bak)
        import shutil
        shutil.copy2(out_path, args.lrc)

    rpt = {
        "audio": os.path.basename(args.audio),
        "lrc": os.path.basename(args.lrc),
        "out": os.path.basename(out_path),
        "model": os.path.basename(model_path),
        "device": device,
        "vocals_separated": bool(vocal_path),
        "lines_total": stats["lines"],
        "lines_anchored": stats["anchored_lines"],
        "lines_fallback": stats["fallback_lines"],
        "chars_total": stats["chars"],
        "chars_anchored_est": stats["anchored_chars"],
        "mean_match_ratio": round(sum(stats["ratios"]) / len(stats["ratios"]), 3) if stats["ratios"] else 0,
        "min_match_ratio": min(stats["ratios"]) if stats["ratios"] else 0,
    }
    with open(out_path + ".report.json", "w", encoding="utf-8") as f:
        json.dump(rpt, f, ensure_ascii=False, indent=2)

    print("\n完成 → " + out_path)
    print(json.dumps(rpt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
