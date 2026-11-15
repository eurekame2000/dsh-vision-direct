/**
 * 上游那一侧：请求头、端点、发一张图、把回答收成结构化证据。
 *
 * 这里没有任何第三方依赖，也不认识任何别的视觉工具——就是 OpenAI Chat
 * Completions 与 Anthropic Messages 两套协议的直接客户端。
 */
import { randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 150_000

/** 一个短 uuid，只用于上游对请求做粘性路由，不含任何身份信息。 */
export function uuid() {
  return randomUUID()
}

/**
 * 按协议给上游拼头。
 *
 * `$uuid` 是唯一的内建占位符——opencode 那条要求「随便一个稳定值」，让用户自己
 * 填一个假 uuid 没有意义，所以留了这个替换。
 */
export function headersFor(config, apiKeyOverride) {
  const key = apiKeyOverride ?? config.apiKey
  const headers = { 'content-type': 'application/json' }
  if (config.protocol === 'anthropic') {
    // Anthropic 用 x-api-key，且必须声明版本；它的 OpenAI 兼容口不存在，所以
    // 这两项不能省。
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${key}`
  }
  if (config.sessionHeader) headers['x-opencode-session'] = uuid()
  for (const [name, value] of Object.entries(config.extraHeaders ?? {})) {
    const lower = name.toLowerCase()
    // 不许覆盖鉴权与内容类型：那三个由上面的协议分支唯一决定。
    if (['authorization', 'x-api-key', 'content-type', 'anthropic-version'].includes(lower)) continue
    headers[lower] = String(value).includes('$uuid') ? String(value).replaceAll('$uuid', uuid()) : value
  }
  return headers
}

/**
 * 上游地址：baseUrl 已经带版本段（/v1）就只补端点，没带就补 /v1 + 端点。
 * 用户把 baseUrl 填成 `https://api.openai.com` 和 `https://api.openai.com/v1`
 * 都是常见写法，不该让他去猜。
 */
export function upstreamUrl(config, kind = config.protocol) {
  const base = String(config.baseUrl ?? '').replace(/\/+$/, '')
  const suffix = kind === 'anthropic' ? '/messages' : '/chat/completions'
  return /\/v\d+$/.test(base) ? `${base}${suffix}` : `${base}/v1${suffix}`
}

export async function forward(url, headers, body, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    const text = await response.text()
    let payload
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      payload = { error: { message: text.slice(0, 400) } }
    }
    return { ok: response.ok, status: response.status, payload }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(signal?.aborted ? '读图被取消' : `上游 ${Math.round(timeoutMs / 1000)} 秒没有响应`)
    }
    throw new Error(`上游不可达：${error?.message ?? error}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// ── 证据的形状 ──────────────────────────────────────────────────────────────
//
// 文本模型读图要的不是「一句话描述」，而是能引用的原文 + 位置 + 不确定项。
// 所以固定一套字段：模型只填内容，形状由我们规定，解析时再兜底一次。

export const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '一句话说这张图是什么、在讲什么' },
    ocr: {
      type: 'object',
      properties: {
        full_text: { type: 'string', description: '图中所有可读文字，按阅读顺序拼接，保留原始换行与标点' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              language: { type: 'string', description: 'BCP-47 语言标签，如 zh-CN、en' },
            },
            required: ['text'],
          },
        },
      },
      required: ['full_text', 'lines'],
    },
    layout: {
      type: 'object',
      properties: {
        regions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description: '区域类型，常用的：title、heading、paragraph、list、table、chart、form、code、image、icon、nav、button。没有合适的就用一个短词。',
              },
              reading_order: { type: 'number', description: '从 1 开始的阅读顺序' },
              text: { type: 'string', description: '这个区域里的文字，没有文字就为空串' },
            },
            required: ['type', 'reading_order', 'text'],
          },
        },
      },
      required: ['regions'],
    },
    semantics: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '画面是什么（界面截图/商品照/图表/文档扫描…）' },
        intent: { type: 'string', description: '这张图想传达什么' },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              evidence: { type: 'string', description: '图上哪个位置/哪句话支撑这个实体' },
            },
            required: ['name', 'type'],
          },
        },
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              predicate: { type: 'string' },
              object: { type: 'string' },
            },
            required: ['subject', 'predicate', 'object'],
          },
        },
      },
      required: ['scene', 'entities'],
    },
    visual: {
      type: 'object',
      properties: {
        dominant_colors: { type: 'array', items: { type: 'string' } },
        style: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    uncertainty: {
      type: 'array',
      items: { type: 'string' },
      description: '看不清、有歧义、可能被裁掉的部分。宁可写出来，不要猜。',
    },
    // 由插件填，不是模型填：来源、大小、模型、耗时，让调用方能判断这次读得值不值。
    meta: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        mime: { type: 'string' },
        bytes: { type: 'number' },
        model: { type: 'string' },
        ms: { type: 'number' },
        cached: { type: 'boolean' },
      },
      required: ['source', 'mime', 'bytes', 'model', 'ms'],
    },
  },
  required: ['summary', 'ocr', 'layout', 'semantics', 'uncertainty'],
}

const INSTRUCTIONS = `You are a vision transcription engine feeding a text-only model. Read the image and answer with ONE JSON object, no prose, no markdown fence, matching this shape:

{
  "summary": "one sentence: what this image is and what it is about",
  "ocr": { "full_text": "every readable word in reading order, original line breaks and punctuation", "lines": [{ "text": "...", "language": "zh-CN" }] },
  "layout": { "regions": [{ "type": "title|heading|paragraph|list|table|chart|form|code|image|icon|nav|button", "reading_order": 1, "text": "text in this region, or empty" }] },
  "semantics": { "scene": "screenshot|product photo|chart|document scan|...", "intent": "what the image is trying to convey", "entities": [{ "name": "...", "type": "...", "evidence": "where it appears" }], "relations": [{ "subject": "...", "predicate": "...", "object": "..." }] },
  "visual": { "dominant_colors": ["#rrggbb"], "style": "...", "notes": ["..."] },
  "uncertainty": ["anything illegible, ambiguous, or possibly cropped"]
}

Rules:
- Transcribe VERBATIM. Never translate, summarise, or fix spelling inside ocr.
- If the image has no text, use empty strings and empty arrays.
- Never invent content. Put every doubt in uncertainty.
- Keep the answer in the language the image is written in; the summary may be in that language too.`

/** 给模型的那段话：固定指令 + 调用方给的关注点。 */
export function visionPrompt(focus) {
  const extra = typeof focus === 'string' ? focus.trim() : ''
  return extra === '' ? INSTRUCTIONS : `${INSTRUCTIONS}\n\nCaller also asks you to pay extra attention to: ${extra}`
}

/** 一张图 → 对应协议的请求体。 */
export function buildVisionRequest(config, image, prompt) {
  const maxTokens = 2048
  if (config.protocol === 'anthropic') {
    return {
      model: config.model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }
  }
  return {
    model: config.model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
        ],
      },
    ],
  }
}

/** 从协议各自的响应里取出文本。 */
export function extractText(protocol, payload) {
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(payload?.content) ? payload.content : []
    return blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
  }
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('')
  return ''
}

// ── 解析 ────────────────────────────────────────────────────────────────────

/** 模型有时会套一层 ```json 围栏，或者在 JSON 前后加一句话。都剥掉。 */
function pickJsonObject(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1))
  candidates.push(text)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim())
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 下一个候选 */
    }
  }
  return null
}

