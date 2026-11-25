/**
 * dsh-vision-direct — host half.
 *
 * 一句话：这个插件自己就是 DSH 的视觉后端。它注册一个读图工具，拿同一份配置
 * 直接请求视觉模型，返回结构化证据。**不依赖、不读写、不启动任何外部视觉工具**
 * ——没有外部视觉工具、没有 CLI 子进程、没有第三方包。
 *
 * 三件事，边界很硬：
 *   1. 读图工具 —— 注册进 tool 注册表，文本模型每一轮都能看到它的 schema；
 *   2. 配置页的后端 —— ~/.dsh/vision/config.json（本机文件，600）；
 *   3. 可选的本机兼容端点 —— 只给「别的程序要接进来」时用，默认关闭。
 *
 * 密钥永远不出后端：页面只拿到 hasKey 布尔值，写入走服务端，浏览器既不读也不
 * 回写。
 */
import { mkdirSync } from 'node:fs'
import { appendBootLog, bootLogLine } from './lib/log.js'
import {
  LOG_MAX_BYTES_CEILING,
  PASTE_MAX_BYTES_FLOOR,
  configDir,
  configPath,
  defaults,
  normalize,
  PROTOCOLS,
  readConfig,
  writeConfig,
} from './lib/config.js'
import {
  anthropicToOpenai,
  anthropicToOpenaiRequest,
  gatewayPort,
  openaiToAnthropic,
  openaiToAnthropicResponse,
  startGateway,
  stopGateway,
} from './lib/gateway.js'
import { loadImage, MAX_IMAGE_BYTES } from './lib/image.js'
import { PASTE_MAX_BYTES, savePaste } from './lib/paste.js'
import {
  EVIDENCE_SCHEMA,
  buildVisionRequest,
  extractText,
  forward,
  headersFor,
  parseEvidence,
  renderEvidence,
  upstreamUrl,
  visionPrompt,
} from './lib/upstream.js'

export const name = 'vision'
// tools 是必须的：没有注册表就没有这个插件。webServer 走可选注入（下面
// ctx.inject），headless profile 没有它也能装。
export const inject = ['tools']

/**
 * 已知上游的预设。这些不是硬编码限制——页面里每一个字段都能改；预设只是让
 * 「OpenCode Zen」「OpenAI 官方」这类常见组合一次点好。
 */
const PRESETS = [
  {
    id: 'opencode-go',
    label: 'OpenCode Zen · Go 车道',
    protocol: 'openai',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    // 上游只认裸模型名；带 `opencode-go/` 前缀会直接 400 "Model is unavailable"。
    model: 'glm-5.3-flash',
    extraHeaders: { 'x-opencode-session': '$uuid' },
    notes: '需要 opencode 订阅。上游强制要求 x-opencode-session 头，值随便一个 uuid 即可。',
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    protocol: 'openai',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    model: 'nemotron-3.5-super-vl-free',
    extraHeaders: {},
    notes: '按量计费车道，额度用尽时上游返回 429 FreeUsageLimitError。',
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    extraHeaders: {},
    notes: '标准 OpenAI Chat Completions 协议。',
  },
  {
    id: 'anthropic',
    label: 'Anthropic 官方',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    extraHeaders: {},
    notes: '标准 Anthropic Messages 协议。',
  },
  {
    id: 'custom',
    label: '自定义端点',
    protocol: 'openai',
    baseUrl: '',
    model: '',
    extraHeaders: {},
    notes: '任何 OpenAI 或 Anthropic 兼容的中转/自建服务。',
  },
]

/**
 * 页面上看到的预设：内置里没被隐藏的，加上用户自己存的。
 *
 * `builtin` 只用于界面区分「隐藏」还是「真删」，不参与任何逻辑。
 */
function listPresets(config) {
  const hidden = new Set(config.presets.hidden)
  return [
    ...PRESETS.filter(preset => !hidden.has(preset.id)).map(preset => ({ ...preset, builtin: true })),
    ...config.presets.custom,
  ]
}

