/**
 * 按内容去重：扫描一个目录，找出内容完全相同（MD5 一致）的文件，每组只保留一份。
 *
 * 为什么需要它：笔袋云盘会把**同一份文件存两遍**——一份文件名干净，另一份末尾多一个
 * `(13-28-40-6833)` 这样的编号。实测 139 对全部逐字节相同（见 docs/GAOJIUA-API.md）。
 * 工具不做下载时去重（要不要去重应由使用者决定），所以提供这个事后清理脚本。
 *
 * 安全设计：
 *   1. **默认只预览，不删除**；必须显式加 --apply 才真正删除
 *   2. 删除前会重新校验：保留的那份必须存在且 MD5 与待删文件一致，否则跳过不删
 *   3. 保留策略：优先保留「文件名干净」的那份（不带 (nn-nn-nn-nnnn) 编号），
 *      其次保留名字更短的，最后按字典序
 *
 * 用法:
 *   node scripts/dedupe-files.mjs <目录>                 预览（不删任何东西）
 *   node scripts/dedupe-files.mjs <目录> --apply          真正删除
 *   node scripts/dedupe-files.mjs <目录> --keep-suffix    改为保留带编号的那份
 *   node scripts/dedupe-files.mjs                         默认扫描 config.json 的 outputDir
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "../src/config.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const positional = argv.filter((a) => !a.startsWith("--"));

const cfg = loadConfig();
const target = path.resolve(positional[0] || cfg.outputDir);
const apply = flag("--apply");
const keepSuffix = flag("--keep-suffix");

/** 匹配站点自动加的编号后缀，例如 (13-28-40-6833) */
const SUFFIX_RE = /\(\d{2}-\d{2}-\d{2}-\d+\)(?=\.[^.]+$)/;

async function md5File(p) {
  const h = crypto.createHash("md5");
  for await (const c of fs.createReadStream(p)) h.update(c);
  return h.digest("hex");
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/** 在同组里挑出要保留的那份 */
function pickKeeper(group) {
  const scored = group.map((f) => {
    const base = path.basename(f);
    const hasSuffix = SUFFIX_RE.test(base);
    const cleanName = base.replace(SUFFIX_RE, "");
    return {
      file: f,
      // keepSuffix=true 时反过来：带编号的排前面
      suffixRank: keepSuffix ? (hasSuffix ? 0 : 1) : hasSuffix ? 1 : 0,
      nameLen: cleanName.length,
      base,
    };
  });
  scored.sort(
    (a, b) => a.suffixRank - b.suffixRank || a.nameLen - b.nameLen || a.base.localeCompare(b.base, "zh")
  );
  return { keeper: scored[0], losers: scored.slice(1) };
}

if (!fs.existsSync(target)) {
  console.error(`目录不存在: ${target}`);
  process.exit(1);
}

console.log(`扫描目录: ${target}`);
console.log(apply ? "模式: 实际删除（--apply）" : "模式: 仅预览（不会删除任何文件）");
console.log("");

const files = walk(target);
console.log(`共 ${files.length} 个文件，正在计算 MD5...`);

const byMd5 = new Map();
for (const f of files) {
  const h = await md5File(f);
  if (!byMd5.has(h)) byMd5.set(h, []);
  byMd5.get(h).push(f);
}

const dupGroups = [...byMd5.entries()].filter(([, arr]) => arr.length > 1);

console.log(`不同内容: ${byMd5.size} 份；重复组: ${dupGroups.length} 组\n`);

if (dupGroups.length === 0) {
  console.log("✓ 没有重复文件，无需处理。");
  process.exit(0);
}

/* ------------------------------ 计划删除清单 ------------------------------ */

const plan = [];
let totalBytes = 0;
let skipped = 0;

for (const [, group] of dupGroups) {
  const { keeper, losers } = pickKeeper(group);
  const keeperPath = keeper.file;
  const keeperMd5 = await md5File(keeperPath);

  for (const loser of losers) {
    const loserPath = loser.file;
    // 删除前再确认一次：保留的那份确实存在、且内容与待删文件一致
    if (!fs.existsSync(keeperPath)) {
      console.log(`  ⚠ 跳过（要保留的文件不存在）: ${loserPath}`);
      skipped++;
      continue;
    }
    const loserMd5 = await md5File(loserPath);
    if (loserMd5 !== keeperMd5) {
      console.log(`  ⚠ 跳过（内容与保留文件不一致，不敢删）: ${loserPath}`);
      skipped++;
      continue;
    }
    const size = fs.statSync(loserPath).size;
    plan.push({ delete: loserPath, keep: keeperPath, md5: keeperMd5, size });
    totalBytes += size;
  }
}

console.log("══════════ 计划 ══════════");
console.log(`  保留: ${byMd5.size} 份（每组一份）`);
console.log(`  删除: ${plan.length} 份重复副本`);
console.log(`  可释放: ${(totalBytes / 1048576).toFixed(1)} MB`);
if (skipped) console.log(`  跳过: ${skipped} 个（校验未通过，为安全起见不动）`);

console.log("\n--- 前 12 条明细（待删 → 保留）---");
for (const p of plan.slice(0, 12)) {
  console.log(`  ✗ ${path.relative(target, p.delete)}`);
  console.log(`    ✓ 保留 ${path.relative(target, p.keep)}`);
}
if (plan.length > 12) console.log(`  ... 其余 ${plan.length - 12} 条略`);

/* -------------------------------- 执行 -------------------------------- */

if (!apply) {
  console.log("\n预览结束，未删除任何文件。");
  console.log(`确认无误后执行:  node scripts/dedupe-files.mjs "${target}" --apply`);
  process.exit(0);
}

console.log("\n开始删除...");
let deleted = 0;
let failed = 0;
for (const p of plan) {
  try {
    fs.rmSync(p.delete);
    deleted++;
  } catch (err) {
    console.error(`  ✗ 删除失败 ${path.relative(target, p.delete)}: ${err.message}`);
    failed++;
  }
}

console.log("");
console.log("────────────── 结果 ──────────────");
console.log(`已删除: ${deleted}   失败: ${failed}   释放: ${(totalBytes / 1048576).toFixed(1)} MB`);
console.log(`目录现在有 ${walk(target).length} 个文件`);
