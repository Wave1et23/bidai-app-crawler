/**
 * 文件夹定位与遍历。
 *
 * 云盘接口只能「按 id 列子项」，既拿不到文件夹自己的名字，也不能按名字查。
 * 所以这里做两件事：
 *   1. 从根目录开始按层做广度优先搜索，把「名字」翻译成「id + 路径」；
 *   2. 按层搜索，**在最浅的一层找到唯一匹配就立刻返回**——常见情况下只要 1~2 次请求。
 *
 * 另外支持直接粘贴网页地址：从中解析出 folder_id。
 */

/** 从文件夹页面 URL 里取出 folder_id。 */
export function parseFolderIdFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.searchParams.get("folder_id") || u.searchParams.get("parent_id") || u.searchParams.get("folderId") || null;
  } catch {
    // 也接受直接给一串数字 id
    const m = String(url).trim().match(/^\d+$/);
    return m ? m[0] : null;
  }
}

/** 列出某个文件夹的直接子项，按类型分开。folderId 为 null 表示根目录。 */
export async function fetchChildren(client, folderId) {
  const json = await client.listFolder(folderId);
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const dirs = [];
  const files = [];
  for (const o of arr) {
    if (!o || typeof o !== "object") continue;
    if (Number(o.file_type) === 1 && o.id != null) dirs.push({ id: String(o.id), name: o.name });
    else if (Number(o.file_type) === 0) files.push(o);
  }
  return { dirs, files, raw: arr };
}

/**
 * 按层广度优先搜索名字匹配的文件夹。
 * @param {(a:string,b:string)=>boolean} match
 * @returns {Promise<{id:string,name:string,path:string[]}|null>}
 */
async function searchByNameLevels(client, name, { match, log = () => {}, maxFolders = 500 }) {
  let frontier = [{ id: null, path: [] }];
  const visited = new Set();
  let scanned = 0;

  while (frontier.length) {
    const levelDirs = [];
    const next = [];
    let capped = false;

    for (const node of frontier) {
      const key = String(node.id);
      if (visited.has(key)) continue;
      visited.add(key);
      if (++scanned > maxFolders) {
        capped = true;
        break;
      }
      let kids;
      try {
        kids = await fetchChildren(client, node.id);
      } catch (err) {
        log(`  ⚠ 列目录失败（${node.id ?? "根目录"}）: ${err.message}`);
        continue;
      }
      for (const d of kids.dirs) {
        const p = [...node.path, d.name];
        levelDirs.push({ id: d.id, name: d.name, path: p });
        next.push({ id: d.id, path: p });
      }
    }

    const hits = levelDirs.filter((d) => match(d.name, name));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const err = new Error(`找到 ${hits.length} 个名字匹配「${name}」的文件夹，无法确定是哪一个`);
      err.candidates = hits;
      throw err;
    }
    if (capped) {
      log(`  ⚠ 已扫描 ${maxFolders} 个文件夹仍未命中，停止搜索`);
      return null;
    }
    frontier = next;
  }
  return null;
}

/** 按「父目录/子目录/...」逐级下钻。 */
async function walkPath(client, parts) {
  let currentId = null;
  const path = [];
  for (const part of parts) {
    const kids = await fetchChildren(client, currentId);
    const lower = part.trim().toLowerCase();
    const hit =
      kids.dirs.find((d) => d.name.trim().toLowerCase() === lower) ||
      kids.dirs.find((d) => d.name.toLowerCase().includes(lower));
    if (!hit) {
      const options = kids.dirs.map((d) => d.name).join("、") || "（没有子文件夹）";
      throw new Error(`路径「${parts.join("/")}」中找不到「${part}」。可选项：${options}`);
    }
    currentId = hit.id;
    path.push(hit.name);
  }
  return { id: currentId, path };
}

/**
 * 把用户给的「文件夹选择器」解析成 { id, path }。
 * 支持三种写法：
 *   - 纯数字 id：      1234567890
 *   - 文件夹名字：      2024·高考英语真题        （支持部分匹配）
 *   - 多级路径：        大学数学/线性代数
 */
