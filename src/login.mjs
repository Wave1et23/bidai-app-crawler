/**
 * 浏览器登录（可选方案）。
 *
 * 适用场景：站点用「手机号 + 短信验证码」登录，验证码每次都变，没法也不该用代码绕过。
 * 本脚本会弹出一个真实的浏览器窗口，由你**本人手动完成登录**，脚本只负责在登录成功后
 * 把会话（Cookie + localStorage）保存下来供后续下载复用。
 *
 * 脚本全程不会读取、记录或上传你的手机号、密码和验证码。
 *
 * 用法:
 *   node src/login.mjs                                  用默认站点
 *   node src/login.mjs --url "https://站点/路径"          指定登录页或任意需登录的页面
 *
 * 需要 playwright-core（已列为可选依赖）。若未安装：
 *   npm install playwright-core
 * 另外本脚本会启动浏览器进程，在受限沙箱里可能被拒绝，建议在本机终端直接运行。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const argv = process.argv.slice(2);
const opt = (n) => {
  const hit = argv.find((a) => a.startsWith(`${n}=`));
  if (hit) return hit.slice(n.length + 1);
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const flag = (n) => argv.includes(n);

const DEFAULT_LOGIN_URL = "https://gaojiua.com/cloud/files/";

if (flag("--help") || flag("-h")) {
  console.log(`
浏览器登录（可选方案）

用法:
  node src/login.mjs [选项]

选项:
  --url <地址>       要打开的登录页或任意需登录的页面（默认笔袋云盘）
  --channel <名字>   用哪个浏览器：msedge（默认，Windows 自带）/ chrome
  --verbose          额外打印抓到的 Cookie 名称
  --help, -h         显示本帮助

说明:
  脚本会弹出一个真实的浏览器窗口，由你本人手动完成登录
  （输入手机号、获取并填写短信验证码）。脚本只保存登录后的会话，
  不读取、不记录、不上传你的手机号、密码和验证码。

  如果你已经有 token，则完全不需要跑这个脚本 —— 直接把 token 写进
  ~/.bidai-token 即可（获取方法见 node src/download.mjs --help）。
`);
  process.exit(0);
}

const loginUrl = opt("--url") || cfg.collect.listUrl || DEFAULT_LOGIN_URL;
const browserChannel = opt("--channel") || cfg.browserChannel || "msedge";

/* ---------- 依赖检查（playwright-core 是可选依赖，可能没装上） ---------- */

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("缺少依赖 playwright-core，请先安装：");
  console.error("  npm install playwright-core");
  console.error("");
  console.error("（这一步是可选的：如果你已经有 token，直接把它写进 ~/.bidai-token 即可，");
  console.error("  不需要走浏览器登录。token 的获取方法见 node src/download.mjs --help）");
  process.exit(1);
}

console.log("即将启动浏览器（使用独立配置目录，不影响你日常使用的浏览器）：");
console.log(`  ${cfg.profileDir}`);
console.log(`登录地址: ${loginUrl}`);
console.log("");

let ctx;
try {
  ctx = await chromium.launchPersistentContext(cfg.profileDir, {
    channel: browserChannel,
    headless: false,
    viewport: null,
    acceptDownloads: true,
    args: ["--start-maximized"],
  });
} catch (err) {
  console.error(`启动浏览器失败: ${err.message}`);
  console.error("");
  console.error("常见原因：");
  console.error(`  - 没有安装浏览器「${browserChannel}」（默认用 Edge，可加 --channel chrome 换 Chrome）`);
  console.error("  - 当前环境不允许启动浏览器进程（例如受限沙箱），请在本机终端直接运行本脚本");
  process.exit(1);
}

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

console.log("────────────────────────────────────────────────");
console.log("请在弹出的浏览器窗口中完成登录：");
console.log("  1. 输入手机号，点击获取验证码");
console.log("  2. 填入手机收到的短信验证码");
console.log("  3. 确认已经进入登录后的页面（能看到文件列表）");
console.log("");
console.log("登录完成后，回到这个终端窗口按【回车】保存会话。");
console.log("────────────────────────────────────────────────");
console.log("");

await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("登录完成后按回车继续... ", () => {
    rl.close();
    resolve();
  });
});

const state = await ctx.storageState();
const cookies = state.cookies ?? [];
const userAgent = await page.evaluate(() => navigator.userAgent);

fs.writeFileSync(cfg.authStateFile, JSON.stringify(state, null, 2), "utf8");
fs.writeFileSync(
  cfg.authStateFile.replace(/\.json$/, "-meta.json"),
  JSON.stringify({ userAgent, savedAt: new Date().toISOString(), loginUrl }, null, 2),
  "utf8"
);

/* 顺手把站点 token 提取出来存到用户目录，这样后续下载不必再开浏览器 */

const tokenCookieName = cfg.tokenCookieName || "bidai-token";
const tokenCookie = cookies.find((c) => c.name === tokenCookieName);

console.log("");
if (cookies.length === 0) {
  console.warn("⚠ 一个 Cookie 都没抓到 —— 可能还没登录成功，请重新运行本脚本。");
} else {
  console.log(`✓ 已保存 ${cookies.length} 个 Cookie → ${cfg.authStateFile}`);
}

if (tokenCookie?.value) {
  const tokenPath = path.join(os.homedir(), ".bidai-token");
  try {
    fs.writeFileSync(tokenPath, tokenCookie.value, "utf8");
    console.log(`✓ 已把 ${tokenCookieName} 写入 ${tokenPath}`);
    console.log("  （放在用户目录而不是项目里，这样即使误把项目目录整个提交，凭证也不会泄露）");
  } catch (err) {
    console.log(`  提示：未能写入 ${tokenPath}（${err.message}），不影响使用。`);
  }
} else if (flag("--verbose")) {
  console.log(`  可用 Cookie: ${cookies.map((c) => c.name).join(", ") || "（无）"}`);
}

console.log("");
console.log("下一步：");
console.log("  node src/download.mjs --list        看看有哪些文件夹");
console.log("  node src/download.mjs --dry-run     看看会下载哪些文件");

await ctx.close();
