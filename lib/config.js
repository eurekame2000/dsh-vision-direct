/**
 * 本插件的配置：读写 ~/.dsh/vision/config.json。
 *
 * 这个文件是唯一的事实来源：本插件只读写自己的配置，不碰任何外部程序的文件。上游地址、模型、密钥、额外请求头全在
 * 这里，读图工具和本机网关共用同一份。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 上游协议：只有两套，别的都是它们的一层皮。 */
export const PROTOCOLS = ['openai', 'anthropic']

export function configDir() {
  return join(homedir(), '.dsh', 'vision')
}

export function configPath() {
  return join(configDir(), 'config.json')
}

export function defaults() {
  return {
    protocol: 'openai',
    baseUrl: '',
    model: '',
    apiKey: '',
    extraHeaders: {},
    // 只有 opencode 的 go 车道强制要这个头；别的上游多发一个无害的头，
    // 但默认跟随预设，不想要可以在页面里关掉。
    sessionHeader: true,
    toolName: 'vision_read_image',
    // 粘贴图片转成路径：DSH 跑的是纯文本模型，原生粘贴会被图片准入拒掉。
    pasteToPath: true,
    // 落盘图片的滚动上限：只留最近这么多张，0 = 不限。
    pasteKeep: 10,
    gateway: { enabled: false, port: 0 },
  }
}

/**
 * 读配置。缺失即默认——但「存在却读不出」不能当成空：那是用户的配置，按空
 * 处理会在下一次保存时把它整个覆盖掉。
 */
export function readConfig() {
  let raw
  try {
    raw = readFileSync(configPath(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return defaults()
    throw new Error(`无法读取 ${configPath()}：${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${configPath()} 不是合法 JSON：${error?.message ?? error}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath()} 里不是一个 JSON 对象`)
  }
  return normalize(parsed)
}

/** 把磁盘上的形状收敛成已知字段，越界的值一律回落而不是抛错。 */
export function normalize(raw) {
  const base = defaults()
  const protocol = PROTOCOLS.includes(raw?.protocol) ? raw.protocol : base.protocol
  const gateway = raw?.gateway !== null && typeof raw?.gateway === 'object' ? raw.gateway : {}
  const port = Number(gateway.port)
  const toolName = typeof raw?.toolName === 'string' && /^[a-z][a-z0-9_]*$/i.test(raw.toolName.trim())
    ? raw.toolName.trim()
    : base.toolName
  return {
    protocol,
    baseUrl: typeof raw?.baseUrl === 'string' ? raw.baseUrl.trim() : base.baseUrl,
    model: typeof raw?.model === 'string' ? raw.model.trim() : base.model,
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : '',
    extraHeaders:
      raw?.extraHeaders !== null && typeof raw?.extraHeaders === 'object' && !Array.isArray(raw.extraHeaders)
        ? Object.fromEntries(
            Object.entries(raw.extraHeaders)
              .filter(([k, v]) => typeof k === 'string' && k.trim() !== '' && typeof v === 'string')
              .map(([k, v]) => [k.trim(), v]),
          )
        : {},
    sessionHeader: raw?.sessionHeader !== false,
    // 默认开：这个插件存在的场景就是文本模型，关掉等于让「⌘V 一张图」失败。
    pasteToPath: raw?.pasteToPath !== false,
    pasteKeep: normalizeKeep(raw?.pasteKeep),
    toolName,
    gateway: {
      enabled: gateway.enabled === true,
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0,
    },
  }
}

/**
 * 保留张数：整数，0 表示不限，上限 1000（再多也只是把磁盘当垃圾场）。
 * 只有「字段存在但不可用」才回落默认值；缺失同样走默认。
 */
function normalizeKeep(value) {
  if (value === undefined || value === null || value === '') return defaults().pasteKeep
  const number = Number(value)
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) return defaults().pasteKeep
  return Math.min(number, 1000)
}

export function writeConfig(config) {
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = configPath()
  // 文件里有密钥：0600 + 先写后改权限，目录 0700。原子性靠 rename，避免半截文件。
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return file
}
