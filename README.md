# dsh-vision-direct

给 DeepSeek Harness 的纯文本模型一双自己的眼睛：一个读图工具、一条粘贴通道，和一个可选的本机兼容端点。

**不依赖任何外部视觉工具**——没有 CLI 子进程、没有第三方包、不读写别的程序的配置。视觉上游是你自己填的任意 OpenAI / Anthropic 兼容端点。

> English: A self-contained vision backend for DSH. It registers its own `vision_read_image` tool, turns pasted images into local file paths, and optionally exposes a loopback OpenAI/Anthropic-compatible endpoint. No external vision CLI, no third-party runtime dependency.

## 和同分类其它视觉插件的区别

同类插件大多走「贴图后立刻转成一段文字描述再喂给主模型」的路子。本插件走的是另一条：**插件自己不描述图片，只把图片变成主模型能主动调用的能力**。四条实质差别：

| | 一次性转译派 | 本插件 |
|---|---|---|
| 贴图之后 | 立刻送视觉模型，结果作为隐藏上下文塞进对话 | 只落盘 + 把**路径**插进输入框，图片不占上下文预算 |
| 模型怎么用 | 被动收到一段别人写好的描述，摘要即全部 | 主动调 `vision_read_image`，可按需重读、追问同一张图的其它方面 |
| 输出形态 | 一段自然语言观感 | 结构化证据：逐字 OCR / 按阅读顺序的版面区域 / 语义 / 颜色风格 / **不确定项单列** |
| 上游 | 通常绑定某家免费视觉模型或某个固定 provider | **你填任意 OpenAI 或 Anthropic 兼容端点**，两套协议字段各自独立 |

另外两点别人没有的：

- **可选回环兼容端点**：把同一份配置暴露成 `127.0.0.1` 上的 OpenAI / Anthropic 兼容端口，让别的程序也能借用这套视觉能力。默认关闭。
- **密钥不进环境变量**：不读 `*_API_KEY`，只写 `~/.dsh/vision/config.json`（`0600`），页面永远拿不到明文。

取舍要说清楚：一次性转译的好处是**主模型完全无感**——不需要多一次工具调用就能「看到」图。本插件多花一轮工具调用，换来的是可追问、不丢细节、以及不把你的上游绑死在别人选的模型上。图片占比高、只想要「大概是什么」的场景，转译派更省事；要读准截图里的字、表格、报错，结构化证据更可靠。

## 为什么需要它

DSH 默认的模型只收文本。往里贴一张图，图片准入会直接拒绝；让它看一个截图路径，它也无从读起。常见做法是外挂一个视觉 CLI——但那意味着再装一个包、再维护一份它的配置、让它决定你的上游。

这个插件把这件事收回自己：

| | 外挂方案 | 本插件 |
|---|---|---|
| 视觉引擎 | 别人的 CLI | 你的端点，插件直连 |
| 配置 | 写进别人的配置文件 | 只写 `~/.dsh/vision/config.json` |
| 依赖 | 视觉包 + 子进程 | Node 内置模块 |
| 协议 | 由 CLI 决定 | OpenAI / Anthropic 二选一 |

## 功能

- **读图工具 `vision_read_image`**：本地路径或 `http(s)` URL 进，结构化证据出——逐字 OCR、按阅读顺序的版面区域、语义、颜色风格、不确定项。工具 schema 每一轮都在模型眼前，不靠提示词触发。
- **粘贴转路径**：`⌘V` 一张图，插件在捕获阶段拦下，存进 `~/.dsh/vision/pastes/`，把路径文本插进输入框。模型看到的就是一个文件路径，然后自己调读图工具。同一张图重复粘贴按内容寻址，不产生第二份文件。
- **预设可管理**：内置预设可以逐张移除（只是隐藏，随时一键恢复），也可以把当前填好的配置存成自己的预设。
- **滚动存储**：落盘目录只保留最近 **10** 张（可配置，`0` = 不限），超出的按最后使用时间删最旧的。刚粘过的那张会被刷新，不会因为「内容已存在」而被当成旧图先删。目录里不是本插件写的文件不碰。
- **启动日志也会滚动**：`~/.dsh/vision/boot.log` 每次加载写一行（谁没被加载、准入闸有没有接上，是唯一能从进程外看到的证据）。单文件超过 256 KiB 就滚成 `boot.log.1`，只留一代——不追求归档，只保证不会无限长。
- **可选的本机兼容端点**：把同一份配置暴露成 `127.0.0.1` 上的 OpenAI / Anthropic 兼容端口，带两套协议互转和自定义请求头。默认关闭，只在你确实要让别的程序接进来时打开。
- **两套上游协议**：OpenAI Chat Completions 与 Anthropic Messages，字段各自独立。
- **密钥不出后端**：页面只拿到 `hasKey` 和打码预览，明文永远不回到浏览器；配置文件 `0600`。

