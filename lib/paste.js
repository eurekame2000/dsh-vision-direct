/**
 * 粘贴落盘。
 *
 * 文本模型收不到图片：后端会把带图请求拒掉，而浏览器早在 admission 那一步
 * 就失败了。所以粘贴通道不走附件，走文件——把字节存成本机的一张图，把路径
 * 交回输入框。模型看到的就是一句「这里有个文件」，和它在终端里拿到的东西
 * 一样，然后自己调读图工具。
 *
 * 边界：只认真实图片（magic bytes），只落 8MB 以内的（与读图上限一致，免得
 * 存下来却读不了），同名内容按内容寻址，重复粘贴不产生第二份文件。
 *
 * 目录会越攒越大，所以按「最近使用」滚动：写完就裁到 keep 张，最旧的先删。
 * keep=0 表示不裁。裁的是插件自己写进这个目录的图片，目录里别的东西不碰。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { configDir } from './config.js'
import { MAX_IMAGE_BYTES, sniffImage } from './image.js'

/** 粘贴请求体上限。比读图上限宽一点：超了在存盘时再给一次人话。 */
export const PASTE_MAX_BYTES = 12 * 1024 * 1024

/** 默认保留张数。 */
export const DEFAULT_KEEP = 10

const EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

const KEEPABLE = /\.(png|jpe?g|gif|webp|bmp)$/i

export function pasteDir() {
  return join(configDir(), 'pastes')
}

/**
 * 滚动清理：按 mtime 从新到旧，保留前 keep 张，其余删掉。
 *
 * 删的是本插件按 `<digest>.<ext>` 命名的文件，目录里别的文件不动。删除失败
 * （权限、正好被别的进程移走）不算错——下一次粘贴还会再裁一遍。
 */
export function prunePastes(keep = DEFAULT_KEEP) {
  if (!Number.isFinite(keep) || keep <= 0) return { removed: 0, kept: null }
  const dir = pasteDir()
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { removed: 0, kept: 0 }
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !KEEPABLE.test(entry.name)) continue
    // 只认内容寻址命名：别人放进来的图不该被我们删。
    if (!/^[0-9a-f]{24}\.(png|jpg|gif|webp|bmp)$/i.test(entry.name)) continue
    const path = join(dir, entry.name)
    try {
      files.push({ path, mtime: statSync(path).mtimeMs })
    } catch {
      /* 刚好被移走 */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  for (const file of files.slice(keep)) {
    try {
      rmSync(file.path, { force: true })
      removed += 1
    } catch {
      /* 删不掉就留到下一次 */
    }
  }
  return { removed, kept: Math.min(files.length, keep) }
}

/**
 * 一张图 → 本机路径。
 *
 * 内容寻址的文件名让「同一张图粘两次」变成同一个路径，读图工具的缓存也就
 * 自然命中；不会出现 paste-1.png、paste-2.png 各存一份 8MB。
 *
 * 重复内容会刷新 mtime（touch），否则它会被算成「旧图」，第二次粘贴反而
 * 先把这张刚用过的删掉。
 *
 * maxBytes 是可配置的单张保存上限（pasteMaxBytes）：默认与读图上限一致，
 * 保证存下来的图读得了。传入值非法（非正数/非有限数）时回落读图上限。
 */
export function savePaste(buffer, { keep = DEFAULT_KEEP, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const mime = sniffImage(buffer)
  if (mime === '') {
    throw new Error('粘贴的不是可识别的图片（支持 PNG / JPEG / GIF / WebP / BMP）')
  }
  if (mime === 'image/heic') {
    throw new Error('粘贴的是 HEIC，视觉模型基本都不认。先导出成 PNG/JPEG 再粘。')
  }
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_IMAGE_BYTES
  if (buffer.length > limit) {
    const mb = (buffer.length / 1024 / 1024).toFixed(1)
    throw new Error(`这张图 ${mb}MB，超过 ${limit / 1024 / 1024}MB 保存上限（可在「视觉模型」设置页调整）。先压缩再粘。`)
  }

  const dir = pasteDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 24)
  const file = join(dir, `${digest}${EXT[mime]}`)
  if (!existsSync(file)) {
    writeFileSync(file, buffer, { mode: 0o600 })
    chmodSync(file, 0o600)
  } else {
    const now = new Date()
    try {
      utimesSync(file, now, now)
    } catch {
      /* 刷新失败只影响排序优先级，不影响正确性 */
    }
  }
  const pruned = prunePastes(keep)
  return { path: file, mime, bytes: buffer.length, pruned }
}
