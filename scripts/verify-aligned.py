"""对生成的增强型 LRC 做结构性验证（只输出统计数字，不输出歌词内容）。

对比基准：把同一行的字数在行时长内"平均分配"（即旧行为）。
如果逐字时间与平均分配差异很大，说明高亮确实跟随了真实演唱节奏。
"""
import re
import statistics
import sys

TAG = re.compile(r"<(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?>")
LINE = re.compile(r"^\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]")


def sec(m, base=0):
    frac = int(m.group(3)) / (10 ** len(m.group(3))) if m.group(3) else 0.0
    return int(m.group(1)) * 60 + int(m.group(2)) + frac


def analyze(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()
    lines = []
    for ln in raw.splitlines():
        lm = LINE.match(ln)
        if not lm:
            continue
        t = sec(lm)
        tags = [sec(m) for m in TAG.finditer(ln)]
        lines.append((t, tags))
    return lines


def report(path):
    lines = analyze(path)
    if not lines:
        print(f"\n{path}: 没有解析到增强型行")
        return
    total_chars = sum(len(t) for _, t in lines)
    print(f"\n=== {path} ===")
    print(f"行数 {len(lines)}，逐字标签 {total_chars} 个")

    # 单调性 & 间隔分布
    bad_mono = 0
    gaps = []
    diffs_vs_uniform = []
    cv_list = []
    for i, (t, tags) in enumerate(lines):
        for a, b in zip(tags, tags[1:]):
            if b < a - 1e-6:
                bad_mono += 1
            gaps.append(round(b - a, 3))
        if len(tags) < 2:
            continue
        next_t = lines[i + 1][0] if i + 1 < len(lines) else None
        if next_t and next_t > t:
            span = next_t - t
            step = span / len(tags)
            uniform = [t + k * step for k in range(len(tags))]
            diffs_vs_uniform += [abs(a - u) for a, u in zip(tags, uniform)]
        g = [b - a for a, b in zip(tags, tags[1:]) if b > a]
        if len(g) >= 3 and statistics.mean(g) > 0:
            cv_list.append(statistics.pstdev(g) / statistics.mean(g))

    print(f"时间戳倒流（应为 0）: {bad_mono}")
    if gaps:
        fast = sum(1 for g in gaps if g <= 0.45)
        held = sum(1 for g in gaps if g >= 1.0)
        print(f"字间距: 中位数 {statistics.median(gaps):.2f}s，"
              f"最短 {min(gaps):.2f}s，最长 {max(gaps):.2f}s")
        print(f"  ≤0.45s 的快字 {fast}/{len(gaps)} ({fast/len(gaps)*100:.0f}%)，"
              f"≥1.0s 的长音 {held}/{len(gaps)} ({held/len(gaps)*100:.0f}%)")
    if cv_list:
        print(f"行内节奏离散度(CV) 中位数 {statistics.median(cv_list):.2f}  "
              f"（若为平均分配则应≈0）")
    if diffs_vs_uniform:
        md = statistics.mean(diffs_vs_uniform)
        mx = max(diffs_vs_uniform)
        print(f"与「平均分配」的偏差: 平均 {md:.2f}s，最大 {mx:.2f}s")
        within = sum(1 for d in diffs_vs_uniform if d <= 0.2)
        print(f"  偏差 ≤0.2s 的字占比 {within/len(diffs_vs_uniform)*100:.0f}% "
              f"（越高说明越接近平均分配）")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)
