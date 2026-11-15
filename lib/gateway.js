/**
 * 本机兼容端点（可选）。
 *
 * 读图工具自己会说话，不需要这一层。这一层是给「别的客户端」用的：它把
 * OpenAI 与 Anthropic 两套协议互转，并补上上游要的、标准客户端拼不出来的
 * 请求头。默认关闭，只有你确实要从别的程序接进来时才开。
 *
 * 只绑 127.0.0.1：这台服务持有明文密钥并替调用方签名，不能出现在局域网上。
 */
import { createServer } from 'node:http'
import { readConfig } from './config.js'
import { forward, headersFor, upstreamUrl, uuid } from './upstream.js'

// ── 双协议转换 ──────────────────────────────────────────────────────────────

/** OpenAI 的 content 数组 → Anthropic 的 content 数组。 */
function openaiContentToAnthropic(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') out.push({ type: 'text', text: part.text })
    else if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url !== 'string') continue
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
      if (match) out.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
      else out.push({ type: 'image', source: { type: 'url', url } })
    }
  }
  return out
}

/** Anthropic 的 content → OpenAI 的 content。 */
function anthropicContentToOpenai(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') out.push({ type: 'text', text: part.text })
    else if (part?.type === 'image' && part.source) {
      const url =
        part.source.type === 'base64'
          ? `data:${part.source.media_type};base64,${part.source.data}`
          : part.source.url
      if (typeof url === 'string') out.push({ type: 'image_url', image_url: { url } })
    }
  }
  return out
}

/** OpenAI 请求体 → Anthropic 请求体。 */
export function openaiToAnthropic(body, config) {
  const messages = []
  let system = ''
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role === 'system') {
      system += `${typeof message.content === 'string' ? message.content : ''}\n`
      continue
    }
    messages.push({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: openaiContentToAnthropic(message?.content),
    })
  }
  const out = {
    model: body?.model || config.model,
    // Anthropic 的 max_tokens 是必填，缺一个默认值。
    max_tokens: Number.isFinite(body?.max_tokens) ? body.max_tokens : 4096,
    messages,
  }
  if (system.trim() !== '') out.system = system.trim()
  if (Number.isFinite(body?.temperature)) out.temperature = body.temperature
  return out
}

/** Anthropic 响应 → OpenAI 响应。 */
export function anthropicToOpenai(payload, model) {
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  const text = blocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
  return {
    id: payload?.id ?? `gateway-${uuid()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: payload?.model ?? model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: payload?.stop_reason === 'max_tokens' ? 'length' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: payload?.usage?.input_tokens ?? 0,
      completion_tokens: payload?.usage?.output_tokens ?? 0,
      total_tokens: (payload?.usage?.input_tokens ?? 0) + (payload?.usage?.output_tokens ?? 0),
    },
  }
}

/** Anthropic 请求体 → OpenAI 请求体。 */
export function anthropicToOpenaiRequest(body, config) {
  const messages = []
  if (typeof body?.system === 'string' && body.system.trim() !== '') {
    messages.push({ role: 'system', content: body.system })
  } else if (Array.isArray(body?.system)) {
    const text = body.system.filter(b => b?.type === 'text').map(b => b.text).join('\n')
    if (text.trim() !== '') messages.push({ role: 'system', content: text })
  }
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    messages.push({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: anthropicContentToOpenai(message?.content),
    })
  }
  const out = { model: body?.model || config.model, messages, stream: false }
  if (Number.isFinite(body?.max_tokens)) out.max_tokens = body.max_tokens
  if (Number.isFinite(body?.temperature)) out.temperature = body.temperature
  return out
}

/** OpenAI 响应 → Anthropic 响应。 */
export function openaiToAnthropicResponse(payload, model) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined
  const content = choice?.message?.content
  const blocks = []
  if (typeof content === 'string' && content !== '') blocks.push({ type: 'text', text: content })
  else if (Array.isArray(content)) {
    for (const part of content) if (part?.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text })
  }
  return {
    id: payload?.id ?? `gateway-${uuid()}`,
    type: 'message',
    role: 'assistant',
    model: payload?.model ?? model,
    content: blocks,
    stop_reason: choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    usage: {
      input_tokens: payload?.usage?.prompt_tokens ?? 0,
      output_tokens: payload?.usage?.completion_tokens ?? 0,
    },
  }
}

// ── 服务 ────────────────────────────────────────────────────────────────────

let server = null
let boundPort = 0

export function gatewayPort() {
  return boundPort
}

async function handleProxy(req, res, clientProtocol) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32 * 1024 * 1024) {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '请求体超过 32MB' } }))
      return
    }
    chunks.push(chunk)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `请求体不是合法 JSON：${error?.message ?? error}` } }))
    return
  }

  const config = readConfig()
  if (config.baseUrl === '') {
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '还没配置上游地址，请先在「视觉模型」页面填写并保存。' } }))
    return
  }
  if (config.apiKey === '') {
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '还没配置 API Key，请先在「视觉模型」页面填写并保存。' } }))
    return
  }

  const upstream = config.protocol
  const outgoing =
    upstream === clientProtocol
      ? body
      : upstream === 'anthropic'
        ? openaiToAnthropic(body, config)
        : anthropicToOpenaiRequest(body, config)

  let result
  try {
    // 网关的调用方可能在传大图，给比读图工具更宽的时间。
    result = await forward(upstreamUrl(config, upstream), headersFor(config), outgoing, { timeoutMs: 300_000 })
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
    return
  }

  if (!result.ok) {
    // 上游的错误原样透出：400/402 的正文是用户唯一能定位问题的线索。
    res.writeHead(result.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.payload))
    return
  }

  const payload =
    upstream === clientProtocol
      ? result.payload
      : upstream === 'anthropic'
        ? anthropicToOpenai(result.payload, config.model)
        : openaiToAnthropicResponse(result.payload, config.model)

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

export function startGateway(port) {
  if (server !== null) return Promise.resolve(boundPort)
  return new Promise((resolve, reject) => {
    const instance = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '只接受 POST' } }))
        return
      }
      const clientProtocol =
        path.endsWith('/messages') ? 'anthropic' : path.endsWith('/chat/completions') ? 'openai' : null
      if (clientProtocol === null) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `未知端点 ${path}` } }))
        return
      }
      void handleProxy(req, res, clientProtocol).catch(error => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
      })
    })
    instance.once('error', reject)
    instance.listen(port, '127.0.0.1', () => {
      server = instance
      boundPort = instance.address().port
      resolve(boundPort)
    })
  })
}

export async function stopGateway() {
  const instance = server
  server = null
  boundPort = 0
  if (instance !== null) await new Promise(resolve => instance.close(resolve))
}
