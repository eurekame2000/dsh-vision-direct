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
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { configDir } from './config.js'
import { MAX_IMAGE_BYTES, sniffImage } from './image.js'

/** 粘贴请求体上限。比读图上限宽一点：超了在存盘时再给一次人话。 */
export const PASTE_MAX_BYTES = 12 * 1024 * 1024

const EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

export function pasteDir() {
  return join(configDir(), 'pastes')
}

/**
 * 一张图 → 本机路径。
 *
 * 内容寻址的文件名让「同一张图粘两次」变成同一个路径，读图工具的缓存也就
 * 自然命中；不会出现 paste-1.png、paste-2.png 各存一份 8MB。
 */
export function savePaste(buffer) {
  const mime = sniffImage(buffer)
  if (mime === '') {
    throw new Error('粘贴的不是可识别的图片（支持 PNG / JPEG / GIF / WebP / BMP）')
  }
  if (mime === 'image/heic') {
    throw new Error('粘贴的是 HEIC，视觉模型基本都不认。先导出成 PNG/JPEG 再粘。')
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    const mb = (buffer.length / 1024 / 1024).toFixed(1)
    throw new Error(`这张图 ${mb}MB，超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限，先压缩再粘。`)
  }

  const dir = pasteDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 24)
  const file = join(dir, `${digest}${EXT[mime]}`)
  if (!existsSync(file)) {
    writeFileSync(file, buffer, { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return { path: file, mime, bytes: buffer.length }
}
