/**
 * 发布前自检：扫描仓库里有没有混进凭证 / 个人隐私信息。
 *
 * 为什么需要它：.gitignore 只能挡住「还没被 git 跟踪」的文件。一旦某个文件被
 * 提交过（哪怕是误用 git add -f），.gitignore 就再也不起作用了。所以在 push
 * 之前用脚本过一遍，比单纯依赖 .gitignore 可靠。
 *
 * 纯 JS 实现，不依赖 git 命令，所以在没有装 git 的环境、CI 里也能跑。
 *
 * 用法:
 *   node scripts/check-secrets.mjs
 *   node scripts/check-secrets.mjs --all     连被忽略的文件也一起扫
 *
 * 退出码：0 = 干净，1 = 发现问题
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const scanAll = process.argv.includes("--all");

/* --------------------------- 忽略规则（读 .gitignore） --------------------------- */

function loadIgnorePatterns() {
  const file = path.join(ROOT, ".gitignore");
  const base = ["node_modules", ".git", ".npm-cache", ".pnpm-store"];
  if (!fs.existsSync(file)) return base;
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return [...base, ...lines];
}

function isIgnored(relPath, patterns) {
  const segs = relPath.split(/[\\/]/);
  return patterns.some((p) => {
    const pat = p.replace(/\/$/, "");
    if (pat.startsWith("*.")) return relPath.endsWith(pat.slice(1));
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return re.test(relPath) || segs.some((s) => re.test(s));
    }
    return segs.includes(pat) || relPath === pat || relPath.startsWith(pat + path.sep) || relPath.startsWith(pat + "/");
  });
}

function walk(dir, patterns, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs);
    if (!scanAll && isIgnored(rel, patterns)) continue;
    if (entry.isDirectory()) walk(abs, patterns, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/* ------------------------------- 检测规则 ------------------------------- */

const RULES = [
  {
    name: "JWT / Bearer token",
    // JWT 头三段式；eyJ 是 {" 的 base64 前缀
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  { name: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "私钥文件内容", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: "含真实取值的 token / secret 赋值",
    // 排除明显是占位符的情况
    re: /(?:token|secret|password|passwd|api[_-]?key|cookie)\s*[:=]\s*["']([A-Za-z0-9_\-.]{24,})["']/gi,
    filter: (m) => !/^(your|xxx|placeholder|example|test|dummy|fake|abc)/i.test(m[1] ?? ""),
  },
  {
    name: "本机绝对路径（泄露用户名）",
    re: /[A-Za-z]:\\+Users\\+[A-Za-z0-9._-]+/g,
  },
  {
    name: "Unix 家目录绝对路径（泄露用户名）",
    re: /(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+\//g,
  },
];

/** 这一行如果带了豁免标记就跳过，便于在文档里举例说明。 */
const ALLOW_MARK = "secret-check-ignore";

/** 构建产物 / 依赖目录里的东西不用报。 */
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".woff", ".woff2", ".ttf"]);

/* --------------------------------- 主流程 --------------------------------- */

const patterns = loadIgnorePatterns();
const files = walk(ROOT, patterns).filter((f) => !SKIP_EXT.has(path.extname(f).toLowerCase()));

console.log(`检查范围: ${files.length} 个文件${scanAll ? "（含被 .gitignore 忽略的文件）" : "（不含 .gitignore 忽略的文件）"}`);
console.log("");

const findings = [];

for (const rel of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    continue; // 二进制或读不了，跳过
  }
  if (text.includes("\u0000")) continue; // 二进制

  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(ALLOW_MARK)) continue;
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        if (rule.filter && !rule.filter(m)) continue;
        // 命中的内容打码，避免把敏感值再打印到日志/CI 里
        const raw = m[0];
        const shown = raw.length > 16 ? `${raw.slice(0, 8)}…${raw.slice(-4)}` : raw;
        findings.push({ file: rel, line: i + 1, rule: rule.name, shown });
        if (m[0] === "") rule.re.lastIndex++;
      }
    }
  }
}

/* --------------------- 额外检查：敏感文件是否被忽略 --------------------- */

const CRITICAL_FILES = [".bidai-token", "auth-state.json", "config.json"];
const ignoreText = fs.existsSync(path.join(ROOT, ".gitignore")) ? fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8") : "";
const notIgnored = CRITICAL_FILES.filter((f) => !ignoreText.split(/\r?\n/).some((l) => l.trim() === f));
const presentLocally = CRITICAL_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)));

/* --------------------------------- 输出 --------------------------------- */

if (findings.length) {
  console.error(`✗ 发现 ${findings.length} 处疑似敏感信息：\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`      规则: ${f.rule}`);
    console.error(`      内容: ${f.shown}`);
  }
  console.error("\n请清理后再提交。若确实是文档里的举例，可在该行加上 '" + ALLOW_MARK + "' 标记。");
} else {
  console.log("✓ 未发现明显的凭证或隐私信息");
}

if (notIgnored.length) {
  console.error(`\n⚠ 以下敏感文件没有出现在 .gitignore 里：${notIgnored.join(", ")}`);
} else {
  console.log(`✓ .gitignore 已覆盖敏感文件：${CRITICAL_FILES.join(", ")}`);
}

if (presentLocally.length) {
  console.log(`\nℹ 本机存在这些文件（只要没被提交就没事）：${presentLocally.join(", ")}`);
  if (presentLocally.includes("config.json")) {
    console.log("  config.json 属于个人配置，仓库里请只保留 config.example.json");
  }
}

console.log("");
if (findings.length || notIgnored.length) {
  console.error("结果：需要处理");
  process.exitCode = 1;
} else {
  console.log("结果：可以安全提交");
}
