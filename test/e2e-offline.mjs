/**
 * dsh-vision 离线端到端测试。
 *
 * 两段：
 *   A. 纯函数 —— 请求头分叉、端点拼接、两套协议的互转、配置归一化；
 *   B. 真链路 —— 起 mock 上游，跑「读图工具」的完整路径（两套协议、缓存、
 *      兜底、错误边界）和可选网关的四条转发路径。
 *
 * 全程不联网、不需要密钥。会临时改写 ~/.dsh/vision/config.json —— 先备份，
 * 跑完恢复。
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 用相对路径定位被测模块：仓库挪到哪都能跑，也不会把本机目录写进公开仓库。
const P = new URL('../index.js', import.meta.url).href
// 用一次性目录，绝不碰用户真实的 ~/.dsh/vision：测试写脏真实配置的代价是
// 「粘贴通道被悄悄关掉」，排查起来比测试本身还费时间。
const GW_DIR = join(tmpdir(), `dsh-vision-test-${process.pid}`)
process.env.DSH_VISION_CONFIG_DIR = GW_DIR
const GW_CFG = join(GW_DIR, 'config.json')
const TMP = join(GW_DIR, 'test-assets')

const K = v => ({ apiKey: v })
const KEY_A = 'K-aaa-111'
const KEY_B = 'K-bbb-222'
const KEY_UP = 'K-upstream-333'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(`${name} ${detail}`)
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, a === e ? '' : `\n        实际: ${a}\n        期望: ${e}`)
}

// 1x1 红点 PNG：真图片，能被嗅探，也能塞进 data URL。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)


const EVIDENCE = {
  summary: '一张测试图，画着一个红点。',
  ocr: { full_text: 'HELLO 42', lines: [{ text: 'HELLO', language: 'en' }, { text: '42' }] },
  layout: {
    regions: [
      { type: 'title', reading_order: 2, text: '42' },
      { type: 'paragraph', reading_order: 1, text: 'HELLO' },
    ],
  },
  semantics: {
    scene: 'screenshot',
    intent: '测试',
    entities: [{ name: '42', type: 'number', evidence: '中央' }],
    relations: [],
  },
  visual: { dominant_colors: ['#ff0000'], style: 'flat', notes: [] },
  uncertainty: ['边缘被裁切'],
}

// ── mock 上游 ──────────────────────────────────────────────────────────────
const seen = []
let upstreamMode = 'json'

function answerText(req, payload) {
  if (upstreamMode === 'nonjson') return '这张图里只有一个红点，没有别的。'
  return JSON.stringify(EVIDENCE)
}

const mock = createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  let body = null
  try {
    body = raw === '' ? null : JSON.parse(raw)
  } catch {
    body = null
  }
  seen.push({ url: req.url, headers: req.headers, body })

  if (upstreamMode === 'http500') {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'boom' } }))
    return
  }

  // 上游的 /models：给两条假模型，供路由形状测试断言「列表真的透传出来」。
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'mock-vision-1', name: 'Mock Vision 1' }, { id: 'mock-vision-2', name: 'Mock Vision 2' }],
    }))
    return
  }

  const text = answerText(req, body)
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url.endsWith('/messages')) {
    res.end(
      JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'mock-anthropic',
        content: [{ type: 'text', text }],
        stop_reason: upstreamMode === 'truncated' ? 'max_tokens' : 'end_turn',
        usage: { input_tokens: 11, output_tokens: 22 },
      }),
    )
    return
  }
  res.end(
    JSON.stringify({
      id: 'chatcmpl_mock',
      object: 'chat.completion',
      created: 1,
      model: 'mock-openai',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: upstreamMode === 'truncated' ? 'length' : 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    }),
  )
})

// ── 纯函数 ─────────────────────────────────────────────────────────────────
async function unit(G) {
  console.log('\n【1】请求头分叉')
  {
    const oa = G.headersFor({ protocol: 'openai', ...K(KEY_A), extraHeaders: {}, sessionHeader: false })
    eq('OpenAI: authorization 为 Bearer', oa.authorization, `Bearer ${KEY_A}`)
    ok('OpenAI: 无 x-api-key', !('x-api-key' in oa), JSON.stringify(oa))
    ok('OpenAI: 无 anthropic-version', !('anthropic-version' in oa))

    const an = G.headersFor({ protocol: 'anthropic', ...K(KEY_B), extraHeaders: {}, sessionHeader: false })
    eq('Anthropic: x-api-key 直填', an['x-api-key'], KEY_B)
    eq('Anthropic: 版本头存在', an['anthropic-version'], '2023-06-01')
    ok('Anthropic: 无 authorization', !('authorization' in an), JSON.stringify(an))

    const sess = G.headersFor({ protocol: 'openai', ...K(KEY_A), extraHeaders: {}, sessionHeader: true })
    ok('sessionHeader 补 x-opencode-session', /^[0-9a-f-]{36}$/.test(sess['x-opencode-session'] ?? ''), String(sess['x-opencode-session']))

    const inj = G.headersFor({ protocol: 'openai', ...K(KEY_A), extraHeaders: { Authorization: 'Bearer EVIL', 'X-Custom': 'v' }, sessionHeader: false })
    eq('extraHeaders 不能覆盖 authorization', inj.authorization, `Bearer ${KEY_A}`)
    eq('extraHeaders 普通字段透传', inj['x-custom'], 'v')

    const uh = G.headersFor({ protocol: 'openai', ...K(KEY_A), extraHeaders: { 'x-opencode-session': '$uuid' }, sessionHeader: false })
    ok('$uuid 占位符被替换', /^[0-9a-f-]{36}$/.test(uh['x-opencode-session'] ?? ''), String(uh['x-opencode-session']))
  }

  console.log('\n【2】端点拼接')
  {
    eq('无版本段 → 补 /v1', G.upstreamUrl({ baseUrl: 'https://a.com' }, 'openai'), 'https://a.com/v1/chat/completions')
    eq('已含 /v1 不重复', G.upstreamUrl({ baseUrl: 'https://a.com/v1' }, 'openai'), 'https://a.com/v1/chat/completions')
    eq('尾斜杠被裁', G.upstreamUrl({ baseUrl: 'https://a.com/v1/' }, 'openai'), 'https://a.com/v1/chat/completions')
    eq('anthropic 走 /messages', G.upstreamUrl({ baseUrl: 'https://api.anthropic.com/v1' }, 'anthropic'), 'https://api.anthropic.com/v1/messages')
    eq('opencode 实配地址', G.upstreamUrl({ baseUrl: 'https://opencode.ai/inference/go/openai/v1' }, 'openai'), 'https://opencode.ai/inference/go/openai/v1/chat/completions')
  }

  console.log('\n【3】OpenAI 请求 → Anthropic 请求')
  {
    const out = G.openaiToAnthropic({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: '你是视觉助手' },
        { role: 'user', content: [{ type: 'text', text: '图上是什么' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'assistant', content: '一个圆和一个方' },
      ],
    }, { model: 'fallback' })
    eq('system 提到顶层', out.system, '你是视觉助手')
    eq('消息数（去 system）', out.messages.length, 2)
    ok('max_tokens 已补默认值', Number.isFinite(out.max_tokens) && out.max_tokens > 0, String(out.max_tokens))
    eq('图片转 base64 source', out.messages[0].content.find(b => b.type === 'image')?.source, { type: 'base64', media_type: 'image/png', data: 'AAAA' })
    eq('文本块保留', out.messages[0].content[0], { type: 'text', text: '图上是什么' })
    eq('assistant 角色不变', out.messages[1].role, 'assistant')
    ok('无 image_url 残留', !JSON.stringify(out).includes('image_url'))
    ok('无 role:system 消息残留', !out.messages.some(m => m.role === 'system'))
  }

  console.log('\n【4】Anthropic 请求 → OpenAI 请求')
  {
    const out = G.anthropicToOpenaiRequest({
      system: '你是视觉助手', max_tokens: 512,
      messages: [{ role: 'user', content: [{ type: 'text', text: '图上是什么' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
    }, { model: 'fallback' })
    eq('system 变 role:system', out.messages[0], { role: 'system', content: '你是视觉助手' })
    eq('stream 固定 false', out.stream, false)
    eq('max_tokens 透传', out.max_tokens, 512)
    ok('图片转 image_url', JSON.stringify(out.messages[1].content).includes('data:image/png;base64,AAAA'))
    ok('无 anthropic image block 残留', !JSON.stringify(out).includes('"source"'))
  }

  console.log('\n【5】响应回程转换')
  {
    const toOA = G.anthropicToOpenai({ id: 'msg_1', model: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: '答' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }, 'fallback')
    eq('→ OpenAI content', toOA.choices[0].message.content, '答')
    eq('object 标记', toOA.object, 'chat.completion')
    eq('usage 映射', toOA.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 })

    const toAN = G.openaiToAnthropicResponse({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '答' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }, 'fallback')
    eq('→ anthropic content blocks', toAN.content, [{ type: 'text', text: '答' }])
    eq('length → max_tokens', toAN.stop_reason, 'max_tokens')
    eq('usage 反向映射', toAN.usage, { input_tokens: 3, output_tokens: 4 })
  }

  console.log('\n【6】配置归一化')
  {
    const d = G.normalize({})
    eq('默认协议 openai', d.protocol, 'openai')
    eq('默认端口 0', d.gateway.port, 0)
    eq('默认 sessionHeader 开', d.sessionHeader, true)
    eq('默认工具名', d.toolName, 'vision_read_image')
    eq('网关默认关闭', d.gateway.enabled, false)
    eq('默认保留 10 张', d.pasteKeep, 10)

    const bad = G.normalize({ protocol: 'gemini', gateway: { port: 99999 }, ...K(123), toolName: '!!!' })
    eq('未知协议回落 openai', bad.protocol, 'openai')
    eq('越界端口回落 0', bad.gateway.port, 0)
    eq('非字符串 key 收敛成空串', bad.apiKey, '')
    eq('非法工具名回落默认', bad.toolName, 'vision_read_image')
    eq('负数张数回落默认', G.normalize({ pasteKeep: -1 }).pasteKeep, 10)
    eq('非数字张数回落默认', G.normalize({ pasteKeep: 'abc' }).pasteKeep, 10)
    eq('小数张数回落默认', G.normalize({ pasteKeep: 2.5 }).pasteKeep, 10)
    eq('0 表示不限', G.normalize({ pasteKeep: 0 }).pasteKeep, 0)
    eq('超大张数封顶 1000', G.normalize({ pasteKeep: 5000 }).pasteKeep, 1000)
    eq('字符串数字被接受', G.normalize({ pasteKeep: '7' }).pasteKeep, 7)
  }

  console.log('\n【7】证据解析')
  {
    const fenced = G.parseEvidence('```json\n' + JSON.stringify(EVIDENCE) + '\n```')
    eq('剥掉 json 围栏', fenced.summary, EVIDENCE.summary)
    const chatty = G.parseEvidence('好的，结果如下：' + JSON.stringify(EVIDENCE) + ' 希望有帮助')
    eq('从闲聊里取出 JSON', chatty.ocr.full_text, 'HELLO 42')
    const plain = G.parseEvidence('图里有个红点。')
    eq('纯文本不报错、进 summary', plain.summary, '图里有个红点。')
    ok('纯文本时 uncertainty 有说明', plain.uncertainty.some(u => u.includes('没有按 JSON')), JSON.stringify(plain.uncertainty))
    const sparse = G.parseEvidence('{"summary":"只有摘要"}')
    eq('缺字段补空结构', sparse.ocr, { full_text: '', lines: [] })
    eq('缺字段补空 regions', sparse.layout.regions, [])
    eq('缺字段补空 uncertainty', sparse.uncertainty, [])
    const odd = G.parseEvidence('{"summary":1,"ocr":{"lines":[{"text":""},{"text":"ok"}]},"uncertainty":"x"}')
    eq('错类型收敛成空串', odd.summary, '')
    eq('空行被丢掉', odd.ocr.lines, [{ text: 'ok' }])
    eq('非数组 uncertainty 收敛', odd.uncertainty, [])
  }
}

// ── 真链路 ─────────────────────────────────────────────────────────────────
async function integration(G, base) {
  const img = join(TMP, 'dot.png')
  writeFileSync(img, PNG)
  const notImage = join(TMP, 'note.txt')
  writeFileSync(notImage, 'this is not an image')
  const huge = join(TMP, 'huge.png')
  writeFileSync(huge, Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]))

  const configure = (patch = {}) => {
    G.writeConfig(
      G.normalize({
        protocol: 'openai',
        baseUrl: base,
        model: 'test-vl',
        ...K(KEY_A),
        extraHeaders: {},
        sessionHeader: false,
        gateway: { enabled: false, port: 0 },
        ...patch,
      }),
    )
  }

  console.log('\n【8】读图 · OpenAI 协议')
  {
    configure()
    const { evidence, text } = await G.readImage(img, '看标题')
    eq('summary 原样返回', evidence.summary, EVIDENCE.summary)
    eq('ocr.full_text', evidence.ocr.full_text, 'HELLO 42')
    eq('版面按 reading_order 排序', evidence.layout.regions.map(r => r.text), ['HELLO', '42'])
    eq('meta 来源是绝对路径', evidence.meta.source, img)
    eq('meta.mime', evidence.meta.mime, 'image/png')
    ok('meta.bytes 是真实大小', evidence.meta.bytes === PNG.length, String(evidence.meta.bytes))
    eq('meta.model', evidence.meta.model, 'test-vl')
    ok('渲染文本含 OCR', text.includes('HELLO 42'))
    const last = seen.at(-1)
    eq('打到 /chat/completions', last.url, '/v1/chat/completions')
    eq('Bearer 鉴权', last.headers.authorization, `Bearer ${KEY_A}`)
    ok('没发多余的 session 头', last.headers['x-opencode-session'] === undefined)
    eq('模型名透传', last.body.model, 'test-vl')
    const part = last.body.messages[0].content.find(p => p.type === 'image_url')
    ok('图片是 data URL', part?.image_url?.url.startsWith('data:image/png;base64,'))
    ok('关注点进了提示词', last.body.messages[0].content.some(p => p.type === 'text' && p.text.includes('看标题')))
  }

  console.log('\n【9】读图 · Anthropic 协议')
  {
    configure({ protocol: 'anthropic' })
    const { evidence } = await G.readImage(img, '', { cache: false })
    eq('summary 原样返回', evidence.summary, EVIDENCE.summary)
    const last = seen.at(-1)
    eq('打到 /messages', last.url, '/v1/messages')
    eq('x-api-key 鉴权', last.headers['x-api-key'], KEY_A)
    eq('声明 anthropic-version', last.headers['anthropic-version'], '2023-06-01')
    const imageBlock = last.body.messages[0].content.find(p => p.type === 'image')
    ok('图片是 base64 source', imageBlock?.source?.type === 'base64' && imageBlock.source.media_type === 'image/png')
    ok('max_tokens 必填', typeof last.body.max_tokens === 'number')
    eq('输出预算够写完整证据', last.body.max_tokens, 4096)
  }

  console.log('\n【10】缓存')
  {
    configure()
    const before = seen.length
    const first = await G.readImage(img, '缓存测试')
    const mid = seen.length
    const second = await G.readImage(img, '缓存测试')
    ok('第一次真的打了上游', mid === before + 1, `${before} → ${mid}`)
    ok('第二次没打上游', seen.length === mid, `${mid} → ${seen.length}`)
    eq('第二次标记 cached', second.evidence.meta.cached, true)
    eq('两次证据一致', second.evidence.summary, first.evidence.summary)
    const third = await G.readImage(img, '换一个问题')
    ok('换关注点会重读', seen.length === mid + 1)
    const again = await G.readImage(img, '缓存测试', { cache: false })
    eq('cache:false 不标记 cached', again.evidence.meta.cached, false)
  }

  console.log('\n【10b】截断')
  {
    upstreamMode = 'truncated'
    configure()
    const { evidence } = await G.readImage(img, '', { cache: false })
    ok('截断时 uncertainty 第一条就说明', (evidence.uncertainty[0] ?? '').includes('截断'), JSON.stringify(evidence.uncertainty[0]))
    upstreamMode = 'json'
  }

  console.log('\n【11】兜底与错误')
  {
    upstreamMode = 'nonjson'
    configure()
    const { evidence } = await G.readImage(img, '', { cache: false })
    ok('非 JSON 回答不报错', evidence.summary.length > 0)
    ok('非 JSON 回答进 uncertainty', evidence.uncertainty[0].includes('没有按 JSON 格式回答'))
    eq('结构仍完整', Array.isArray(evidence.layout.regions), true)
    upstreamMode = 'json'
  }
  {
    configure()
    await G.readImage(notImage, '', { cache: false }).then(
      () => ok('非图片应当报错', false),
      error => ok('非图片报错清晰', error.message.includes('不是可识别的图片'), error.message),
    )
    await G.readImage(join(TMP, 'nope.png'), '', { cache: false }).then(
      () => ok('缺文件应当报错', false),
      error => ok('缺文件报错清晰', error.message.includes('找不到文件'), error.message),
    )
    await G.readImage(huge, '', { cache: false }).then(
      () => ok('超大图应当报错', false),
      error => ok('超大图报错清晰', error.message.includes('上限'), error.message),
    )
    ok('超大图确实超过 8MB', statSync(huge).size > 8 * 1024 * 1024)
    await G.readImage('', '', { cache: false }).then(
      () => ok('空路径应当报错', false),
      error => ok('空路径报错清晰', error.message.includes('不能为空'), error.message),
    )
  }
  {
    upstreamMode = 'http500'
    configure()
    await G.readImage(img, '', { cache: false }).then(
      () => ok('上游 500 应当报错', false),
      error => ok('上游错误带状态码', error.message.includes('上游 HTTP 500'), error.message),
    )
    upstreamMode = 'json'
  }
  {
    G.writeConfig(G.normalize({ protocol: 'openai', baseUrl: '', model: '', apiKey: '', sessionHeader: false }))
    await G.readImage(img, '', { cache: false }).then(
      () => ok('未配置应当报错', false),
      error => ok('未配置提示去页面', error.message.includes('视觉模型'), error.message),
    )
  }

  console.log('\n【12】本机兼容端点')
  {
    configure({ gateway: { enabled: true, port: 0 } })
    await G.stopGateway()
    const gw = await G.startGateway(0)
    ok('网关拿到端口', gw > 0, String(gw))

    const post = async (path, body, port = gw) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, payload: await response.json() }
    }

    const same = await post('/v1/chat/completions', { model: 'test-vl', messages: [{ role: 'user', content: 'hi' }] })
    eq('OpenAI→OpenAI 状态', same.status, 200)
    eq('OpenAI→OpenAI 直通模型', seen.at(-1).body.model, 'test-vl')

    const cross = await post('/v1/messages', {
      model: 'test-vl',
      max_tokens: 64,
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    eq('Anthropic→OpenAI 状态', cross.status, 200)
    ok('Anthropic→OpenAI 回 Anthropic 形状', Array.isArray(cross.payload.content))
    eq('系统提示被搬到 messages', seen.at(-1).body.messages[0].role, 'system')

    configure({ protocol: 'anthropic', gateway: { enabled: true, port: 0 } })
    await G.stopGateway()
    const port2 = await G.startGateway(0)
    const response = await fetch(`http://127.0.0.1:${port2}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-vl',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      }),
    })
    const payload = await response.json()
    eq('OpenAI→Anthropic 状态', response.status, 200)
    ok('OpenAI→Anthropic 回 chat.completion', Array.isArray(payload.choices))

    const bad = await post('/v1/embeddings', {}, port2)
    eq('未知端点 404', bad.status, 404)
    const get = await fetch(`http://127.0.0.1:${port2}/v1/chat/completions`)
    eq('非 POST 405', get.status, 405)
    await G.stopGateway()
  }

  console.log('\n【12b】清空连接参数')
  {
    configure({ protocol: 'anthropic', pasteToPath: true, pasteKeep: 4 })
    await G.save({ baseUrl: '', model: '', clearKey: true })
    const cleared = G.readConfig()
    eq('上游被清空', cleared.baseUrl, '')
    eq('模型被清空', cleared.model, '')
    eq('密钥被清空', cleared.apiKey, '')
    eq('粘贴开关不受影响', cleared.pasteToPath, true)
    eq('保留张数不受影响', cleared.pasteKeep, 4)
  }

  console.log('\n【13】配置落盘')
  {
    configure({ protocol: 'anthropic', sessionHeader: true, extraHeaders: { 'x-custom': 'v-$uuid' } })
    const loaded = G.readConfig()
    eq('协议持久化', loaded.protocol, 'anthropic')
    ok('额外头持久化', loaded.extraHeaders['x-custom'] === 'v-$uuid')
    const headers = G.headersFor(loaded)
    ok('$uuid 被替换', headers['x-custom'].startsWith('v-') && headers['x-custom'].length > 10)
    ok('session 头已注入', typeof headers['x-opencode-session'] === 'string')
    ok('配置文件是 600', (statSync(GW_CFG).mode & 0o777) === 0o600, (statSync(GW_CFG).mode & 0o777).toString(8))
    eq('工具名写进配置', JSON.parse(readFileSync(GW_CFG, 'utf8')).toolName, 'vision_read_image')
  }
}

// ── 粘贴通道 ───────────────────────────────────────────────────────────────
async function pasteChannel(G) {
  console.log('\n【14】粘贴通道')
  const handlers = {}
  const mod = await import(P)
  const ctx = {
    tools: { register() { return () => {} } },
    inject(services, cb) {
      if (services.includes('llm')) return cb({ llm: undefined })
      if (services.includes('webServer')) {
        cb({
          webServer: {
            register(row) {
              handlers[row.path] = row.handler
              return () => {}
            },
          },
          effect(fn) {
            const dispose = fn()
            return typeof dispose === 'function' ? dispose : () => {}
          },
        })
      }
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  mod.apply(ctx, {})
  ok('粘贴路由已注册', typeof handlers['/api/vision/paste'] === 'function')

  const call = (method, url, body, route = '/api/vision/paste') => new Promise(resolve => {
    const req = Readable.from(body === undefined ? [] : [body])
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:43120' }
    const res = {
      status: 0,
      payload: null,
      headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true },
      end(text) {
        try { this.payload = JSON.parse(text) } catch { this.payload = text }
        resolve({ status: this.status, payload: this.payload })
      },
    }
    handlers[route](req, res)
  })

  G.writeConfig(G.normalize({ protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', ...K(KEY_A), pasteToPath: true, gateway: { enabled: false, port: 0 } }))

  const probe = await call('GET', '/api/vision/paste?model=DeepSeek', undefined)
  eq('探路返回 200', probe.status, 200)
  eq('通道开着', probe.payload.enabled, true)
  eq('无 llm 时默认接管', probe.payload.takeover, true)

  const first = await call('POST', '/api/vision/paste', PNG)
  eq('粘一张图返回 200', first.status, 200)
  ok('返回了路径', typeof first.payload.path === 'string' && first.payload.path.endsWith('.png'), first.payload.path)
  ok('落盘文件存在', existsSync(first.payload.path))
  eq('落盘文件 600', (statSync(first.payload.path).mode & 0o777), 0o600)
  ok('落盘在配置目录的 pastes 下', first.payload.path.startsWith(join(GW_DIR, 'pastes')))
  eq('mime 正确', first.payload.mime, 'image/png')

  const second = await call('POST', '/api/vision/paste', PNG)
  eq('同一张图内容寻址', second.payload.path, first.payload.path)

  const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const third = await call('POST', '/api/vision/paste', tiny)
  ok('不同内容得到不同路径', third.payload.path !== first.payload.path)

  const text = await call('POST', '/api/vision/paste', Buffer.from('hello'))
  eq('非图片 400', text.status, 400)
  ok('非图片提示清楚', String(text.payload.error).includes('不是可识别的图片'), String(text.payload.error))

  const empty = await call('POST', '/api/vision/paste', Buffer.alloc(0))
  eq('空内容 400', empty.status, 400)

  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(32)])
  const heicRes = await call('POST', '/api/vision/paste', heic)
  eq('HEIC 400', heicRes.status, 400)
  ok('HEIC 提示会转格式', String(heicRes.payload.error).includes('HEIC'), String(heicRes.payload.error))

  G.writeConfig(G.normalize({ protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', ...K(KEY_A), pasteToPath: false, gateway: { enabled: false, port: 0 } }))
  const off = await call('GET', '/api/vision/paste?model=DeepSeek', undefined)
  eq('关闭后 enabled=false', off.payload.enabled, false)
  eq('关闭后不接管', off.payload.takeover, false)
  const rejected = await call('POST', '/api/vision/paste', PNG)
  eq('关闭后 POST 409', rejected.status, 409)

  rmSync(first.payload.path, { force: true })
  rmSync(third.payload.path, { force: true })

  // ── 滚动清理 ──
  const pastes = join(GW_DIR, 'pastes')
  const variant = index => Buffer.concat([PNG, Buffer.from(`-variant-${index}`)])
  const pause = () => new Promise(resolve => setTimeout(resolve, 5))
  const setKeep = keep => G.writeConfig(G.normalize({
    protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', ...K(KEY_A),
    pasteToPath: true, pasteKeep: keep, gateway: { enabled: false, port: 0 },
  }))

  rmSync(pastes, { recursive: true, force: true })
  setKeep(3)
  const kept = []
  for (let i = 0; i < 5; i += 1) {
    kept.push((await call('POST', '/api/vision/paste', variant(i))).payload.path)
    await pause()
  }
  eq('保留 3 张时目录只有 3 个文件', readdirSync(pastes).length, 3)
  ok('最旧的两张被删', !existsSync(kept[0]) && !existsSync(kept[1]))
  ok('最新的三张都在', kept.slice(2).every(path => existsSync(path)))

  // 重复粘贴应当刷新优先级，而不是因为「内容已存在」被当成旧图先删
  rmSync(pastes, { recursive: true, force: true })
  setKeep(2)
  const a = (await call('POST', '/api/vision/paste', variant(10))).payload.path
  await pause()
  const b = (await call('POST', '/api/vision/paste', variant(11))).payload.path
  await pause()
  const aAgain = (await call('POST', '/api/vision/paste', variant(10))).payload.path
  eq('重复内容路径不变', aAgain, a)
  await pause()
  const c = (await call('POST', '/api/vision/paste', variant(12))).payload.path
  eq('重复粘贴后保留 2 张', readdirSync(pastes).length, 2)
  ok('刚重复粘过的那张还在', existsSync(a))
  ok('最新那张还在', existsSync(c))
  ok('中间那张被挤掉', !existsSync(b))

  // 0 = 不限
  rmSync(pastes, { recursive: true, force: true })
  setKeep(0)
  for (let i = 0; i < 6; i += 1) {
    await call('POST', '/api/vision/paste', variant(20 + i))
    await pause()
  }
  eq('0 表示不限，6 张全留', readdirSync(pastes).length, 6)

  // 只清自己命名的文件，别人放进目录的东西不碰
  writeFileSync(join(pastes, 'mine.txt'), 'not ours')
  setKeep(2)
  await call('POST', '/api/vision/paste', variant(30))
  {
    const names = readdirSync(pastes)
    ok('外来文件没被删', names.includes('mine.txt'))
    eq('图片被裁到 2 张', names.filter(name => name !== 'mine.txt').length, 2)
  }
  rmSync(join(pastes, 'mine.txt'), { force: true })

  // ── 重置 ──
  setKeep(3)
  G.writeConfig(G.normalize({
    protocol: 'anthropic', baseUrl: 'https://example.invalid/v1', model: 'some-vl',
    ...K(KEY_B), extraHeaders: { 'x-custom': '1' }, pasteToPath: false, pasteKeep: 3,
    gateway: { enabled: false, port: 0 },
  }))
  const reset = await call('POST', '/api/vision/reset', Buffer.from('{}'), '/api/vision/reset')
  eq('重置返回 200', reset.status, 200)
  const after = G.readConfig()
  eq('重置清空上游', after.baseUrl, '')
  eq('重置清空模型', after.model, '')
  eq('重置清空密钥', after.apiKey, '')
  eq('重置清空请求头', after.extraHeaders, {})
  eq('重置恢复默认张数', after.pasteKeep, 10)
  eq('重置恢复粘贴通道', after.pasteToPath, true)
  eq('重置恢复默认协议', after.protocol, 'openai')
}

// ── 预设管理 ───────────────────────────────────────────────────────────────
async function presetChannel(G) {
  console.log('\n【15】预设管理')
  G.writeConfig(G.normalize({
    protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', ...K(KEY_A),
    gateway: { enabled: false, port: 0 },
  }))

  const initial = await G.summary()
  eq('默认五个预设', initial.presets.length, 5)
  ok('都标记为内置', initial.presets.every(preset => preset.builtin === true))
  eq('初始没有隐藏', initial.hiddenPresets, 0)

  await G.presets({ action: 'hide', id: 'openai' })
  const hidden = await G.summary()
  eq('隐藏后剩四个', hidden.presets.length, 4)
  ok('被隐藏的不在列表里', !hidden.presets.some(preset => preset.id === 'openai'))
  eq('隐藏计数为 1', hidden.hiddenPresets, 1)

  await G.presets({ action: 'unhide', id: 'openai' })
  eq('单个恢复', (await G.summary()).presets.length, 5)

  await G.presets({ action: 'hide', id: 'openai' })
  await G.presets({ action: 'hide', id: 'anthropic' })
  await G.presets({ action: 'restore' })
  const restored = await G.summary()
  eq('一键恢复清空隐藏', restored.hiddenPresets, 0)
  eq('一键恢复后五个都在', restored.presets.length, 5)

  await G.presets({
    action: 'save',
    preset: { label: '我的中转', protocol: 'openai', baseUrl: 'https://relay.example/v1', model: 'glm-4v' },
  })
  const saved = (await G.summary()).presets.find(preset => preset.label === '我的中转')
  ok('自定义预设被保存', saved !== undefined)
  eq('自定义预设不是内置', saved?.builtin, false)
  eq('自定义预设保留模型名', saved?.model, 'glm-4v')

  await G.presets({ action: 'remove', id: saved.id })
  ok('自定义预设被删除', !(await G.summary()).presets.some(preset => preset.id === saved.id))

  await G.presets({ action: 'hide', id: 'nope' }).then(
    () => ok('未知内置应当报错', false),
    error => ok('未知内置报错清晰', error.message.includes('没有这个内置预设'), error.message),
  )
  await G.presets({ action: 'save', preset: { label: 'x', baseUrl: '' } }).then(
    () => ok('空地址应当报错', false),
    error => ok('空地址报错清晰', error.message.includes('上游地址'), error.message),
  )
  await G.presets({ action: 'save', preset: { label: '', baseUrl: 'https://a.example/v1' } }).then(
    () => ok('空名字应当报错', false),
    error => ok('空名字报错清晰', error.message.includes('名字'), error.message),
  )
  await G.presets({ action: 'bogus' }).then(
    () => ok('未知操作应当报错', false),
    error => ok('未知操作报错清晰', error.message.includes('未知的预设操作'), error.message),
  )
}

// ── 路由返回形状 ───────────────────────────────────────────────────────────
/**
 * 把 apply() 挂到假宿主上，用真 HTTP 打每条路由，断言**返回形状**。
 *
 * 为什么单列一节：其余各节都直接调 `__vision` 里导出的函数，**绕过了 route()
 * 外壳**，所以「后端吐裸数组 / 前端按字段名取 → 恒空且不报错」这类 bug 一条都
 * 测不出来。`/api/vision/models` 就这样让 32 个上游模型在页面上显示了很久的
 * 0 个，而当时 175 条断言全绿。新增或修改路由时，同步在这里补一条形状断言。
 */
