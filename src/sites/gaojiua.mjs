/**
 * gaojiua.com（笔袋）站点适配。
 *
 * 该站点是云盘类 SPA，文件列表和下载都走 api.gaojiua.com 的 JSON 接口。
 * 接口信息是从前端 bundle 里还原出来的（见 README 的「站点适配笔记」）：
 *
 *   认证:  Authorization: Bearer <bidai-token Cookie 的值>
 *   固定头: AppFingerprint: bidai / PlatformName: H5 / SoftVersion: 8000 / AppVersion: 8000
 *   签名:  nonce = 32 位十六进制随机串
 *          ts    = Unix 秒级时间戳
 *          sign  = HMAC-SHA1(ts + nonce + url, KEYS[ts % 5])   // GET 不带 body
 *
 *   列表:  GET /api/cloud/file/list/?folder_id=...
 *   下载:  GET /api/cloud/file/pre-download/?file_id=...&file_url=...
 *          （先换取真实下载地址，再拉文件本体 —— 所以链接是带时效的，必须逐个解析后立即下载）
 */
import crypto from "node:crypto";

export const API_BASE = "https://api.gaojiua.com/release";
export const SITE_ORIGIN = "https://gaojiua.com";
export const TOKEN_COOKIE = "bidai-token";

// 从 bundle 里还原的 5 个签名密钥，按 ts % 5 选取
const KEYS = [
  "SXx$dF+4mwJA@Mt8",
  "t!60uANswex@VP2x",
  "WXKkA7SPJ@3sFDge",
  "mkDRx0h2Tgo&2kmo",
  "mtcX=TK$I!7bPX6U",
];

/**
 * 纯函数：按站点算法算出签名。抽出来是为了能单独做回归测试
 * （站点如果改了密钥或算法，单元测试会立刻失败，而不是等到线上才发现）。
 */
export function computeSign(ts, nonce, url) {
  return crypto.createHmac("sha1", KEYS[ts % 5]).update(`${ts}${nonce}${url}`).digest("hex");
}

/** 生成签名头。url 必须是「路径 + 查询串」，例如 /api/cloud/file/list/?folder_id=1 */
export function makeSignHeaders(url) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  return { nonce, sign: computeSign(ts, nonce, url), ts: String(ts) };
}

/**
 * 复刻前端 Ge()：把对象拼成查询串，key 按字典序排序，null/undefined 跳过，数组展开成同名多参。
 * 注意：不做 URL 编码 —— 前端也是直接字符串拼接的，签名要覆盖同一串，所以必须保持一致。
 */
export function buildQuery(params) {
  const parts = [];
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === null || item === undefined) continue;
        parts.push(`${k}=${item}`);
      }
    } else {
      parts.push(`${k}=${v}`);
    }
  }
  parts.sort();
  return parts.length ? `?${parts.join("&")}` : "";
}

export class GaojiuaClient {
  constructor({ token, userAgent, timeoutMs = 120000, onLog = () => {} }) {
    if (!token) throw new Error("缺少 bidai-token");
    this.token = token;
    this.userAgent = userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";
    this.timeoutMs = timeoutMs;
    this.onLog = onLog;
  }

  /** 带签名与认证的 GET，返回解析后的 JSON。path 必须包含查询串。 */
  async apiGet(path, { raw = false } = {}) {
    const url = API_BASE + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Authorization: `Bearer ${this.token}`,
          AppFingerprint: "bidai",
          PlatformName: "H5",
          SoftVersion: "8000",
          AppVersion: "8000",
          Origin: SITE_ORIGIN,
          Referer: SITE_ORIGIN + "/",
          "User-Agent": this.userAgent,
          ...makeSignHeaders(path),
        },
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }

    if (!res.ok || (json && json.code === "ERROR")) {
      const detail = json?.detail || json?.message || text.slice(0, 200);
      const err = new Error(`接口失败 HTTP ${res.status}: ${detail}`);
      err.status = res.status;
      err.detail = detail;
      err.body = json ?? text;
      // 登录相关错误单独标记，便于上层提示重新登录
      if (res.status === 401 || /登录|token|认证|授权/i.test(String(detail))) {
        err.needsLogin = true;
      }
      // 签名相关错误单独标记
      if (/签名|sign/i.test(String(detail))) err.badSign = true;
      throw err;
    }
    return raw ? { json, text, res } : json;
  }

  /** 列出某个文件夹下的文件。注意：参数名是 parent_id，不是 folder_id（实测 folder_id 被服务端忽略）。 */
  async listFolder(folderId, extra = {}) {
    const path = `/api/cloud/file/list/${buildQuery({ parent_id: folderId, ...extra })}`;
    this.onLog(`  接口: GET ${path}`);
    return this.apiGet(path);
  }

  /**
   * 换取带签名的真实下载地址（有时效，必须解析完立即下载）。
   * 实测响应: {code:"SUCCESS", data:{signed_file_url:"...?sign=<ts>-...", md5:"..."}}
   */
  async preDownload({ fileId, fileUrl }) {
    const path = `/api/cloud/file/pre-download/${buildQuery({ file_id: fileId, file_url: fileUrl })}`;
    return this.apiGet(path);
  }
}