## 安装

```sh
dsh plugin --profile web add dsh-vision-direct
```

DSH Desktop 请在应用内 **设置 → 插件** 里安装（桌面端的 profile 归应用的插件管理器所有，命令行改不了它）。装完重启或刷新页面。

## 配置

打开 **设置 → 视觉模型**，选一个预设或自己填：

| 字段 | 说明 |
|---|---|
| 协议 | `OpenAI`（`/chat/completions`）或 `Anthropic`（`/messages`） |
| 上游地址 | 结尾带不带 `/v1` 都行 |
| 模型名 | 必须是能看图的模型（名字通常含 `vl` / `vision` / `omni`） |
| API Key | 只存在本机，页面不回显 |
| 额外请求头 | 值写 `$uuid` 表示每次请求换一个新 uuid |

内置预设：OpenCode Zen · Go 车道、OpenCode Zen、OpenAI 官方、Anthropic 官方。预设只负责填字段，所有值都能改。

填完先点 **测试连接**（一张 1×1 真图，验证鉴权和视觉输入），再点 **读图自检** 当场读一张图看证据。

想减就减：额外请求头每行右侧是「删除」；**重置配置** 会把上游、模型、密钥、请求头、粘贴张数一起清回默认值（会二次确认）。

## 用法

对话里直接给路径或 URL：

```
看看 ~/Desktop/invoice.png，把金额和日期列出来
```

或者直接粘贴截图。模型会拿到类似这样的证据：

```
一张测试图，画着一个红点。

── OCR（逐字）──
HELLO 42

── 版面（阅读顺序）──
1. [paragraph] HELLO
2. [title] 42

── 语义 ──
screenshot · 测试
实体：42（number；中央）

── 不确定 ──
· 边缘被裁切
```

支持 PNG / JPEG / GIF / WebP / BMP，单张 ≤ 8MB。HEIC 会被明确拒绝并提示先转格式。

## 工具契约

```jsonc
// 参数
{ "path": "绝对路径 / ~/… / http(s) URL", "prompt": "可选：这次额外关注什么" }

// 返回（节选）
{
  "summary": "一句话说这张图是什么",
  "ocr": { "full_text": "逐字原文", "lines": [{ "text": "…", "language": "zh-CN" }] },
  "layout": { "regions": [{ "type": "table", "reading_order": 1, "text": "…" }] },
  "semantics": { "scene": "…", "intent": "…", "entities": [], "relations": [] },
  "visual": { "dominant_colors": ["#rrggbb"], "style": "…", "notes": [] },
  "uncertainty": ["看不清、有歧义、可能被裁切的部分"],
  "meta": { "source": "…", "mime": "image/png", "bytes": 12740, "model": "…", "ms": 12367 }
}
```

模型没按 JSON 回答时不会报错：原文进 `summary`，并在 `uncertainty` 里标明「这次没按格式回」，调用方永远拿到一个形状完整的对象。

