#!/usr/bin/env python
"""批量逐字对齐：把 lyrics/ 里所有「整行」LRC 升级为「逐字」LRC。

- 只处理 music/ 里能找到对应音频、且歌词还没逐字标签的歌
- 已对齐的自动跳过 → 可随时中断、重跑续传
- 每首成功后打印匹配率；结果写入 lyrics/<歌名>.lrc（原文件备份为 .bak）

用法:
  python tools/align-all.py              # 处理全部待对齐的
  python tools/align-all.py --limit 5    # 只处理 5 首（试探用）
  python tools/align-all.py --only 演员  # 只处理指定歌名
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MUSIC = os.path.join(ROOT, "music")
LYRICS = os.path.join(ROOT, "lyrics")
ALIGN = os.path.join(ROOT, "tools", "align-lyrics.py")

# Windows 控制台/重定向默认可能是 GBK，打印 ✓ 之类的字符会直接抛
# UnicodeEncodeError 让整个批处理崩掉。这里强制 UTF-8，不依赖环境变量。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

WORD_TAG = re.compile(r"<\d{1,2}:\d{1,2}")


def norm(s: str) -> str:
    return re.sub(r"[\s\-_·•.'\"()（）【】\[\]!！?？,，、:：/\\]", "", str(s)).lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default=None)
    ap.add_argument("--model", default=None)
    args = ap.parse_args()

    lrc_files = sorted(glob.glob(os.path.join(LYRICS, "*.lrc")))
    mp3_files = sorted(glob.glob(os.path.join(MUSIC, "*.mp3")))
    lrc_norm = {norm(os.path.basename(p)[:-4]): p for p in lrc_files}

    def find_lrc(base):
        nb = norm(base)
        if nb in lrc_norm:
            return lrc_norm[nb]
        best = None
        for n, p in lrc_norm.items():
            if len(n) >= 2 and (n in nb or nb in n):
                best = best or p
        return best

    todo = []
    for mp3 in mp3_files:
        base = os.path.basename(mp3)[:-4]
        lrc = find_lrc(base)
        if not lrc:
            continue
        with open(lrc, "r", encoding="utf-8", errors="replace") as f:
            if WORD_TAG.search(f.read()):
                continue          # 已经是逐字版
        todo.append((base, mp3, lrc))

    if args.only:
        todo = [x for x in todo if args.only in x[0]]
    if args.limit:
        todo = todo[: args.limit]

    print(f"音频 {len(mp3_files)} 个，歌词 {len(lrc_files)} 个，待对齐 {len(todo)} 首", flush=True)
    if not todo:
        print("没有需要对齐的曲目 ✓")
        return

    t_all = time.time()
    ok = fail = 0
    stats = []
    for i, (base, mp3, lrc) in enumerate(todo, 1):
        print(f"\n[{i}/{len(todo)}] {base}", flush=True)
        cmd = [sys.executable, ALIGN, "--audio", mp3, "--lrc", lrc, "--replace"]
        if args.model:
            cmd += ["--model", args.model]
        t0 = time.time()
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        dt = time.time() - t0
        if r.returncode != 0:
            print(f"    ✗ 失败（{dt:.0f}s）", flush=True)
            for line in (r.stderr or "").strip().splitlines()[-3:]:
                print("      " + line[:150], flush=True)
            fail += 1
            continue
        rep_path = lrc + ".aligned.lrc.report.json"
        ratio = None
        if os.path.exists(rep_path):
            try:
                with open(rep_path, encoding="utf-8") as f:
                    rep = json.load(f)
                ratio = rep.get("mean_match_ratio")
                stats.append((base, ratio, rep.get("lines_anchored"), rep.get("lines_total")))
            except Exception:
                pass
        mark = "✓" if (ratio is None or ratio >= 0.5) else "⚠"
        print(f"    {mark} 对齐完成 {dt:.0f}s  匹配率 {ratio if ratio is not None else '?'}", flush=True)
        ok += 1

    print(f"\n===== 批量完成 =====\n成功 {ok}，失败 {fail}，总耗时 {(time.time()-t_all)/60:.1f} 分钟")
    if stats:
        low = [s for s in stats if s[1] is not None and s[1] < 0.5]
        print(f"平均匹配率 {sum(s[1] for s in stats)/len(stats):.3f}")
        if low:
            print(f"匹配率偏低（<0.5）的 {len(low)} 首，建议人工核对：")
            for b, r, a, t in low:
                print(f"  {b}  匹配率 {r:.2f}  行 {a}/{t}")


if __name__ == "__main__":
    main()
