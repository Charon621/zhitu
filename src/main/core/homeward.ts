import type Database from 'better-sqlite3'
import { z } from 'zod'
import { newId } from './ids'
import { completeChat, type ProviderConfig } from './provider'
import { HOMEWARD_PROMPT } from './prompts'
import type { Store } from './store'

interface NodeRow {
  id: string
  topic_id: string | null
  title: string
  body_md: string
  status: string
  mastery: number
  created_at: string
  last_seen_at: string
}

export interface OpenThread {
  id: string
  topicId: string | null
  sessionId: string | null
  title: string
  stoppedAt: string
  nextStep: string
  score: number
}

export interface HomewardResult {
  rootNodeId: string
  isClosed: boolean
  conclusion: string
  stoppedAt: string
  nextStep: string
}

const resultSchema = z.object({
  threads: z.array(z.object({
    rootNodeId: z.string(),
    isClosed: z.boolean(),
    conclusion: z.string(),
    stoppedAt: z.string(),
    nextStep: z.string()
  }))
})

const DAY = 86_400_000

export class HomewardService {
  constructor(private db: Database.Database, private store: Store, private utilityConfig: () => ProviderConfig) {}

  private sessionNodes(sessionId: string): { topicId: string | null; nodes: NodeRow[]; edges: Array<{ src_id: string; dst_id: string }> } {
    const session = this.db.prepare('SELECT topic_id FROM sessions WHERE id = ?')
      .get(sessionId) as { topic_id: string | null } | undefined
    if (!session) throw new Error('找不到这一场')
    if (!session.topic_id) return { topicId: null, nodes: [], edges: [] }
    // 只收本场涉及的知识点。一个主题下可以有很多场学习，按 topic_id 全量取会把
    // 别的场次的支线算进本场小结，还会把已经收过的旧场次重新标成未收线。
    const ids = this.store.sessionNodeIds(sessionId)
    if (!ids.size) return { topicId: session.topic_id, nodes: [], edges: [] }
    const nodes = [...ids].map((id) => this.db.prepare(`SELECT id, topic_id, title, body_md, status,
      mastery, created_at, last_seen_at FROM nodes WHERE id = ? AND kind != 'resource'`)
      .get(id) as NodeRow | undefined).filter((row): row is NodeRow => !!row)
    const edges = this.db.prepare(`SELECT e.src_id, e.dst_id FROM edges e
      JOIN nodes src ON src.id = e.src_id JOIN nodes dst ON dst.id = e.dst_id
      WHERE e.type = 'parent' AND src.topic_id = ? AND dst.topic_id = ?`)
      .all(session.topic_id, session.topic_id) as Array<{ src_id: string; dst_id: string }>
    const inSession = new Set(nodes.map((node) => node.id))
    return { topicId: session.topic_id, nodes, edges:
      edges.filter((edge) => inSession.has(edge.src_id) && inSession.has(edge.dst_id)) }
  }

  /** Each open node belongs to its highest open ancestor. A cycle cannot trap the traversal. */
  private branches(nodes: NodeRow[], edges: Array<{ src_id: string; dst_id: string }>): Array<{ root: NodeRow; path: NodeRow[] }> {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const parents = new Map<string, string[]>()
    const children = new Map<string, string[]>()
    for (const edge of edges) {
      parents.set(edge.dst_id, [...(parents.get(edge.dst_id) ?? []), edge.src_id])
      children.set(edge.src_id, [...(children.get(edge.src_id) ?? []), edge.dst_id])
    }
    const rootOf = (node: NodeRow): NodeRow => {
      let current = node
      const seen = new Set<string>([node.id])
      while (true) {
        const parent = (parents.get(current.id) ?? []).map((id) => byId.get(id))
          .find((candidate) => candidate?.status === 'open' && !seen.has(candidate.id))
        if (!parent) return current
        seen.add(parent.id)
        current = parent
      }
    }
    const roots = new Map<string, NodeRow>()
    for (const node of nodes) if (node.status === 'open') {
      const root = rootOf(node)
      roots.set(root.id, root)
    }
    return [...roots.values()].map((root) => {
      const path: NodeRow[] = []
      const queue = [root.id]
      const seen = new Set<string>()
      while (queue.length && path.length < 100) {
        const id = queue.shift()!
        if (seen.has(id)) continue
        seen.add(id)
        const node = byId.get(id)
        if (node) path.push(node)
        for (const child of children.get(id) ?? []) queue.push(child)
      }
      return { root, path }
    })
  }