## 数据留在哪

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.dsh/vision/config.json` | 协议 / 上游 / 模型 / 密钥 | `0600` |
| `~/.dsh/vision/pastes/` | 粘贴落盘的图片，按内容寻址，默认只留最近 10 张 | 目录 `0700`，文件 `0600` |

网络请求只有一个方向：发往你自己填的上游地址。没有遥测，没有回传。

## 与其它视觉插件共存

本插件不依赖、不读写、不启动任何其它视觉工具。如果你已经装了别的读图插件，两边都会注册一个能力近似的工具，模型的工具列表里会出现重复——建议只留一个。

## 兼容性

- DSH `>= 0.2.0`
- Node.js `>= 20`（用到内置 `fetch` 与 `node:test` 之外的零依赖实现）

路由准入在 DSH 提供 `connection` 服务时走 `connection.requestRejection`（桌面端默认有）；没有这条服务的 profile（如 headless）只保留自建的同源栅栏，插件照样加载。

## 开发

```sh
node test/e2e-offline.mjs
```

214 条离线断言，不联网：两套协议的请求头与端点、协议互转、证据解析兜底、缓存、粘贴落盘与内容寻址、滚动清理（含 0=不限与外来文件保护）、重置、预设增删、错误边界、网关四条转发路径、配置权限、路由准入、启动日志滚动（含只留一代备份与写失败不抛）。测试会临时改写 `~/.dsh/vision/config.json`，跑完恢复。

### 环境变量 `DSH_VISION_CONFIG_DIR`

`lib/config.js` 支持用 `DSH_VISION_CONFIG_DIR` 覆盖配置目录，原本只为测试用。注意它会被 DSH 主机进程继承：如果你在某个 shell 里 export 过它再启动 DSH，桌面端就会一直读写那个目录下的 `config.json` 和 `boot.log`，`~/.dsh/vision/` 里的真实配置反而不生效，表现是「凭据明明填了却报上游不可用」，而 `boot.log` 停在旧时间不再增长。

排查：`ps eww -p <DSH 主进程 pid> | tr ' ' '\n' | grep DSH_VISION`。清掉后要从 Finder 或 Dock 重启 DSH（从终端 `open` 会继承终端环境，等于没清）。

### 路由准入（两道闸，都要有）

`webServer.register` 挂的路由，**DSH 不会自动做 Host / Origin 准入**——这一点和 `connection.fetch.register` 不同，容易误以为「宿主已经帮我挡了」。所以每条路由的 handler 入口都调 `refuse(req, res)`，它串两道闸：

1. **自建同源栅栏** `isTrustedRequest(req)`：Host 必须是回环地址，`sec-fetch-site: cross-site` 直接拒，有 Origin 时必须与 Host 同 authority。挡的是「网页替用户点按钮」。
2. **DSH 准入** `connection.requestRejection(req)`：宿主给了 `connection` 服务就调（桌面端有），未认证一律 401。挡的是「本机另一个进程直接打端口」。没有这条服务时（headless profile）自动跳过，插件照常加载——所以它没有写进 `inject` 常量，是用 `ctx.inject(['connection'], ...)` 可选接入的。

新增或修改路由时，**入口第一行必须是 `if (refuse(req, res)) return`**，不要直接调 `isTrustedRequest`——那样会漏掉第二道闸，正是维护者 fkysly 在 awesome-dsh-plugin#15548 里指出的缺口。

### 改路由时必须遵守的约定

前后端是靠**约定**对接的，没有 schema 校验，形状对不上也不会抛错，只会静默空白。加路由或改返回值时，两条一起检查：

1. **路由返回对象，不返回裸数组或裸标量。** `route()` 外壳把 `run()` 的返回值原样当响应体，不做包装。要吐列表就包成 `{ models: [...] }`，要吐单值就包成 `{ value: ... }`。
2. **前端按字段名取，别把 payload 当数组。** 写成 `Array.isArray(payload?.models) ? payload.models : []`。后端若改回裸数组，这一行会恒空而**不报错**。

踩过的实例：`/api/vision/models` 曾经直接返回 `listModels()` 的数组，页面永远显示 0 个模型（上游实际有 32 个），而且当时 175 条断言全绿——**因为该路由当时没有测试覆盖**。所以规则 3：

3. **新增路由要同时补一条形状断言**，至少验证「返回的是对象、列表在预期字段下、不空」。只测状态码 200 挡不住这类 bug。

`route()` 的超时只是「页面不等了」：到点回 504，不会取消 `run()` 和它内部的上游请求。别指望它当中断器用。

## License

MIT