// ── 读图 ────────────────────────────────────────────────────────────────────

const CACHE_LIMIT = 32
const CACHE_TTL_MS = 5 * 60_000
/** 同一张图（内容相同）同一关注点，五分钟内不再请求上游。 */
const evidenceCache = new Map()

/** 最近一次读图的结果，纯展示。不落盘：重启后归零比写一份可能过期的状态好。 */
let lastRead = null
let registeredToolName = ''
/** llm 服务：只在粘贴判定里用到，拿不到就退化成「不确定 = 接管」。 */
let llmService = null

function requireConfigured(config) {
  if (config.baseUrl === '') throw new Error('还没配置上游地址，请先打开「视觉模型」设置页填写并保存。')
  if (config.model === '') throw new Error('还没配置模型名，请先在「视觉模型」设置页填写并保存。')
  if (config.apiKey === '') throw new Error('还没配置 API Key，请先在「视觉模型」设置页填写并保存。')
}

function trimCache() {
  const now = Date.now()
  for (const [key, entry] of evidenceCache) {
    if (entry.expiresAt <= now) evidenceCache.delete(key)
  }
  while (evidenceCache.size > CACHE_LIMIT) {
    const oldest = evidenceCache.keys().next().value
    evidenceCache.delete(oldest)
  }
}

/**
 * 读一张图，返回 `{ evidence, text }`。
 *
 * 缓存只认「图片内容 + 关注点 + 模型」：换文件名不该再问一次模型，但同一张图
 * 换一个问题就必须重读。失败不进缓存——上游恢复后立刻能用。
 */
export async function readImage(source, focus = '', { signal, cache = true } = {}) {
  const config = readConfig()
  requireConfigured(config)
  const image = await loadImage(source, { signal })
  const key = JSON.stringify([image.digest, String(focus ?? '').trim(), config.model, config.protocol])
  if (cache) {
    const hit = evidenceCache.get(key)
    if (hit !== undefined && hit.expiresAt > Date.now()) {
      return {
        evidence: { ...structuredClone(hit.evidence), meta: { ...hit.evidence.meta, cached: true } },
        text: hit.text,
      }
    }
  }

  const started = Date.now()
  const body = buildVisionRequest(config, image, visionPrompt(focus))
  const result = await forward(upstreamUrl(config), headersFor(config), body, { signal })
  if (!result.ok) {
    const detail = JSON.stringify(result.payload).slice(0, 500)
    throw new Error(`上游 HTTP ${result.status}：${detail}`)
  }
  const elapsed = Date.now() - started
  const evidence = parseEvidence(extractText(config.protocol, result.payload))
  const finishReason =
    config.protocol === 'anthropic' ? result.payload?.stop_reason : result.payload?.choices?.[0]?.finish_reason
  // 截断是这条链路最常见的失败方式，而且长得很像「模型不听话」。明说一句，
  // 调用方才知道该把关注点写窄，而不是换模型。
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    evidence.uncertainty.unshift(
      '输出达到 max_tokens 上限被截断，OCR 与版面可能不完整。把 prompt 写窄一点（只问其中一部分）再读一次。',
    )
  }
  evidence.meta = {
    source: image.label,
    mime: image.mime,
    bytes: image.bytes,
    model: config.model,
    ms: elapsed,
    cached: false,
  }
  const text = renderEvidence(evidence)
  if (cache) {
    evidenceCache.set(key, { evidence: structuredClone(evidence), text, expiresAt: Date.now() + CACHE_TTL_MS })
    trimCache()
  }
  lastRead = {
    at: Date.now(),
    source: image.label,
    mime: image.mime,
    bytes: image.bytes,
    model: config.model,
    ms: elapsed,
    summary: evidence.summary.slice(0, 200),
    ocrChars: evidence.ocr.full_text.length,
  }
  return { evidence, text }
}