const str = value => (typeof value === 'string' ? value : '')
const arr = value => (Array.isArray(value) ? value : [])

function strList(value) {
  return arr(value).filter(item => typeof item === 'string' && item !== '')
}

/**
 * 收敛成已知形状。模型少给字段、给错类型都当没有——绝不因为一个字段缺失就
 * 让整次读图失败：有 summary 也总比报错强。
 */
export function normalizeEvidence(raw) {
  const ocr = raw?.ocr !== null && typeof raw?.ocr === 'object' ? raw.ocr : {}
  const layout = raw?.layout !== null && typeof raw?.layout === 'object' ? raw.layout : {}
  const semantics = raw?.semantics !== null && typeof raw?.semantics === 'object' ? raw.semantics : {}
  const visual = raw?.visual !== null && typeof raw?.visual === 'object' ? raw.visual : {}
  return {
    summary: str(raw?.summary),
    ocr: {
      full_text: str(ocr.full_text),
      lines: arr(ocr.lines)
        .filter(line => line !== null && typeof line === 'object' && str(line.text) !== '')
        .map(line => ({ text: str(line.text), ...(str(line.language) === '' ? {} : { language: str(line.language) }) })),
    },
    layout: {
      regions: arr(layout.regions)
        .filter(region => region !== null && typeof region === 'object')
        .map((region, index) => ({
          type: str(region.type) || 'region',
          reading_order: Number.isFinite(Number(region.reading_order)) ? Number(region.reading_order) : index + 1,
          text: str(region.text),
        }))
        .sort((a, b) => a.reading_order - b.reading_order),
    },
    semantics: {
      scene: str(semantics.scene),
      intent: str(semantics.intent),
      entities: arr(semantics.entities)
        .filter(entity => entity !== null && typeof entity === 'object' && str(entity.name) !== '')
        .map(entity => ({ name: str(entity.name), type: str(entity.type), ...(str(entity.evidence) === '' ? {} : { evidence: str(entity.evidence) }) })),
      relations: arr(semantics.relations)
        .filter(rel => rel !== null && typeof rel === 'object')
        .map(rel => ({ subject: str(rel.subject), predicate: str(rel.predicate), object: str(rel.object) })),
    },
    visual: {
      dominant_colors: strList(visual.dominant_colors),
      style: str(visual.style),
      notes: strList(visual.notes),
    },
    uncertainty: strList(raw?.uncertainty),
  }
}

