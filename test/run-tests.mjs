/**
 * 测试套件。
 *
 *   node test/run-tests.mjs      （或 npm test）
 *
 * 分两部分：
 *   1. 单元测试 —— 配置解析、文件名处理、URL 解析、查询串构造、签名算法回归
 *   2. 端到端测试 —— 起一个本地假站点，用真实的 CLI 下载一遍，检查落盘结果
 *
 * 端到端部分不需要联网、不需要真实账号，所以 CI 里也能跑。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createFixtureServer } from "./fixture-server.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, ".test-out");
const TMP = path.join(ROOT, ".test-out-config.json");

let passed = 0;
let failed = 0;

/** 记录一项断言结果。 */
function record(name, passed_, detail = "") {
  if (passed_) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

/**
 * 同步断言。cond 可以是布尔值，也可以是一个返回布尔值的函数（便于写成代码块）。
 *
 * ⚠️ 异步逻辑必须用 okAsync —— Promise 对象恒为真值，用 ok 会「永远通过」。
 */
function ok(name, cond, detail = "") {
  let result = cond;
  let err = null;
  if (typeof cond === "function") {
    try {
      result = cond();
    } catch (e) {
      result = false;
      err = e;
    }
  }
  if (result && typeof result.then === "function") {
    record(name, false, "异步断言请改用 await okAsync()");
    return;
  }
  record(name, result, detail + (err ? `\n      抛错: ${err.message}` : ""));
}

/** 异步断言：fn 返回 Promise<boolean>。 */
async function okAsync(name, fn, detail = "") {
  let result = false;
  let err = null;
  try {
    result = await fn();
  } catch (e) {
    err = e;
  }
  record(name, result === true, detail + (err ? `\n      抛错: ${err.message}` : ""));
}

function section(title) {
  console.log(`\n──────── ${title} ────────`);
}

/* ══════════════════════════ 1. 单元测试 ══════════════════════════ */

section("单元测试：配置解析");

const { stripJsonComments, safeFileName, DEFAULT_CONFIG } = await import("../src/config.mjs");

ok("能解析带注释的 JSONC", () => {
  const src = `{
    // 这是行注释
    "a": 1, /* 这是块注释 */
    "b": "http://x//y",
    "c": [1, 2,]
  }`;
  const o = JSON.parse(stripJsonComments(src));
  return o.a === 1 && o.b === "http://x//y" && o.c.length === 2;
});

ok("注释里的引号不会破坏解析", () => {
  const o = JSON.parse(stripJsonComments('{"a":"b"} // 他说 "你好" 了吗\n'));
  return o.a === "b";
});

ok("字符串里的 // 不会被当成注释", () => {
  const o = JSON.parse(stripJsonComments('{"u":"https://a.com//b"}'));
  return o.u === "https://a.com//b";
});

ok("默认配置包含必要字段", Boolean(DEFAULT_CONFIG.collect && DEFAULT_CONFIG.layout && DEFAULT_CONFIG.behavior));

section("单元测试：文件名安全处理");

ok("过滤 Windows 非法字符", safeFileName('a<b>c:d"e/f\\g|h?i*j') === "a_b_c_d_e_f_g_h_i_j");
ok("去掉首尾的点与空格", safeFileName("  ..name..  ") === "name");
ok("空字符串走兜底名", safeFileName("", "fallback") === "fallback");
ok("全是非法字符时也走兜底", safeFileName("///", "fallback") === "___");
ok("规避 Windows 保留设备名", safeFileName("con") === "_con");
ok("超长名字被截断", safeFileName("x".repeat(500)).length <= 180);

section("单元测试：页面地址解析");

const { parseFolderIdFromUrl } = await import("../src/folders.mjs");

ok("从页面 URL 取出 folder_id", parseFolderIdFromUrl("https://example.com/cloud/files/?folder_id=1234567890") === "1234567890");
ok("也接受 parent_id 参数", parseFolderIdFromUrl("https://example.com/a?parent_id=42") === "42");
ok("直接给纯数字 id 也能认", parseFolderIdFromUrl("123456") === "123456");
ok("带其它参数时仍能取出", parseFolderIdFromUrl("https://example.com/a?foo=1&folder_id=99&bar=2") === "99");
ok("没有 folder_id 时返回 null", parseFolderIdFromUrl("https://example.com/a?foo=1") === null);

section("单元测试：查询串构造（必须与前端行为一致）");

const { buildQuery, computeSign } = await import("../src/sites/gaojiua.mjs");

ok("参数按 key 字典序排序", buildQuery({ b: 2, a: 1 }) === "?a=1&b=2");
ok("跳过 null / undefined", buildQuery({ a: 1, b: null, c: undefined }) === "?a=1");
ok("数组展开为同名多参", buildQuery({ a: [1, 2] }) === "?a=1&a=2");
ok("不做 URL 编码（必须与前端的字符串拼接保持一致）", buildQuery({ u: "https://x.com/a/b" }) === "?u=https://x.com/a/b");
ok("空参数返回空串", buildQuery({}) === "");

section("单元测试：签名算法回归");

// 固定输入 → 固定输出。站点若改了密钥或拼接顺序，这里会立刻失败。
const SIGN_VECTOR = "ca70be677128a34a1e60b3638a2a76db86ea2384";
ok(
  "签名与已知向量一致",
  computeSign(1700000000, "0123456789abcdef0123456789abcdef", "/api/cloud/file/list/?parent_id=1") === SIGN_VECTOR,
  "若此项失败，说明 src/sites/gaojiua.mjs 里的 KEYS 或拼接顺序被改动了"
);
ok(
  "不同 url 产生不同签名",
  computeSign(1700000000, "0123456789abcdef", "/a") !== computeSign(1700000000, "0123456789abcdef", "/b")
);
ok("签名是 40 位十六进制（HMAC-SHA1）", /^[0-9a-f]{40}$/.test(computeSign(1700000000, "abc", "/x")));

section("单元测试：列表接口分页（防静默截断）");

// 站点默认每页只返回 20 条，不翻页会让 30 个文件的文件夹只下到 20 个，且不报错。
// 这几个用例就是钉死这个行为。
const { fetchAllPages, DEFAULT_PAGE_SIZE } = await import("../src/sites/gaojiua.mjs");

/** 造一个假接口：共 total 条，每页返回 pageSize 条，page 从 1 开始 */
function makeFakeApi(total, pageSize) {
  const items = Array.from({ length: total }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` }));
  const calls = [];
  return {
    calls,
    fetchPage: async (page) => {
      calls.push(page);
      const start = (page - 1) * pageSize;
      return { code: "SUCCESS", data: items.slice(start, start + pageSize) };
    },
  };
}

ok("默认页大小必须大于服务端的 20，否则会被截断", DEFAULT_PAGE_SIZE > 20, `当前 ${DEFAULT_PAGE_SIZE}`);

await okAsync("32 条 / 每页 10 条 → 翻 4 页取全 32 条", async () => {
  const api = makeFakeApi(32, 10);
  const { count, pages } = await fetchAllPages(api.fetchPage, { pageSize: 10 });
  return count === 32 && pages === 4 && api.calls.join(",") === "1,2,3,4";
});

await okAsync("条数正好等于页大小时，要多请求一次空页才能确认到底", async () => {
  const api = makeFakeApi(20, 20);
  const { count, pages } = await fetchAllPages(api.fetchPage, { pageSize: 20 });
  return count === 20 && pages === 2 && api.calls.join(",") === "1,2";
});

await okAsync("空文件夹只请求 1 页", async () => {
  const api = makeFakeApi(0, 20);
  const { count, pages } = await fetchAllPages(api.fetchPage, { pageSize: 20 });
  return count === 0 && pages === 1;
});

await okAsync("翻页结果不重复且顺序稳定", async () => {
  const api = makeFakeApi(45, 10);
  const { result } = await fetchAllPages(api.fetchPage, { pageSize: 10 });
  const ids = result.data.map((x) => x.id);
  return ids.length === 45 && new Set(ids).size === 45 && ids[0] === 1 && ids[44] === 45;
});

await okAsync("达到翻页上限仍未取完时，必须抛错而不是假装成功", async () => {
  const api = makeFakeApi(100, 10);
  try {
    await fetchAllPages(api.fetchPage, { pageSize: 10, maxPages: 3 });
    return false; // 不该走到这里
  } catch (err) {
    return /上限/.test(err.message) && Array.isArray(err.partial) && err.partial.length === 30;
  }
});

/* ══════════════════════════ 2. 端到端测试 ══════════════════════════ */

section("端到端测试：真实下载引擎");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const { server, files, base } = createFixtureServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = base();
console.log(`  假站点已启动: ${BASE}`);

// 测试配置写到仓库根目录，不污染正式 config.json
fs.writeFileSync(
  TMP,
  JSON.stringify(
    {
      outputDir: ".test-out",
      collect: {
        mode: "selector",
        listUrl: `${BASE}/list`,
        selector: "a[href]",
        hrefPattern: "/files/",
        paginate: { enabled: true, urlTemplate: `${BASE}/list?page={page}`, startPage: 1, endPage: 2 },
      },
      layout: { createFolder: false },
      naming: { mode: "original", fallbackPrefix: "file" },
      request: { delayMs: 20, timeoutMs: 20000, retries: 2, retryBackoffMs: 100 },
      authStateFile: ".test-out/auth.json",
    },
    null,
    2
  ),
  "utf8"
);

/**
 * 跑一次真实的 CLI。
 *
 * 这里必须用异步 spawn，不能用 spawnSync：假站点就跑在本进程里，
 * spawnSync 会把事件循环整个阻塞住，服务端无法响应子进程的请求，
 * 子进程只能干等到超时。stdio 用 inherit 是因为受限环境下管道不可用。
 */
function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "src", "download.mjs"), ...args], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, BIDAI_CONFIG: TMP, ...extraEnv },
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const readReport = () => JSON.parse(fs.readFileSync(path.join(ROOT, "report.json"), "utf8"));

console.log("\n  [第 1 轮] 全量下载（共 5 个链接，其中 1 个是 404）");
const code1 = await runCli(["--cookie", "test=1"]);
ok("退出码为 0（个别文件失败不影响整体）", code1 === 0, `实际 ${code1}`);

const report1 = readReport();
ok("总计 5 个", report1.total === 5, `实际 ${report1.total}`);
ok("成功 4 个", report1.downloaded === 4, `实际 ${report1.downloaded}`);
ok("失败 1 个（那个 404）", report1.failedCount === 1, `实际 ${report1.failedCount}`);

const onDisk = fs.readdirSync(OUT).filter((f) => !f.endsWith(".json"));
ok("落盘 4 个文件", onDisk.length === 4, `实际: ${onDisk.join(", ") || "（空）"}`);

let sizeOk = true;
let md5Ok = true;
for (const [name, expected] of Object.entries(files)) {
  const p = path.join(OUT, name);
  if (!fs.existsSync(p)) {
    sizeOk = false;
    md5Ok = false;
    continue;
  }
  const buf = fs.readFileSync(p);
  if (buf.length !== expected.length) sizeOk = false;
  if (crypto.createHash("md5").update(buf).digest("hex") !== crypto.createHash("md5").update(expected).digest("hex")) {
    md5Ok = false;
  }
}
ok("每个文件大小与源一致", sizeOk);
ok("每个文件 MD5 与源一致", md5Ok);
ok("没有残留 .part 临时文件", fs.readdirSync(OUT).every((f) => !f.endsWith(".part")));

console.log("\n  [第 2 轮] 重跑，应全部跳过（断点续传 / 幂等）");
const code2 = await runCli(["--cookie", "test=1"]);
ok("退出码为 0", code2 === 0, `实际 ${code2}`);
const report2 = readReport();
ok("本轮跳过 4 个", report2.skipped === 4, `实际 ${report2.skipped}`);
ok("本轮下载 0 个", report2.downloaded === 0, `实际 ${report2.downloaded}`);

console.log("\n  [第 3 轮] --limit 2，只应处理 2 个");
const code3 = await runCli(["--cookie", "test=1", "--limit", "2"]);
ok("退出码为 0", code3 === 0, `实际 ${code3}`);
const report3 = readReport();
ok("总计 2 个", report3.total === 2, `实际 ${report3.total}`);

console.log("\n  [第 4 轮] 凭证失效（服务端返回登录页），应立即中止");
fs.writeFileSync(
  TMP,
  JSON.stringify(
    {
      outputDir: ".test-out",
      collect: { mode: "selector", listUrl: `${BASE}/needs-login`, selector: "a[href]" },
      authStateFile: ".test-out/auth.json",
    },
    null,
    2
  ),
  "utf8"
);
const code4 = await runCli(["--cookie", "test=1"]);
ok("退出码非 0（明确报错，而不是静默继续）", code4 !== 0, `实际 ${code4}`);

// 关键是「因为识别出登录页而中止」，而不是因为其它莫名其妙的错误碰巧失败
const failReport = JSON.parse(fs.readFileSync(path.join(ROOT, "report.json"), "utf8"));
ok("失败阶段标记为 collect", failReport.stage === "collect", `实际 ${failReport.stage}`);
ok(
  "错误信息确实指向凭证失效",
  /过期|登录/.test(String(failReport.error)),
  `实际错误: ${failReport.error}`
);
ok("机读字段 needsCredentials 为 true", failReport.needsCredentials === true);

/* ══════════════════════════════ 清理与汇总 ══════════════════════════════ */

server.close();
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(TMP, { force: true });
fs.rmSync(path.join(ROOT, "report.json"), { force: true });

console.log("\n════════════════════════════════════");
console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
console.log("════════════════════════════════════");
if (failed > 0) process.exitCode = 1;