/** 模型看到的工具：schema 每轮都在，不靠提示词触发。 */
function readImageTool(toolName) {
  return {
    name: toolName,
    description:
      'Read an image with the vision model configured for this harness. Use whenever a message references an image you cannot see: a local file path (absolute or ~/…) or an http(s) URL to a screenshot, photo, chart, diagram, or document scan. Returns structured evidence: verbatim OCR (ocr.full_text), layout regions in reading order, semantics, visual description, and an uncertainty list. Quote the evidence instead of guessing. Call once per image and reuse the result; call again with a different `prompt` only when you need a different focus. Supported: PNG, JPEG, GIF, WebP, BMP up to 8MB.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Local image path (absolute, or ~/…) or an http(s) URL. Prefer absolute paths: a relative path resolves against the host process directory, not the workspace.',
        },
        prompt: {
          type: 'string',
          description: 'Optional extra focus for this reading, e.g. "read the axis labels and the legend"',
        },
      },
      required: ['path'],
    },
    output: {
      schema: EVIDENCE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderEvidence(value) }],
    },
    // 上游自己也有超时；这是协作式的兜底，比单次请求宽一点。
    timeoutMs: 200_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      title: toolName,
      kind: 'read',
      rawInput: args,
      ...(typeof args?.path === 'string' && !/^https?:\/\//i.test(args.path.trim())
        ? { locations: [{ path: args.path }] }
        : {}),
    }),
    async execute(args, exec) {
      if (typeof args?.path !== 'string' || args.path.trim() === '') {
        throw new Error(`${toolName} 需要一个非空的 path：本地图片路径或 http(s) URL。`)
      }
      const focus = typeof args.prompt === 'string' ? args.prompt : ''
      const { evidence } = await readImage(args.path, focus, { signal: exec?.signal })
      return structuredClone(evidence)
    },
  }
}

// ── 粘贴 ────────────────────────────────────────────────────────────────────

/**
 * 当前模型能不能收图？决定浏览器要不要接管这次粘贴/拖拽。
 *
 * 只在「明确确认支持图片」时说不接管：模型选择器的标签只有描述文字和展示名，
 * 宿主只能按名字去 llm 的模型清单里找，找不到或没声明输入模态都算不确定。
 * 不确定就接管——这个插件服务的正是文本模型，猜错方向会让 ⌘V 直接报错。
 *
 * 返回结构化结论而不是裸布尔：takeover 之外的 reason 会一路带回浏览器 console，
 * 「这次为什么接管/不接管」不再靠猜。matched 是命中的 provider/model。
 */
async function pasteVerdict(label) {
  const llm = llmService
  if (llm === null || llm === undefined) return { takeover: true, reason: 'no-llm-service' }
  if (typeof label !== 'string' || label.trim() === '') return { takeover: true, reason: 'empty-label' }
  if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { takeover: true, reason: 'no-llm-service' }
  }
  const lowered = label.toLowerCase()
  for (const info of llm.listProviders()) {
    if (typeof info?.id !== 'string') continue
    let models = []
    try {
      models = await llm.listModels(info.id)
    } catch {
      continue
    }
    for (const model of models) {
      for (const candidate of [model?.name, model?.id]) {
        // 一两个字符的名字在标签正文里到处都是，匹配上了也不足以说明是谁。
        if (typeof candidate !== 'string' || candidate.length < 3) continue
        if (!lowered.includes(candidate.toLowerCase())) continue
        if (Array.isArray(model?.inputModalities) && model.inputModalities.includes('image')) {
          return { takeover: false, reason: 'model-accepts-image', matched: `${info.id}/${model.id}` }
        }
      }
    }
  }
  return { takeover: true, reason: 'no-image-model-matched' }
}

