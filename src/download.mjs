/**
 * 批量下载器 —— 命令行入口（纯 HTTP，不需要浏览器）。
 *
 * 常用用法：
 *   node src/download.mjs --list                       列出云盘里的文件夹，挑一个
 *   node src/download.mjs --url "<文件夹页面地址>"        按网页地址下载（自动取 folder_id）
 *   node src/download.mjs --folder "2024·高考英语真题"    按文件夹名字下载
 *   node src/download.mjs --folder 1234567890          按文件夹 id 下载
 *   node src/download.mjs --dry-run                    只列清单不下载
 *   node src/download.mjs --limit 3                    先试下 3 个
 *   node src/download.mjs --init                       生成 config.json 供长期使用
 *
 * 引擎特性：
 *   - 串行下载 + 可配置间隔（默认 800ms），避免触发风控
 *   - 断点续传：已存在的文件跳过，随时中断、重跑接着下
 *   - 先写 .part 临时文件、校验通过后再改名 → 不会留下半个坏文件
 *   - 双重完整性校验：Content-Length + 服务端 md5
 *   - 失败自动重试（指数退避），失败清单写入 report.json
 *   - 签名地址带时效的站点：每个文件下载前才换取新地址
 *   - 会话/凭证失效立即中止并提示，不会默默下载一堆错误页覆盖已有文件
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig, safeFileName, readJson } from "./config.mjs";
import { loadSession, request, looksLikeLoginPage, looksExpired, ensureDir } from "./session.mjs";
import { collectItems } from "./collect.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

if (flag("--help") || flag("-h")) {
  printHelp();
  process.exit(0);
}

const cfg = loadConfig();

/* ---------------------------- 应用命令行覆盖 ---------------------------- */

if (opt("--out")) cfg.outputDir = path.resolve(process.cwd(), opt("--out"));
if (opt("--url")) cfg.collect.listUrl = opt("--url");
const folderArg = opt("--folder") || opt("--folder-id");
if (folderArg) cfg.collect.folder = folderArg;

// --flat 关闭子目录（平铺）；--with-path 用从根开始的完整层级
if (flag("--flat") || flag("--no-folder")) cfg.layout.createFolder = false;
if (flag("--with-path") || flag("--full-path")) cfg.layout.mode = "path";
if (flag("--recursive") || flag("-r")) cfg.collect.recursive = true;

const dryRun = flag("--dry-run");
const limit = Number(opt("--limit", "0")) || 0;
const wantList = flag("--list") || flag("--tree") || flag("--folders");
const asJson = flag("--json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => {
  if (!asJson) console.log(`[${stamp()}] ${msg}`);
};

