/**
 * 配置加载。
 *
 * 设计原则：**config.json 是可选的**。所有配置项都有内置默认值，因此
 *   node src/download.mjs --url "https://.../cloud/files/?folder_id=123"
 * 不建任何配置文件也能直接跑起来。
 *
 * 支持 JSONC（// 与 /* *\/ 注释、尾随逗号），所以 config.example.json 可以写得自解释。
 */
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

/** 内置默认值。CLI 参数与 config.json 都会覆盖这里。 */
export const DEFAULT_CONFIG = {
  outputDir: "./downloads",
  collect: {
    mode: "gaojiua",
    listUrl: "",
    folder: "",
    recursive: false,
  },
  layout: {
    createFolder: true,
    mode: "name",
  },
  naming: {
    mode: "original",
    fallbackPrefix: "file",
  },
  request: {
    delayMs: 800,
    timeoutMs: 120000,
    retries: 3,
    retryBackoffMs: 3000,
    concurrency: 1,
  },
  behavior: {
    skipExisting: true,
    verifySize: true,
    verifyMd5: true,
    /**
     * MD5 与服务器记录不符时怎么办：
     *   "fail"（默认）= 删除临时文件并重试，最终计入失败
     *   "warn"        = 保留文件，但明确告警并记入 report 的 warnings
     * 留这个开关的原因：站点元数据可能是过期的（实测存在 size/md5 与实际内容不符、
     * 但 Content-Length 与实际字节数一致且文件本身合法完整的文件）。
     */
    md5Mismatch: "fail",
    overwrite: false,
  },
  profileDir: ".browser-profile",
  authStateFile: "auth-state.json",
};

/**
 * 去掉 JSONC 里的注释与尾随逗号。
 * 用状态机而不是正则，避免把字符串里的 "//" 或 ",}" 误伤。
 */
export function stripJsonComments(text) {
  let out = "";
  let inStr = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        if (n !== undefined) {
          out += n;
          i++;
        }
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    // 尾随逗号：后面（跳过空白）紧跟 } 或 ] 时丢掉
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

/** 读 JSON / JSONC，容忍 UTF-8 BOM（记事本保存的中文配置常带 BOM）。 */
export function readJson(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(stripJsonComments(raw));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 递归合并（用户配置覆盖默认值）。 */
function merge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (k.startsWith("$")) continue; // 允许 "//" 之外的说明性键
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

/**
 * 加载配置。
 * 优先级：内置默认值 < config.json < 代码里的 CLI 覆盖（由调用方在 loadConfig 之后应用）
 */
export function loadConfig() {
  const file = process.env.BIDAI_CONFIG ? path.resolve(process.env.BIDAI_CONFIG) : path.join(ROOT, "config.json");

  let userCfg = {};
  let usedFile = null;
  if (fs.existsSync(file)) {
    userCfg = readJson(file);
    usedFile = file;
  }

  // 兼容旧字段名
  if (userCfg.collect?.folderId && !userCfg.collect.folder) {
    userCfg.collect.folder = String(userCfg.collect.folderId);
  }

  const cfg = merge(DEFAULT_CONFIG, userCfg);

  // 兼容别名：早期版本 listUrl 是顶层字段，现在归到 collect 下。
  // 内部仍有若干处引用 cfg.listUrl，这里统一兜住，避免两条路径行为不一致。
  cfg.listUrl = cfg.collect.listUrl || cfg.listUrl || "";

  cfg.root = ROOT;
  cfg.configFile = usedFile;
  cfg.exampleConfigFile = path.join(ROOT, "config.example.json");
  cfg.outputDir = path.resolve(ROOT, cfg.outputDir || "./downloads");
  cfg.profileDir = path.resolve(ROOT, cfg.profileDir || ".browser-profile");
  cfg.authStateFile = path.resolve(ROOT, cfg.authStateFile || "auth-state.json");

  return cfg;
}

/** 把任意字符串转成 Windows / macOS / Linux 下都合法的文件名或目录名。 */
export function safeFileName(name, fallback = "file") {
  let out = String(name ?? "")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (!out) out = fallback;
  // Windows 保留设备名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = `_${out}`;
  return out.slice(0, 180);
}