export async function resolveFolder(client, selector, { log = () => {}, maxFolders = 500 } = {}) {
  const sel = String(selector ?? "").trim();
  if (!sel) throw new Error("没有指定文件夹。用 --folder <名字或id> 或 --url <文件夹页面地址> 指定。");

  if (/^\d+$/.test(sel)) {
    log(`  按文件夹 id 定位: ${sel}`);
    const path = await findFolderById(client, sel, { log, maxFolders });
    if (!path) throw new Error(`云盘里找不到 id 为 ${sel} 的文件夹（可能它已被删除，或不属于当前账号）`);
    return { id: sel, path };
  }

  const parts = sel.split("/").map((s) => s.trim()).filter(Boolean);
  log(`  按文件夹名字定位: ${parts.join(" / ")}`);

  if (parts.length > 1) return await walkPath(client, parts);

  const exact = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  let hit = await searchByNameLevels(client, parts[0], { match: exact, log, maxFolders });
  if (!hit) {
    log(`  未找到完全同名的文件夹，改为模糊匹配...`);
    hit = await searchByNameLevels(client, parts[0], {
      match: (a, b) => a.toLowerCase().includes(b.trim().toLowerCase()),
      log,
      maxFolders,
    });
  }
  if (!hit) {
    throw new Error(`云盘里找不到名字匹配「${sel}」的文件夹。可以先跑 --list 看看有哪些文件夹。`);
  }
  return { id: hit.id, path: hit.path };
}

/** 按 id 反查路径（用于只知道 id、但想按名字建本地子目录的情况）。 */
export async function findFolderById(client, targetId, { log = () => {}, maxFolders = 500 }) {
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
        log(`  ⚠ 已扫描 ${maxFolders} 个文件夹仍未找到目标，停止搜索`);
        return null;
      }
      let kids;
      try {
        kids = await fetchChildren(client, node.id);
      } catch (err) {
        log(`  ⚠ 列目录失败（${node.id ?? "根目录"}）: ${err.message}`);
        continue;
      }
      for (const d of kids.dirs) {
        const p = [...node.path, d.name];
        if (d.id === target) return p;
        next.push({ id: d.id, path: p });
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * 遍历文件夹（可选递归），逐个 yield 每一层的子项，供下载逻辑使用。
 * 用 async generator 是为了边遍历边下载，不必先把整棵树读进内存。
 */
export async function* walkFolders(client, startId, { recursive = false, log = () => {} } = {}) {
  const queue = [{ id: String(startId), rel: [] }];
  const seen = new Set();

  while (queue.length) {
    const node = queue.shift();
    if (seen.has(node.id)) continue;
    seen.add(node.id);

    const kids = await fetchChildren(client, node.id);
    yield { id: node.id, rel: node.rel, dirs: kids.dirs, files: kids.files };

    if (recursive) {
      for (const d of kids.dirs) queue.push({ id: d.id, rel: [...node.rel, d.name] });
    }
  }
}

/**
 * 打印云盘目录树，方便使用者挑文件夹（对应 --list）。
 * 需要逐个文件夹统计文件数，所以会比较慢；用 maxDepth / maxFolders 兜住。
 */
export async function printTree(client, { rootId = null, maxDepth = 3, maxFolders = 120, log = console.log } = {}) {
  let dirCount = 0;
  let fileCount = 0;
  let truncated = false;

  const walk = async (folderId, prefix, depth) => {
    if (truncated) return;

    let kids;
    try {
      kids = await fetchChildren(client, folderId);
    } catch (err) {
      log(`${prefix}└── ⚠ 读取失败: ${err.message}`);
      return;
    }

    const entries = [
      ...kids.files.map((f) => ({ kind: "file", name: f.name })),
      ...kids.dirs.map((d) => ({ kind: "dir", name: d.name, id: d.id })),
    ];

    for (const [i, e] of entries.entries()) {
      const last = i === entries.length - 1;
      const branch = last ? "└── " : "├── ";
      const childPrefix = prefix + (last ? "    " : "│   ");

      if (e.kind === "file") {
        fileCount++;
        log(`${prefix}${branch}📄 ${e.name}`);
        continue;
      }

      if (++dirCount > maxFolders) {
        truncated = true;
        return;
      }
      log(`${prefix}${branch}📁 ${e.name}   [id=${e.id}]`);

      if (depth >= maxDepth) {
        log(`${childPrefix}└── ...（已达最大显示层数 ${maxDepth}）`);
      } else {
        await walk(e.id, childPrefix, depth + 1);
      }
    }
  };

  log("📁 云盘根目录");
  await walk(rootId, "", 1);

  log("");
  log(`共 ${dirCount} 个文件夹${truncated ? "（已截断）" : ""}，根层级另有 ${fileCount} 个散落文件`);
  log("");
  log("下载某个文件夹：");
  log(`  按名字：node src/download.mjs --folder "<上面显示的文件夹名>"`);
  log(`  按 id：  node src/download.mjs --folder <id>`);
}
