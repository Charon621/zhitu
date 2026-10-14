import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { openDatabase, SCHEMA_VERSION } from './db'
import { BACKUP_TABLES, ExportService } from './exports'
import type { DocumentAnalysis } from '@shared/library'
import { z } from 'zod'
import { SUPPORTED_ATTACHMENT_EXTENSIONS } from './attachments'

type Row = Record<string, string | number | null>
type Backup = Record<string, unknown>
export interface BackupPreview { exportedAt: string; schemaVersion: number; sessions: number; notes: number; attachments: number; fileBytes: number; archived: number; trash: number }
const MAX_BYTES = 300 * 1024 * 1024
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const evidence = { id: z.string().min(1), source: z.number().int().nonnegative(), quote: z.string() }
const resultSchema = z.object({
  notes: z.array(z.object({ ...evidence, category: z.string(), title: z.string(), content: z.string() })),
  characters: z.array(z.object({ ...evidence, name: z.string(), description: z.string(), segment: z.number() })),
  events: z.array(z.object({ ...evidence, title: z.string(), summary: z.string(), characters: z.array(z.string()), segment: z.number() })),
  relations: z.array(z.object({ ...evidence, from: z.string(), to: z.string(), label: z.string(), segment: z.number() }))
})
const analysisSchema = z.object({ attachmentId: z.string(), mode: z.enum(['book', 'handwriting']),
  status: z.enum(['idle', 'running', 'done', 'failed', 'cancelled']), sources: z.array(z.object({ text: z.string(), label: z.string(), page: z.number().int().nullable() })),
  result: resultSchema, previousResult: resultSchema.optional(), warnings: z.array(z.string()),
  completed: z.number(), total: z.number(), ocrCompleted: z.number(), ocrTotal: z.number(),
  stage: z.string(), updatedAt: z.string(), startPage: z.number(), endPage: z.number(), revision: z.number()
})

/** Restore adds an independent copy. It never replaces live rows, configuration or credentials. */
export class BackupService {
  constructor(private db: Database.Database, private dataDir: string) {}

  private validate(raw: unknown): { data: Backup; files: Map<string, Buffer>; preview: BackupPreview } {
    if (!object(raw) || raw.format !== 'zhitu-backup-v1' || !Number.isInteger(raw.schemaVersion) ||
      Number(raw.schemaVersion) < 2 || Number(raw.schemaVersion) > SCHEMA_VERSION) throw new Error('这不是支持的织图备份，或备份来自更高版本。')
    const data: Backup = { ...raw }
    const test = openDatabase(':memory:').db
    const files = new Map<string, Buffer>()
    try {
      for (const table of BACKUP_TABLES) {
        const values = data[table] ?? []
        if (!Array.isArray(values) || values.length > 500_000) throw new Error(`备份中的 ${table} 表不完整。`)
        const columns = new Set((test.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name))
        for (const row of values) {
          if (!object(row) || !Object.keys(row).length || Object.entries(row).some(([key, value]) => !columns.has(key) ||
            (value !== null && typeof value !== 'string' && typeof value !== 'number'))) throw new Error(`备份中的 ${table} 记录格式有误。`)
          for (const [key, value] of Object.entries(row)) if (key.endsWith('_json') && typeof value === 'string') JSON.parse(value)
        }
        data[table] = values
      }
      if (!Array.isArray(data.sessions) || !Array.isArray(data.attachments) || !Array.isArray(data.attachments_files)) throw new Error('备份缺少场次或附件原件。')
      test.transaction(() => {
        test.pragma('defer_foreign_keys = ON')
        for (const table of BACKUP_TABLES) for (const row of data[table] as Row[]) this.insert(test, table, row)
        if ((test.pragma('foreign_key_check') as unknown[]).length) throw new Error('备份存在断开的引用，不能恢复。')
      })()
      let total = 0
      for (const file of data.attachments_files as unknown[]) {
        if (!object(file) || typeof file.attachmentId !== 'string' || typeof file.base64 !== 'string' ||
          file.base64.length > 50 * 1024 * 1024 * 1.4 || files.has(file.attachmentId)) throw new Error('附件原件格式有误或重复。')
        const bytes = Buffer.from(file.base64, 'base64'); total += bytes.length
        if (!bytes.length || bytes.toString('base64') !== file.base64) throw new Error('附件原件编码有误。')
        if (total > MAX_BYTES) throw new Error('备份原件超过 300 MB，请分开恢复。')
        files.set(file.attachmentId, bytes)
      }
      const attachmentRows = test.prepare('SELECT * FROM attachments').all() as Row[]
      for (const attachment of attachmentRows) {
        const bytes = files.get(String(attachment.id))
        if (!bytes || bytes.length !== attachment.bytes || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256 ||
          !SUPPORTED_ATTACHMENT_EXTENSIONS.has(extname(String(attachment.original_name)).toLowerCase())) throw new Error(`附件原件缺失或校验失败：${attachment.original_name}`)
      }
      if (files.size !== attachmentRows.length) throw new Error('备份包含无法对应的附件原件。')
      for (const row of data.document_analyses as Row[]) {
        const job = JSON.parse(String(row.payload_json)) as DocumentAnalysis
        if (!analysisSchema.safeParse(job).success || job.attachmentId !== row.attachment_id) throw new Error('资料整理结果不完整，不能恢复。')
      }
      const sessions = data.sessions as Row[]
      return { data, files, preview: { exportedAt: String(data.exportedAt ?? ''), schemaVersion: Number(data.schemaVersion),
        sessions: sessions.length, notes: (data.note_blocks as Row[]).length, attachments: files.size, fileBytes: total,
        archived: sessions.filter((s) => s.archived_at && !s.deleted_at).length, trash: sessions.filter((s) => s.deleted_at).length } }
    } finally { test.close() }
  }

