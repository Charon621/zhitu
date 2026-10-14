import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { newId } from './ids'
import type { DocumentSource } from '@shared/library'

export interface AttachmentRow {
  id: string
  session_id: string
  turn_id: string | null
  kind: string
  original_name: string
  stored_path: string
  bytes: number
  sha256: string
  extracted_md: string | null
  extract_status: 'pending' | 'ok' | 'partial' | 'failed'
  extract_error: string | null
  page_count: number | null
  resource_node_id: string | null
  created_at: string
  active_source_version: number
}

export interface SearchChunk {
  id: string
  attachment_id: string
  ordinal: number
  text: string
  page: number | null
  original_name: string
  score: number
}

const textExtensions = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'js', 'jsx', 'ts', 'tsx', 'py',
  'java', 'c', 'cpp', 'h', 'hpp', 'rs', 'go', 'sql', 'css', 'scss', 'sh', 'yaml', 'yml', 'xml'
])
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp'])
const documentExtensions = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'epub'])
export const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([...textExtensions, ...imageExtensions, ...documentExtensions].map((ext) => `.${ext}`))
const forbiddenExtensions = new Set(['exe', 'dll', 'bat', 'cmd', 'ps1', 'com', 'msi', 'scr'])
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_SESSION_FILES = 20

export class AttachmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

function cleanName(name: string): string {
  return basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').slice(0, 180) || '未命名文件'
}

export function chunkText(text: string, maxLength = 450): string[] {
  const clean = text.replace(/\r\n?/g, '\n').trim()
  if (!clean) return []
  const chunks: string[] = []
  let cursor = 0
  while (cursor < clean.length) {
    const end = Math.min(clean.length, cursor + maxLength)
    if (end === clean.length) { chunks.push(clean.slice(cursor).trim()); break }
    const segment = clean.slice(cursor, end)
    const boundaries = ['\n\n', '。', '！', '？', '\n', '；', '，']
    let cut = -1
    for (const boundary of boundaries) {
      const index = segment.lastIndexOf(boundary)
      if (index >= 280) { cut = index + boundary.length; break }
    }
    if (cut < 0) cut = maxLength
    const part = clean.slice(cursor, cursor + cut).trim()
    if (part) chunks.push(part)
    cursor += cut
  }
  return chunks.filter(Boolean)
}