  async evaluate(sessionId: string): Promise<{ results: HomewardResult[]; summary: string }> {
    const { nodes, edges } = this.sessionNodes(sessionId)
    const branches = this.branches(nodes, edges)
    if (!branches.length) {
      const summary = '这一场没有未收线的问题。'
      this.persist(sessionId, [], summary, [])
      return { results: [], summary }
    }
    const turns = this.db.prepare("SELECT role, content FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 20")
      .all(sessionId) as Array<{ role: string; content: string }>
    const source = branches.map(({ root, path }, i) => {
      const notes = path.flatMap((node) => (this.db.prepare(`SELECT content_md FROM note_blocks
        WHERE node_id = ? AND deleted_by_user = 0 ORDER BY ordinal LIMIT 4`)
        .all(node.id) as Array<{ content_md: string }>).map((block) => `${node.title}：${block.content_md.slice(0, 150)}`))
      return `【支线 ${i + 1}】\nrootNodeId：${root.id}\n最初的问题：${root.title}\n路径：${path.map((node) => node.title).join(' → ')}\n相关笔记：${notes.join('；') || '（空）'}`
    }).join('\n\n')
    const dialogue = turns.reverse().map((turn) => `${turn.role === 'user' ? '学习者' : '助手'}：${turn.content.slice(0, 500)}`).join('\n')
    let parsed: z.infer<typeof resultSchema> | null = null
    let lastError = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await completeChat(this.utilityConfig(), [
        { role: 'system', content: HOMEWARD_PROMPT },
        { role: 'user', content: `${source}\n\n【本场最近对话】\n${dialogue}${lastError ? `\n上次格式错误：${lastError}。请修正。` : ''}` }
      ], AbortSignal.timeout(45_000))
      try {
        parsed = resultSchema.parse(JSON.parse(raw))
        const expected = new Set(branches.map(({ root }) => root.id))
        if (parsed.threads.length !== expected.size || new Set(parsed.threads.map((row) => row.rootNodeId)).size !== expected.size ||
          parsed.threads.some((row) => !expected.has(row.rootNodeId) ||
            (row.isClosed ? !row.conclusion.trim() : !row.stoppedAt.trim() || !row.nextStep.trim()) ||
            [row.conclusion, row.stoppedAt, row.nextStep].some((text) => text.length > 300))) {
          throw new Error('支线数量、编号或内容不符合要求')
        }
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        parsed = null
      }
    }
    if (!parsed) throw new Error(`归航判定失败：${lastError}`)
    const results = parsed.threads.map((row) => ({ ...row,
      conclusion: row.conclusion.trim(), stoppedAt: row.stoppedAt.trim(), nextStep: row.nextStep.trim() }))
    const closed = results.filter((row) => row.isClosed)
    const open = results.filter((row) => !row.isClosed)
    const summary = `本场收起 ${closed.length} 条线，留下 ${open.length} 条未收线。` +
      (closed.length ? `\n搞懂了：${closed.map((row) => row.conclusion).join('；')}` : '') +
      (open.length ? `\n下次可以从这里接着问：${open.map((row) => row.nextStep).join('；')}` : '')
    this.persist(sessionId, results, summary, branches)
    return { results, summary }
  }

  private persist(sessionId: string, results: HomewardResult[], summary: string,
    branches: Array<{ root: NodeRow; path: NodeRow[] }>): void {
    const now = new Date().toISOString()
    this.db.transaction(() => {
      for (const result of results) {
        const branch = branches.find(({ root }) => root.id === result.rootNodeId)!
        if (result.isClosed) {
          const row = this.db.prepare('SELECT body_md FROM nodes WHERE id = ?').get(result.rootNodeId) as { body_md: string }
          const cleaned = row.body_md.replace(/\n?## 结论\n[\s\S]*?(?=\n## |$)/, '')
          this.db.prepare("UPDATE nodes SET status = 'gathered', body_md = ?, updated_at = ? WHERE id = ?")
            .run(`${cleaned.trim()}\n\n## 结论\n${result.conclusion}`.trim(), now, result.rootNodeId)
          this.db.prepare('DELETE FROM homeward_state WHERE node_id = ?').run(result.rootNodeId)
          const answerer = [...branch.path].reverse().find((node) => node.id !== result.rootNodeId) ?? branch.root
          this.db.prepare(`INSERT OR IGNORE INTO edges (id, src_id, dst_id, type, created_at)
            VALUES (?, ?, ?, 'answers', ?)`).run(newId('edg'), answerer.id, result.rootNodeId, now)
        } else {
          this.db.prepare(`INSERT INTO homeward_state (node_id, stopped_at, next_step, updated_at)
            VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET
            stopped_at = excluded.stopped_at, next_step = excluded.next_step, updated_at = excluded.updated_at`)
            .run(result.rootNodeId, result.stoppedAt, result.nextStep, now)
          const old = this.db.prepare(`SELECT id FROM note_blocks WHERE node_id = ? AND block_type = 'question'
            AND origin_turn_id IS NULL AND edited_by_user = 0 ORDER BY rowid DESC LIMIT 1`)
            .get(result.rootNodeId) as { id: string } | undefined
          const content = `停在：${result.stoppedAt}\n下次：${result.nextStep}`
          if (old) this.db.prepare('UPDATE note_blocks SET content_md = ?, updated_at = ? WHERE id = ?')
            .run(content, now, old.id)
          else {
            const ordinal = (this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS n FROM note_blocks WHERE node_id = ?')
              .get(result.rootNodeId) as { n: number }).n + 1
            this.db.prepare(`INSERT INTO note_blocks
              (id, node_id, block_type, content_md, ordinal, created_at, updated_at)
              VALUES (?, ?, 'question', ?, ?, ?, ?)`).run(newId('blk'), result.rootNodeId, content, ordinal, now, now)
          }
        }
      }
      this.db.prepare('UPDATE sessions SET ended_at = ?, summary_md = ? WHERE id = ?').run(now, summary, sessionId)
      this.db.prepare(`INSERT INTO session_homeward (session_id, results_json, created_at)
        VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET results_json = excluded.results_json, created_at = excluded.created_at`)
        .run(sessionId, JSON.stringify(results), now)
    })()
  }

  summary(sessionId: string): { summary: string; results: HomewardResult[] } | null {
    const row = this.db.prepare(`SELECT s.summary_md, h.results_json FROM sessions s
      LEFT JOIN session_homeward h ON h.session_id = s.id WHERE s.id = ?`)
      .get(sessionId) as { summary_md: string | null; results_json: string | null } | undefined
    if (!row?.summary_md) return null
    return { summary: row.summary_md, results: row.results_json ? JSON.parse(row.results_json) as HomewardResult[] : [] }
  }

  listOpen(): OpenThread[] {
    const now = Date.now()
    // 判定"未收线"只认 status = 'open'：节点是概念还是问题由标题形态决定，
    // 拿 kind = 'question' 当筛子会让"残差连接为什么有用"这类概念节点
    // 在未收线清单里整条消失，用户也就没法收它的线。
    const rows = this.db.prepare(`SELECT n.id, n.topic_id, n.title, n.mastery, n.created_at, n.last_seen_at,
      COALESCE(t.session_id, (SELECT s.id FROM sessions s WHERE s.topic_id = n.topic_id AND s.deleted_at IS NULL
        ORDER BY s.started_at DESC LIMIT 1)) AS session_id,
      COALESCE(h.stopped_at, '') AS stopped_at, COALESCE(h.next_step, '') AS next_step,
      COALESCE(p.recommendation_weight, 1) AS recommendation_weight,
      EXISTS(SELECT 1 FROM edges e JOIN nodes other ON other.id = e.dst_id
        WHERE e.src_id = n.id AND e.type = 'prereq' AND other.status = 'open') AS blocker
      FROM nodes n LEFT JOIN turns t ON t.id = n.origin_turn_id
      LEFT JOIN homeward_state h ON h.node_id = n.id
      LEFT JOIN topic_preferences p ON p.topic_id = n.topic_id
      WHERE n.status = 'open' AND n.kind != 'resource' AND n.trashed_at IS NULL`)
      .all() as Array<NodeRow & { session_id: string | null; stopped_at: string; next_step: string; recommendation_weight: number; blocker: number }>
    return rows.map((row) => {
      const recentDays = Math.max(0, (now - Date.parse(row.last_seen_at)) / DAY)
      const ageDays = Math.max(0, (now - Date.parse(row.created_at)) / DAY)
      const recency = Math.max(0, 1 - recentDays / 7)
      const openAge = ageDays <= 30 ? ageDays / 30 : Math.max(0, 1 - (ageDays - 30) / 30)
      const score = (0.4 * recency + 0.3 * (row.blocker ? 1 : 0) +
        0.2 * (1 - row.mastery / 5) + 0.1 * openAge) * row.recommendation_weight
      return { id: row.id, topicId: row.topic_id, sessionId: row.session_id, title: row.title,
        stoppedAt: row.stopped_at, nextStep: row.next_step, score }
    }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  }

  close(nodeId: string, reason: 'mastered' | 'uninterested'): boolean {
    // 与 listOpen 保持一致：清单纯粹由 status = 'open' 决定，
    // 否则清单上看得见的条目会因为 kind 不匹配而关不掉。
    const row = this.db.prepare(`SELECT topic_id FROM nodes
      WHERE id = ? AND status = 'open' AND kind != 'resource' AND trashed_at IS NULL`)
      .get(nodeId) as { topic_id: string | null } | undefined
    if (!row) return false
    const now = new Date().toISOString()
    this.db.transaction(() => {
      this.db.prepare("UPDATE nodes SET status = CASE WHEN ? = 'mastered' THEN 'mastered' ELSE 'gathered' END, mastery = CASE WHEN ? = 'mastered' THEN 5 ELSE mastery END, updated_at = ? WHERE id = ?")
        .run(reason, reason, now, nodeId)
      this.db.prepare('DELETE FROM homeward_state WHERE node_id = ?').run(nodeId)
      if (reason === 'uninterested' && row.topic_id) {
        this.db.prepare(`INSERT INTO topic_preferences (topic_id, recommendation_weight) VALUES (?, 0.7)
          ON CONFLICT(topic_id) DO UPDATE SET recommendation_weight = MAX(0.2, recommendation_weight * 0.7)`)
          .run(row.topic_id)
      }
    })()
    return true
  }
}
