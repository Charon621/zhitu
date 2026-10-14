import type Database from 'better-sqlite3'
import JSZip from 'jszip'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const safeName = (value: string): string => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '').slice(0, 80) || '未命名'

export const BACKUP_TABLES = ['topics', 'sessions', 'turns', 'concepts', 'nodes', 'edges', 'extractions',
  'attachments', 'chunks', 'turn_meta', 'note_blocks', 'learner_profile', 'profile_observations', 'reviews',
  'review_attempts', 'homeward_state', 'topic_preferences', 'session_homeward', 'document_analyses'] as const

const blockLabels: Record<string, string> = {
  claim: '核心', mece: '结构', example: '例子', contrast: '对比', pitfall: '易错',
  question: '留着的问题', formula: '公式', source_quote: '原文', user_note: '我记下的'
}
const edgeLabels: Record<string, string> = {
  parent: '从哪来', prereq: '先会什么', related: '相关', answers: '回答了'
}

interface NodeRow {
  id: string; topic_id: string | null; topic_title: string | null; title: string;
  kind: string; status: string; mastery: number; body_md: string
}

export class ExportService {
  constructor(private db: Database.Database, private dataDir: string) {}

  async notesZip(): Promise<Uint8Array> {
    const nodes = this.db.prepare(`SELECT n.id, n.topic_id, tp.title AS topic_title, n.title,
      n.kind, n.status, n.mastery, n.body_md FROM nodes n LEFT JOIN topics tp ON tp.id = n.topic_id
      WHERE n.trashed_at IS NULL
      ORDER BY tp.title, n.title, n.id`).all() as NodeRow[]
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const used = new Set<string>()
    const paths = new Map<string, string>()
    for (const node of nodes) {
      const folder = safeName(node.topic_title ?? '未归类')
      let base = safeName(node.title)
      let path = `${folder}/${base}`
      if (used.has(path.toLowerCase())) { base = `${base.slice(0, 68)}-${node.id.slice(-10)}`; path = `${folder}/${base}` }
      used.add(path.toLowerCase())
      paths.set(node.id, path)
    }
    const zip = new JSZip()
    for (const node of nodes) {
      const blocks = this.db.prepare(`SELECT block_type, content_md, origin_chunk_ids_json FROM note_blocks
        WHERE node_id = ? AND deleted_by_user = 0 ORDER BY pinned DESC, ordinal`)
        .all(node.id) as Array<{ block_type: string; content_md: string; origin_chunk_ids_json: string }>
      const links = this.db.prepare('SELECT src_id, dst_id, type FROM edges WHERE src_id = ? OR dst_id = ?')
        .all(node.id, node.id) as Array<{ src_id: string; dst_id: string; type: string }>
      const lines = [`# ${node.title}`, '', `主题：${node.topic_title ?? '未归类'}`, `类型：${node.kind}`,
        `状态：${node.status}`, `掌握度：${node.mastery} / 5`, '']
      if (node.body_md.trim()) lines.push('## 结论', '', node.body_md.trim(), '')
      if (blocks.length) {
        lines.push('## 笔记', '')
        for (const block of blocks) {
          lines.push(`### ${blockLabels[block.block_type] ?? block.block_type}`, '', block.content_md.trim(), '')
          let chunkIds: string[] = []
          try { chunkIds = JSON.parse(block.origin_chunk_ids_json) as string[] } catch { /* 旧数据可能为空 */ }
          if (chunkIds.length) {
            const source = this.db.prepare(`SELECT a.original_name, c.page FROM chunks c
              JOIN attachments a ON a.id = c.attachment_id WHERE c.id = ?`)
              .get(chunkIds[0]) as { original_name: string; page: number | null } | undefined
            if (source) lines.push(`来源：《${source.original_name}》${source.page ? `第 ${source.page} 页` : ''}`, '')
          }
        }
      }
      const relations = links.flatMap((edge) => {
        const otherId = edge.src_id === node.id ? edge.dst_id : edge.src_id
        const other = byId.get(otherId)
        const target = paths.get(otherId)
        if (!other || !target || otherId === node.id) return []
        const direction = edge.src_id === node.id ? '→' : '←'
        return [`${edgeLabels[edge.type] ?? edge.type}${direction} [[${target}|${other.title}]]`]
      })
      if (relations.length) lines.push('## 关联', '', ...relations, '')
      zip.file(`${paths.get(node.id)}.md`, `${lines.join('\n').trim()}\n`)
    }
    zip.file('导出说明.md', '这份压缩包可以直接解压进 Obsidian 笔记库。节点之间的关系保留为 [[双链]]。API 密钥不包含在导出中。\n')
    for (const row of this.db.prepare(`SELECT d.attachment_id, d.payload_json, a.original_name
      FROM document_analyses d JOIN attachments a ON a.id = d.attachment_id
      JOIN sessions s ON s.id = a.session_id WHERE s.deleted_at IS NULL`).all() as Array<{ attachment_id: string; payload_json: string; original_name: string }>) {
      const job = JSON.parse(row.payload_json) as import('@shared/library').DocumentAnalysis
      const result = job.status !== 'done' && job.previousResult ? job.previousResult : job.result
      const lines = [`# ${row.original_name}`, '', `AI 整理，需核对原文。状态：${job.status}；处理 ${job.completed}/${job.total} 段。`, '']
      const sources = job.status !== 'done' && job.previousSources ? job.previousSources : job.sources
      const source = (e: import('@shared/library').Evidence) => `来源：${sources[e.source]?.label ?? '原文'}；摘录：${e.quote}`
      for (const note of result.notes) lines.push(`## ${note.category} / ${note.title}`, '', note.content, '', source(note), '')
      for (const person of result.characters) lines.push(`## 人物：${person.name}`, '', person.description, '', source(person), '')
      for (const event of result.events) lines.push(`## 剧情：${event.title}`, '', event.summary, '', source(event), '')
      for (const edge of result.relations) lines.push(`${result.characters.find((p) => p.id === edge.from)?.name} → ${result.characters.find((p) => p.id === edge.to)?.name}：${edge.label}`, source(edge), '')
      zip.file(`资料库/${safeName(row.original_name)}-${row.attachment_id.slice(-8)}.md`, lines.join('\n'))
    }
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  }