function matchQuery(query: string): string | null {
  const clean = query.replace(/["'`*(){}[\]:^~+\\/|!?，。？！；：、\s]+/g, ' ')
  const compact = clean.replace(/\s/g, '')
  const terms = new Set<string>()
  for (let i = 0; i <= compact.length - 3 && terms.size < 8; i++) {
    const term = compact.slice(i, i + 3)
    if (/\p{Script=Han}/u.test(term)) terms.add(`"${term}"`)
  }
  for (const word of clean.split(/\s+/)) {
    if (word.length >= 3 && terms.size < 8) terms.add(`"${word.slice(0, 24)}"`)
  }
  return terms.size ? [...terms].join(' OR ') : null
}

/** 原件保存在 userData，解析失败只更新附件状态；对话与笔记原件不受影响。 */
export class AttachmentService {
  constructor(private db: Database.Database, private dataDir: string) {}

  add(sessionId: string, incomingName: string, bytes: Buffer): AttachmentRow {
    const name = cleanName(incomingName)
    const ext = extname(name).slice(1).toLowerCase()
    if (forbiddenExtensions.has(ext)) throw new AttachmentError('出于安全考虑，不能导入可执行文件')
    if (!textExtensions.has(ext) && !imageExtensions.has(ext) && !documentExtensions.has(ext)) {
      throw new AttachmentError('暂不支持这种文件格式')
    }
    if (!bytes.length) throw new AttachmentError('文件是空的')
    if (bytes.length > MAX_FILE_BYTES) throw new AttachmentError('单个文件不能超过 50 MB', 413)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const existing = this.db.prepare('SELECT * FROM attachments WHERE session_id = ? AND sha256 = ?')
      .get(sessionId, sha256) as AttachmentRow | undefined
    if (existing) return existing
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE session_id = ?')
      .get(sessionId) as { n: number }
    if (count.n >= MAX_SESSION_FILES) throw new AttachmentError('一场最多导入 20 个文件')
    const storedPath = join('attachments', sha256.slice(0, 2), `${sha256}.${ext}`)
    const fullPath = this.fullPath(storedPath)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, bytes)
    const row: AttachmentRow = {
      id: newId('att'), session_id: sessionId, turn_id: null,
      kind: imageExtensions.has(ext) ? 'image' : ext,
      original_name: name, stored_path: storedPath, bytes: bytes.length, sha256,
      extracted_md: null, extract_status: imageExtensions.has(ext) ? 'ok' : 'pending',
      extract_error: null, page_count: null, resource_node_id: null, created_at: new Date().toISOString(), active_source_version: 0
    }
    this.db.prepare(`INSERT INTO attachments
      (id, session_id, turn_id, kind, original_name, stored_path, bytes, sha256,
       extracted_md, extract_status, extract_error, page_count, resource_node_id, created_at)
      VALUES (@id, @session_id, @turn_id, @kind, @original_name, @stored_path, @bytes, @sha256,
       @extracted_md, @extract_status, @extract_error, @page_count, @resource_node_id, @created_at)`).run(row)
    if (row.extract_status === 'pending') setImmediate(() => void this.extract(row.id))
    return row
  }

  get(id: string): AttachmentRow | null {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined ?? null
  }

  listSession(sessionId: string): AttachmentRow[] {
    return this.db.prepare('SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at, rowid')
      .all(sessionId) as AttachmentRow[]
  }

  /** 资料库看的是"用户现在还拥有的资料"：回收站里那些场次的资料不返回。 */
  listAll(): AttachmentRow[] {
    return this.db.prepare(`SELECT a.* FROM attachments a JOIN sessions s ON s.id = a.session_id
      WHERE s.deleted_at IS NULL ORDER BY a.created_at DESC, a.rowid DESC`).all() as AttachmentRow[]
  }

  validateSelection(sessionId: string, ids: string[]): AttachmentRow[] {
    const rows = [...new Set(ids)].map((id) => this.get(id))
    if (rows.some((row) => !row || row.session_id !== sessionId)) {
      throw new AttachmentError('所选资料不属于这一场')
    }
    if (rows.some((row) => row?.extract_status === 'pending')) {
      throw new AttachmentError('资料还在解析，等状态变成就绪后再提问', 409)
    }
    if (rows.some((row) => row?.extract_status === 'failed')) {
      throw new AttachmentError('有资料解析失败，请移除后再提问', 409)
    }
    return rows as AttachmentRow[]
  }

  markUsed(sessionId: string, userTurnId: string, ids: string[]): AttachmentRow[] {
    const rows = this.validateSelection(sessionId, ids)
    const session = this.db.prepare('SELECT topic_id, deleted_at FROM sessions WHERE id = ?')
      .get(sessionId) as { topic_id: string | null; deleted_at: string | null } | undefined
    if (!session?.topic_id) throw new AttachmentError('这一场没有可用主题')
    if (session.deleted_at) throw new AttachmentError('这场在回收站里，恢复后才能使用资料', 409)
    return this.db.transaction(() => rows.map((row) => {
      const attachment = row
      if (attachment.resource_node_id) return attachment
      const now = new Date().toISOString()
      const nodeId = newId('nod')
      const title = attachment.original_name.slice(0, 30)
      const body = `这是用户导入的《${attachment.original_name}》，可在本场对话中检索和引用。`
      this.db.prepare(`INSERT INTO nodes
        (id, topic_id, title, body_md, kind, status, origin_turn_id, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, 'resource', 'gathered', ?, ?, ?, ?)`)
        .run(nodeId, session.topic_id, title, body, userTurnId, now, now, now)
      this.db.prepare('UPDATE attachments SET turn_id = COALESCE(turn_id, ?), resource_node_id = ? WHERE id = ?')
        .run(userTurnId, nodeId, attachment.id)
      return { ...attachment, turn_id: attachment.turn_id ?? userTurnId, resource_node_id: nodeId }
    }))()
  }

  getChunks(id: string): Array<{ id: string; ordinal: number; text: string; page: number | null }> {
    return this.db.prepare(`SELECT c.id, c.ordinal, c.text, c.page FROM chunks c JOIN attachments a ON a.id = c.attachment_id
      WHERE c.attachment_id = ? AND c.source_version = a.active_source_version ORDER BY c.ordinal`)
      .all(id) as Array<{ id: string; ordinal: number; text: string; page: number | null }>
  }

  /** Keep old citation IDs and the original file; only future retrieval uses the corrected version. */
  useCorrectedSources(id: string, sources: DocumentSource[]): void {
    const row = this.get(id)
    if (!row) throw new AttachmentError('找不到这份资料', 404)
    this.db.transaction(() => {
      const version = row.active_source_version + 1
      const pages = new Set(sources.map((source) => source.page))
      const unchanged = this.getChunks(id).filter((chunk) => !pages.has(chunk.page))
      const chunks = [...unchanged.map((chunk) => ({ text: chunk.text, page: chunk.page })),
        ...sources.flatMap((source) => chunkText(source.text).map((text) => ({ text, page: source.page })))]
        .sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
      const insert = this.db.prepare(`INSERT INTO chunks (id, attachment_id, ordinal, text, page, token_estimate, source_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      chunks.forEach((chunk, i) => insert.run(newId('chk'), id, i + 1, chunk.text, chunk.page, Math.ceil(chunk.text.length / 2), version))
      this.db.prepare('UPDATE attachments SET active_source_version = ? WHERE id = ?').run(version, id)
    })()
  }

  readOriginal(id: string): { row: AttachmentRow; bytes: Buffer } | null {
    const row = this.get(id)
    if (!row) return null
    return { row, bytes: readFileSync(this.fullPath(row.stored_path)) }
  }

  async renderPdfPage(id: string, number: number): Promise<Buffer> {
    const original = this.readOriginal(id)
    if (!original || original.row.kind !== 'pdf') throw new AttachmentError('找不到 PDF 原件', 404)
    const result = await runWorker('render', String(number), this.fullPath(original.row.stored_path)) as { png: string }
    return Buffer.from(result.png, 'base64')
  }

  addOcrPage(id: string, page: number, rawText: string): number {
    const row = this.get(id)
    if (!row || row.kind !== 'pdf' || row.extract_status !== 'partial') return 0
    const text = rawText.trim().slice(0, 20_000)
    if (!text || text.includes('无可辨识文字')) return 0
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE attachment_id = ? AND page = ? AND source_version = ?')
        .get(id, page, row.active_source_version) as { n: number }
      if (existing.n) return 0
      let ordinal = (this.db.prepare(`SELECT COALESCE(MAX(c.ordinal), 0) AS n FROM chunks c
        JOIN attachments a ON a.id = c.attachment_id WHERE a.session_id = ?`)
        .get(row.session_id) as { n: number }).n
      const insert = this.db.prepare(`INSERT INTO chunks
        (id, attachment_id, ordinal, text, page, token_estimate, source_version) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      const chunks = chunkText(text)
      for (const chunk of chunks) {
        insert.run(newId('chk'), id, ++ordinal, chunk, page, Math.ceil(chunk.length / 2), row.active_source_version)
      }
      this.db.prepare('UPDATE attachments SET extracted_md = COALESCE(extracted_md, \'\') || ? WHERE id = ?')
        .run(`\n\n[第 ${page} 页视觉识别，需核对原件]\n${text}`, id)
      return chunks.length
    })()
  }

  remove(id: string): boolean {
    const row = this.get(id)
    if (!row) return false
    const inTurn = this.db.prepare('SELECT 1 FROM turn_meta WHERE attachment_ids_json LIKE ? LIMIT 1')
      .get(`%${row.id}%`)
    const inNote = this.db.prepare(`SELECT 1 FROM note_blocks b JOIN chunks c
      ON b.origin_chunk_ids_json LIKE '%' || c.id || '%'
      WHERE c.attachment_id = ? LIMIT 1`).get(id)
    if (row.resource_node_id || inTurn || inNote) {
      throw new AttachmentError('这份资料已被对话或笔记引用，不能彻底删除原件', 409)
    }
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
    const remaining = this.db.prepare('SELECT 1 FROM attachments WHERE stored_path = ? LIMIT 1')
      .get(row.stored_path)
    if (!remaining) {
      try { unlinkSync(this.fullPath(row.stored_path)) } catch { /* 文件已不存在，数据库仍已清理 */ }
    }
    return true
  }

  search(sessionId: string, query: string, limit = 5, ids: string[] = []): SearchChunk[] {
    const match = matchQuery(query)
    if (!match) return []
    const restrict = ids.length ? ` AND a.id IN (${ids.map(() => '?').join(',')})` : ''
    try {
      return this.db.prepare(`SELECT c.id, c.attachment_id, c.ordinal, c.text, c.page,
        a.original_name, bm25(search_fts) AS score
        FROM search_fts JOIN chunks c ON c.id = search_fts.ref_id
        JOIN attachments a ON a.id = c.attachment_id
        WHERE search_fts MATCH ? AND search_fts.ref_kind = 'chunk'
          AND a.session_id = ? AND a.extract_status IN ('ok', 'partial') AND c.source_version = a.active_source_version${restrict}
        ORDER BY score LIMIT ?`).all(match, sessionId, ...ids, Math.max(1, Math.min(5, limit))) as SearchChunk[]
    } catch { return [] }
  }

  firstChunks(sessionId: string, ids: string[], limit = 3, page?: number): SearchChunk[] {
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    const pageFilter = page ? ' AND c.page = ?' : ''
    return this.db.prepare(`SELECT c.id, c.attachment_id, c.ordinal, c.text, c.page,
      a.original_name, 0 AS score FROM chunks c JOIN attachments a ON a.id = c.attachment_id
      WHERE a.session_id = ? AND a.id IN (${placeholders}) AND a.extract_status IN ('ok', 'partial') AND c.source_version = a.active_source_version${pageFilter}
      ORDER BY c.ordinal LIMIT ?`).all(sessionId, ...ids,
        ...(page ? [page] : []), Math.max(1, Math.min(5, limit))) as SearchChunk[]
  }

  resumePending(): void {
    const rows = this.db.prepare("SELECT id FROM attachments WHERE extract_status = 'pending'")
      .all() as Array<{ id: string }>
    for (const row of rows) setImmediate(() => void this.extract(row.id))
  }

  private fullPath(relative: string): string {
    const root = resolve(this.dataDir, 'attachments')
    const full = resolve(this.dataDir, relative)
    if (!full.startsWith(root + sep)) throw new Error('附件路径不在数据目录内')
    return full
  }

  private async extract(id: string): Promise<void> {
    const row = this.get(id)
    if (!row || row.extract_status !== 'pending') return
    try {
      const parsed = await runWorker('parse', row.kind, this.fullPath(row.stored_path)) as ParsedDocument
      const text = parsed.pages.map((page) => page.text).join('\n\n')
      if (!text.trim() && !parsed.warning) throw new Error('没有提取出可阅读的文字')
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM chunks WHERE attachment_id = ?').run(id)
        const insert = this.db.prepare(`INSERT INTO chunks
          (id, attachment_id, ordinal, text, page, token_estimate) VALUES (?, ?, ?, ?, ?, ?)`)
        let ordinal = (this.db.prepare(`SELECT COALESCE(MAX(c.ordinal), 0) AS n FROM chunks c
          JOIN attachments a ON a.id = c.attachment_id WHERE a.session_id = ? AND a.id != ?`)
          .get(row.session_id, id) as { n: number }).n
        for (const page of parsed.pages) {
          for (const chunk of chunkText(page.text)) {
            insert.run(newId('chk'), id, ++ordinal, chunk, page.number, Math.ceil(chunk.length / 2))
          }
        }
        this.db.prepare("UPDATE attachments SET extracted_md = ?, extract_status = ?, extract_error = ?, page_count = ? WHERE id = ?")
          .run(text, parsed.warning ? 'partial' : 'ok', parsed.warning, parsed.pageCount, id)
      })()
    } catch (error) {
      this.db.prepare("UPDATE attachments SET extract_status = 'failed', extract_error = ? WHERE id = ?")
        .run(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), id)
    }
  }
}

