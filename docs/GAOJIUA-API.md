# 笔袋（gaojiua.com）接口逆向笔记

这份文档记录了本工具依赖的全部站点细节，以及**站点改版后如何重新逆向**。

所有信息都是从站点自己的前端 JS 里还原出来的，不是猜测。目标站点的接口没有任何公开文档。

---

## 1. 站点结构

| 部分 | 位置 |
|---|---|
| 前端页面 | `https://gaojiua.com`（Vue SPA，静态资源托管在腾讯 COS 上） |
| 数据接口 | `https://api.gaojiua.com/release`（同步）/ `.../arelease`（异步） |
| 文件本体 | `https://cloud.gaojiua.com/data/...` |

前端是纯 SPA：直接请求页面地址只会拿到几百字节的 HTML 外壳和一堆 JS，文件列表是 JS 渲染的。所以**不能靠抓 HTML**，必须直接调它的 JSON 接口。

---

## 2. 认证

```
Authorization: Bearer <bidai-token>
```

`bidai-token` 是一个 JWT，存在**域名 `.gaojiua.com`** 的 Cookie 里（因此对 `api.gaojiua.com` 和 `cloud.gaojiua.com` 也可见）。

前端逻辑是「优先用内存里的 userInfo.token，没有就退回读 Cookie」，两者取其一即可。

### 另外必须带的固定请求头

少任何一个都会被拒：

```
AppFingerprint: bidai
PlatformName: H5
SoftVersion: 8000
AppVersion: 8000
```

---

## 3. 请求签名

除了认证头，每个接口请求还必须带三个签名头：`nonce`、`ts`、`sign`。

### 算法

```
ts     = Unix 秒级时间戳
nonce  = 32 位十六进制随机串（uuid 去掉横线）
msg    = ts + nonce + url            // GET 请求不拼接 body
sign   = HMAC-SHA1(msg, KEY) 的十六进制小写
KEY    = KEYS[ts % 5]
```

其中 `url` 是**路径 + 查询串**，例如 `/api/cloud/file/list/?parent_id=1`。

### 密钥表（直接取自前端 bundle，按 `ts % 5` 选取）

```js
const KEYS = [
  "SXx$dF+4mwJA@Mt8",   // ts % 5 === 0
  "t!60uANswex@VP2x",   // 1
  "WXKkA7SPJ@3sFDge",   // 2
  "mkDRx0h2Tgo&2kmo",   // 3
  "mtcX=TK$I!7bPX6U",   // 4
];
```

这些是前端里硬编码的常量（不是你的个人凭证），所以放在仓库里没有安全问题。

### 回归测试向量

固定输入必须得到固定输出：

| 输入 | 值 |
|---|---|
| `ts` | `1700000000` |
| `nonce` | `0123456789abcdef0123456789abcdef` |
| `url` | `/api/cloud/file/list/?parent_id=1` |
| **`sign`** | `ca70be677128a34a1e60b3638a2a76db86ea2384` |

`npm test` 会校验这个向量。如果哪天失败了，说明密钥表或拼接顺序被改坏了。

### 查询串的构造规则

前端的 `Ge()` 函数负责把参数对象拼成查询串，规则很特殊，**必须严格复刻**（因为签名要覆盖同一串）：

1. 参数名按**字典序排序**
2. 跳过值为 `null` / `undefined` 的项
3. 数组展开成同名多参：`{a:[1,2]}` → `a=1&a=2`
4. **不做 URL 编码** —— 直接字符串拼接，所以 `file_url=https://...` 里的 `:` 和 `/` 是原样的

实现见 `src/sites/gaojiua.mjs` 的 `buildQuery()`。

---

## 4. 接口清单

### 4.1 列文件

```
GET /api/cloud/file/list/?parent_id=<文件夹id>&page=<页码>&page_size=<每页条数>
```

- **参数名是 `parent_id`，不是 `folder_id`！**
  实测传 `folder_id` 服务端**不报错**，而是直接返回根目录 —— 这是个很容易踩的坑，会让人以为"接口通了"但下错东西。
- 不带 `parent_id` 即列根目录。
- 没有"按名字查文件夹"的接口，只能从根开始逐层列（本工具的 `src/folders.mjs` 就是这么做的）。

#### ⚠️ 必须翻页，否则会静默丢数据

**这个接口默认每页只返回 20 条**，而且响应里**没有任何分页元信息**（只有 `code` 和 `data`，没有 `total`/`has_more`）。实测数据：

| 请求 | 返回条数 |
|---|---|
| 不带分页参数 | **20**（被截断） |
| `page_size=1` | 1 |
| `page_size=50` / `100` / `200` / `1000` | 32（全量） |
| `page=2`（默认页大小） | 12（剩余部分） |

也就是说：**一个 30 个文件的文件夹，不翻页只会拿到 20 个，而且不报任何错。**

实测确认的语义：

- `page` 是 **1 起始**（`page=1` 从第一条开始）
- 翻页**不重叠、无遗漏**（逐页取完后去重，条数与全量一致）
- `page_size` 可以放大，实测到 1000 仍正常返回
- 到底的判断只能靠「本页条数 < `page_size`」——因为没有 `total` 字段

本工具的处理：显式带 `page_size=200`（`DEFAULT_PAGE_SIZE`），并循环翻页直到某一页不满；若翻到 `MAX_PAGES` 上限还没取完，**直接抛错而不是假装成功**（宁可报错，也不能悄悄少下文件）。实现见 `src/sites/gaojiua.mjs` 的 `fetchAllPages()`。