/**
 * 从 pre-download 的响应里取出真实下载地址。
 * 已实测结构为 data.signed_file_url；同时保留兜底扫描，以防服务端改字段。
 */
export function extractDownloadUrl(json) {
  const direct = json?.data?.signed_file_url ?? json?.data?.file_url ?? json?.signed_file_url;
  if (typeof direct === "string" && /^https?:\/\//i.test(direct)) return direct;

  const preferred = ["signed_file_url", "url", "download_url", "downloadUrl", "file_url", "fileUrl", "presigned_url", "signed_url", "link"];
  const found = { hit: null };

  const visit = (node, depth) => {
    if (found.hit || node == null || depth > 6) return;
    if (typeof node === "string") {
      if (/^https?:\/\//i.test(node)) found.hit = node;
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const it of node) visit(it, depth + 1);
      return;
    }
    for (const k of preferred) {
      if (typeof node[k] === "string" && /^https?:\/\//i.test(node[k])) {
        found.hit = node[k];
        return;
      }
    }
    for (const v of Object.values(node)) visit(v, depth + 1);
  };

  visit(json, 0);
  return found.hit;
}

/**
 * 把 list 接口的 data 数组归一化成下载项。
 * 实测字段: id / name / file_type(0=文件,1=目录) / file_url / extension / size / md5 / forbid_download / parent
 */
export function listToItems(json) {
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return arr
    .filter((o) => o && typeof o === "object")
    .filter((o) => Number(o.file_type) === 0) // 只保留文件，跳过目录
    .map((o) => ({
      name: o.name ?? o.file_name ?? "",
      fileId: o.id ?? o.file_id ?? null,
      fileUrl: o.file_url ?? null,
      size: Number(o.size) || 0,
      md5: o.md5 ?? null,
      extension: o.extension ?? null,
      forbidDownload: Boolean(o.forbid_download),
      raw: o,
    }))
    .filter((it) => it.fileId !== null);
}

/** 兼容旧名（早期版本用的启发式解析，保留以防其他地方引用）。 */
export const extractFileItems = listToItems;

/**
 * 找出某个文件夹在云盘里的完整路径（形如 ["大学数学", "线性代数"]）。
 *
 * 接口只能按 id 列子项、拿不到「这个文件夹本身叫什么」，所以从根目录开始做广度优先
 * 搜索，**一旦命中目标就立即返回**——所以顶层文件夹只需 1 次请求。
 *
 * @returns {Promise<string[]|null>} 路径数组；找不到返回 null
 */
export async function findFolderPath(client, targetId, { log = () => {}, maxFolders = 300 } = {}) {
  const target = String(targetId);
  let frontier = [{ id: null, path: [] }];
  const visited = new Set();
  let scanned = 0;

  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      const key = String(node.id);
      if (visited.has(key)) continue;
      visited.add(key);

      if (++scanned > maxFolders) {
        log(`  ⚠ 已扫描 ${maxFolders} 个文件夹仍未找到目标，停止搜索（避免请求过多）`);
        return null;
      }

      let json;
      try {
        json = await client.listFolder(node.id);
      } catch (err) {
        log(`  ⚠ 列目录失败（${node.id ?? "根目录"}）: ${err.message}`);
        continue;
      }
      const arr = Array.isArray(json?.data) ? json.data : [];
      for (const o of arr) {
        if (Number(o.file_type) !== 1 || o.id == null) continue;
        const path = [...node.path, o.name];
        if (String(o.id) === target) return path;
        next.push({ id: String(o.id), path });
      }
    }
    frontier = next;
  }
  return null;
}
