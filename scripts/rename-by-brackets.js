"use strict";
// 把「…薛之谦《歌名》…【Hi-res】.mp3」这类文件名，重命名为书名号里的歌名。
//
// 用法:
//   node scripts/rename-by-brackets.js "<文件夹>"          # 预演，不改动任何文件
//   node scripts/rename-by-brackets.js "<文件夹>" --apply  # 真正执行重命名
//
// 规则：
//   - 取第一个《…》里的内容，去掉首尾空白与全角空格
//   - 保留原扩展名
//   - 目标名已存在（或与别的文件重名）时跳过，不会覆盖任何文件
//   - 不含《》的文件保持不动

const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
const apply = process.argv.includes("--apply");

if (!dir) {
  console.error('用法: node scripts/rename-by-brackets.js "<文件夹>" [--apply]');
  process.exit(1);
}
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error("文件夹不存在: " + dir);
  process.exit(1);
}

// 从文件名推导目标名；返回 null 表示这个文件不该动
function targetName(name) {
  const m = String(name).match(/《([^《》]*)》/);
  if (!m) return null;
  const base = m[1].replace(/[\s\u3000]+/g, " ").trim().replace(/[\\/:*?"<>|]/g, "_");
  if (!base) return null;
  return base + path.extname(name);
}

const files = fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name)
  .sort((a, b) => a.localeCompare(b, "zh"));

const planned = [];
const taken = new Set();
const results = [];
let ok = 0, skipped = 0, failed = 0;

for (const from of files) {
  const to = targetName(from);
  if (to === null) {
    results.push({ from, to: null, status: "跳过：文件名里没有《》" });
    skipped++;
    continue;
  }
  if (to === from) {
    results.push({ from, to, status: "跳过：已经是这个名字" });
    skipped++;
    continue;
  }
  const clash = taken.has(to) || (fs.existsSync(path.join(dir, to)) && to !== from);
  if (clash) {
    results.push({ from, to, status: "跳过：目标名已存在，不覆盖" });
    skipped++;
    continue;
  }
  taken.add(to);
  planned.push({ from, to });
}

if (!apply) {
  console.log("=== 预演（未改动任何文件）===");
  for (const r of results) console.log("  " + r.status.padEnd(24) + " " + r.from);
  for (const p of planned) console.log("  " + "将重命名".padEnd(24) + " " + p.from + "\n" + " ".repeat(26) + "-> " + p.to);
  console.log("\n共 " + files.length + " 个文件：将重命名 " + planned.length +
    "，跳过 " + results.filter(r => r.to === null || true).length);
  console.log("确认无误后加 --apply 执行。");
  process.exit(0);
}

console.log("=== 执行重命名 ===");
for (const p of planned) {
  try {
    fs.renameSync(path.join(dir, p.from), path.join(dir, p.to));
    console.log("  ✓ " + p.from + "  ->  " + p.to);
    ok++;
  } catch (e) {
    console.log("  ✗ " + p.from + "  失败: " + e.code);
    failed++;
  }
}
for (const r of results) if (r.to === null || r.status.startsWith("跳过")) { /* 已统计 */ }
console.log("\n完成：成功 " + ok + "，跳过 " + skipped + "，失败 " + failed);
