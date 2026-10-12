#!/usr/bin/env python
"""把 lyrics/ 里繁体歌词转成简体（用 zhconv，只在内容真的变化时才写回）。

用法:
  python scripts/fix-lyrics-zh.py          # 预演：只报告哪些文件是繁体
  python scripts/fix-lyrics-zh.py --apply  # 实际转换（原文件备份为 .zht.bak）

注意：只处理歌词文本，不打印歌词内容。
"""
import glob
import os
import sys

try:
    from zhconv import convert
except ImportError:
    sys.exit("请先安装：python -m pip install zhconv")

ROOT = os.path.join(os.path.dirname(__file__), "..")
LYRICS = os.path.join(ROOT, "lyrics")
APPLY = "--apply" in sys.argv

# 元数据标签行（[ti:] [ar:] 等）也一并转换，但要保留时间轴
def convert_text(text: str) -> str:
    return convert(text, "zh-cn")

files = sorted(glob.glob(os.path.join(LYRICS, "*.lrc")))
print(f"歌词文件 {len(files)} 个")
changed = []
for p in files:
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()
    dst = convert_text(src)
    if dst != src:
        changed.append(p)

print(f"检测到繁体（转换后内容有变化）：{len(changed)} 个")
for p in changed:
    print("  " + os.path.basename(p))

if not APPLY:
    print("\n（预演模式，未改动。加 --apply 才会转换）")
    sys.exit(0)

done = 0
for p in changed:
    bak = p + ".zht.bak"
    if not os.path.exists(bak):
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            orig = f.read()
        with open(bak, "w", encoding="utf-8") as f:
            f.write(orig)
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()
    with open(p, "w", encoding="utf-8") as f:
        f.write(convert_text(src))
    done += 1

print(f"\n已转换 {done} 个（原文件备份为 *.zht.bak）")
