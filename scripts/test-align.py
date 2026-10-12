#!/usr/bin/env python
"""对 align-line 的字符级对齐算法做单元测试（纯 stdlib，不需要 torch/whisper）。

用合成的 ASR 字符流（时间刻意不均匀）当作"真值"，验证：
  1. 正常情况：每个字都能对齐到接近真值的时间
  2. 识别有错字：错字不影响其它字的对齐
  3. 覆盖不足：退回插值兜底，而不是产出乱数据
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
from importlib import import_module  # noqa: E402

align = import_module("align-lyrics".replace("-", "_")) if False else None

# 模块名带横线，用 importlib 从文件加载
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "alignlyrics", os.path.join(os.path.dirname(__file__), "..", "tools", "align-lyrics.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

SUNG = mod.SUNG

# 自造占位文字（非任何歌曲歌词），每个字的真值时间刻意做成"很不均匀"
TEXT = "甲乙丙丁戊己庚辛壬癸"
TRUTH = [10.0, 10.4, 10.8, 13.5, 13.9, 14.3, 14.7, 19.0, 19.6, 20.2]  # 有长音也有快字
LINE_T = 10.0


def make_asr(chars, times, extra_before=(), extra_after=()):
    """构造 ASR 字符流 [(char, start, end), ...]"""
    stream = list(extra_before)
    for c, t in zip(chars, times):
        stream.append((c, t, t + 0.3))
    stream += list(extra_after)
    stream.sort(key=lambda x: x[1])
    return stream


def approx(a, b, tol=0.35):
    return abs(a - b) <= tol


print("=== 用例 1：完全正确识别 ===")
asr = make_asr(list(TEXT), TRUTH,
               extra_before=[("无", 9.0, 9.3), ("关", 9.5, 9.8)],
               extra_after=[("结", 21.0, 21.3)])
times, ratio = mod.align_line(TEXT, LINE_T, None, asr)
print(f"  匹配率 {ratio:.2f}")
ok = 0
for i, (c, t, truth) in enumerate(zip(TEXT, times, TRUTH)):
    hit = approx(t, truth)
    ok += hit
    print(f"    {c}  对齐={t:6.2f}  真值={truth:6.2f}  {'✓' if hit else '✗ 偏 ' + format(t - truth, '+.2f')}")
print(f"  → {ok}/{len(TRUTH)} 字命中（容差 0.35s）")
assert ok >= 8, "用例 1 失败：对齐精度不足"

print("\n=== 用例 2：识别错了 2 个字（模拟 ASR 误识）===")
bad = list(TEXT)
bad[3] = "错"
bad[7] = "误"
asr2 = make_asr(bad, TRUTH)
times2, ratio2 = mod.align_line(TEXT, LINE_T, None, asr2)
print(f"  匹配率 {ratio2:.2f}")
ok2 = 0
for i, (c, t, truth) in enumerate(zip(TEXT, times2, TRUTH)):
    hit = approx(t, truth, 0.9)
    ok2 += hit
    print(f"    {c}  对齐={t:6.2f}  真值={truth:6.2f}  {'✓' if hit else '✗'}")
print(f"  → {ok2}/{len(TRUTH)} 字容差内（0.9s）")
assert ok2 >= 7, "用例 2 失败：错字带偏了其它字"

print("\n=== 用例 3：该行完全没有识别覆盖（应退回插值）===")
times3, ratio3 = mod.align_line(TEXT, LINE_T, None, [("无", 1.0, 1.3), ("关", 2.0, 2.3)])
print(f"  返回 times={times3}  ratio={ratio3:.2f}  → {'正确返回 None（交给插值兜底）' if times3 is None else '⚠️ 不应返回数据'}")
assert times3 is None, "用例 3 失败：覆盖不足时不应产出对齐数据"

print("\n=== 用例 4：长音/快字混排，检查是否还原了非均匀节奏 ===")
gaps = [round(times[i + 1] - times[i], 2) for i in range(len(times) - 1)]
truth_gaps = [round(TRUTH[i + 1] - TRUTH[i], 2) for i in range(len(TRUTH) - 1)]
print("  对齐间隔: " + str(gaps))
print("  真值间隔: " + str(truth_gaps))
uniform = max(gaps) - min(gaps) < 0.5
print("  → " + ("⚠️ 间隔接近均匀，可能退化成平均分配" if uniform else "✅ 间隔明显不均匀，还原了真实节奏"))
assert not uniform, "用例 4 失败：未能还原非均匀节奏"

print("\n全部用例通过 ✅")