/** 流式计算文件 md5，避免把大文件整个读进内存。 */
async function md5File(file) {
  const hash = crypto.createHash("md5");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

if (flag("--init")) {
  initConfig();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✗ ${err?.message || err}`);
  if (process.env.BIDAI_DEBUG) console.error(err?.stack);
  process.exitCode = 1;
});

/* ------------------------------- 辅助 ------------------------------- */

function printHelp() {
  console.log(`
批量下载器

用法:
  node src/download.mjs [选项]

选项:
  --list, --tree          列出云盘里的文件夹（用来挑文件夹）
  --url <页面地址>         你在浏览器里打开的那个文件夹页面地址，自动取 folder_id
  --folder <名字或id>      要下载的文件夹，支持中文名、部分匹配、「父/子」多级路径
  --out <目录>            保存到哪个目录（默认 ./downloads）
  --flat                  不要子目录，文件平铺在输出目录
  --with-path             子目录带完整层级（父目录/子目录/）而非只有当前文件夹名
  --recursive, -r         连同子文件夹一起下载
  --dry-run               只列清单，不下载
  --limit <N>             只处理前 N 个文件
  --json                  以 JSON 输出结果（便于脚本/agent 解析）
  --token <值>            临时指定登录 token
  --init                  根据 config.example.json 生成 config.json
  --help, -h              显示本帮助

凭证:
  token 依次从 --token、环境变量 BIDAI_TOKEN、~/.bidai-token、
  项目根目录 .bidai-token、auth-state.json 里查找。
`);
}

function initConfig() {
  const target = path.join(cfg.root, "config.json");
  const example = cfg.exampleConfigFile;
  if (fs.existsSync(target) && !flag("--force")) {
    console.error(`config.json 已存在，未覆盖：${target}`);
    console.error("要重新生成请加 --force（会覆盖你当前的配置）");
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(example)) {
    console.error(`找不到模板文件：${example}`);
    process.exitCode = 1;
    return;
  }
  fs.copyFileSync(example, target);
  console.log(`✓ 已生成 ${target}`);
  console.log("  按需修改后运行：node src/download.mjs --list");
}

async function main() {

/* ------------------------------ 会话准备 ------------------------------ */

let session;
const cookieOverride = opt("--cookie");
if (cookieOverride) {
  session = {
    cookies: [],
    cookieHeader: cookieOverride,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0",
    state: { cookies: [] },
  };
  log("使用命令行传入的 Cookie（--cookie）");
} else {
  try {
    session = loadSession(cfg);
    log(`已加载会话，共 ${session.cookies.length} 个 Cookie`);
    if (looksExpired(session)) {
      console.error("✗ 会话里的 Cookie 全部已过期，请重新运行: node src/login.mjs");
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    // gaojiua 模式用 bidai-token 认证，不需要浏览器 Cookie 会话
    if (cfg.collect.mode === "gaojiua") {
      session = { cookies: [], cookieHeader: "", userAgent: undefined, state: { cookies: [] } };
      log("未使用 Cookie 会话（gaojiua 模式通过 bidai-token 认证）");
    } else {
      console.error(`✗ ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
}

/* ------------------------------ 收集链接 ------------------------------ */

if (!cfg.configFile && !asJson) {
  log("未找到 config.json，使用内置默认值（想长期使用可以跑 --init 生成一份）");
}

/* ---- --list：只打印云盘目录树，方便挑文件夹 ---- */
if (wantList) {
  const { GaojiuaClient } = await import("./sites/gaojiua.mjs");
  const { printTree } = await import("./folders.mjs");
  const { resolveToken, tokenHelp } = await import("./token.mjs");

  const { token, source } = resolveToken(cfg);
  if (!token) {
    console.error(tokenHelp());
    process.exitCode = 1;
    return;
  }
  log(`认证 token 来源: ${source}`);
  const client = new GaojiuaClient({ token, userAgent: session.userAgent, timeoutMs: cfg.request.timeoutMs });

  if (asJson) {
    const { fetchChildren } = await import("./folders.mjs");
    const out = [];
    const walk = async (id, rel, depth) => {
      if (depth > 4) return;
      const kids = await fetchChildren(client, id);
      for (const d of kids.dirs) {
        const pathArr = [...rel, d.name];
        out.push({ id: d.id, name: d.name, path: pathArr });
        await walk(d.id, pathArr, depth + 1);
      }
    };
    await walk(null, [], 1);
    console.log(JSON.stringify({ folders: out }, null, 2));
    return;
  }

  await printTree(client, { maxDepth: 3, maxFolders: 150, log: console.log });
  return;
}

log(`目标输出目录: ${cfg.outputDir}`);
if (!fs.existsSync(cfg.outputDir) && !dryRun) ensureDir(cfg.outputDir);

let items;
try {
  items = await collectItems(cfg, session, (m) => log(m));
} catch (err) {
  console.error(`\n✗ 收集文件列表失败: ${err.message}`);
  if (/会话|过期|登录|凭证|token|401|403/i.test(err.message)) {
    console.error("\n  凭证可能已失效或不正确。重新获取 token 后再试（见 --help 的「凭证」一节）。");
  }
  // 把失败原因也写成机读的，便于脚本 / AI agent 判断发生了什么
  const failReport = {
    finishedAt: new Date().toISOString(),
    outputDir: cfg.outputDir,
    stage: "collect",
    error: err.message,
    needsCredentials: /会话|过期|登录|凭证|token|401|403/i.test(err.message),
  };
  try {
    fs.writeFileSync(path.join(cfg.root, "report.json"), JSON.stringify(failReport, null, 2), "utf8");
  } catch {
    /* 写不了报告不影响主流程 */
  }
  if (asJson) console.log(JSON.stringify(failReport, null, 2));
  process.exitCode = 1;
  return;
}

log(`识别到 ${items.length} 个文件`);

if (items.length === 0) {
  console.error("✗ 一个文件都没找到。可能是这个文件夹是空的，或筛选条件不对。");
  console.error("  建议先跑: node src/download.mjs --list 看看有哪些文件夹。");
  process.exitCode = 1;
  return;
}

if (dryRun) {
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          outputDir: cfg.outputDir,
          total: items.length,
          files: items.map((it) => ({
            name: it.name,
            subPath: it.subPath || [],
            size: it.size ?? null,
            md5: it.md5 ?? null,
            url: it.url ?? null,
          })),
        },
        null,
        2
      )
    );
    return;
  }
  console.log("\n--- DRY RUN：以下文件将被下载（未实际下载）---");
  console.log(`输出根目录: ${cfg.outputDir}`);
  let lastDir = null;
  items.forEach((it, i) => {
    const dir = (it.subPath || []).join("/") || "(根目录)";
    if (dir !== lastDir) {
      console.log(`\n  📁 ${dir}${(it.subPath || []).length ? "/" : ""}`);
      lastDir = dir;
    }
    console.log(`${String(i + 1).padStart(4)}. ${it.name}`);
    console.log(`      ${it.url}`);
  });
  console.log(`\n共 ${items.length} 个。确认无误后运行: node src/download.mjs`);
  return;
}

