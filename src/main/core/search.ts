import type Database from 'better-sqlite3'

export interface SearchHit {
  kind: 'turn' | 'node' | 'note_block' | 'chunk' | 'library'
  id: string
  title: string
  excerpt: string
  sessionId: string | null
  nodeId: string | null
  attachmentId: string | null
  page: number | null
  libraryItemId?: string
}

export class SearchService {
  constructor(private db: Database.Database) {}

  find(raw: string): SearchHit[] {
    const query = raw.trim().slice(0, 100)
    if (!query) return []
    const alive = `(ref_kind = 'turn' AND EXISTS (SELECT 1 FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=ref_id AND s.deleted_at IS NULL))
      OR (ref_kind = 'node' AND EXISTS (SELECT 1 FROM nodes n WHERE n.id=ref_id AND n.trashed_at IS NULL))
      OR (ref_kind = 'note_block' AND EXISTS (SELECT 1 FROM note_blocks b JOIN nodes n ON n.id=b.node_id WHERE b.id=ref_id AND b.deleted_by_user=0 AND n.trashed_at IS NULL))
      OR (ref_kind = 'chunk' AND EXISTS (SELECT 1 FROM chunks c JOIN attachments a ON a.id=c.attachment_id JOIN sessions s ON s.id=a.session_id WHERE c.id=ref_id AND c.source_version=a.active_source_version AND s.deleted_at IS NULL))
      OR (ref_kind = 'library' AND EXISTS (SELECT 1 FROM library_search_entries e JOIN attachments a ON a.id=e.attachment_id JOIN sessions s ON s.id=a.session_id WHERE e.id=ref_id AND s.deleted_at IS NULL))`
    const rows = query.length >= 3
      ? this.db.prepare(`SELECT ref_kind, ref_id, text FROM search_fts
        WHERE search_fts MATCH ? AND (${alive}) ORDER BY bm25(search_fts) LIMIT 40`)
        .all(`"${query.replace(/"/g, '""')}"`) as Array<{ ref_kind: string; ref_id: string; text: string }>
      : this.db.prepare(`SELECT ref_kind, ref_id, text FROM search_fts
        WHERE instr(lower(text), lower(?)) > 0 AND (${alive}) LIMIT 40`)
        .all(query) as Array<{ ref_kind: string; ref_id: string; text: string }>
    const hits: SearchHit[] = []
    for (const row of rows) {
      let title = ''
      let sessionId: string | null = null
      let nodeId: string | null = null
      let attachmentId: string | null = null
      let page: number | null = null
      let libraryItemId: string | undefined
      if (row.ref_kind === 'turn') {
        const detail = this.db.prepare(`SELECT s.title, t.session_id FROM turns t
          JOIN sessions s ON s.id = t.session_id WHERE t.id = ? AND s.deleted_at IS NULL`).get(row.ref_id) as
          { title: string; session_id: string } | undefined
        if (!detail) continue
        title = detail.title; sessionId = detail.session_id
      } else if (row.ref_kind === 'node') {
        const detail = this.db.prepare('SELECT title FROM nodes WHERE id = ? AND trashed_at IS NULL').get(row.ref_id) as
          { title: string } | undefined
        if (!detail) continue
        title = detail.title; nodeId = row.ref_id
      } else if (row.ref_kind === 'note_block') {
        const detail = this.db.prepare(`SELECT n.id, n.title FROM note_blocks b
          JOIN nodes n ON n.id = b.node_id WHERE b.id = ? AND b.deleted_by_user = 0 AND n.trashed_at IS NULL`)
          .get(row.ref_id) as { id: string; title: string } | undefined
        if (!detail) continue
        title = detail.title; nodeId = detail.id
      } else if (row.ref_kind === 'chunk') {
        const detail = this.db.prepare(`SELECT a.id, a.original_name, c.page FROM chunks c
          JOIN attachments a ON a.id = c.attachment_id
          JOIN sessions s ON s.id = a.session_id
          WHERE c.id = ? AND s.deleted_at IS NULL AND c.source_version = a.active_source_version`)
          .get(row.ref_id) as { id: string; original_name: string; page: number | null } | undefined
        if (!detail) continue
        title = detail.original_name; attachmentId = detail.id; page = detail.page
      } else if (row.ref_kind === 'library') {
        const detail = this.db.prepare(`SELECT e.title, e.item_id, a.id, a.original_name FROM library_search_entries e
          JOIN attachments a ON a.id = e.attachment_id JOIN sessions s ON s.id = a.session_id
          WHERE e.id = ? AND s.deleted_at IS NULL`).get(row.ref_id) as
          { title: string; item_id: string; id: string; original_name: string } | undefined
        if (!detail) continue
        title = `${detail.title} · ${detail.original_name}`; attachmentId = detail.id; libraryItemId = detail.item_id
      } else continue
      const at = Math.max(0, row.text.indexOf(query))
      const start = Math.max(0, at - 35)
      const excerpt = `${start ? '…' : ''}${row.text.slice(start, start + 145)}${row.text.length > start + 145 ? '…' : ''}`
      hits.push({ kind: row.ref_kind as SearchHit['kind'], id: row.ref_id,
        title, excerpt, sessionId, nodeId, attachmentId, page, ...(libraryItemId ? { libraryItemId } : {}) })
      if (hits.length >= 30) break
    }
    return hits
  }
}
