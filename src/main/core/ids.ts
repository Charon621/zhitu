import { randomUUID } from 'node:crypto'

/**
 * 生成一个按时间递增的 id，形如 20260316-1a2b3c4d5e6f。
 * 用日期开头是为了方便你自己看数据库时能一眼认出是哪天的记录。
 */
export function newId(prefix?: string): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const rand = randomUUID().replace(/-/g, '').slice(0, 12)
  const body = `${y}${m}${d}-${rand}`
  return prefix ? `${prefix}_${body}` : body
}