/* ------------------------------- 下载 -------------------------------- */

/** 某个下载项的本地目录（含按网页结构生成的子目录）。 */
function itemDir(item) {
  return path.join(cfg.outputDir, ...(item.subPath || []));
}

/** 用于日志显示的相对路径，例如 2024·高考英语真题/xxx.docx */
function itemLabel(item, name) {
  return [...(item.subPath || []), name || item.name].join("/");
}

function resolveTargetName(item, res) {
  let name = item.name;
  const hasExt = /\.[A-Za-z0-9]{1,6}$/.test(name);
  const cd = res.headers.get("content-disposition") || "";
  if (!hasExt) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    const fromCd = star ? decodeURIComponent(star[1]) : plain ? plain[1] : "";
    if (fromCd) return safeFileName(fromCd);
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    const map = {
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/msword": ".doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/vnd.ms-excel": ".xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "application/octet-stream": ".bin",
    };
    name += map[ct] || (ct.startsWith("image/") ? `.${ct.split("/")[1]}` : ".bin");
  }
  return name;
}

let ok = 0,
  skipped = 0,
  failed = [];
let aborted = false;

const queue = limit ? items.slice(0, limit) : items;
if (limit) log(`⚠ --limit ${limit}：本次只处理前 ${limit} 个文件`);

