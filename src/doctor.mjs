/**
 * 自检 / 诊断工具。
 *
 * 出问题时第一个该跑的就是它：它会依次检查
 *   1. 凭证 token 是否可用
 *   2. 接口是否连得通（顺带确认签名算法没被服务端改掉）
 *   3. 指定文件夹能否列出来
 *   4. 下载链路是否通（换取签名地址 → 用 Range 只取前 1KB 验证，不会下载整个文件）
 *
 * 用法:
 *   node src/doctor.mjs
 *   node src/doctor.mjs --folder "2024·高考英语真题"
 *   node src/doctor.mjs --url "https://gaojiua.com/cloud/files/?folder_id=1234567890"
 */
import { loadConfig } from "./config.mjs";
import { resolveToken, tokenHelp } from "./token.mjs";
import { GaojiuaClient, extractDownloadUrl } from "./sites/gaojiua.mjs";
import { resolveFolder, fetchChildren, parseFolderIdFromUrl } from "./folders.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const cfg = loadConfig();

main().catch((err) => {
  console.error(`\n✗ ${err?.message || err}`);
  if (process.env.BIDAI_DEBUG) console.error(err?.stack);
  process.exitCode = 1;
});

/** 常见文件类型的 magic number，用来确认下到的确实是文件而不是错误页。 */
const MAGIC = [
  { hex: "504b0304", what: "zip 容器（docx/xlsx/pptx 等都是它）" },
  { hex: "25504446", what: "PDF" },
  { hex: "d0cf11e0", what: "旧版 Office（doc/xls/ppt）" },
  { hex: "89504e47", what: "PNG" },
  { hex: "ffd8ff", what: "JPEG" },
  { hex: "52617221", what: "RAR" },
  { hex: "1f8b", what: "gzip" },
];