/**
 * 模型回答 → 证据。
 *
 * 解析不出 JSON 不算失败：把原文放进 summary，并在 uncertainty 里说明「这次
 * 没按格式回」，总比让调用方拿到一个错误、再花一轮重试要好。调用方永远拿到
 * 一个形状完整的对象。
 */
export function parseEvidence(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') {
    const empty = normalizeEvidence({})
    empty.summary = ''
    empty.uncertainty = ['上游返回了空回答']
    return empty
  }
  const parsed = pickJsonObject(trimmed)
  if (parsed === null) {
    const fallback = normalizeEvidence({})
    fallback.summary = trimmed.slice(0, 2000)
    fallback.uncertainty = ['模型没有按 JSON 格式回答，下面是它的原话；OCR 与版面信息不可用']
    return fallback
  }
  return normalizeEvidence(parsed)
}

/** 证据 → 模型可读的文本块。渲染只负责排版，不改内容。 */
export function renderEvidence(evidence) {
  const lines = []
  const summary = evidence?.summary ?? ''
  lines.push(summary === '' ? '（没有摘要）' : summary)
  const full = evidence?.ocr?.full_text ?? ''
  if (full !== '') {
    lines.push('', '── OCR（逐字）──', full)
  }
  const regions = evidence?.layout?.regions ?? []
  if (regions.length > 0) {
    lines.push('', '── 版面（阅读顺序）──')
    for (const region of regions) {
      lines.push(`${region.reading_order}. [${region.type}] ${region.text === '' ? '（无文字）' : region.text}`)
    }
  }
  const scene = evidence?.semantics?.scene ?? ''
  const intent = evidence?.semantics?.intent ?? ''
  if (scene !== '' || intent !== '') lines.push('', '── 语义 ──', [scene, intent].filter(Boolean).join(' · '))
  const entities = evidence?.semantics?.entities ?? []
  if (entities.length > 0) {
    lines.push(`实体：${entities.map(e => (e.evidence ? `${e.name}（${e.type}；${e.evidence}）` : `${e.name}（${e.type}）`)).join('、')}`)
  }
  const uncertainty = evidence?.uncertainty ?? []
  if (uncertainty.length > 0) {
    lines.push('', '── 不确定 ──')
    for (const item of uncertainty) lines.push(`· ${item}`)
  }
  return lines.join('\n')
}
