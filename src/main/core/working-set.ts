import type Database from 'better-sqlite3'
import type { ChatMessage } from '@shared/types'
import type { Store } from './store'

interface NodeRow { id: string; title: string; body_md: string }
interface TurnRow { role: 'user' | 'assistant' | 'system'; content: string }

/** 保守估算中英文混合文本，给不同服务商的分词差异留出余量。 */
export function estimateTokens(value: string): number {
  const han = (value.match(/[\u3400-\u9fff]/g) ?? []).length
  return Math.ceil(han * 1.7 + (value.length - han) / 2)
}

export class WorkingSetService {
  constructor(private db: Database.Database, private store: Store) {}

  assemble(sessionId: string, topicId: string | null, question: string,
    reservedText: string): { context: string; history: ChatMessage[]; estimatedTokens: number } {
    const topic = topicId ? this.db.prepare('SELECT title, goal_kind FROM topics WHERE id = ?')
      .get(topicId) as { title: string; goal_kind: string } | undefined : undefined
    // 当前知识点必须来自本场：一个主题下有很多场，只看最近碰过的节点会把
    // 别的场次的知识点当成"现在聊到哪了"（见 store.ts 的场次归属说明）。
    // 这里问的是"这一场聊到哪了"，所以取本场最后一轮的位置即可。
    const currentRef = this.store.currentNodeFor(sessionId, Number.MAX_SAFE_INTEGER)
    const current = currentRef ? this.db.prepare('SELECT id, title, body_md FROM nodes WHERE id = ?')
      .get(currentRef.id) as NodeRow | undefined : undefined
    const parents: NodeRow[] = []
    let childId = current?.id
    for (let depth = 0; depth < 5 && childId; depth++) {
      const row = this.db.prepare(`SELECT n.id, n.title, n.body_md FROM edges e JOIN nodes n ON n.id = e.src_id
        WHERE e.dst_id = ? AND e.type = 'parent' LIMIT 1`).get(childId) as NodeRow | undefined
      if (!row || parents.some((parent) => parent.id === row.id)) break
      parents.unshift(row); childId = row.id
    }
    const prereqs = current ? this.db.prepare(`SELECT n.title FROM edges e JOIN nodes n ON n.id = e.dst_id
      WHERE e.src_id = ? AND e.type = 'prereq' LIMIT 3`).all(current.id) as Array<{ title: string }> : []
    const parentId = current ? this.db.prepare("SELECT src_id FROM edges WHERE dst_id = ? AND type = 'parent' LIMIT 1")
      .get(current.id) as { src_id: string } | undefined : undefined
    const siblings = parentId ? this.db.prepare(`SELECT n.title FROM edges e JOIN nodes n ON n.id = e.dst_id
      WHERE e.src_id = ? AND e.type = 'parent' AND n.id != ? LIMIT 5`)
      .all(parentId.src_id, current?.id) as Array<{ title: string }> : []
    // "已经记下的笔记"同样限定在本场，否则会把别的场次的笔记标题喂给模型，
    // 模型会以为那些内容这场已经讲过了。
    const noteTitles = this.db.prepare(`SELECT substr(b.content_md, 1, 55) AS title FROM note_blocks b
      JOIN turns t ON t.id = b.origin_turn_id
      WHERE t.session_id = ? AND b.deleted_by_user = 0
      ORDER BY b.updated_at DESC LIMIT 10`).all(sessionId) as Array<{ title: string }>
    const recalled: NodeRow[] = []
    const terms = [...new Set((question.match(/[\u3400-\u9fff]{3}|[a-zA-Z0-9]{3,24}/g) ?? []).slice(0, 6))]
    if (topicId && terms.length) {
      const matches = this.db.prepare(`SELECT ref_kind, ref_id FROM search_fts WHERE search_fts MATCH ?
        AND ref_kind IN ('node', 'note_block') LIMIT 30`).all(terms.map((term) =>
        `"${term.replace(/"/g, '""')}"`).join(' OR ')) as
        Array<{ ref_kind: string; ref_id: string }>
      for (const match of matches) {
        const node = match.ref_kind === 'node'
          ? this.db.prepare(`SELECT n.id, n.title, COALESCE(NULLIF(n.body_md, ''),
            (SELECT b.content_md FROM note_blocks b WHERE b.node_id = n.id AND b.deleted_by_user = 0
              ORDER BY b.pinned DESC, b.ordinal LIMIT 1), '') AS body_md
            FROM nodes n WHERE n.id = ? AND n.topic_id = ?`).get(match.ref_id, topicId) as NodeRow | undefined
          : this.db.prepare(`SELECT n.id, n.title, b.content_md AS body_md FROM note_blocks b
            JOIN nodes n ON n.id = b.node_id WHERE b.id = ? AND b.deleted_by_user = 0
            AND n.topic_id = ?`).get(match.ref_id, topicId) as NodeRow | undefined
        if (node && node.id !== current?.id && !parents.some((parent) => parent.id === node.id) &&
          !recalled.some((existing) => existing.id === node.id))
          recalled.push(node)
        if (recalled.length >= 5) break
      }
    }
    const contextLines = [
      `【本场主题与目标】${topic?.title ?? '自由探索'}；${topic?.goal_kind ?? 'casual'}`,
      current ? `【当前知识点】${current.title}${current.body_md ? `：${current.body_md.slice(0, 150)}` : ''}` : '',
      parents.length ? `【从哪里走到这里】${parents.map((row) => row.title).join(' → ')} → ${current?.title}` : '',
      prereqs.length ? `【理解当前问题先要会】${prereqs.map((row) => row.title).join('、')}` : '',
      siblings.length ? `【同层其他问题】${siblings.map((row) => row.title).join('、')}` : '',
      recalled.length ? `【相关的旧知识】${recalled.map((row) =>
        `${row.title}：${row.body_md.slice(0, 110)}`).join('；')}` : '',
      noteTitles.length ? `【本场已经记下的笔记标题】${noteTitles.map((row) => row.title).join('；')}` : ''
    ].filter(Boolean)
    // 结构信息优先于旧对话；按整轮取最近最多八轮，避免中途截断一条回复。
    let context = `\n\n${contextLines.join('\n')}`
    while (estimateTokens(reservedText + context) > 2200 && contextLines.length > 1) {
      contextLines.pop(); context = `\n\n${contextLines.join('\n')}`
    }
    const rows = this.db.prepare(`SELECT role, content FROM turns WHERE session_id = ?
      ORDER BY rowid DESC LIMIT 16`).all(sessionId) as TurnRow[]
    const newestFirst: TurnRow[] = []
    let used = estimateTokens(reservedText + context)
    for (const row of rows) {
      const cost = estimateTokens(row.content)
      if (used + cost > 6000) {
        if (!newestFirst.length) throw new Error('这次输入太长，超过单次对话的上下文容量。请缩短问题，或把长内容作为资料导入。原文已保存在本场对话中。')
        break
      }
      newestFirst.push(row); used += cost
    }
    return { context, history: newestFirst.reverse().map((row) => ({ role: row.role, content: row.content })),
      estimatedTokens: used }
  }
}