/** 原始字节请求体：不走 JSON，避免图片先 base64 一次白占 33%。 */
function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`图片超过 ${Math.round(limit / 1024 / 1024)}MB 上限`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** GET 探路 + POST 落盘。浏览器拿到 `{ path }` 后把它当文本插进输入框。 */
async function pasteRoute(req, res) {
  if (refuse(req, res)) return
  const config = readConfig()
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET') {
    const label = url.searchParams.get('model') ?? ''
    const verdict = config.pasteToPath ? await pasteVerdict(label) : { takeover: false, reason: 'paste-disabled' }
    json(res, 200, {
      enabled: config.pasteToPath,
      takeover: verdict.takeover,
      reason: verdict.reason,
      matched: verdict.matched ?? '',
    })
    return
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: '只接受 GET 或 POST' })
    return
  }
  if (!config.pasteToPath) {
    json(res, 409, { error: '粘贴通道已关闭' })
    return
  }
  try {
    // 请求体上限比保存上限宽一点（保存上限可以在页面里调小），超了在存盘
    // 那一步给一句人话，而不是在字节流中间静默断开。
    const limit = Math.max(config.pasteMaxBytes, PASTE_MAX_BYTES)
    const buffer = await readBinary(req, limit)
    if (buffer.length === 0) throw new Error('粘贴内容为空')
    const saved = savePaste(buffer, { keep: config.pasteKeep, maxBytes: config.pasteMaxBytes })
    json(res, 200, saved)
  } catch (error) {
    json(res, 400, { error: String(error?.message ?? error) })
  }
}

// ── 页面后端 ────────────────────────────────────────────────────────────────

/** 页面拿到的摘要。密钥不出后端——只给 hasKey。 */
async function summary() {
  const config = readConfig()
  const port = config.gateway.enabled ? await startGateway(config.gateway.port).catch(() => 0) : 0
  return {
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: config.apiKey !== '',
    // 密钥的「形状」就够了：让人认出自己填的是哪一把，又不泄露内容。
    keyPreview:
      config.apiKey === ''
        ? ''
        : `${config.apiKey.slice(0, 4)}…${config.apiKey.slice(-4)} (${config.apiKey.length} 字符)`,
    extraHeaders: config.extraHeaders,
    sessionHeader: config.sessionHeader,
    toolName: config.toolName,
    toolRegistered: registeredToolName === config.toolName,
    pasteToPath: config.pasteToPath,
    pasteKeep: config.pasteKeep,
    pasteMaxBytes: config.pasteMaxBytes,
    logMaxBytes: config.logMaxBytes,
    gateway: { enabled: config.gateway.enabled, port, requestedPort: config.gateway.port },
    lastRead,
    presets: listPresets(config),
    hiddenPresets: config.presets.hidden.length,
    protocols: PROTOCOLS,
    configPath: configPath(),
  }
}

/**
 * 保存。密钥「空字符串 = 不动」：页面从来拿不到已存的密钥，所以它提交上来的
 * 空值只可能是「这一格我没改」，不可能是「我要清掉」——清掉走独立的 clearKey。
 */
