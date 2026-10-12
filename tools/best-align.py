#!/usr/bin/env python
"""对每首歌跑两种配方，保留匹配率更高的结果。

配方 A：带 Demucs 人声分离（适合伴奏很响、人声被埋的歌）
配方 B：跳过人声分离（适合老录音——分离残留反而干扰识别）

实测结论：最优配方因歌而异，不存在万能解，所以逐首取较优者。

用法:
  python tools/best-align.py                # 全部歌曲，跳过已足够好的
  python tools/best-align.py --only 刚刚好    # 指定歌名
  python tools/best-align.py --threshold 0.8 # 只处理匹配率低于此值的（默认 0.8）
  python tools/best-align.py --force         # 连已经很好的也重跑
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MUSIC, LYRICS = os.path.join(ROOT, "music"), os.path.join(ROOT, "lyrics")
ALIGN = os.path.join(ROOT, "tools", "align-lyrics.py")
TMP = os.path.join(ROOT, "_bestalign")
WORD_TAG = re.compile(r"<\d{1,2}:\d{1,2}")


def norm(s):
    return re.sub(r"[\s\-_·•.'\"()（）【】\[\]!！?？,，、:：/\\]", "", str(s)).lower()


def ratio_of(rep_path):
    try:
        with open(rep_path, encoding="utf-8") as f:
            j = json.load(f)
        return (j.get("mean_match_ratio") or 0), j.get("lines_anchored") or 0, j.get("lines_total") or 0
    except Exception:
        return None, 0, 0


def main():
    args = sys.argv[1:]
    threshold = 0.8
    force = "--force" in args
    only = None
    if "--threshold" in args:
        threshold = float(args[args.index("--threshold") + 1])
    if "--only" in args:
        only = args[args.index("--only") + 1]

    mp3s = sorted(glob.glob(os.path.join(MUSIC, "*.mp3")))
    lrc_map = {norm(os.path.basename(p)[:-4]): p for p in glob.glob(os.path.join(LYRICS, "*.lrc"))
               if not p.endswith(".aligned.lrc")}

    todo = []
    for mp3 in mp3s:
        base = os.path.basename(mp3)[:-4]
        if only and only not in base:
            continue
        lrc = lrc_map.get(norm(base))
        if not lrc:
            for n, p in lrc_map.items():
                if len(n) >= 2 and (n in norm(base) or norm(base) in n):
                    lrc = p
                    break
        if not lrc:
            continue
        rep = lrc + ".aligned.lrc.report.json"
        cur, anchored, _ = ratio_of(rep)
        if not force and cur is not None and cur >= threshold:
            continue
        todo.append((base, mp3, lrc, cur))

    print(f"待优化 {len(todo)} 首（当前匹配率低于 {threshold}）", flush=True)
    os.makedirs(TMP, exist_ok=True)
    improved = kept = failed = 0
    t_all = time.time()

    for i, (base, mp3, lrc, cur) in enumerate(todo, 1):
        print(f"\n[{i}/{len(todo)}] {base}（当前 {cur if cur is not None else '?'}）", flush=True)
        results = []
        for label, extra in (("跳过分离", ["--no-vocals"]), ("带分离", [])):
            out = os.path.join(TMP, base + ("_novocal" if extra else "_vocal") + ".lrc")
            t0 = time.time()
            r = subprocess.run([sys.executable, ALIGN, "--audio", mp3, "--lrc", lrc,
                                "--out", out] + extra,
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            ratio, anchored, total = ratio_of(out + ".report.json")
            dt = time.time() - t0
            if r.returncode == 0 and ratio is not None:
                print(f"    {label}: 匹配率 {ratio:<6} 锚定 {anchored}/{total}  {dt:.0f}s", flush=True)
                results.append((ratio, anchored, total, out))
            else:
                print(f"    {label}: 失败（{dt:.0f}s）", flush=True)
        if not results:
            failed += 1
            continue
        results.sort(key=lambda x: -x[0])
        best = results[0]
        if cur is not None and best[0] <= cur + 0.02:
            print(f"    两种配方都没能超过当前值（{cur}），保留原样", flush=True)
            kept += 1
            continue
        shutil.copy2(best[3], lrc)
        bak = lrc + ".bak"
        if not os.path.exists(bak):
            pass
        print(f"    → 已采用匹配率 {best[0]} 的版本（原 {cur}）", flush=True)
        improved += 1

    print(f"\n===== 完成：提升 {improved}，保持 {kept}，失败 {failed}，"
          f"耗时 {(time.time()-t_all)/60:.1f} 分钟 =====", flush=True)


if __name__ == "__main__":
    main()