响应：

```json
{
  "code": "SUCCESS",
  "data": [
    {
      "id": 1234567890,
      "name": "示例文件.docx",
      "file_type": 0,
      "file_url": "https://cloud.gaojiua.com/data/abcdef0123456789....docx",
      "extension": "docx",
      "size": 69325,
      "md5": "0123456789abcdef0123456789abcdef",
      "forbid_download": false,
      "forbid_print": false,
      "parent": 1234567890,
      "creator": 1000001,
      "uploader": 1000002
    }
  ]
}
```

字段含义：

| 字段 | 说明 |
|---|---|
| `id` | 文件 / 文件夹 id |
| `name` | 显示名（含扩展名） |
| `file_type` | **`0` = 文件，`1` = 文件夹** |
| `file_url` | 文件在对象存储上的原始地址；**目录为 `null`** |
| `size` | 字节数 |
| `md5` | 文件 MD5 —— 本工具用它做端到端校验 |
| `forbid_download` | 服务端标记禁止下载时跳过 |
| `parent` | 所属文件夹 id（根目录为 `null`） |

### 4.2 换取下载地址

```
GET /api/cloud/file/pre-download/?file_id=<id>&file_url=<url>
```

参数同样由 `Ge()` 排序拼接，且 **`file_url` 不做编码**。

响应：

```json
{
  "code": "SUCCESS",
  "data": {
    "signed_file_url": "https://cloud.gaojiua.com/data/4eca1769....docx?sign=1790337068-926f4d01-0-37f9e1b6c52748cfbd7c8010ee3de89f",
    "md5": "db3d66f2014b1664746f2b4184a00508"
  }
}
```

### 4.3 其它已识别但未使用的接口

从同一个前端类里读出、目前用不到的：`/api/cloud/file/search/`、`/list-trash/`、`/delete/`、`/rename/`、`/move/`、`/queue/add/`、`/doc/preview/`、`/api/async/cloud/file/create/`。

---

## 5. 下载链路（两步，不能省）

```
① 直接访问 file_url
   → HTTP 403 Forbidden（返回 17 字节的 "invalid..."）

② GET /api/cloud/file/pre-download/?file_id=..&file_url=..
   → 拿到 data.signed_file_url（带 ?sign= 参数）

③ GET signed_file_url
   → HTTP 200 / 206，得到文件本体
```

**关键点：签名地址是有时效的**（`sign` 参数里带时间戳），所以不能提前把所有链接批量取好存起来，必须「解析一个、立刻下载一个」。本工具是通过给每个下载项挂一个 `resolve()` 回调来实现的 —— 在真正发请求前的那一瞬间才去换地址。

签名地址支持 `Range` 请求（实测返回 206），所以整文件下载和断点校验都能正常工作。

---

## 6. 站点改版了怎么办

站点前端改版后，密钥或接口路径可能变化，表现为：

- `doctor` 提示「签名校验没过」
- 接口返回 4xx 且错误信息与签名相关
- 列文件返回空或结构变化

重新逆向的步骤：

### 第 1 步：拿到最新的前端 bundle

```bash
# 1) 打开站点，查看源码里的 script 标签
node src/probe.mjs "https://gaojiua.com/cloud/files/" --no-auth
```

输出里会列出 JS 入口文件（形如 `https://gaojiua.com/assets/index-XXXX.js`）。

### 第 2 步：下载并搜索关键字

```bash
# 用 node 下载（Windows 上 curl/Invoke-WebRequest 可能因 TLS 配置失败）
node -e "fetch('https://gaojiua.com/assets/index-XXXX.js').then(r=>r.text()).then(t=>require('fs').writeFileSync('app.js',t))"
```

因为是压缩过的单行文件，直接 grep 不好看，建议搜关键字并打印上下文：

```bash
node -e "
const s=require('fs').readFileSync('app.js','utf8');
for (const kw of ['pre-download','AppFingerprint','getTokenInCookie','list/']) {
  let i=0,n=0;
  while((i=s.indexOf(kw,i))>=0 && n<3){ console.log('===',kw,'@',i,'\n',s.slice(i-250,i+250).replace(/\s+/g,' '),'\n'); i+=kw.length; n++; }
}
"
```

### 第 3 步：核对这几处

| 要找的东西 | 搜索关键字 |
|---|---|
| 签名函数（生成 nonce/ts/sign） | `q-sign-algorithm`、`HmacSHA1`、`KEYS` 附近的字符串数组 |
| 密钥表 | 搜索签名函数里那个字符串数组，通常是 5 个 |
| 请求拦截器（认证头） | `AppFingerprint`、`Bearer` |
| 接口基址 | `api.gaojiua.com`、`baseURL` |
| 列文件接口 | `cloud/file/list` |
| 下载接口 | `pre-download` |
| token 的存取 | `getTokenInCookie`、`bidai-token` |

### 第 4 步：更新代码并跑测试

改 `src/sites/gaojiua.mjs`（`KEYS` / `computeSign` / `buildQuery` / `listFolder` / `preDownload`），然后：

```bash
npm test                 # 签名回归向量会告诉你算法是否还对
node src/doctor.mjs      # 端到端确认真实接口通了
```

如果算法变了，记得同步更新本文档和 `npm test` 里的 `SIGN_VECTOR`。

---

## 7. 合规提示

以上均为公开前端代码中可读到的技术信息，记录在此是为了让工具在站点改版后可维护。

请只下载你自己有权访问的文件，并遵守站点服务条款。默认限速（每文件间隔 800ms、串行）请勿随意调小。
