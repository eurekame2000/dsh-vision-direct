/**
 * 读一张图：本地路径或 http(s) URL → { mime, bytes, base64 }。
 *
 * 边界都在这里：
 *   - 只认真实图片（嗅探 magic bytes），不信扩展名，也不信 Content-Type；
 *   - 单张上限 8MB —— base64 后约 10.7MB，多数上游的请求体上限在 10~20MB；
 *   - 远程抓取有超时和重定向上限，避免一个慢图拖死整个工具调用；
 *   - HEIC/HEIF 直接给一句人话：上游基本不认，让用户自己转。
 */
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 3

/**
 * magic bytes → MIME。顺序有意义：PNG 的签名比其他都长，但互不重叠，先查谁都行；
 * BM 和 TIFF 放最后，它们的尾巴短，容易被前面的误判。
 */
const SNIFFS = [
  { mime: 'image/png', test: b => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { mime: 'image/jpeg', test: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: b => b.length >= 6 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') },
  { mime: 'image/webp', test: b => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  {
    mime: 'image/heic',
    test: b => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(b.toString('ascii', 8, 12)),
  },
  { mime: 'image/bmp', test: b => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d },
]

export function sniffImage(buffer) {
  for (const sniff of SNIFFS) if (sniff.test(buffer)) return sniff.mime
  return ''
}

function expand(source) {
  if (source === '~') return homedir()
  if (source.startsWith('~/')) return resolve(homedir(), source.slice(2))
  return resolve(source)
}

function tooLarge(bytes, source) {
  const mb = (bytes / 1024 / 1024).toFixed(1)
  return new Error(`${source} 有 ${mb}MB，超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限。先压缩或截图小一点再读。`)
}

async function fetchImage(url, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'image/*' },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null) throw new Error(`HTTP ${response.status} 重定向没有 Location`)
        current = new URL(location, current).toString()
        continue
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
      // 声明了长度且已经超限就不用下完。
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw tooLarge(declared, url)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > MAX_IMAGE_BYTES) throw tooLarge(buffer.length, url)
      return buffer
    }
    throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`)
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(signal?.aborted ? '读图被取消' : `抓取 ${url} 超过 ${FETCH_TIMEOUT_MS / 1000} 秒`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 远程来源给一句可读的标注；本地来源给绝对路径。 */
export async function loadImage(source, { signal } = {}) {
  const trimmed = String(source ?? '').trim()
  if (trimmed === '') throw new Error('path 不能为空')

  const remote = /^https?:\/\//i.test(trimmed)
  let buffer
  let label
  if (remote) {
    buffer = await fetchImage(trimmed, signal)
    label = trimmed
  } else {
    const file = expand(trimmed)
    let info
    try {
      info = await stat(file)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`找不到文件：${file}`)
      throw new Error(`读不到 ${file}：${error?.message ?? error}`)
    }
    if (!info.isFile()) throw new Error(`${file} 不是普通文件`)
    if (info.size === 0) throw new Error(`${file} 是空文件`)
    if (info.size > MAX_IMAGE_BYTES) throw tooLarge(info.size, file)
    buffer = await readFile(file, { signal })
    label = file
  }

  const mime = sniffImage(buffer)
  if (mime === '') {
    throw new Error(`${label} 不是可识别的图片（支持 PNG / JPEG / GIF / WebP / HEIC / BMP）`)
  }
  if (mime === 'image/heic') {
    throw new Error(`${label} 是 HEIC，上游视觉模型基本都不认。先用「预览」导出成 PNG/JPEG 再读。`)
  }
  return {
    mime,
    bytes: buffer.length,
    base64: buffer.toString('base64'),
    label,
    // 内容身份：同一张图换个文件名不该再问一次模型。
    digest: createHash('sha256').update(buffer).digest('hex'),
  }
}