for (const [i, item] of queue.entries()) {
  if (aborted) break;
  const prefix = `[${i + 1}/${queue.length}]`;

  // 快速跳过：目标文件已存在（按子目录 + 文件名判断）
  const guessPath = path.join(itemDir(item), item.name);
  if (cfg.behavior.skipExisting && fs.existsSync(guessPath) && fs.statSync(guessPath).size > 0 && !cfg.behavior.overwrite) {
    log(`${prefix} 跳过（已存在）: ${itemLabel(item)}`);
    skipped++;
    continue;
  }

  let done = false;
  for (let attempt = 1; attempt <= cfg.request.retries && !done; attempt++) {
    const partPath = path.join(itemDir(item), item.name + ".part");
    try {
      // 带时效签名的站点：在即将下载的这一刻才换取新地址
      let targetUrl = item.url;
      if (typeof item.resolve === "function") {
        targetUrl = await item.resolve();
      }

      const res = await request(targetUrl, {
        session,
        cfg,
        headers: { Referer: item.referer || cfg.listUrl, Accept: "application/octet-stream,*/*" },
      });

      const ct = res.headers.get("content-type") || "";
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (ct.includes("text/html")) {
        const peek = await res.text();
        if (looksLikeLoginPage({ status: res.status, url: res.url }, peek, cfg)) {
          aborted = true;
          console.error(`\n✗ 会话已过期（返回登录页）。已下载 ${ok} 个文件。`);
          console.error("  → 请重新运行: node src/login.mjs  然后重跑本脚本（已下载的会自动跳过）");
          break;
        }
        throw new Error(`返回的是 HTML 而不是文件（Content-Type: ${ct}），可能需要带上正确的 Referer 或该链接是详情页`);
      }

      const finalName = resolveTargetName(item, res);
      // 关键：文件名交给服务端确定（可能来自 Content-Disposition），但目录始终用 resolve 出来的子目录
      const finalPath = path.join(itemDir(item), finalName);
      const finalPart = finalPath + ".part";

      if (cfg.behavior.skipExisting && fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0 && !cfg.behavior.overwrite) {
        log(`${prefix} 跳过（已存在）: ${itemLabel(item, finalName)}`);
        skipped++;
        done = true;
        break;
      }

      const expected = Number(res.headers.get("content-length") || 0);
      ensureDir(path.dirname(finalPart));
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(finalPart));

      const got = fs.statSync(finalPart).size;
      if (cfg.behavior.verifySize && expected > 0 && got !== expected) {
        fs.rmSync(finalPart, { force: true });
        throw new Error(`大小不符：期望 ${expected} 字节，实际 ${got} 字节`);
      }

      // 服务端在列表/接口里给了 md5，用它做端到端校验（比大小更可靠）
      if (cfg.behavior.verifyMd5 && item.md5) {
        const gotMd5 = await md5File(finalPart);
        if (gotMd5.toLowerCase() !== String(item.md5).toLowerCase()) {
          fs.rmSync(finalPart, { force: true });
          throw new Error(`MD5 不符：期望 ${item.md5}，实际 ${gotMd5}`);
        }
      }

      fs.renameSync(finalPart, finalPath);
      ok++;
      const mb = (got / 1048576).toFixed(2);
      log(`${prefix} ✓ ${itemLabel(item, finalName)}  (${mb} MB${expected ? ` / ${(expected / 1048576).toFixed(2)} MB` : ""})`);
      done = true;
    } catch (err) {
      fs.rmSync(partPath, { force: true });
      if (aborted) break;
      const last = attempt === cfg.request.retries;
      log(`${prefix} ${last ? "✗ 放弃" : `⟳ 第 ${attempt} 次失败重试`}: ${itemLabel(item)} — ${err.message}`);
      if (!last) await sleep(cfg.request.retryBackoffMs * attempt);
      else failed.push({ name: item.name, subPath: item.subPath || [], path: itemLabel(item), url: item.url, error: err.message });
    }
  }

  // 限速：每个文件之间等待，最后一刻不用等
  if (!aborted && i < queue.length - 1) await sleep(cfg.request.delayMs);
}

/* ------------------------------- 汇总 -------------------------------- */

const report = {
  finishedAt: new Date().toISOString(),
  outputDir: cfg.outputDir,
  total: queue.length,
  downloaded: ok,
  skipped,
  failedCount: failed.length,
  aborted,
  failed,
};
const reportFile = path.join(cfg.root, "report.json");
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");

if (asJson) {
  console.log(JSON.stringify({ ...report, reportFile }, null, 2));
} else {
  console.log("");
  console.log("────────────── 下载结果 ──────────────");
  console.log(`成功: ${ok}   跳过(已存在): ${skipped}   失败: ${failed.length}   总计: ${queue.length}`);
  console.log(`输出目录: ${cfg.outputDir}`);
  if (failed.length) {
    console.log(`\n失败清单已写入 report.json（前 10 条）：`);
    failed.slice(0, 10).forEach((f) => console.log(`  ✗ ${f.path || f.name} — ${f.error}`));
    console.log("\n重新运行本脚本即可只重试失败的文件（成功的会自动跳过）。");
  }
  if (aborted) console.log("\n⚠ 因凭证失效提前中止，请重新获取 token 后再跑一次。");
}

} // end main()

