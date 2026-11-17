/**
 * 启动日志的落盘与滚动。
 *
 * boot.log 是「插件到底有没有被加载」的唯一外部证据（进程里面看不到，只能从
 * 文件看），所以每次 apply() 都要写一行。只追加不裁剪的话它会无限长——DSH
 * 每次启停各写一行，一年下来就是几千行，翻起来反而更难找。
 *
 * 策略：按大小滚动。写之前若已超过上限，先把当前文件挪成 `boot.log.1`（覆盖
 * 更旧的那份），只留一代备份。这个日志的用途是「看最近几次启动」，不需要长
 * 历史，所以不需要按天分文件那一套。
 *
 * 与 paste.js 的 pasteKeep 是同一个思路：不追求完美归档，只保证不会无限膨胀。
 * 任何一步失败都不抛——留痕是附属品，不能反过来把插件拖死。
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 日志文件名；和 config.json 同目录（~/.dsh/vision）。 */
export const BOOT_LOG_NAME = 'boot.log'

/** 单个文件上限：256 KiB。按每行约 100 字节算，够存两千多次启动。 */
export const BOOT_LOG_MAX_BYTES = 256 * 1024

/** 备份文件后缀：滚动后旧内容在这里，只保留一代。 */
export const BOOT_LOG_BACKUP_SUFFIX = '.1'

/**
 * 追加一行启动日志，必要时先滚动。
 *
 * @param {string} dir 日志目录（通常是 configDir()）
 * @param {string} line 已经拼好的整行（含换行符）
 * @param {{ maxBytes?: number }} [options] maxBytes <= 0 表示不限、不滚动
 * @returns {{ written: boolean, rotated: boolean }} 结果，仅用于测试，调用方可以忽略
 */
export function appendBootLog(dir, line, { maxBytes = BOOT_LOG_MAX_BYTES } = {}) {
  const path = join(dir, BOOT_LOG_NAME)
  const backup = `${path}${BOOT_LOG_BACKUP_SUFFIX}`
  let rotated = false
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (Number.isFinite(maxBytes) && maxBytes > 0) {
      let size = 0
      try {
        size = statSync(path).size
      } catch {
        /* 第一次写，还没有文件 */
      }
      // 先把上一代备份删掉再改名：renameSync 覆盖已存在文件在部分平台会失败。
      if (size >= maxBytes) {
        try {
          rmSync(backup, { force: true })
        } catch {
          /* 删不掉就让 rename 去失败，下面有 catch */
        }
        renameSync(path, backup)
        rotated = true
      }
    }
    appendFileSync(path, line)
    return { written: true, rotated }
  } catch {
    // 留痕失败不影响插件本身；写不进去就当作没留。
    return { written: false, rotated }
  }
}

/**
 * 拼一行启动日志。统一格式，方便直接 `grep attached` / `grep registered`。
 */
export function bootLogLine(fields) {
  const parts = [new Date().toISOString()]
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${value}`)
  }
  return `${parts.join(' ')}\n`
}