async function routeShapes(V, base) {
  console.log('\n【16】路由返回形状')

  const table = new Map()
  const host = {
    tools: { register: () => {} },
    inject: (deps, fn) => {
      fn({
        effect: (producer) => { const value = producer(); if (value?.route) table.set(value.route.path, value.route.handler) },
        webServer: {
          register: route => { table.set(route.path, route.handler); return { route, handler: route.handler } },
        },
        llm: { listProviders: () => [], listModels: async () => [] },
      })
    },
    effect: () => {},
  }

  // 路由读的是磁盘配置：先写一份指向 mock 上游的，避免碰真实上游。
  V.__vision.writeConfig(V.__vision.normalize({
    protocol: 'openai', baseUrl: base, model: 'mock-vision-1', ...K(KEY_A),
    gateway: { enabled: false, port: 0 },
  }))
  V.apply(host, {})

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const handler = table.get(path)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `no route ${path}` }))
      return
    }
    handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`

  const hit = async (method, path, body, headers = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try { json = text === '' ? null : JSON.parse(text) } catch { json = null }
    return { status: response.status, json, text }
  }

  try {
    // 一条工具 + 八条路由（summary / save / reset / presets / test / models / paste / read）。
    eq('八条路由全部注册', table.size, 8)

    // 总纲：所有路由的响应体必须是对象。裸数组/裸标量会让前端所有按字段名
    // 取值的写法静默失效，而 HTTP 200 看起来完全正常。
    const summary = await hit('GET', '/api/vision/summary')
    eq('summary 状态 200', summary.status, 200)
    ok('summary 是对象不是数组', summary.json !== null && typeof summary.json === 'object' && !Array.isArray(summary.json))
    ok('summary 带 presets 列表', Array.isArray(summary.json?.presets) && summary.json.presets.length > 0)
    ok('summary 不回明文密钥', !('apiKey' in (summary.json ?? {})) && typeof summary.json?.hasKey === 'boolean')

    // 这一条就是当初漏掉的 bug：裸数组 → 页面永远 0 个模型。
    const models = await hit('POST', '/api/vision/models', {})
    eq('models 状态 200', models.status, 200)
    ok('models 是对象不是裸数组', models.json !== null && !Array.isArray(models.json), `实际 ${JSON.stringify(models.json).slice(0, 80)}`)
    ok('models 列表在 models 字段下', Array.isArray(models.json?.models), `实际键 ${Object.keys(models.json ?? {}).join(',')}`)
    eq('models 透传上游两条', models.json?.models?.length, 2)
    eq('models 保留 id', models.json?.models?.[0]?.id, 'mock-vision-1')

    const save = await hit('POST', '/api/vision/save', { pasteKeep: 6 })
    eq('save 状态 200', save.status, 200)
    ok('save 返回 configPath 字符串', typeof save.json?.configPath === 'string' && save.json.configPath !== '')

    const test = await hit('POST', '/api/vision/test', {})
    eq('test 状态 200', test.status, 200)
    ok('test 返回 ok 布尔', typeof test.json?.ok === 'boolean')

    const read = await hit('POST', '/api/vision/read', { path: '/tmp/definitely-not-here.png' })
    eq('read 不存在的文件 400', read.status, 400)
    ok('read 报错说清是找不到文件', String(read.json?.error ?? '').includes('找不到文件'), JSON.stringify(read.json).slice(0, 120))

    const paste = await hit('POST', '/api/vision/paste', {})
    eq('paste 空体 400', paste.status, 400)

    const preset = await hit('POST', '/api/vision/presets', { action: 'nuke' })
    eq('presets 非法操作 400', preset.status, 400)
    ok('presets 报错说清哪里不对', String(preset.json?.error ?? '').includes('未知的预设操作'), JSON.stringify(preset.json).slice(0, 120))

    // 外壳的两道闸：方法不对、来源不对。
    const wrongMethod = await hit('GET', '/api/vision/models')
    eq('方法不对回 405', wrongMethod.status, 405)

    const crossSite = await hit('GET', '/api/vision/summary', undefined, { origin: 'https://evil.example' })
    eq('跨站 Origin 被栅栏挡下 403', crossSite.status, 403)

    // reset 放最后：它会把配置清回默认值，前面依赖配置的断言不能排在它后面。
    const reset = await hit('POST', '/api/vision/reset', {})
    eq('reset 状态 200', reset.status, 200)
    ok('reset 同样返回完整 summary 对象', typeof reset.json?.configPath === 'string' && reset.json?.hasKey === false)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

// ── 跑 ─────────────────────────────────────────────────────────────────────
try {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${mock.address().port}/v1`
  const V = await import(P)
  const { __vision: G } = V

  mkdirSync(TMP, { recursive: true })
  await unit(G)
  await integration(G, base)
  await pasteChannel(G)
  await presetChannel(G)
  await routeShapes(V, base)
} catch (error) {
  console.error('\n测试自身崩溃：', error)
  fail += 1
} finally {
  await new Promise(resolve => mock.close(resolve))
  rmSync(GW_DIR, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`)
  if (failures.length > 0) console.log(failures.map(f => ` - ${f}`).join('\n'))
  process.exitCode = fail === 0 ? 0 : 1
}
