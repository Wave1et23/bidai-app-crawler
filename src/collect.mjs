/**
 * 链接提取。四种策略，按站点实际情况在 config.json 的 collect.mode 里选：
 *
 *   selector —— 列表页 HTML 里就有文件直链（最简单）
 *   detail   —— 列表页是详情页链接，需要逐个进详情页找下载链接
 *   api      —— 页面是 JS 渲染的，真实数据来自一个 JSON 接口（最常见也最稳）
 *   browser  —— 兜底：用 Edge 真实渲染后提取（需要浏览器权限，最慢）
 *
 * ⚠ 目前是通用骨架：等拿到目标站点的真实页面/cURL，我会把对应模式补成精确实现。
 */
import * as cheerio from "cheerio";
import { request, looksLikeLoginPage } from "./session.mjs";
import { safeFileName } from "./config.mjs";

function toAbsolute(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function baseNameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

function applyNaming({ url, text, index, cfg }) {
  const { mode, fallbackPrefix } = cfg.naming;
  const ext = (baseNameFromUrl(url).match(/\.[A-Za-z0-9]{1,6}$/) || [""])[0];
  const original = baseNameFromUrl(url);

  if (mode === "title") {
    const t = safeFileName(text || original.replace(/\.[^.]+$/, ""), fallbackPrefix);
    return ext ? `${t}${ext}` : t;
  }
  if (mode === "prefix-index") {
    const idx = String(index + 1).padStart(4, "0");
    return safeFileName(`${idx}_${original || fallbackPrefix}`);
  }
  return safeFileName(original || `${fallbackPrefix}_${index + 1}`);
}

async function fetchText(url, session, cfg, referer) {
  const res = await request(url, { session, cfg, headers: referer ? { Referer: referer } : {} });
  const text = await res.text();
  if (looksLikeLoginPage(res, text, cfg)) {
    throw new Error(`会话可能已过期（HTTP ${res.status}，被重定向到登录页）: ${url}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  return { text, finalUrl: res.url || url };
}

function pageUrls(cfg) {
  const { listUrl, collect } = cfg;
  const pg = collect.paginate;
  if (!pg?.enabled) return [listUrl];
  const urls = [];
  for (let p = pg.startPage; p <= pg.endPage; p++) {
    urls.push(pg.urlTemplate.replace("{page}", String(p)));
  }
  return urls;
}

/* ------------------------------- selector ------------------------------- */

async function collectBySelector(cfg, session, log) {
  const { selector = "a[href]", attr = "href", hrefPattern } = cfg.collect;
  const re = hrefPattern ? new RegExp(hrefPattern, "i") : null;
  const items = [];
  const seen = new Set();

  for (const listUrl of pageUrls(cfg)) {
    log(`  读取列表页: ${listUrl}`);
    const { text, finalUrl } = await fetchText(listUrl, session, cfg);
    const $ = cheerio.load(text);
    $(selector).each((i, el) => {
      const raw = $(el).attr(attr);
      if (!raw) return;
      const abs = toAbsolute(raw.trim(), finalUrl);
      if (!abs || seen.has(abs)) return;
      if (re && !re.test(abs) && !re.test($(el).text())) return;
      seen.add(abs);
      const text2 = $(el).text().trim();
      items.push({
        url: abs,
        name: applyNaming({ url: abs, text: text2, index: items.length, cfg }),
        referer: finalUrl,
      });
    });
  }
  return items;
}

/* -------------------------------- detail -------------------------------- */

async function collectByDetail(cfg, session, log) {
  const { detailSelector = "a[href]", detailPattern, selector = "a[href]", attr = "href", hrefPattern } =
    cfg.collect;
  const dRe = detailPattern ? new RegExp(detailPattern, "i") : null;
  const fRe = hrefPattern ? new RegExp(hrefPattern, "i") : null;

  const detailUrls = [];
  const seenDetail = new Set();
  for (const listUrl of pageUrls(cfg)) {
    log(`  读取列表页: ${listUrl}`);
    const { text, finalUrl } = await fetchText(listUrl, session, cfg);
    const $ = cheerio.load(text);
    $(detailSelector).each((i, el) => {
      const raw = $(el).attr(attr);
      if (!raw) return;
      const abs = toAbsolute(raw.trim(), finalUrl);
      if (!abs || seenDetail.has(abs)) return;
      if (dRe && !dRe.test(abs)) return;
      seenDetail.add(abs);
      detailUrls.push({ url: abs, text: $(el).text().trim() });
    });
  }
  log(`  共 ${detailUrls.length} 个详情页，逐个解析下载链接...`);

  const items = [];
  for (const [i, d] of detailUrls.entries()) {
    const { text, finalUrl } = await fetchText(d.url, session, cfg);
    const $ = cheerio.load(text);
    let found = null;
    $(selector).each((j, el) => {
      if (found) return;
      const raw = $(el).attr(attr);
      if (!raw) return;
      const abs = toAbsolute(raw.trim(), finalUrl);
      if (!abs) return;
      if (fRe && !fRe.test(abs)) return;
      found = abs;
    });
    if (!found) {
      log(`  ⚠ 第 ${i + 1} 个详情页没找到匹配的下载链接: ${d.url}`);
      continue;
    }
    items.push({
      url: found,
      name: applyNaming({ url: found, text: d.text, index: items.length, cfg }),
      referer: finalUrl,
    });
    log(`  [${i + 1}/${detailUrls.length}] ${items.at(-1).name}`);
  }
  return items;
}

/* ---------------------------------- api --------------------------------- */

function pickPath(obj, dotted) {
  if (!dotted) return obj;
  return dotted.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

async function collectByApi(cfg, session, log) {
  const c = cfg.collect;
  const raw = [];

  if (c.paginate?.enabled) {
    for (let p = c.paginate.startPage; p <= c.paginate.endPage; p++) {
      const u = c.apiUrl.replace("{page}", String(p));
      log(`  调用接口: ${u}`);
      const res = await request(u, { session, cfg, headers: c.headers || {} });
      const json = await res.json();
      const arr = pickPath(json, c.itemsPath) || [];
      raw.push(...arr);
      if (c.pageDelayMs) await new Promise((r) => setTimeout(r, c.pageDelayMs));
    }
  } else {
    log(`  调用接口: ${c.apiUrl}`);
    const res = await request(c.apiUrl, { session, cfg, method: c.method || "GET", headers: c.headers || {}, body: c.body });
    const json = await res.json();
    const arr = pickPath(json, c.itemsPath) || [];
    raw.push(...arr);
  }

  const items = [];
  const seen = new Set();
  for (const [i, it] of raw.entries()) {
    let url = c.urlField ? pickPath(it, c.urlField) : null;
    if (!url && c.urlTemplate) {
      const id = c.idField ? pickPath(it, c.idField) : null;
      if (id != null) url = c.urlTemplate.replace("{id}", encodeURIComponent(String(id)));
    }
    if (!url) continue;
    const abs = toAbsolute(String(url), c.apiUrl);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    const title = c.nameField ? pickPath(it, c.nameField) : "";
    items.push({
      url: abs,
      name: applyNaming({ url: abs, text: String(title || ""), index: items.length, cfg }),
      referer: cfg.listUrl,
    });
  }
  return items;
}

/* -------------------------------- browser -------------------------------- */

async function collectByBrowser(cfg, session, log) {
  const { chromium } = await import("playwright-core");
  log("  启动 Edge 渲染页面（需要浏览器权限）...");
  const ctx = await chromium.launchPersistentContext(cfg.profileDir, {
    channel: "msedge",
    headless: cfg.collect.headless !== false,
    viewport: null,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const hrefs = new Set();
  page.on("request", (req) => hrefs.add(req.url()));
  for (const listUrl of pageUrls(cfg)) {
    await page.goto(listUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(cfg.collect.settleMs ?? 2000);
    if (cfg.collect.autoScroll) {
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 800) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 300));
        }
      });
    }
  }
  const domHrefs = await page.evaluate((sel) =>
    Array.from(document.querySelectorAll(sel)).map((el) => el.href || el.getAttribute("href")), cfg.collect.selector || "a[href]");
  await ctx.close();

  const re = cfg.collect.hrefPattern ? new RegExp(cfg.collect.hrefPattern, "i") : null;
  const all = [...new Set([...domHrefs, ...hrefs])].filter(Boolean);
  const items = [];
  const seen = new Set();
  for (const h of all) {
    const abs = toAbsolute(String(h), cfg.listUrl);
    if (!abs || seen.has(abs)) continue;
    if (re && !re.test(abs)) continue;
    seen.add(abs);
    items.push({ url: abs, name: applyNaming({ url: abs, text: "", index: items.length, cfg }), referer: cfg.listUrl });
  }
  return items;
}

/* ------------------------------ gaojiua ------------------------------ */

/**
 * gaojiua.com 站点：走 JSON 接口拿文件清单。
 * 下载地址是带时效签名的，所以这里不给死链接，而是塞一个 resolve() 回调，
 * 由下载器在「即将下载的那一刻」才去换取新签名地址。
 */
async function collectByGaojiua(cfg, session, log) {
  const { resolveToken, tokenHelp } = await import("./token.mjs");
  const { GaojiuaClient, listToItems, extractDownloadUrl } = await import("./sites/gaojiua.mjs");
  const { resolveFolder, walkFolders, parseFolderIdFromUrl } = await import("./folders.mjs");

  const { token, source } = resolveToken(cfg);
  if (!token) throw new Error(tokenHelp());
  log(`  认证 token 来源: ${source}`);

  const client = new GaojiuaClient({
    token,
    userAgent: session?.userAgent,
    timeoutMs: cfg.request.timeoutMs,
    onLog: log,
  });

  /* ---- 定位要下载的文件夹 ---- */
  let selector = cfg.collect.folder;
  if (!selector && cfg.collect.listUrl) {
    selector = parseFolderIdFromUrl(cfg.collect.listUrl);
    if (selector) log(`  已从页面地址解析出 folder_id: ${selector}`);
  }
  if (!selector) {
    throw new Error(
      [
        "没有指定要下载的文件夹。下面三种写法任选其一：",
        '  node src/download.mjs --url "https://gaojiua.com/cloud/files/?folder_id=1234567890"',
        '  node src/download.mjs --folder "2024·高考英语真题"',
        "  node src/download.mjs --folder 1234567890",
        "（不确定文件夹叫什么名字，可以先跑 node src/download.mjs --list）",
      ].join("\n")
    );
  }

  const target = await resolveFolder(client, selector, { log });
  log(`  目标文件夹: ${target.path.join(" / ")}   [id=${target.id}]`);

  /* ---- 本地子目录：按网页里的文件夹结构生成 ---- */
  const layout = cfg.layout || {};
  const createFolder = layout.createFolder !== false;
  let basePath = [];

  if (createFolder) {
    const names = layout.mode === "path" ? target.path : [target.path[target.path.length - 1]];
    basePath = names.map((s) => safeFileName(s, `folder_${target.id}`));
    log(`  本地子目录: ${basePath.join(" / ")}`);
  } else {
    log("  按配置不创建子目录（layout.createFolder = false），文件平铺在输出目录");
  }

  /* ---- 遍历（可选递归） ---- */
  const recursive = Boolean(cfg.collect.recursive);
  const items = [];

  for await (const node of walkFolders(client, target.id, { recursive, log })) {
    const files = listToItems(node.files);
    const rel = node.rel.map((s) => safeFileName(s));
    const where = [...basePath, ...rel].join("/") || "输出目录根";
    log(`  文件夹 ${node.id} → ${where}: ${files.length} 个文件`);

    for (const f of files) {
      if (f.forbidDownload) {
        log(`  ⚠ 跳过（服务端标记禁止下载）: ${f.name}`);
        continue;
      }
      const index = items.length;
      const baseName = safeFileName(f.name, `${cfg.naming.fallbackPrefix}_${index + 1}`);
      const name =
        cfg.naming.mode === "prefix-index" ? safeFileName(`${String(index + 1).padStart(4, "0")}_${baseName}`) : baseName;

      items.push({
        name,
        subPath: [...basePath, ...rel],
        url: f.fileUrl,
        fileId: f.fileId,
        fileUrl: f.fileUrl,
        size: f.size,
        md5: f.md5,
        referer: cfg.listUrl,
        // 每次下载前换取新的签名地址（签名带时效，不能预先批量取好）
        resolve: async () => {
          const pre = await client.preDownload({ fileId: f.fileId, fileUrl: f.fileUrl });
          const url = extractDownloadUrl(pre);
          if (!url) throw new Error(`pre-download 未返回下载地址: ${JSON.stringify(pre).slice(0, 200)}`);
          return url;
        },
      });
    }
  }

  return items;
}

/* --------------------------------- 入口 --------------------------------- */

export async function collectItems(cfg, session, log = console.log) {
  log(`链接提取方式: ${cfg.collect.mode}`);
  let items;
  switch (cfg.collect.mode) {
    case "selector":
      items = await collectBySelector(cfg, session, log);
      break;
    case "detail":
      items = await collectByDetail(cfg, session, log);
      break;
    case "api":
      items = await collectByApi(cfg, session, log);
      break;
    case "gaojiua":
      items = await collectByGaojiua(cfg, session, log);
      break;
    case "browser":
      items = await collectByBrowser(cfg, session, log);
      break;
    default:
      throw new Error(`未知的 collect.mode: ${cfg.collect.mode}`);
  }

  // 重名去重：按「子目录 + 文件名」判断，避免互相覆盖
  const used = new Map();
  for (const it of items) {
    const key = [...(it.subPath || []), it.name].join("/").toLowerCase();
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    if (n > 0) {
      const dot = it.name.lastIndexOf(".");
      it.name = dot > 0 ? `${it.name.slice(0, dot)}_${n + 1}${it.name.slice(dot)}` : `${it.name}_${n + 1}`;
    }
  }
  return items;
}

/* --------------------------- 目录树（--list） --------------------------- */

/**
 * 打印云盘目录树，方便使用者挑文件夹。
 * 各站点 client 都实现了 listFolder，所以这里不依赖具体站点实现。
 */
export async function listFolderTree(client, { rootId = null, maxDepth = 3, maxFolders = 120, log = console.log } = {}) {
  const { printTree } = await import("./folders.mjs");
  await printTree(client, { rootId, maxDepth, maxFolders, log });
}
