"use strict";
// 对 renderer/ 下所有 ES 模块做语法检查（不执行）。
// Node 缺省把 .js 当 CommonJS，且本环境不支持 --experimental-default-type，
// 故通过 stdin + --input-type=module 交给 node 做 ESM 语法校验。
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.join(__dirname, "..", "renderer");
const files = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith(".js")) files.push(p);
  }
})(root);

let failed = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const r = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: src,
    stdio: ["pipe", "inherit", "inherit"]
  });
  if (r.status !== 0) { console.error("  ✗ " + f); failed++; }
}
if (failed) { console.error(`\n[check-renderer] ${failed} 个文件语法检查未通过`); process.exit(1); }
console.log(`[check-renderer] 已通过 ${files.length} 个模块的语法检查`);