async function save(patch) {
  const config = readConfig()
  if (patch?.protocol !== undefined) {
    if (!PROTOCOLS.includes(patch.protocol)) throw new Error(`未知协议：${patch.protocol}`)
    config.protocol = patch.protocol
  }
  for (const field of ['baseUrl', 'model']) {
    if (patch?.[field] === undefined) continue
    config[field] = typeof patch[field] === 'string' ? patch[field].trim() : ''
  }
  if (typeof patch?.apiKey === 'string' && patch.apiKey.trim() !== '') config.apiKey = patch.apiKey.trim()
  if (patch?.clearKey === true) config.apiKey = ''
  if (patch?.extraHeaders !== undefined) {
    const headers = patch.extraHeaders
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('额外请求头必须是对象')
    config.extraHeaders = Object.fromEntries(
      Object.entries(headers)
        .filter(([k, v]) => typeof k === 'string' && k.trim() !== '' && typeof v === 'string')
        .map(([k, v]) => [k.trim(), v]),
    )
  }
  if (patch?.sessionHeader !== undefined) config.sessionHeader = patch.sessionHeader !== false
  if (patch?.pasteToPath !== undefined) config.pasteToPath = patch.pasteToPath !== false
  if (patch?.pasteKeep !== undefined) {
    const keep = Number(patch.pasteKeep)
    if (!Number.isInteger(keep) || keep < 0) throw new Error('保留张数必须是不小于 0 的整数')
    config.pasteKeep = Math.min(keep, 1000)
  }
  if (patch?.pasteMaxBytes !== undefined) {
    const bytes = Number(patch.pasteMaxBytes)
    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('单张保存上限必须是正整数（字节）')
    config.pasteMaxBytes = Math.min(Math.max(Math.round(bytes), PASTE_MAX_BYTES_FLOOR), MAX_IMAGE_BYTES)
  }
  if (patch?.logMaxBytes !== undefined) {
    const bytes = Number(patch.logMaxBytes)
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('日志滚动上限必须是不小于 0 的整数（字节，0 = 不限）')
    const rounded = Math.round(bytes)
    config.logMaxBytes = rounded === 0 ? 0 : Math.min(Math.max(rounded, 4 * 1024), LOG_MAX_BYTES_CEILING)
  }
  if (patch?.gateway !== undefined && patch.gateway !== null && typeof patch.gateway === 'object') {
    config.gateway = {
      enabled: patch.gateway.enabled === true,
      port: Number.isInteger(Number(patch.gateway.port)) ? Number(patch.gateway.port) : config.gateway.port,
    }
  }
  writeConfig(config)
  // 端口或开关变了就得重建监听，否则页面显示的端口和真正在听的不是一回事。
  await stopGateway()
  if (config.gateway.enabled) await startGateway(config.gateway.port).catch(() => 0)
  return summary()
}

/**
 * 预设的增删。
 *
 * 内置的只能隐藏（代码里还有，清空隐藏列表就回来）；自定义的是真删。两种都
 * 走同一组 action，浏览器不用知道哪张卡是哪种。
 */
async function updatePresets(body) {
  const config = readConfig()
  const action = typeof body?.action === 'string' ? body.action : ''
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (action === 'hide') {
    if (!PRESETS.some(preset => preset.id === id)) throw new Error(`没有这个内置预设：${id}`)
    config.presets.hidden = [...new Set([...config.presets.hidden, id])]
  } else if (action === 'unhide') {
    config.presets.hidden = config.presets.hidden.filter(hidden => hidden !== id)
  } else if (action === 'restore') {
    config.presets.hidden = []
  } else if (action === 'remove') {
    config.presets.custom = config.presets.custom.filter(preset => preset.id !== id)
  } else if (action === 'save') {
    const preset = body?.preset ?? {}
    if (typeof preset.baseUrl !== 'string' || preset.baseUrl.trim() === '') throw new Error('先把上游地址填好再存成预设')
    if (typeof preset.label !== 'string' || preset.label.trim() === '') throw new Error('预设需要一个名字')
    const next = normalize({
      ...config,
      presets: {
        ...config.presets,
        custom: [
          ...config.presets.custom,
          {
            id: `custom-${Date.now().toString(36)}-${config.presets.custom.length}`,
            label: preset.label.trim().slice(0, 40),
            protocol: preset.protocol,
            baseUrl: preset.baseUrl.trim(),
            model: typeof preset.model === 'string' ? preset.model.trim() : '',
            extraHeaders: preset.extraHeaders ?? {},
            notes: '你自己存的预设。',
          },
        ],
      },
    })
    config.presets = next.presets
  } else {
    throw new Error(`未知的预设操作：${action}`)
  }
  writeConfig(config)
  return summary()
}

/**
 * 重置：把配置写回默认值。
 *
 * 这是页面里唯一一个「减少」的动作——清空上游、模型、密钥、额外请求头、
 * 粘贴张数，回到刚装上的样子。网关先停，免得它拿着旧凭据继续听。
 */
