#!/usr/bin/env node
// work-gc.mjs — work/ 本机生成物清理（work/ 已 gitignore，不影响仓库）
//
// 用法：
//   node scripts/work-gc.mjs                # dry-run，只报告，不删
//   node scripts/work-gc.mjs --apply       # 真删
//
// 策略：
//   1. runtime-releases-final/ : 只读不可变 release，保留最近 N 个，其余删
//   2. runtime-builds/         : 按天数过期（默认 7 天）
//   3. runtime-source-bindings/: 按天数过期
//   4. m5-runtime-sources/     : 按天数过期
//   5. m5-runtime-releases/    : 按天数过期
//   6. runtime-releases/       : 按天数过期（默认 7 天，保留最近 cutover）
//   保留：local-ai/venvs/（Python 运行环境，非产物）

import { readdirSync, statSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = join(process.cwd(), "work");
const APPLY = process.argv.includes("--apply");
const KEEP_RELEASES = Number(process.env.KEEP_RELEASES ?? 5);
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS ?? 7);
const now = Date.now();
const ageMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

const fmt = (bytes) => {
  const u = ["B", "K", "M", "G", "T"];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)}${u[i]}`;
};

const dirSize = (p) => {
  let total = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  try {
    walk(p);
  } catch {
    return 0;
  }
  return total;
};

const plans = []; // { path, reason, size }

// 1. runtime-releases-final: 保留最近 N 个
const releasesDir = join(ROOT, "runtime-releases-final");
try {
  const entries = readdirSync(releasesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = join(releasesDir, e.name);
      return { name: e.name, full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const e of entries.slice(KEEP_RELEASES)) {
    plans.push({
      path: e.full,
      reason: `release 保留最近 ${KEEP_RELEASES} 个，此为第 ${entries.indexOf(e) + 1} 旧`,
      size: dirSize(e.full),
    });
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

// 2-6. 按天数过期的目录
for (const sub of [
  "runtime-builds",
  "runtime-source-bindings",
  "m5-runtime-sources",
  "m5-runtime-releases",
  "runtime-releases",
]) {
  const dir = join(ROOT, sub);
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      const mtime = statSync(full).mtimeMs;
      if (now - mtime > ageMs) {
        plans.push({
          path: full,
          reason: `${sub} 超过 ${MAX_AGE_DAYS} 天（mtime ${new Date(mtime).toISOString().slice(0, 10)}）`,
          size: dirSize(full),
        });
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

// 报告
let total = 0;
console.log(`\nwork-gc  模式: ${APPLY ? " APPLY（真删）" : "DRY-RUN（只报告）"}`);
console.log(`策略: release 保留最近 ${KEEP_RELEASES} 个；其余按 ${MAX_AGE_DAYS} 天过期`);
console.log(`local-ai/venvs/ 保留（Python 运行环境）\n`);
console.log("─".repeat(80));
for (const p of plans.sort((a, b) => b.size - a.size)) {
  total += p.size;
  console.log(`${fmt(p.size).padStart(8)}  ${p.path.replace(ROOT + "/", "")}`);
  console.log(`          ${p.reason}`);
}
console.log("─".repeat(80));
console.log(`待回收: ${fmt(total)}  共 ${plans.length} 项\n`);

if (!APPLY) {
  console.log("确认无误后执行: node scripts/work-gc.mjs --apply\n");
} else {
  let removed = 0;
  for (const p of plans) {
    // release 目录常是只读（0555），先恢复写权限再删
    try {
      execSync(`chmod -R u+w ${JSON.stringify(p.path)}`, { stdio: "ignore" });
    } catch {}
    try {
      rmSync(p.path, { recursive: true, force: true });
      removed++;
    } catch (e) {
      console.log(`  ✗ 删除失败: ${p.path.replace(ROOT + "/", "")} — ${e.code}`);
    }
  }
  console.log(`已删除 ${removed}/${plans.length} 项，回收 ${fmt(total)}\n`);
}
