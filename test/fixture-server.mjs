/**
 * 测试用的本地假站点：一个列表页 + 几个可下载文件。
 * 不依赖真实站点即可验证下载引擎（分页、重试、大小校验、跳过已存在、断点续传）。
 *
 * 直接运行：node test/fixture-server.mjs
 * 也可以被 test/run-tests.mjs 以模块方式引入。
 */
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

export function createFixtureServer({ port = 0 } = {}) {
  // 故意造几个大小不同的文件
  const files = {};
  for (const [name, kb] of [
    ["alpha.pdf", 64],
    ["beta.xlsx", 128],
    ["gamma.zip", 256],
    ["delta.pdf", 32],
  ]) {
    const buf = crypto.randomBytes(kb * 1024);
    if (name.endsWith(".pdf")) buf.write("%PDF-1.4\n", 0, "utf8");
    files[name] = buf;
  }

  // flaky.bin 前两次请求会中途断流，用来测「失败 → 重试 → 成功」
  let flakyHits = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port || 1}`);
    const base = `http://127.0.0.1:${server.address()?.port ?? port}`;

    if (url.pathname === "/" || url.pathname === "/list") {
      const page = Number(url.searchParams.get("page") || 1);
      const links = Object.keys(files)
        .map((n) => `    <li><a href="/files/${n}">${n}</a></li>`)
        .join("\n");
      // 第 2 页故意放一个不存在的文件（404），用来测失败处理
      const body2 = `    <li><a href="/files/epsilon.pdf">epsilon.pdf</a></li>`;
      const next = page === 1 ? `<a href="${base}/list?page=2">下一页</a>` : "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>文件列表 第${page}页</title></head>\n` +
          `<body><h1>文件列表</h1><ul>\n${page === 1 ? links : body2}\n</ul>${next}</body></html>`
      );
      return;
    }

    if (url.pathname.startsWith("/files/")) {
      const name = decodeURIComponent(url.pathname.slice("/files/".length));

      if (name === "flaky.bin") {
        flakyHits++;
        if (flakyHits <= 2) {
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "999999" });
          res.write("partial");
          res.destroy();
          return;
        }
      }

      const buf = files[name];
      if (!buf) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
        "Content-Length": String(buf.length),
        "Content-Disposition": `attachment; filename="${name}"`,
      });
      res.end(buf);
      return;
    }

    // 一个需要登录的页面，用来测「凭证失效时立即中止」
    if (url.pathname === "/needs-login") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body>请登录 输入手机号获取验证码</body></html>");
      return;
    }

    res.writeHead(404).end("nope");
  });

  return { server, files, base: () => `http://127.0.0.1:${server.address().port}` };
}

/* 直接运行时，起在固定端口上方便手工调试 */
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isDirectRun) {
  const port = Number(process.env.PORT || 8899);
  const { server, files } = createFixtureServer({ port });
  server.listen(port, "127.0.0.1", () => {
    console.log(`fixture server: http://127.0.0.1:${port}/list`);
    console.log(`files: ${Object.keys(files).join(", ")}`);
  });
}