async function resetConfig() {
  await stopGateway()
  writeConfig(defaults())
  return summary()
}

/** 直连测试：1x1 的红色 PNG，一次真图请求，回答「这套配置通不通」。 */
async function test() {
  const config = readConfig()
  requireConfigured(config)
  // 一张真图，能同时验证「鉴权通」和「视觉输入被上游接受」。
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const started = Date.now()
  const body =
    config.protocol === 'anthropic'
      ? {
          model: config.model,
          max_tokens: 32,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
                { type: 'text', text: '这张图是什么颜色？只回一个词。' },
              ],
            },
          ],
        }
      : {
          model: config.model,
          max_tokens: 32,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
                { type: 'text', text: '这张图是什么颜色？只回一个词。' },
              ],
            },
          ],
        }
  const result = await forward(upstreamUrl(config), headersFor(config), body, { timeoutMs: 120_000 })
  const elapsed = Date.now() - started
  const answer = extractText(config.protocol, result.payload)
  return {
    ok: result.ok,
    status: result.status,
    elapsedMs: elapsed,
    answer: typeof answer === 'string' ? answer.slice(0, 200) : '',
    error: result.ok ? '' : JSON.stringify(result.payload).slice(0, 500),
  }
}

/** 列上游能看到的模型（只部分上游支持 /models）。 */
async function listModels() {
  const config = readConfig()
  if (config.baseUrl === '') throw new Error('请先填写上游地址')
  if (config.apiKey === '') throw new Error('请先填写 API Key')
  const base = config.baseUrl.replace(/\/+$/, '')
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`
  const headers = headersFor(config)
  delete headers['content-type']
  const response = await fetch(url, { method: 'GET', headers })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 300)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`返回不是 JSON：${text.slice(0, 200)}`)
  }
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return list
    .map(item => (typeof item === 'string' ? { id: item } : { id: item?.id ?? '', name: item?.name ?? '' }))
    .filter(item => item.id !== '')
    // 视觉模型先排前面：这里存在的意义就是挑一个能看图说话的模型。
    .sort((a, b) => Number(isVisionish(b.id)) - Number(isVisionish(a.id)))
}

/** 名字里带这些词的，基本就是多模态。上游没有统一的能力字段，只能看名字。 */
export function isVisionish(id) {
  return /vl|vision|omni|multimodal|gpt-4|gemini|claude|glm-4\.[5-9]|qwen.*vl/i.test(id)
}

// ── 路由 ────────────────────────────────────────────────────────────────────

/** 回环 + 同源：这条栅栏挡住「网页替用户点按钮」这一类请求。 */
function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const name = hostUrl.hostname
  const loopback = name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1'
  if (!loopback) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * DSH 自家的准入闸（Host/Origin 栅栏 + 浏览器登录态）。
 *
 * 为什么需要第二道：用 `webServer.register` 挂的路由，DSH **不会**自动套
 * Host / Origin 准入——同源的裸路由谁都能打。上面那条 isTrustedRequest 只挡
 * 「网页替用户点按钮」这一类跨站请求，挡不住同源但未登录的客户端。
 *
 * `connection` 服务存在时用它做第二道（桌面端就有），未认证一律 401；headless
 * profile 没有这个服务，那就只留第一道——降级而不是报错，插件要能在任何宿主里装上。
 *
 * 用 Reflect.get 而不是 `scoped.connection`：这条服务在某些宿主里是浏览器侧类型，
 * 直接取属性在类型层面不成立，运行时也可能被代理包一层。
 */
let connectionService

function connectionRejection(req) {
  const connection = connectionService
  if (connection === undefined || connection === null) return undefined
  const requestRejection = Reflect.get(connection, 'requestRejection')
  if (typeof requestRejection !== 'function') return undefined
  return requestRejection.call(connection, req)
}

/** 两道闸的公共出口：返回 true 表示已经写完拒绝响应，调用方直接 return。 */
function refuse(req, res) {
  if (!isTrustedRequest(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('request refused: this route answers same-origin loopback only')
    return true
  }
  const rejection = connectionRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('request refused: DSH connection admission rejected this request')
  return true
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`))
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * 一个路由外壳：栅栏 → 方法 → 执行 → JSON。
 *
 * 返回形状的约定（踩过坑，别改）：
 *   run() 返回什么，整个响应体就是什么，外壳不做任何包装。
 *   所以 run() 必须返回**对象**，不要直接返回数组或标量。裸数组在前端是
 *   陷阱：页面习惯写 `Array.isArray(result?.items) ? result.items : []`，
 *   此时 `result` 本身就是数组，`result.items` 是 undefined，于是静默变成
 *   空列表、不报错、页面只是「什么都没有」。要吐列表就用 `{ items: [...] }`
 *   包一层。同理标量要包成 `{ value: ... }`。
 *   历史案例：`/models` 曾直接返回 `listModels()` 的数组，导致上游 32 个模型
 *   在页面上永远是 0 个，而全部测试仍是绿的（那条路由当时没有测试覆盖）。
 *
 * 超时语义：timer 到点只在响应头还没发出去时回 504，并不取消 run() 和它内部
 * 的上游请求——「页面不等了」不等于「活儿停了」。真要取消得把 AbortSignal
 * 一路传下去，目前是有意不做。
 */
