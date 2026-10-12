#!/usr/bin/env python
"""直接从镜像站下载 faster-whisper 模型文件（绕开 huggingface_hub，支持断点续传）。

huggingface_hub 走镜像时会在内部端点卡住（Xet 后端 401 / 请求挂起），
这里改用最朴素的 HTTP 分块下载，已下载部分可续传，方便中断后重跑。

用法:
  python tools/download-model.py                 # large-v3
  python tools/download-model.py medium
  python tools/download-model.py large-v3 --mirror https://hf-mirror.com
"""

import argparse
import os
import sys
import time

import httpx

# faster-whisper (CTranslate2) 模型需要的文件
NEED = ["config.json", "model.bin", "preprocessor_config.json",
        "tokenizer.json", "vocabulary.json"]

MIRRORS = ["https://hf-mirror.com", "https://huggingface.co"]


def human(n):
    return f"{n/1024/1024:.1f} MB" if n >= 1024 * 1024 else f"{n/1024:.0f} KB"


def head_size(client, url):
    try:
        r = client.head(url, follow_redirects=True, timeout=30)
        if r.status_code == 200:
            return int(r.headers.get("content-length", 0))
    except Exception:
        pass
    return 0


def download(client, url, dest, label):
    have = os.path.getsize(dest) if os.path.exists(dest) else 0
    headers = {"User-Agent": "jx-align/1.0"}
    if have:
        headers["Range"] = f"bytes={have}-"

    with client.stream("GET", url, headers=headers, follow_redirects=True) as r:
        if r.status_code == 416:          # 已完整
            print(f"  {label}: 已完整（{human(have)}）")
            return True
        if r.status_code not in (200, 206):
            print(f"  {label}: HTTP {r.status_code} 失败")
            return False
        mode = "ab" if (have and r.status_code == 206) else "wb"
        if mode == "wb":
            have = 0
        total = have + int(r.headers.get("content-length", 0))
        t0 = time.time()
        last_report = 0
        with open(dest, mode) as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
                have += len(chunk)
                if have - last_report >= 100 * 1024 * 1024:
                    last_report = have
                    rate = have / max(0.001, time.time() - t0) / 1024
                    pct = f"{have/total*100:.0f}%" if total else "?"
                    print(f"  {label}: {human(have)}/{human(total)} ({pct})  {rate:.0f} KB/s", flush=True)
    if total and have < total:
        print(f"  {label}: 未完成 {human(have)}/{human(total)}（可重跑续传）")
        return False
    print(f"  {label}: 完成 {human(have)}", flush=True)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("size", nargs="?", default="large-v3")
    ap.add_argument("--mirror", default=None)
    ap.add_argument("--dir", default=None)
    args = ap.parse_args()

    outdir = args.dir or os.path.join("models", f"faster-whisper-{args.size}")
    os.makedirs(outdir, exist_ok=True)
    repo = f"Systran/faster-whisper-{args.size}"
    mirrors = [args.mirror] if args.mirror else MIRRORS

    print(f"模型: {repo}")
    print(f"保存到: {os.path.abspath(outdir)}")

    client = httpx.Client(timeout=httpx.Timeout(30.0, read=120.0))
    base = None
    for m in mirrors:
        probe = f"{m}/{repo}/resolve/main/config.json"
        try:
            r = client.head(probe, follow_redirects=True, timeout=20)
            if r.status_code == 200:
                base = m
                print(f"使用镜像: {m}")
                break
        except Exception as e:
            print(f"  {m} 不可用: {type(e).__name__}")
    if not base:
        sys.exit("所有镜像都不可用")

    ok = True
    for name in NEED:
        dest = os.path.join(outdir, name)
        url = f"{base}/{repo}/resolve/main/{name}"
        want = head_size(client, url)
        if want and os.path.exists(dest) and os.path.getsize(dest) == want:
            print(f"  {name}: 已存在且大小正确（{human(want)}）")
            continue
        t0 = time.time()
        got = download(client, url, dest, name)
        ok = ok and got
        if got and want:
            actual = os.path.getsize(dest)
            if actual != want:
                print(f"    警告：大小不符 want={want} got={actual}")

    total = sum(os.path.getsize(os.path.join(outdir, f))
                for f in os.listdir(outdir) if os.path.isfile(os.path.join(outdir, f)))
    print(f"\n目录合计: {human(total)}")
    print("结果: " + ("全部就绪 ✅" if ok else "未完成（可重跑续传）"))
    print("模型路径: " + os.path.abspath(outdir))


if __name__ == "__main__":
    main()
