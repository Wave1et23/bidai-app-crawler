# bidai-app-crawler

**笔袋（gaojiua.com）云盘批量下载爬虫工具** —— 把网页里的文件夹整个下载到本地，自动按原目录结构建子目录。

手工点几十次「下载」很烦。这个工具让你一条命令下完一整个文件夹，而且：

- ✅ **按文件夹名字下载**，不用去翻网页源码找 id
- ✅ **断点续传**：中断了重跑就行，已下载的自动跳过
- ✅ **完整性校验**：比对体积 + 与服务器下发的 MD5 逐字节核对
- ✅ **按网页结构建目录**：`下载目录/2024·高考英语真题/xxx.docx`
- ✅ **失败自动重试**，失败清单落到 `report.json`，重跑只补失败的
- ✅ 附带 `--json` 输出和 `doctor` 自检，**方便交给 AI agent 使用**

> 只用 Node.js 标准库 + 一个 HTML 解析库，不需要 Selenium。

---

## 快速开始

### 1. 安装

```bash
git clone https://github.com/Wave1et23/bidai-app-crawler.git
cd bidai-app-crawler
npm install
```

需要 Node.js 18.17 或更高版本。

### 2. 拿到你的登录凭证（token）

在浏览器里打开 [https://gaojiua.com/cloud/](https://gaojiua.com/cloud/)并登录你自己的账号，然后：

1. 按 **F12** 打开开发者工具
2. 切到 **Application**（中文版叫「应用程序」）
3. 左侧 **Cookies** → 点开你站点的地址
4. 找到名为 **`bidai-token`** 的那一行，复制它的 **Value**

要完整复制，**双击单元格**再 Ctrl+C（单击可能只选中一部分）。

> 这个值等同于你的登录凭证，有效期较长。**不要提交到 git、不要发给别人。**
> 怀疑泄露时，在网站上退出登录即可让它失效。

把它存到**用户目录**（推荐，这样凭证不在项目里，怎么折腾都不会误提交）：

```powershell
# Windows PowerShell
Set-Content "$env:USERPROFILE\.bidai-token" "把token粘到这里" -NoNewline
```

```bash
# macOS / Linux
echo -n "把token粘到这里" > ~/.bidai-token
```

也可以临时用 `--token=<值>` 或环境变量 `BIDAI_TOKEN` 传入。

### 3. 看看有哪些文件夹，然后下载

```bash
node src/download.mjs --list                          # 列出云盘里的文件夹
node src/download.mjs --folder "2024·高考英语真题"      # 下载这个文件夹
```

---

## 常用命令

```bash
# 先看要下什么，不实际下载（不会有任何写入）
node src/download.mjs --folder "2024·高考英语真题" --dry-run

# 直接粘贴网页地址，脚本自动解析出文件夹
node src/download.mjs --url "https://gaojiua.com/cloud/files/?folder_id=1234567890"

# 先试下 3 个，确认没问题再全量
node src/download.mjs --folder "2024·高考英语真题" --limit 3

# 指定保存位置
node src/download.mjs --folder "2024·高考英语真题" --out "D:\资料\英语"

# 连同子文件夹一起下载，并保留完整层级
node src/download.mjs --folder "大学数学" --recursive --with-path

# 出问题时先自检
node src/doctor.mjs --folder "2024·高考英语真题"
```

### 全部参数

| 参数 | 说明 |
|---|---|
| `--list` / `--tree` | 列出云盘里的文件夹（挑文件夹用） |
| `--url <页面地址>` | 你在浏览器里打开的那个文件夹页面地址，自动取 `folder_id` |
| `--folder <名字或id>` | 要下载的文件夹。支持中文名、部分匹配、`父目录/子目录` 多级路径 |
| `--out <目录>` | 保存到哪个目录（默认 `./downloads`） |
| `--flat` | 不要子目录，文件平铺在输出目录 |
| `--with-path` | 子目录带完整层级（`大学数学/线性代数/`） |
| `--recursive` / `-r` | 连同子文件夹一起下载 |
| `--dry-run` | 只列清单，不下载 |
| `--limit <N>` | 只处理前 N 个文件 |
| `--json` | 以 JSON 输出（便于脚本或 agent 解析） |
| `--token <值>` | 临时指定 token |
| `--init` | 根据 `config.example.json` 生成 `config.json` |
| `--help` / `-h` | 帮助 |

---

## 交给 AI agent 用

这个工具是照着「让 agent 直接调用」设计的。你只需要把下面三样东西给 agent，它就能自己完成下载：

1. **凭证** —— 你的 `bidai-token`（或已登录好的浏览器里那个 Cookie）
2. **目标** —— 文件夹的网页地址，或者文件夹的名字
3. **保存位置** —— 想存到哪个目录

典型的 agent 调用流程：

```bash
node src/doctor.mjs                                  # 1. 先自检凭证和下载链路是否通
node src/download.mjs --list --json                  # 2. 拿到文件夹清单（机读）
node src/download.mjs --url "<页面地址>" --dry-run --json   # 3. 确认待下载清单
node src/download.mjs --url "<页面地址>" --out "<目录>"      # 4. 正式下载
```

设计上为 agent 做了这些事：

- **凭证可以完全脱离项目目录**（`~/.bidai-token` 或环境变量），agent 不需要往仓库里写密钥
- **`--json`** 让每一阶段的输出都能被程序解析
- **失败原因机读**：凭证失效时 `report.json` 里会有 `stage: "collect"` 和 `needsCredentials: true`
- **幂等**：重复执行不会重复下载，agent 可以放心重试
- **`doctor`** 能明确区分「token 失效」和「站点改版导致签名算法变化」

---

## 保存目录长什么样

默认会按网页里的文件夹结构建子目录：

```
downloads/
└── 2024·高考英语真题/
    ├── 2024年高考英语试卷（浙江）（1月）（解析卷）.docx
    ├── 2024年高考英语试卷（浙江）（1月）（空白卷）.docx
    └── ...（共 12 个）
```

加 `--recursive` 时，子文件夹会在本地镜像成嵌套目录；加 `--with-path` 则会从云盘根目录开始保留完整层级。

不想建子目录就加 `--flat`。

---

## 配置文件（可选）

**不建配置文件也能用** —— 所有选项都有默认值，命令行参数就足够了。

想长期固定某些设置的话：

```bash
node src/download.mjs --init        # 从模板生成 config.json
```

然后编辑 `config.json`。它支持注释（JSONC），模板里每一项都有说明。`config.json` 属于个人配置，已在 `.gitignore` 中排除——仓库里只保留 `config.example.json`。

---

## 出问题了？

先跑自检：

```bash
node src/doctor.mjs --folder "你的文件夹"
```

它会依次检查并明确告诉你卡在哪一步：

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `401 请登录` | token 失效或复制不全 | 重新获取 token（见上文） |
| 提示**签名校验没过** | 站点前端改了签名算法 | 需要更新 `src/sites/gaojiua.mjs`，见 [docs/GAOJIUA-API.md](docs/GAOJIUA-API.md) |
| 找不到文件夹 | 名字不匹配 | 先跑 `--list` 看准确名字，或用 `--folder <id>` |
| 找到多个同名文件夹 | 重名 | 用 `--folder "父目录/子目录"` 或直接给 id |
| 某个文件一直失败 | 该文件有问题 | 看 `report.json` 里的失败原因，重跑会自动只补失败的 |

想看详细的报错堆栈，加上环境变量 `BIDAI_DEBUG=1`。

---

## 它是怎么工作的

站点是个 Vue SPA，前端托管在静态存储上，数据走 `api.gaojiua.com`。这个工具没有去模拟浏览器点击，而是**复刻了网页自己的请求**：逆向出接口地址、必需的请求头，以及一套 HMAC-SHA1 签名算法。

下载是两步：先调 `pre-download` 接口换一个**带时效签名的临时地址**，再拉文件本体。所以链接没法提前批量取好，必须「解析一个、立刻下载一个」——工具内部就是这么做的。

完整的技术细节（接口清单、签名算法、字段含义、站点改版后怎么重新逆向）都在 **[docs/GAOJIUA-API.md](docs/GAOJIUA-API.md)**。

---

## 开发

```bash
npm test                # 跑测试（不需要联网、不需要账号）
npm run doctor          # 自检
npm run check-secrets   # 提交前扫描有没有混进凭证
```

测试分两层：

- **单元测试**：配置解析（JSONC）、文件名安全处理、URL 解析、查询串构造、**签名算法回归向量**
- **端到端测试**：起一个本地假站点，用真实 CLI 完整下载一遍，校验落盘文件的体积与 MD5、断点续传、`--limit`、以及凭证失效时是否正确中止

项目结构：

```
src/
├── download.mjs        命令行入口（参数解析 + 下载循环）
├── doctor.mjs          自检 / 诊断
├── login.mjs           可选的浏览器登录（手机号+短信验证码）
├── collect.mjs         文件清单获取（多种模式）
├── folders.mjs         文件夹定位与遍历（按名字/URL/id）
├── sites/gaojiua.mjs   笔袋站点适配：签名、接口、字段解析
├── session.mjs         会话与 HTTP 封装
├── token.mjs           凭证解析（--token / 环境变量 / ~/.bidai-token / 项目内 / Cookie）
├── config.mjs          配置加载（JSONC、默认值合并）
└── probe.mjs           通用站点诊断（研究新站点时用）
scripts/check-secrets.mjs   提交前密钥扫描
test/                       本地假站点 + 测试套件
docs/GAOJIUA-API.md         逆向出来的接口与签名说明
```

### 适配其他站点

`src/collect.mjs` 里预留了另外几种取文件清单的模式（`selector` 直接解析页面链接、`detail` 逐层进详情页、`api` 调 JSON 接口、`browser` 用浏览器渲染）。改站点适配的入口是 `src/sites/` 下新增一个模块，实现 `listFolder` / `preDownload` 两个方法，再在 `collect.mjs` 里加一个分支即可。

---

## 安全性

- 仓库里**不包含任何凭证**。`.bidai-token`、`auth-state.json`、`config.json` 全部在 `.gitignore` 中
- 推荐把 token 放在 `~/.bidai-token`（用户目录），这样它根本不在项目里
- `npm run check-secrets` 会在提交前扫描 JWT、GitHub token、私钥、含真实取值的密钥赋值、以及泄露用户名的本机绝对路径
- **注意**：`.gitignore` 只能挡住「还没被 git 跟踪」的文件。一旦某文件被提交过（哪怕误用 `git add -f`），`.gitignore` 就再也不起作用了，所以提交前请跑一次 `check-secrets`

---

## 免责声明

- 请只用于下载**你自己有权访问**的文件。
- 请遵守目标站点的服务条款与 robots 政策。
- 默认串行下载 + 每个文件之间 800ms 间隔，就是为了不给对方服务器造成压力，**请不要为了快而把间隔调到很小**。
- 本工具仅供个人学习与自用，使用风险自负。

## License

[MIT](LICENSE)
