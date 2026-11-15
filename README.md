# dsh-vision-direct

给 DeepSeek Harness 的纯文本模型一双自己的眼睛：一个读图工具、一条粘贴通道，和一个可选的本机兼容端点。

**不依赖任何外部视觉工具**——没有 CLI 子进程、没有第三方包、不读写别的程序的配置。视觉上游是你自己填的任意 OpenAI / Anthropic 兼容端点。

> English: A self-contained vision backend for DSH. It registers its own `vision_read_image` tool, turns pasted images into local file paths, and optionally exposes a loopback OpenAI/Anthropic-compatible endpoint. No external vision CLI, no third-party runtime dependency.

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
| `~/.dsh/vision/pastes/` | 粘贴落盘的图片，按内容寻址 | 目录 `0700`，文件 `0600` |

网络请求只有一个方向：发往你自己填的上游地址。没有遥测，没有回传。

## 与其它视觉插件共存

本插件不依赖、不读写、不启动任何其它视觉工具。如果你已经装了别的读图插件，两边都会注册一个能力近似的工具，模型的工具列表里会出现重复——建议只留一个。

## 兼容性

- DSH `>= 0.2.0`
- Node.js `>= 20`（用到内置 `fetch` 与 `node:test` 之外的零依赖实现）

## 开发

```sh
node test/e2e-offline.mjs
```

125 条离线断言，不联网：两套协议的请求头与端点、协议互转、证据解析兜底、缓存、粘贴落盘与内容寻址、错误边界、网关四条转发路径、配置权限。测试会临时改写 `~/.dsh/vision/config.json`，跑完恢复。

## License

MIT
