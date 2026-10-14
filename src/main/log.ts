import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 极简日志。
 * 桌面软件最怕"用户说打不开，但我看不到任何信息"，
 * 所以从第一天起就把关键步骤写进文件。
 */

let logFile: string | null = null
let buffer: string[] = []

export function initLogger(userDataDir: string): void {
  try {
    const dir = join(userDataDir, 'logs')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'app.log')
    // 把启动早期攒下的日志补写进去
    for (const line of buffer) write(line)
    buffer = []
  } catch {
    logFile = null
  }
}

function write(line: string): void {
  if (!logFile) {
    buffer.push(line)
    return
  }
  try {
    appendFileSync(logFile, line + '\n', 'utf-8')
  } catch {
    // 日志失败不能影响主流程
  }
}

function stamp(): string {
  return new Date().toISOString()
}

export function log(message: string, ...rest: unknown[]): void {
  const line = `[${stamp()}] ${message}${rest.length ? ' ' + rest.map(fmt).join(' ') : ''}`
  console.log(line)
  write(line)
}

export function logError(message: string, err: unknown): void {
  const detail =
    err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : fmt(err)
  const line = `[${stamp()}] ERROR ${message}: ${detail}`
  console.error(line)
  write(line)
}

function fmt(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
