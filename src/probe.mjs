/**
 * 站点诊断工具：抓一个 URL，报告它是什么类型、有没有登录、文件列表可能来自哪里。
 * 用于接入新站点时快速判断该用哪种 collect 模式。
 *
 * 用法:
 *   node src/probe.mjs https://example.com/files/
 *   node src/probe.mjs <url> --dump scratch/list.html     把 HTML 存下来细看
 *   node src/probe.mjs <url> --no-auth                    不带 Cookie 访问
 *   node src/probe.mjs <url> --show-body 3000             打印响应体前 N 字符
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { loadSession } from "./session.mjs";

const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith("--"));
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

if (!url) {
  console.error("用法: node src/probe.mjs <url> [--dump out.html] [--no-auth] [--show-body N]");
  process.exit(1);
}

const cfg = loadConfig();

let session;
if (flag("--no-auth")) {
  session = { cookies: [], cookieHeader: "", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0" };
  console.log("模式: 不带 Cookie（匿名访问）");
} else {
  try {
    session = loadSession(cfg);
    console.log(`模式: 带会话（${session.cookies.length} 个 Cookie）`);
  } catch (e) {
    console.log(`模式: 无会话可用（${e.message.split("\n")[0]}），改为匿名访问`);
    session = { cookies: [], cookieHeader: "", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0" };
  }
}

console.log(`请求: ${url}\n`);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60000);
let res;
try {
  res = await fetch(url, {
    redirect: "follow",
    signal: controller.signal,
    headers: {
      "User-Agent": session.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(session.cookieHeader ? { Cookie: session.cookieHeader } : {}),
    },
  });
} catch (err) {
  console.error(`✗ 请求失败: ${err.message}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

const ct = res.headers.get("content-type") || "";
const body = await res.text();

console.log("── 基本响应 ──────────────────────────────");
console.log(`HTTP 状态   : ${res.status} ${res.statusText}`);
console.log(`最终 URL    : ${res.url}${res.url !== url ? "   ← 发生了跳转" : ""}`);
console.log(`Content-Type: ${ct}`);
console.log(`响应体大小  : ${body.length} 字符`);
console.log(`Server      : ${res.headers.get("server") || "-"}`);
console.log(`set-cookie  : ${res.headers.getSetCookie?.().length ?? 0} 个`);

const title = (body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
if (title) console.log(`页面标题    : ${title.trim()}`);

console.log("\n── 页面类型判断 ──────────────────────────");
const isHtml = ct.includes("text/html");
const looksSpa =
  /<div id="(app|root)">\s*<\/div>/i.test(body) ||
  /window\.__(NUXT|NEXT_DATA|INITIAL_STATE)__/.test(body) ||
  (isHtml && body.length < 4000 && /<script[^>]+src=/i.test(body));
console.log(`是 HTML     : ${isHtml ? "是" : "否"}`);
console.log(`疑似 SPA    : ${looksSpa ? "是（内容由 JS 渲染，普通抓包拿不到列表 → 需要找接口或用 browser 模式）" : "否"}`);

const loginHints = ["验证码", "登录", "signin", "login", "passport"].filter((k) => body.includes(k));
console.log(`登录相关字样: ${loginHints.length ? loginHints.join(", ") : "无"}`);
if (/验证码/.test(body) && /登录/.test(body)) {
  console.log("              → 当前拿到的是登录页，说明会话无效或未登录");
}

console.log("\n── 页面里的 script（找前端入口，便于定位接口）──");
const scripts = [...body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
if (scripts.length === 0) console.log("  （无外链 script）");
scripts.slice(0, 15).forEach((s) => {
  let abs = s;
  try {
    abs = new URL(s, res.url).toString();
  } catch {}
  console.log(`  ${abs}`);
});

console.log("\n── 关键接口线索（在 HTML 里直接搜到的关键字）──");
for (const kw of ["pre-download", "file_id", "folder_id", "cloud/files", "/api/"]) {
  const n = body.split(kw).length - 1;
  if (n > 0) console.log(`  "${kw}" 出现 ${n} 次`);
}

// 尝试从 HTML 里直接提取文件直链
const hrefs = [...body.matchAll(/(?:href|src|data-[a-z-]*url)=["']([^"']+)["']/gi)].map((m) => m[1]);
const fileish = hrefs.filter((h) => /\.(pdf|docx?|xlsx?|zip|rar|pptx?|txt|csv|jpe?g|png|mp4)(\?|$)/i.test(h));
if (fileish.length) {
  console.log("\n── HTML 里疑似文件直链 ──");
  [...new Set(fileish)].slice(0, 20).forEach((h) => console.log(`  ${h}`));
}

const dump = opt("--dump");
if (dump) {
  const p = path.resolve(cfg.root, dump);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
  console.log(`\n✓ HTML 已保存: ${p}（${body.length} 字符）`);
}

const showBody = Number(opt("--show-body", "0"));
if (showBody > 0) {
  console.log(`\n── 响应体前 ${showBody} 字符 ──`);
  console.log(body.slice(0, showBody));
}