function route(method, run, timeoutMs = 30_000) {
  return async (req, res) => {
    if (refuse(req, res)) return
    if (req.method !== method) {
      json(res, 405, { error: `只接受 ${method}` })
      return
    }
    const timer = setTimeout(() => {
      if (!res.headersSent) json(res, 504, { error: `超过 ${Math.round(timeoutMs / 1000)} 秒没有结果` })
    }, timeoutMs)
    try {
      const body = method === 'POST' ? await readBody(req) : {}
      const payload = await run(body)
      clearTimeout(timer)
      json(res, 200, payload)
    } catch (error) {
      clearTimeout(timer)
      if (!res.headersSent) json(res, 400, { error: String(error?.message ?? error) })
    }
  }
}

// ── 装载 ────────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  // 工具注册：失败只降级、不拖垮宿主（缺注册表、名字撞车都在这里收）。
  const desiredName = (() => {
    try {
      return typeof config.toolName === 'string' && config.toolName !== '' ? config.toolName : readConfig().toolName
    } catch {
      return defaults().toolName
    }
  })()
  try {
    ctx.tools.register(readImageTool(desiredName))
    registeredToolName = desiredName
  } catch (error) {
    console.error(`[vision] ${desiredName} 注册失败：${error?.message ?? error}`)
  }
  // 启动留痕：插件到底有没有被加载，只能从进程外面看，本机日志比猜快。
  // 写之前按大小滚动（见 lib/log.js），滚动的阈值来自配置（logMaxBytes）。
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 })
    let configured = defaults()
    try {
      configured = readConfig()
    } catch {
      /* 配置读不出就按默认上限滚动，别让留痕挂掉 */
    }
    appendBootLog(
      configDir(),
      bootLogLine({
        apply: desiredName,
        registered: registeredToolName === desiredName,
        node: process.version,
      }),
      { maxBytes: configured.logMaxBytes },
    )
  } catch {
    /* 留痕失败不影响插件 */
  }

  ctx.inject(['llm'], scoped => {
    llmService = scoped.llm
  })

  // 准入服务：有就接上（桌面端有），没有就只用自建的同源栅栏。
  // 这里刻意不改 `inject` 常量——把它列成必需依赖会让插件在 headless profile
  // 里直接装不上，而路由本身并不是必需品。
  ctx.inject(['connection'], scoped => {
    connectionService = scoped.connection
    // 同样留痕：路由到底有没有接上 DSH 的准入闸，只能看日志，不能靠猜。
    try {
      let configured = defaults()
      try {
        configured = readConfig()
      } catch {
        /* 配置读不出就按默认上限滚动 */
      }
      appendBootLog(
        configDir(),
        bootLogLine({ connection: 'attached', hasService: connectionService != null }),
        { maxBytes: configured.logMaxBytes },
      )
    } catch {
      /* 留痕失败不影响插件 */
    }
    scoped.effect(() => () => {
      if (connectionService === scoped.connection) connectionService = undefined
    }, 'vision: connection')
  })

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'exact', path: '/api/vision/summary', handler: route('GET', summary) }),
      'vision: summary',
    )
    scoped.effect(
      () => server.register({ kind: 'exact', path: '/api/vision/save', handler: route('POST', body => save(body)) }),
      'vision: save',
    )
    scoped.effect(
      () => server.register({ kind: 'exact', path: '/api/vision/reset', handler: route('POST', () => resetConfig()) }),
      'vision: reset',
    )
    scoped.effect(
      () => server.register({ kind: 'exact', path: '/api/vision/presets', handler: route('POST', body => updatePresets(body)) }),
      'vision: presets',
    )
    scoped.effect(
      () => server.register({ kind: 'exact', path: '/api/vision/test', handler: route('POST', () => test(), 180_000) }),
      'vision: test',
    )
    scoped.effect(
      () => server.register({
        kind: 'exact',
        path: '/api/vision/models',
        // 用对象包一层：路由统一返回 JSON 对象，页面按 `{ models: [...] }` 取用。
        // 裸数组在这里是个陷阱——`Array.isArray(result?.models)` 会静默变成空列表。
        handler: route('POST', async () => ({ models: await listModels() }), 60_000),
      }),
      'vision: models',
    )
    // 粘贴通道：浏览器 capture 阶段的 paste 把图片字节交到这里，换回一个路径。
    scoped.effect(
      () =>
        server.register({
          kind: 'exact',
          path: '/api/vision/paste',
          handler: (req, res) => {
            void pasteRoute(req, res).catch(error => {
              if (!res.headersSent) json(res, 500, { error: String(error?.message ?? error) })
            })
          },
        }),
      'vision: paste',
    )
    // 页面自检读图：和工具同一条链路，但不吃工具缓存。
    scoped.effect(
      () =>
        server.register({
          kind: 'exact',
          path: '/api/vision/read',
          handler: route('POST', async body => {
            if (typeof body?.path !== 'string' || body.path.trim() === '') throw new Error('请填写本地路径或图片 URL')
            const { evidence, text } = await readImage(body.path, typeof body.prompt === 'string' ? body.prompt : '', {
              cache: false,
            })
            return { evidence, text }
          }, 200_000),
        }),
      'vision: read',
    )
  })

  // 网关只在显式开启时监听；默认关，省一个常驻端口。
  ctx.effect(() => {
    void (async () => {
      try {
        const current = readConfig()
        if (current.gateway.enabled && current.baseUrl !== '') await startGateway(current.gateway.port)
      } catch {
        /* 配置坏了不影响宿主启动，页面会显示错误 */
      }
    })()
    return () => {
      void stopGateway()
    }
  }, 'vision: listener')
}

export const __vision = {
  defaults,
  normalize,
  readConfig,
  writeConfig,
  configPath,
  readImage,
  renderEvidence,
  parseEvidence,
  visionPrompt,
  EVIDENCE_SCHEMA,
  isVisionish,
  PRESETS,
  summary,
  save,
  test,
  reset: resetConfig,
  presets: updatePresets,
  listPresets,
  listModels,
  startGateway,
  stopGateway,
  gatewayPort,
  upstreamUrl,
  headersFor,
  buildVisionRequest,
  extractText,
  // 网关的协议转换：测试要单独验，外部要复用也方便。
  openaiToAnthropic,
  anthropicToOpenaiRequest,
  anthropicToOpenai,
  openaiToAnthropicResponse,
}

/** 兼容旧测试路径：之前这里导出 __gateway。 */
export const __gateway = __vision
