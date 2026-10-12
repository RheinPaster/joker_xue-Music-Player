#!/usr/bin/env python
"""诊断：为什么这些歌对齐不上？

对指定歌曲运行 Whisper（不分离人声），然后：
  1. 报告识别的语言、字符数（判断是不是伴奏无人声）
  2. 把识别结果与**全部**歌词文件交叉比对，找出最相似的
     —— 如果最相似的是另一首歌，说明音频文件标错了名
  3. 只输出统计数字，不输出歌词内容
"""
import glob
import os
import sys
from difflib import SequenceMatcher

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
MUSIC, LYRICS = os.path.join(ROOT, "music"), os.path.join(ROOT, "lyrics")
MODEL = os.path.join(ROOT, "models", "faster-whisper-large-v3")

SUNG = __import__("re").compile(r"[\u3400-\u9fffA-Za-z0-9]")


def read_lrc_chars(path):
    """取歌词里的可唱字符（去掉时间轴标签）"""
    import re
    out = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = re.sub(r"[\[<]\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?[\]>]", "", line)
            out += [c for c in line if SUNG.match(c)]
    return "".join(out)


def main():
    names = sys.argv[1:] or ["你过得好吗", "刚刚好", "初学者", "流星的眼泪", "被人", "钗头凤"]
    # 复用 align-lyrics.py 里的 CUDA 运行库路径设置（ctranslate2 需要
    # cuBLAS/cuDNN 的 DLL，单靠 PATH 无效，必须 os.add_dll_directory）
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "alignlyrics", os.path.join(ROOT, "tools", "align-lyrics.py"))
    al = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(al)
    dirs = al.setup_cuda_dlls()
    print(f"CUDA 运行库目录 {len(dirs)} 个已加入", flush=True)

    from faster_whisper import WhisperModel

    print("加载模型…", flush=True)
    model = WhisperModel(MODEL, device="cuda", compute_type="float16")

    # 预读全部歌词
    lib = {}
    for p in glob.glob(os.path.join(LYRICS, "*.lrc")):
        if p.endswith(".aligned.lrc"):
            continue
        lib[os.path.basename(p)[:-4]] = read_lrc_chars(p)

    for n in names:
        mp3 = os.path.join(MUSIC, n + ".mp3")
        if not os.path.exists(mp3):
            print(f"\n{n}: 缺音频")
            continue
        print(f"\n=== {n} ===", flush=True)
        segs, info = model.transcribe(mp3, language="zh", word_timestamps=False, vad_filter=False)
        text = []
        for s in segs:
            text.append(s.text)
        asr = "".join(c for c in "".join(text) if SUNG.match(c))
        print(f"  识别语言 {info.language}({info.language_probability:.2f})  识别字符数 {len(asr)}")

        own = lib.get(n, "")
        if own:
            r = SequenceMatcher(None, own[:400], asr[:400], autojunk=False).ratio()
            print(f"  与本歌歌词相似度 {r:.3f}（歌词字符 {len(own)}）")
        # 与全部歌词交叉比对，找最像的
        best = (None, 0.0)
        for title, chars in lib.items():
            if not chars or not asr:
                continue
            r = SequenceMatcher(None, chars[:400], asr[:400], autojunk=False).ratio()
            if r > best[1]:
                best = (title, r)
        if best[0]:
            flag = "  ← 疑似文件名标错！" if best[0] != n and best[1] > 0.3 else ""
            print(f"  最相似的歌词是《{best[0]}》 相似度 {best[1]:.3f}{flag}")
        else:
            print("  没有可比的歌词")


if __name__ == "__main__":
    main()
