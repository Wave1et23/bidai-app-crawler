/**
 * 会话与 HTTP 请求封装：把登录捕获的 Cookie 变成普通 fetch 请求可用的请求头。
 * 下载阶段完全不依赖浏览器。
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, readJson } from "./config.mjs";

export function loadSession(cfg = loadConfig()) {
  const metaFile = cfg.authStateFile.replace(/\.json$/, "-meta.json");
  if (!fs.existsSync(cfg.authStateFile)) {
    throw new Error(
      `找不到会话文件 ${cfg.authStateFile}\n请先运行: node src/login.mjs`
    );
  }
  const state = readJson(cfg.authStateFile);
  let userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";
  if (fs.existsSync(metaFile)) {
    try {
      const meta = readJson(metaFile);
      if (meta.userAgent) userAgent = meta.userAgent;
    } catch {
      /* 忽略：UA 用默认值即可 */
    }
  }

  const cookies = state.cookies ?? [];
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  return { cookies, cookieHeader, userAgent, state };
}

/** 判断会话是否明显过期（Cookie 全部带 expires 且都已过期）。 */
export function looksExpired(session) {
  const now = Date.now() / 1000;
  const withExpiry = session.cookies.filter((c) => typeof c.expires === "number" && c.expires > 0);
  if (withExpiry.length === 0) return false;
  return withExpiry.every((c) => c.expires < now);
}

/**
 * 带会话的 fetch。支持超时、Referer、重试留给调用方处理。
 */
export async function request(url, { session, cfg, method = "GET", headers = {}, body, redirect = "follow" }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.request.timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect,
      signal: controller.signal,
      headers: {
        "User-Agent": session.userAgent,
        Accept: "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Cookie: session.cookieHeader,
        ...headers,
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** 常见「被踢回登录页」的启发式判断。 */
export function looksLikeLoginPage(res, text, cfg) {
  if (res.status === 401 || res.status === 403) return true;
  if (!text) return false;
  const sample = text.slice(0, 4000).toLowerCase();
  if (sample.includes("验证码") && (sample.includes("登录") || sample.includes("signin"))) return true;
  const finalUrl = res.url || "";
  if (/login|signin|passport|sso/i.test(finalUrl) && !/login/i.test(cfg.listUrl || "")) return true;
  return false;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export { path };
