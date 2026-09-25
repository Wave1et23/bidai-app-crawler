/**
 * 登录凭证（token）的解析。
 *
 * 按优先级依次尝试，找到第一个可用的就返回：
 *   1. 命令行     --token=<值>
 *   2. 环境变量   BIDAI_TOKEN
 *   3. 用户目录   ~/.bidai-token        ← 推荐：凭证完全不在项目目录里，误 git add 也带不走
 *   4. 项目根目录 .bidai-token
 *   5. auth-state.json 里的对应 Cookie   ← 由 src/login.mjs（浏览器登录）产出
 *
 * 之所以支持这么多来源，是为了让「凭证」和「代码」彻底分开：
 * 你把仓库公开、打包发给别人，都不会带上你的 token。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, readJson } from "./config.mjs";

const DEFAULT_TOKEN_COOKIE = "bidai-token";
const ENV_NAME = "BIDAI_TOKEN";
const FILE_NAME = ".bidai-token";

function tryReadFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const v = fs.readFileSync(file, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

export function resolveToken(cfg = loadConfig()) {
  const cookieName = cfg.tokenCookieName || DEFAULT_TOKEN_COOKIE;

  // 1. 命令行 --token=<值> / --token <值>
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--token=")) {
      const v = a.slice("--token=".length).trim();
      if (v) return { token: v, source: "命令行 --token" };
    } else if (a === "--token" && argv[i + 1]) {
      const v = argv[i + 1].trim();
      if (v) return { token: v, source: "命令行 --token" };
    }
  }

  // 2. 环境变量
  const env = process.env[ENV_NAME]?.trim();
  if (env) return { token: env, source: `环境变量 ${ENV_NAME}` };

  // 3. 用户目录（推荐位置：不在项目目录内）
  const home = tryReadFile(path.join(os.homedir(), FILE_NAME));
  if (home) return { token: home, source: `~/${FILE_NAME}` };

  // 4. 项目根目录
  const local = tryReadFile(path.join(cfg.root, FILE_NAME));
  if (local) return { token: local, source: `项目根目录 ${FILE_NAME}` };

  // 5. 浏览器登录会话里的 Cookie
  try {
    if (fs.existsSync(cfg.authStateFile)) {
      const state = readJson(cfg.authStateFile);
      const c = (state.cookies || []).find((x) => x.name === cookieName);
      if (c?.value) return { token: c.value, source: `auth-state.json 的 ${cookieName} Cookie` };
    }
  } catch {
    /* 忽略，继续 */
  }

  return { token: null, source: null };
}

/** 给「拿不到 token」时的友好提示。 */
export function tokenHelp() {
  return [
    "没有找到登录凭证 token。任选一种方式提供：",
    "",
    "  方式一（推荐，凭证不进项目目录）：",
    `    在用户目录建 ${FILE_NAME} 文件，内容就是 token 本身。`,
    `    Windows: ${path.join(os.homedir(), FILE_NAME)}`,
    "",
    "  方式二（临时）：",
    "    node src/download.mjs --token=<你的token>",
    "",
    "  方式三（环境变量）：",
    `    $env:${ENV_NAME}="你的token"    # PowerShell`,
    "",
    "  方式四（浏览器登录，适合手机号+短信验证码的站点）：",
    "    node src/login.mjs",
    "",
    "怎么拿到 token：在浏览器里登录站点后按 F12 → Application → Cookies →",
    "选中该站点 → 找到名为 bidai-token 的条目 → 复制它的 Value。",
  ].join("\n");
}