  sessionMarkdown(id: string): string | null {
    const session = this.db.prepare('SELECT id, title, started_at, summary_md, deleted_at FROM sessions WHERE id = ?')
      .get(id) as { id: string; title: string; started_at: string; summary_md: string | null; deleted_at: string | null } | undefined
    if (!session || session.deleted_at) return null
    const turns = this.db.prepare('SELECT id, role, content, created_at FROM turns WHERE session_id = ? ORDER BY rowid')
      .all(id) as Array<{ id: string; role: string; content: string; created_at: string }>
    const lines = [`# ${session.title}`, '', `开始于：${session.started_at}`, '']
    for (const turn of turns) {
      lines.push(`## ${turn.role === 'user' ? '我' : turn.role === 'assistant' ? 'AI' : '系统'} · ${turn.created_at}`, '')
      const attachments = this.db.prepare('SELECT original_name FROM attachments WHERE turn_id = ?')
        .all(turn.id) as Array<{ original_name: string }>
      if (attachments.length) lines.push(`附件：${attachments.map((row) => row.original_name).join('、')}`, '')
      lines.push(turn.content, '')
    }
    if (session.summary_md) lines.push('## 本场小结', '', session.summary_md, '')
    return `${lines.join('\n').trim()}\n`
  }

  allJson(): string {
    const tables = BACKUP_TABLES
    const payload: Record<string, unknown> = {
      format: 'zhitu-backup-v1', exportedAt: new Date().toISOString(),
      schemaVersion: this.db.pragma('user_version', { simple: true }),
      note: '不包含 API 密钥；附件原件以 base64 保存在 attachments_files 中。'
    }
    for (const table of tables) payload[table] = this.db.prepare(`SELECT * FROM ${table}`).all()
    payload.app_config = this.db.prepare("SELECT * FROM app_config WHERE key NOT LIKE 'secret.%'").all()
    const files: Array<{ attachmentId: string; name: string; base64: string }> = []
    for (const row of payload.attachments as Array<{ id: string; original_name: string; stored_path: string }>) {
      // 备份少一份原件就不算成功，直接报错给用户。
      const root = resolve(this.dataDir, 'attachments')
      const full = resolve(this.dataDir, row.stored_path)
      if (!full.startsWith(root + sep)) throw new Error(`附件路径不在数据目录内：${row.original_name}`)
      files.push({ attachmentId: row.id, name: row.original_name,
        base64: readFileSync(full).toString('base64') })
    }
    payload.attachments_files = files
    return JSON.stringify(payload, null, 2)
  }
}