  private insert(db: Database.Database, table: string, row: Row): void {
    const columns = Object.keys(row)
    db.prepare(`INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row))
  }

  preview(raw: unknown): BackupPreview { return this.validate(raw).preview }

  async restore(raw: unknown, rebuild: () => void): Promise<{ preview: BackupPreview; snapshotPath: string; snapshotWarning?: string }> {
    const { data, files, preview } = this.validate(raw)
    const idMap = new Map<string, string>()
    for (const table of BACKUP_TABLES) for (const row of data[table] as Row[]) if (typeof row.id === 'string') idMap.set(row.id, `restored_${randomUUID()}`)
    const concepts = data.concepts as Row[]
    const skipConcepts = new Set<string>()
    for (const row of concepts) {
      const existing = this.db.prepare('SELECT id FROM concepts WHERE canonical_name = ?').get(row.canonical_name) as { id: string } | undefined
      if (existing) { idMap.set(String(row.id), existing.id); skipConcepts.add(String(row.id)) }
    }
    const remapJSON = (value: unknown): unknown => typeof value === 'string' ? idMap.get(value) ?? value : Array.isArray(value)
      ? value.map(remapJSON) : object(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapJSON(v)])) : value
    // A complete, usable backup is mandatory before any live mutation.
    const snapshotDir = join(this.dataDir, 'backups', `${Date.now()}-${randomUUID().slice(0, 8)}`)
    let snapshotPath = join(snapshotDir, '恢复前完整备份.json')
    let snapshotWarning: string | undefined
    mkdirSync(snapshotDir, { recursive: true })
    try { writeFileSync(snapshotPath, new ExportService(this.db, this.dataDir).allJson(), { flag: 'wx' }) }
    catch (error) {
      // A backup is also needed when a live original has been lost. Preserve the
      // database and every remaining original; explicitly record missing files.
      const root = resolve(this.dataDir, 'attachments')
      const missing: string[] = []
      for (const row of this.db.prepare('SELECT original_name, stored_path FROM attachments').all() as Array<{ original_name: string; stored_path: string }>) {
        const full = resolve(this.dataDir, row.stored_path)
        if (!full.startsWith(root + sep) || !existsSync(full)) { missing.push(row.original_name); continue }
        const target = join(snapshotDir, relative(this.dataDir, full))
        mkdirSync(dirname(target), { recursive: true }); copyFileSync(full, target)
      }
      if (!missing.length) throw error
      writeFileSync(join(snapshotDir, '原件缺失清单.json'), JSON.stringify({ missing, note: '恢复前已有原件缺失；数据库及仍存在的原件已保存。' }, null, 2), { flag: 'wx' })
      snapshotPath = join(snapshotDir, 'zhitu.db')
      snapshotWarning = `恢复前已有 ${missing.length} 份原件缺失，缺失清单与其余原件已和数据库快照一起保存。`
    }
    await this.db.backup(join(snapshotDir, 'zhitu.db'))
    const created: string[] = []
    try {
      this.db.transaction(() => {
        this.db.pragma('defer_foreign_keys = ON')
        for (const table of BACKUP_TABLES) {
          for (const original of data[table] as Row[]) {
            if (table === 'concepts' && skipConcepts.has(String(original.id))) continue
            if (table === 'learner_profile' && this.db.prepare('SELECT 1 FROM learner_profile LIMIT 1').get()) continue
            const row: Row = Object.fromEntries(Object.entries(original).map(([k, v]) => [k,
              k.endsWith('_json') && typeof v === 'string' ? JSON.stringify(remapJSON(JSON.parse(v))) :
                (k === 'id' || k.endsWith('_id')) && typeof v === 'string' ? idMap.get(v) ?? v : v]))
            if (table === 'sessions' && row.deleted_at) row.deleted_at = new Date().toISOString()
            if (table === 'sessions' && !row.ended_at) row.ended_at = new Date().toISOString()
            if (table === 'attachments') {
              const bytes = files.get(String(original.id))!
              const relative = `attachments/${randomUUID()}${extname(String(original.original_name)).toLowerCase()}`
              const full = join(this.dataDir, relative)
              mkdirSync(join(this.dataDir, 'attachments'), { recursive: true })
              writeFileSync(full, bytes, { flag: 'wx' }); created.push(full); row.stored_path = relative
            }
            if (table === 'document_analyses') {
              const job = JSON.parse(String(row.payload_json)) as DocumentAnalysis
              if (job.status === 'running') { job.status = 'failed'; job.error = '从备份恢复，已保存进度；需要时可手动继续。' }
              row.payload_json = JSON.stringify(job)
            }
            this.insert(this.db, table, row)
          }
        }
        if ((this.db.pragma('foreign_key_check') as unknown[]).length) throw new Error('恢复后的引用校验失败。')
        rebuild()
      })()
    } catch (error) {
      for (const path of created) if (existsSync(path)) unlinkSync(path)
      throw error
    }
    return { preview, snapshotPath, ...(snapshotWarning ? { snapshotWarning } : {}) }
  }
}
