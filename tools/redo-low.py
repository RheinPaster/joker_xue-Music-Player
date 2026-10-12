#!/usr/bin/env python
"""对匹配率偏低/零锚定的歌，用「跳过人声分离」重跑。

打样已验证：Demucs 对这批老录音的分离结果会把 Whisper 带偏，
导致一行都锚定不上（匹配率 0）。跳过分离后匹配率可达 0.77~0.95。

用法:
  python tools/redo-low.py            # 处理内置清单
  python tools/redo-low.py --auto     # 自动扫描所有 report，重跑 ratio<0.5 的
"""
import glob
import json
import os
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

# 已知需要重跑的（21 首零锚定 + 5 首偏低 + 1 首原生崩溃未完成）
NAMES = [
    "丑八怪", "你过得好吗", "像风一样", "其实", "凤毛麟角", "初学者", "动物世界", "小孩",
    "怪咖", "慢半拍", "木偶人", "流星的眼泪", "湖泊", "火星人来过", "爱情宣判", "肆无忌惮",
    "被人", "解解闷", "钗头凤", "骆驼", "黄色枫叶",
    "刚刚好", "在那天回不去的路上", "最好", "王子归来", "租购",
    "我害怕",
]


def auto_list():
    out = []
    for rep in glob.glob(os.path.join(LYRICS, "*.lrc.aligned.lrc.report.json")):
        try:
            with open(rep, encoding="utf-8") as f:
                j = json.load(f)
        except Exception:
            continue
        if j.get("lines_anchored", 0) == 0 or (j.get("mean_match_ratio") or 0) < 0.5:
            out.append(os.path.basename(rep).replace(".lrc.aligned.lrc.report.json", ""))
    return out


def main():
    names = auto_list() if "--auto" in sys.argv else NAMES
    # --names "a,b,c" 指定歌单；--model 指定模型（默认用 align-lyrics.py 的本地 large-v3）
    model = None
    for i, a in enumerate(sys.argv):
        if a == "--names" and i + 1 < len(sys.argv):
            names = [x.strip() for x in sys.argv[i + 1].split(",") if x.strip()]
        if a == "--model" and i + 1 < len(sys.argv):
            model = sys.argv[i + 1]
    print(f"待重跑 {len(names)} 首（跳过人声分离）{'模型 ' + model if model else ''}", flush=True)
    ok = fail = 0
    t_all = time.time()
    rows = []
    for i, n in enumerate(names, 1):
        mp3, lrc = os.path.join(MUSIC, n + ".mp3"), os.path.join(LYRICS, n + ".lrc")
        if not (os.path.exists(mp3) and os.path.exists(lrc)):
            print(f"[{i}/{len(names)}] {n} —— 缺音频或歌词，跳过", flush=True)
            continue
        t0 = time.time()
        cmd = [sys.executable, ALIGN, "--audio", mp3, "--lrc", lrc,
               "--no-vocals", "--replace"]
        if model:
            cmd += ["--model", model]
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        dt = time.time() - t0
        rep = lrc + ".aligned.lrc.report.json"
        if r.returncode == 0 and os.path.exists(rep):
            with open(rep, encoding="utf-8") as f:
                j = json.load(f)
            ratio = j.get("mean_match_ratio") or 0
            print(f"[{i}/{len(names)}] {n:<20} 匹配率 {ratio:<6} "
                  f"锚定 {j.get('lines_anchored')}/{j.get('lines_total')}  {dt:.0f}s", flush=True)
            rows.append((n, ratio))
            ok += 1
        else:
            print(f"[{i}/{len(names)}] {n:<20} 失败 {dt:.0f}s", flush=True)
            for line in (r.stderr or "").strip().splitlines()[-2:]:
                print("      " + line[:140], flush=True)
            fail += 1

    print(f"\n===== 重跑完成：成功 {ok}，失败 {fail}，"
          f"总耗时 {(time.time()-t_all)/60:.1f} 分钟 =====", flush=True)
    if rows:
        good = [r for r in rows if r[1] >= 0.5]
        print(f"其中匹配率 >=0.5 的 {len(good)} 首，平均 {sum(r[1] for r in good)/max(1,len(good)):.3f}", flush=True)
        bad = [r for r in rows if r[1] < 0.5]
        if bad:
            print("仍然偏低的：" + " / ".join(f"{n}({r})" for n, r in bad), flush=True)


if __name__ == "__main__":
    main()