interface ParsedDocument {
  pages: Array<{ number: number | null; text: string }>
  pageCount: number | null
  warning: string | null
}

function workerScript(): string {
  const candidates = [
    resolve(__dirname, '../../scripts/attachment-worker.cjs'),
    resolve(__dirname, '../../../scripts/attachment-worker.cjs'),
    ...(process.resourcesPath ? [resolve(process.resourcesPath, 'app.asar/scripts/attachment-worker.cjs')] : [])
  ]
  const script = candidates.find((path) => existsSync(path))
  if (!script) throw new Error('资料解析组件缺失')
  return script
}

function runWorker(mode: 'parse' | 'render', kindOrPage: string, path: string): Promise<unknown> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [workerScript(), mode, kindOrPage, path], {
      windowsHide: true,
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const output: Buffer[] = []
    let size = 0
    let errorText = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 30_000)
    child.stdout.on('data', (part: Buffer) => {
      size += part.length
      if (size > 16 * 1024 * 1024) { child.kill(); return }
      output.push(part)
    })
    child.stderr.on('data', (part: Buffer) => { errorText += part.toString('utf8').slice(0, 1000) })
    child.on('error', (error) => { clearTimeout(timer); rejectResult(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) { rejectResult(new Error('解析超过 30 秒')); return }
      if (size > 16 * 1024 * 1024) { rejectResult(new Error('提取内容过大，超过 16 MB')); return }
      if (code !== 0) { rejectResult(new Error(errorText || `解析组件异常退出（${code}）`)); return }
      try { resolveResult(JSON.parse(Buffer.concat(output).toString('utf8')) as unknown) }
      catch { rejectResult(new Error('解析组件返回的数据无法读取')) }
    })
  })
}