async function main() {
  const results = [];

  /* ---------- 1. 凭证 ---------- */
  console.log("────────── 1) 检查登录凭证 ──────────");
  const { token, source } = resolveToken(cfg);
  if (!token) {
    console.error(tokenHelp());
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 找到 token（来源: ${source}，长度 ${token.length}）`);
  if (token.split(".").length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
      if (payload.exp) {
        const exp = new Date(payload.exp * 1000);
        const days = Math.round((exp - Date.now()) / 86400000);
        console.log(`  JWT 载荷: 有效期至 ${exp.toISOString().slice(0, 10)}（${days > 0 ? `还有 ${days} 天` : "已过期"}）`);
      }
    } catch {
      /* 不是 JWT 也没关系 */
    }
  }
  results.push("凭证存在");

  const client = new GaojiuaClient({ token, timeoutMs: cfg.request.timeoutMs });

  /* ---------- 2. 接口连通性 ---------- */
  console.log("\n────────── 2) 检查接口连通性 ──────────");
  try {
    const kids = await fetchChildren(client, null);
    console.log(`✓ 接口连通，根目录有 ${kids.dirs.length} 个文件夹、${kids.files.length} 个文件`);
    results.push("接口连通");
  } catch (err) {
    console.error(`✗ 接口请求失败: ${err.message}`);
    if (err.needsLogin) {
      console.error("  → token 无效或已过期，请重新获取。获取方法见 --help 的「凭证」一节。");
    } else if (err.badSign) {
      console.error("  → 签名校验没过，说明站点前端改了签名算法，需要更新 src/sites/gaojiua.mjs。");
    }
    process.exitCode = 1;
    return;
  }

  /* ---------- 3. 定位文件夹 ---------- */
  let selector = opt("--folder");
  if (!selector && opt("--url")) selector = parseFolderIdFromUrl(opt("--url"));
  if (!selector && cfg.collect.folder) selector = cfg.collect.folder;
  if (!selector && cfg.collect.listUrl) selector = parseFolderIdFromUrl(cfg.collect.listUrl);

  if (!selector) {
    console.log("\n────────── 3) 定位文件夹 ──────────");
    console.log("（未指定文件夹，跳过。用 --folder 或 --url 指定后可以继续检查下载链路）");
    console.log("\n小提示：先跑 node src/download.mjs --list 看看有哪些文件夹。");
    return;
  }

  console.log("\n────────── 3) 定位文件夹 ──────────");
  let target;
  try {
    target = await resolveFolder(client, selector, { log: (m) => console.log(m) });
    console.log(`✓ 定位到: ${target.path.join(" / ")}   [id=${target.id}]`);
    results.push("文件夹定位");
  } catch (err) {
    console.error(`✗ ${err.message}`);
    if (err.candidates) err.candidates.forEach((c) => console.error(`   候选: ${c.path.join(" / ")}  [id=${c.id}]`));
    process.exitCode = 1;
    return;
  }

  const kids = await fetchChildren(client, target.id);
  console.log(`  该文件夹: ${kids.files.length} 个文件、${kids.dirs.length} 个子文件夹`);
  kids.files.slice(0, 10).forEach((f, i) => {
    const mb = f.size ? ` (${(f.size / 1048576).toFixed(2)} MB)` : "";
    console.log(`    ${String(i + 1).padStart(3)}. ${f.name}${mb}`);
  });
  if (kids.files.length > 10) console.log(`    ... 其余 ${kids.files.length - 10} 个略`);

  const sample = kids.files[0];
  if (!sample) {
    console.log("\n（该文件夹没有文件，下载链路检查跳过）");
    return;
  }

  /* ---------- 4. 下载链路 ---------- */
  console.log("\n────────── 4) 检查下载链路 ──────────");
  const fileId = sample.id ?? sample.file_id;
  const fileUrl = sample.file_url ?? sample.fileUrl;
  console.log(`样本: ${sample.name}`);
  console.log(`  直接访问 file_url（跳过换取签名地址）:`);
  try {
    const direct = await fetch(fileUrl, { headers: { Range: "bytes=0-63" } });
    const directBody = Buffer.from(await direct.arrayBuffer());
    const isError = direct.status >= 400 || directBody.toString("utf8").slice(0, 20).toLowerCase().includes("invalid");
    console.log(`    HTTP ${direct.status} ${isError ? "→ 需要签名（正常，符合预期）" : "→ 居然直接可下"}`);
  } catch (err) {
    console.log(`    请求失败: ${err.message}`);
  }

  let realUrl;
  try {
    const pre = await client.preDownload({ fileId, fileUrl });
    realUrl = extractDownloadUrl(pre);
    console.log(`✓ 换取签名地址成功`);
    console.log(`    ${String(realUrl).slice(0, 110)}...`);
    results.push("换取签名地址");
  } catch (err) {
    console.error(`✗ 换取签名地址失败: ${err.message}`);
    if (err.body) console.error(`   响应: ${JSON.stringify(err.body).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  try {
    const res = await fetch(realUrl, { headers: { Range: "bytes=0-1023" } });
    const buf = Buffer.from(await res.arrayBuffer());
    const hex = buf.subarray(0, 4).toString("hex");
    const magic = MAGIC.find((m) => hex.startsWith(m.hex));
    console.log(`\n  用 Range 只取前 1KB 验证（不下载整个文件）:`);
    console.log(`    HTTP ${res.status}  Content-Type=${res.headers.get("content-type")}`);
    console.log(`    实际收到 ${buf.length} 字节，文件头 ${hex}`);
    console.log(`    识别为: ${magic ? "✓ " + magic.what : "⚠ 未知类型（也可能是正常的）"}`);
    if (res.ok && buf.length > 0) {
      console.log(`✓ 下载链路正常，可以正式下载了`);
      results.push("下载链路");
    } else {
      console.error(`✗ 下载链路异常`);
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    console.error(`✗ 下载验证失败: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  /* ---------- 汇总 ---------- */
  console.log("\n────────── 自检通过 ──────────");
  console.log(`通过项: ${results.join(" / ")}`);
  console.log(`\n下一步：`);
  console.log(`  node src/download.mjs --folder "${target.path.join("/")}" --dry-run`);
  console.log(`  node src/download.mjs --folder "${target.path.join("/")}"`);
}
