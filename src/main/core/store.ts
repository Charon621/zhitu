import type Database from 'better-sqlite3'
import { unlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Role } from '@shared/types'
import { newId } from './ids'

export interface SessionRow {
  id: string
  topic_id: string | null
  title: string
  started_at: string
  ended_at: string | null
  summary_md: string | null
  archived_at: string | null
  /** 非空 = 这场在回收站里。对所有界面读取入口都必须不可见。 */
  deleted_at: string | null
}

export type GoalKind = 'principle' | 'hands_on' | 'casual'

/**
 * 回收站保留天数：到期后在启动时真正删掉。
 * 改这里就够了——界面上的"还有几天自动清理"也读这个常量。
 */
export const TRASH_RETENTION_DAYS = 30

export interface TurnRow {
  id: string
  session_id: string
  role: Role
  content: string
  created_at: string
}

/** 一个知识节点属于哪一场：连接、创建、还是最近被这一场碰到。 */
export interface SessionNodeRow {
  id: string
  title: string
  last_seen_at: string
}

/** 删除前的预演：让用户在按下去之前就知道会删掉什么、会留下什么。 */
export interface SessionDeletionPreview {
  title: string
  /** 会被删掉的对话轮次（原件） */
  turns: number
  /** 会被删掉的知识点：这场建出来、且没有别的场次碰过 */
  leaves: number
  /** 上面那些知识点的标题，给用户看清楚删的是哪几个 */
  nodes: string[]
  /** 会留下的知识点：别的场次还在用，只切断本场与它们的连接 */
  keeps: number
  /** 会被删掉的笔记块 */
  notes: number
  /** 会一并清理的导入原件 */
  attachments: number
}

/**
 * 场次归属的统一判定。
 *
 * 一个主题下可以有很多场学习（`sessions`），节点挂在主题上而不挂在场次上。
 * 所以"这个点是不是这一场的"必须显式算出来，不能按 `topic_id` 一把抓，
 * 否则回到旧场次时会看到别的场次的知识点（笔记、工作集、归航都会错）。
 *
 * 判定规则，按可信度从高到低：
 *   1. 本场的某轮对话抽取到了这个节点（`extractions` 通过 `turns` 连回本场）
 *   2. 这个节点是在本场里创建出来的（`origin_turn_id` 落在本场的轮次里）
 *   3. 这个节点本来属于更早的场次，但本场又碰过它（本场有抽取记录指向它）
 *
 * 规则 3 是连接关系，不属于本场的身份：它决定"本场该不该看到这个点"（归航要看），
 * 但节点本身仍然算原来那一场的（笔记卡片不该因此搬场）。
 */
const SESSION_NODE_SQL = `
  SELECT e.node_id AS id, MAX(t.rowid) AS last_turn FROM extractions e
    JOIN turns t ON t.id = e.turn_id
    WHERE t.session_id = ? AND e.node_id IS NOT NULL AND e.status = 'ok'
    GROUP BY e.node_id
  UNION ALL
  SELECT n.id AS id, MAX(t.rowid) AS last_turn FROM nodes n
    JOIN turns t ON t.id = n.origin_turn_id
    WHERE t.session_id = ? AND n.kind != 'resource'
    GROUP BY n.id
  UNION ALL
  SELECT e.node_id AS id, MAX(t.rowid) AS last_turn FROM extractions e
    JOIN turns t ON t.id = e.turn_id
    WHERE t.session_id = ? AND e.node_id IS NOT NULL
    GROUP BY e.node_id
`

/**
 * 对话流水与学习场次的读写。
 *
 * 注意：turns 只新增，永远不修改。这是全系统的"原件"。
 */
export class Store {
  /**
   * `dataDir` 只在删除场次时需要：数据库的 CASCADE 管不到磁盘上的原件。
   * 测试用内存库时不传，删文件自然成为空操作。
   */
  constructor(private db: Database.Database, private dataDir = '') {}

  createTopic(title: string, goalKind: GoalKind): string {
    const id = newId('top')
    this.db.prepare(
      'INSERT INTO topics (id, title, goal_kind, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, title.slice(0, 60), goalKind, new Date().toISOString())
    return id
  }

  // ── 场次 ────────────────────────────────

  historyPage(query: string, state: 'active' | 'archived', offset: number, limit: number) {
    const where = `deleted_at IS NULL AND archived_at IS ${state === 'active' ? 'NULL' : 'NOT NULL'} AND instr(lower(title), lower(?)) > 0`
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM sessions WHERE ${where}`).get(query) as { total: number }).total
    const sessions = this.db.prepare(`SELECT * FROM sessions WHERE ${where} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(query, limit, offset) as SessionRow[]
    return { sessions, total, offset, limit, counts: {
      active: (this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NULL AND archived_at IS NULL').get() as { count: number }).count,
      archived: (this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NULL AND archived_at IS NOT NULL').get() as { count: number }).count
    } }
  }

  createSession(title: string, topicId: string | null = null): SessionRow {
    const row: SessionRow = {
      id: newId('ses'),
      topic_id: topicId,
      title: title.slice(0, 60) || '未命名的一场',
      started_at: new Date().toISOString(),
      ended_at: null,
      summary_md: null,
      archived_at: null,
      deleted_at: null
    }
    this.db
      .prepare(
        `INSERT INTO sessions (id, topic_id, title, started_at, ended_at, summary_md, archived_at)
         VALUES (@id, @topic_id, @title, @started_at, @ended_at, @summary_md, @archived_at)`
      )
      .run(row)
    return row
  }

  getSession(id: string): SessionRow | null {
    return (
      (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
        | SessionRow
        | undefined) ?? null
    )
  }

  /** 最近的一场（用于"关掉再打开还在原来的地方"）。归档和回收站里的场次都不算。 */
  latestSession(): SessionRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM sessions WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1')
        .get() as SessionRow | undefined) ?? null
    )
  }

  /**
   * 全部场次，新的在前。归档的场次仍然返回（带 archived_at 标记），
   * 由界面决定是否显示、要不要折叠——归档是"收起来"，不是"看不见"。
   * 回收站里的不返回：那是"删除"，对所有读取入口都不可见。
   */
  listSessions(limit = 50): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY started_at DESC LIMIT ?')
      .all(limit) as SessionRow[]
  }

  listArchivedSessions(limit = 50): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE archived_at IS NOT NULL AND deleted_at IS NULL
        ORDER BY archived_at DESC LIMIT ?`)
      .all(limit) as SessionRow[]
  }

  map(topicId?: string): {
    topics: Array<{ id: string; title: string }>
    selectedTopicId: string | null
    nodes: Array<{ id: string; title: string; kind: string; status: string; mastery: number;
      updated_at: string; summary: string; origin_session_id: string | null }>
    edges: Array<{ id: string; src_id: string; dst_id: string; type: string }>
  } {
    // 地图下拉里只放"真的有知识点可画"的主题。资料库导入、只传了文件没聊过天的
    // 主题一个知识点都没有,混进下拉只会让人点开看到一片空白(2026-10-01 修)。
    const topics = this.db.prepare(`SELECT t.id, t.title
      FROM topics t WHERE t.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM nodes n WHERE n.topic_id = t.id AND n.trashed_at IS NULL)
      ORDER BY t.created_at DESC`)
      .all() as Array<{ id: string; title: string }>
    // 默认选中:最新的"有节点"主题。旧逻辑取最新的任意主题,会被刚导入的文件
    // 抢走,打开地图是一片空白,而真正的学习记录其实有几十个点。
    // 显式传了 topicId 就照用户的选的来,哪怕它是空的(界面会给出空状态)。
    const selectedTopicId = topicId && topics.some((topic) => topic.id === topicId)
      ? topicId : topics[0]?.id ?? null
    if (!selectedTopicId) return { topics, selectedTopicId: null, nodes: [], edges: [] }
    const nodes = this.db.prepare(`SELECT n.id, n.title, n.kind, n.status, n.mastery, n.updated_at,
      COALESCE((SELECT b.content_md FROM note_blocks b WHERE b.node_id = n.id AND b.deleted_by_user = 0
        ORDER BY b.pinned DESC, b.ordinal LIMIT 1), n.body_md, '') AS summary,
      COALESCE(t.session_id, (SELECT s.id FROM sessions s WHERE s.topic_id = n.topic_id AND s.deleted_at IS NULL
        ORDER BY s.started_at DESC LIMIT 1)) AS origin_session_id
      FROM nodes n LEFT JOIN turns t ON t.id = n.origin_turn_id
      WHERE n.topic_id = ? AND n.trashed_at IS NULL
      ORDER BY n.created_at, n.id`).all(selectedTopicId) as Array<{
        id: string; title: string; kind: string; status: string; mastery: number;
        updated_at: string; summary: string; origin_session_id: string | null
      }>
    const edges = this.db.prepare(`SELECT e.id, e.src_id, e.dst_id, e.type FROM edges e
      JOIN nodes a ON a.id = e.src_id JOIN nodes b ON b.id = e.dst_id
      WHERE a.topic_id = ? AND b.topic_id = ? AND a.trashed_at IS NULL AND b.trashed_at IS NULL`).all(selectedTopicId, selectedTopicId) as Array<{
        id: string; src_id: string; dst_id: string; type: string
      }>
    return { topics, selectedTopicId, nodes, edges }
  }

  renameSession(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ? WHERE id = ?')
      .run(title.slice(0, 60), id)
  }

  /** 归档或取消归档一场。归档只是从列表里收起来，数据一条都不动。 */
  setArchived(id: string, archived: boolean): boolean {
    const result = this.db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
      .run(archived ? new Date().toISOString() : null, id)
    return result.changes === 1
  }

  // ── 删除一场学习 ────────────────────────

  /**
   * 这场"独占"的知识点：本场建出来的，而且没有任何别的场次碰过它。
   *
   * 判定要看两个来源，缺一不可：
   *   - `nodes.origin_turn_id` 指向本场的轮次 → 这个点是这场建出来的
   *   - 没有任何**别场**的轮次抽取到它 → 没有别人共享
   *
   * 为什么要这么严：v0.9.2 起，回到旧场次继续追问同一个知识点时，那个点
   * 在本场也是活的支线。如果只按 origin 判断就删，会把还在别的场次路径上的
   * 点一起删掉，那张地图就断了。
   */
  private exclusiveNodeIds(sessionId: string): string[] {
    return (this.db.prepare(`
      SELECT n.id FROM nodes n
      JOIN turns t ON t.id = n.origin_turn_id
      WHERE t.session_id = ? AND n.kind != 'resource'
        AND NOT EXISTS (
          SELECT 1 FROM extractions e JOIN turns ot ON ot.id = e.turn_id
          WHERE e.node_id = n.id AND ot.session_id != ?
        )
    `).all(sessionId, sessionId) as Array<{ id: string }>).map((row) => row.id)
  }

  /** 删除前的预演：会删掉什么、会留下什么。界面据此让用户确认。 */
  deletionPreview(sessionId: string): SessionDeletionPreview | null {
    const session = this.getSession(sessionId)
    if (!session) return null
    const exclusive = this.exclusiveNodeIds(sessionId)
    const sharedCount = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM nodes n
      JOIN turns t ON t.id = n.origin_turn_id
      WHERE t.session_id = ? AND n.kind != 'resource' AND EXISTS (
        SELECT 1 FROM extractions e JOIN turns ot ON ot.id = e.turn_id
        WHERE e.node_id = n.id AND ot.session_id != ?
      )
    `).get(sessionId, sessionId) as { n: number }).n
    const turns = (this.db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
      .get(sessionId) as { n: number }).n
    const attachments = this.db.prepare('SELECT id, stored_path FROM attachments WHERE session_id = ?')
      .all(sessionId) as Array<{ id: string; stored_path: string }>
    const notes = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM note_blocks b WHERE b.deleted_by_user = 0 AND (
        EXISTS (SELECT 1 FROM turns t WHERE t.id = b.origin_turn_id AND t.session_id = ?)
        OR b.node_id IN (${exclusive.length ? exclusive.map(() => '?').join(',') : "''"})
      )
    `).get(sessionId, ...exclusive) as { n: number }).n
    return {
      title: session.title,
      turns,
      leaves: exclusive.length,
      nodes: exclusive.map((id) => (this.db.prepare('SELECT title FROM nodes WHERE id = ?')
        .get(id) as { title: string } | undefined)?.title ?? '').filter(Boolean),
      keeps: sharedCount,
      notes,
      attachments: attachments.length
    }
  }

  /**
   * 真删一场：对话流水 + 它独占的知识点。
   *
   * 留下的是"别的场次还在用"的知识点——只把本场与它们的连接切断
   * （`nodes.origin_turn_id` 是 ON DELETE SET NULL，删轮次时自动置空）。
   * 数据库层靠外键 CASCADE 清派生数据，磁盘上的原件单独清，否则会留下孤儿文件。
   */
  deleteSession(sessionId: string): { ok: boolean; deletedNodes: number; filesRemoved: number } {
    const session = this.getSession(sessionId)
    if (!session) return { ok: false, deletedNodes: 0, filesRemoved: 0 }
    const exclusive = this.exclusiveNodeIds(sessionId)
    const attachments = this.db.prepare('SELECT stored_path FROM attachments WHERE session_id = ?')
      .all(sessionId) as Array<{ stored_path: string }>
    const topicId = session.topic_id

    this.db.transaction(() => {
      const removeNode = this.db.prepare('DELETE FROM nodes WHERE id = ?')
      for (const id of exclusive) removeNode.run(id)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
      // 主题是地图的单位。这场是它最后一场时，主题也一起收掉，
      // 否则地图下拉框里会堆一串空的旧主题。
      if (topicId) {
        const left = this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE topic_id = ?')
          .get(topicId) as { n: number }
        const nodesLeft = this.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE topic_id = ?')
          .get(topicId) as { n: number }
        if (!left.n && !nodesLeft.n) this.db.prepare('DELETE FROM topics WHERE id = ?').run(topicId)
      }
    })()

    // 磁盘清理必须在数据库删完之后：只有确认没有任何记录再指向这个文件时才动手。
    // 数据库层面的 CASCADE 只管表，原件是磁盘上的文件，不管就会变成孤儿。
    let filesRemoved = 0
    for (const attachment of attachments) {
      const stillUsed = this.db.prepare('SELECT 1 FROM attachments WHERE stored_path = ? LIMIT 1')
        .get(attachment.stored_path)
      if (!stillUsed && this.removeStoredFile(attachment.stored_path)) filesRemoved++
    }
    return { ok: true, deletedNodes: exclusive.length, filesRemoved }
  }

  /** 删掉一个原件。路径必须落在数据目录内，且只删我们自己管的 attachments 子目录。 */
  private removeStoredFile(storedPath: string): boolean {
    if (!this.dataDir) return false
    try {
      const root = resolve(this.dataDir, 'attachments')
      const full = resolve(this.dataDir, storedPath)
      if (!full.startsWith(root + sep)) return false
      unlinkSync(full)
      return true
    } catch {
      // 文件已经不在了，或者被占用。数据库那边已经清理干净，这里失败不影响结果。
      return false
    }
  }

  // ── 场次归属（见文件上方 SESSION_NODE_SQL 的规则说明） ──────

  /**
   * 本场"当前所在的知识点"，即在这一轮之前最近抽取到的节点。
   *
   * `beforeTurnRowId` 不能省：抽取过程中会把自己刚建好的节点写回抽取记录，
   * 少了"只算更早的轮次"这个边界，同一轮会把自己的新节点当成"上一个知识点"，
   * 明明在补充同一个问题，却每轮都另起一张卡。
   *
   * `EXISTS` 那道判断也不能省：重算时会删掉被拆开或合并的旧节点，
   * 而 `extractions.node_id` 是 `ON DELETE SET NULL`，删掉之后仍可能留下
   * 指向已删节点的行。若把它当成父节点，父边会插不进去（外键拒绝），
   * 本场的路径就断了。
   */
  currentNodeFor(sessionId: string, beforeTurnRowId: number): SessionNodeRow | null {
    const extracted = this.db.prepare(`
      SELECT n.id, n.title, n.last_seen_at FROM extractions e
      JOIN turns t ON t.id = e.turn_id
      JOIN nodes n ON n.id = e.node_id
      WHERE t.session_id = ? AND t.role = 'assistant' AND t.rowid < ?
        AND e.status = 'ok' AND n.kind != 'resource'
        AND EXISTS (SELECT 1 FROM nodes alive WHERE alive.id = e.node_id)
      ORDER BY t.rowid DESC LIMIT 1
    `).get(sessionId, beforeTurnRowId) as SessionNodeRow | undefined
    if (extracted) return extracted
    return (this.db.prepare(`
      SELECT n.id, n.title, n.last_seen_at FROM nodes n
      JOIN turns t ON t.id = n.origin_turn_id
      WHERE t.session_id = ? AND t.rowid < ? AND n.kind != 'resource'
      ORDER BY t.rowid DESC, n.rowid DESC LIMIT 1
    `).get(sessionId, beforeTurnRowId) as SessionNodeRow | undefined) ?? null
  }

  /**
   * 本场涉及的全部节点 id。
   *
   * 包含"本场连接到的、原本属于早先场次的节点"：回到旧场次继续追问同一个知识点时，
   * 那个点在本场也是活的支线，收线时必须能收它。
   * 笔记卡片的归属不用这个（见 `notes.listSessionCards`，它按笔记块的来源轮次判定）。
   */
  sessionNodeIds(sessionId: string): Set<string> {
    const rows = this.db.prepare(`SELECT id FROM (${SESSION_NODE_SQL}) GROUP BY id`)
      .all(sessionId, sessionId, sessionId) as Array<{ id: string }>
    return new Set(rows.map((row) => row.id))
  }

  /**
   * 本场的节点，按"这一场里第几轮碰到它"排序。
   *
   * `rank` 是 turns.rowid 的最大值：同一个节点在好几轮里被更新时，取最后一次。
   * 这是本场学习顺序的权威来源——父边（parent）本来就是按这个顺序连的，
   * 所以重算后要用它重建路径，而不是靠旧边去猜。
   */
  sessionNodeOrder(sessionId: string): Array<{ id: string; rank: number }> {
    return this.db.prepare(`SELECT id, MAX(last_turn) AS rank FROM (${SESSION_NODE_SQL}) GROUP BY id`)
      .all(sessionId, sessionId, sessionId) as Array<{ id: string; rank: number }>
  }

  // ── 流水 ────────────────────────────────

  addTurn(sessionId: string, role: Role, content: string): TurnRow {
    const row: TurnRow = {
      id: newId('trn'),
      session_id: sessionId,
      role,
      content,
      created_at: new Date().toISOString()
    }
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, role, content, created_at)
         VALUES (@id, @session_id, @role, @content, @created_at)`
      )
      .run(row)
    return row
  }

  listTurns(sessionId: string): TurnRow[] {
    return this.db
      .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId) as TurnRow[]
  }

  countTurns(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
      .get(sessionId) as { n: number }
    return row.n
  }

  // ── 用来自动起标题 ──────────────────────

  setSessionTitleIfDefault(sessionId: string, title: string): void {
    const trimmed = title.trim().replace(/\s+/g, ' ').slice(0, 30)
    if (!trimmed) return
    this.db
      .prepare(
        `UPDATE sessions SET title = ? WHERE id = ? AND (title = '新的一场' OR title = '')`
      )
      .run(trimmed, sessionId)
  }

  // ── 统计（首页/设置页用） ────────────────

  stats(): { sessions: number; turns: number } {
    const s = this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL').get() as { n: number }
    const t = this.db.prepare(`SELECT COUNT(*) AS n FROM turns t JOIN sessions s ON s.id = t.session_id
      WHERE s.deleted_at IS NULL`).get() as { n: number }
    return { sessions: s.n, turns: t.n }
  }

  // ── 回收站（软删除 / 恢复 / 彻底删除） ──────────

  /** 这场在不在回收站里。 */
  isTrashed(id: string): boolean {
    const row = this.db.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get(id) as
      { deleted_at: string | null } | undefined
    return !!row?.deleted_at
  }

  /** 只在"这场还活着"时才返回。界面上的读取入口一律走这个。 */
  getAliveSession(id: string): SessionRow | null {
    const session = this.getSession(id)
    return session && !session.deleted_at ? session : null
  }

  listTrash(limit = 200): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?')
      .all(limit) as SessionRow[]
  }

  /** 回收站现在占了多少、最早那场什么时候到期。 */
  trashStats(): { sessions: number; turns: number; nodes: number; bytes: number
    oldestAt: string | null; nextPurgeAt: string | null } {
    const row = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NOT NULL) AS sessions,
      (SELECT COUNT(*) FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.deleted_at IS NOT NULL) AS turns,
      (SELECT COUNT(*) FROM nodes WHERE trashed_at IS NOT NULL) AS nodes,
      (SELECT COALESCE(SUM(a.bytes), 0) FROM attachments a JOIN sessions s ON s.id = a.session_id
        WHERE s.deleted_at IS NOT NULL) AS bytes,
      (SELECT MIN(deleted_at) FROM sessions WHERE deleted_at IS NOT NULL) AS oldest`).get() as
      { sessions: number; turns: number; nodes: number; bytes: number; oldest: string | null }
    return {
      sessions: row.sessions, turns: row.turns, nodes: row.nodes, bytes: row.bytes, oldestAt: row.oldest,
      nextPurgeAt: row.oldest ? new Date(Date.parse(row.oldest) + TRASH_RETENTION_DAYS * 86_400_000).toISOString() : null
    }
  }

  /**
   * 移入回收站：只打标记，什么都不搬走。
   *
   * 这场"独占"的知识点跟着一起藏起来——和彻底删除会删掉的是同一批（`exclusiveNodeIds`），
   * 所以"删掉后看不见的东西"和"恢复后回来的东西"永远一致。
   * 主题刻意不动：回收站期间主题要留着，恢复时主题名才回得来。
   */
  trashSession(id: string): { ok: boolean; nodes: number } {
    const session = this.getSession(id)
    if (!session || session.deleted_at) return { ok: false, nodes: 0 }
    const exclusive = this.exclusiveNodeIds(id)
    const now = new Date().toISOString()
    this.db.transaction(() => {
      this.db.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(now, id)
      const mark = this.db.prepare('UPDATE nodes SET trashed_at = ? WHERE id = ?')
      for (const nodeId of exclusive) mark.run(now, nodeId)
    })()
    return { ok: true, nodes: exclusive.length }
  }

  /** 从回收站恢复。只把自己标记过的知识点放回来。 */
  restoreSession(id: string): boolean {
    const session = this.getSession(id)
    if (!session?.deleted_at) return false
    this.db.transaction(() => {
      this.db.prepare('UPDATE sessions SET deleted_at = NULL WHERE id = ?').run(id)
      this.db.prepare(`UPDATE nodes SET trashed_at = NULL
        WHERE trashed_at IS NOT NULL AND origin_turn_id IN (SELECT id FROM turns WHERE session_id = ?)`).run(id)
      this.reconcileTrashedNodes()
    })()
    return true
  }

  /**
   * 把"已经不成立"的隐藏标记清掉：一个知识点如果被还活着的场次引用过，就不该继续藏着。
   * 软删、恢复、彻底删除之后都跑一次，让这个标记能自我修复，不靠调用方记得。
   */
  reconcileTrashedNodes(): void {
    this.db.prepare(`UPDATE nodes SET trashed_at = NULL WHERE trashed_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM extractions e JOIN turns t ON t.id = e.turn_id JOIN sessions s ON s.id = t.session_id
      WHERE e.node_id = nodes.id AND s.deleted_at IS NULL)`).run()
  }

  /** 彻底删除：走原来的硬删（连带磁盘原件）。 */
  purgeSession(id: string): { ok: boolean; deletedNodes: number; filesRemoved: number } {
    return this.deleteSession(id)
  }

  /** 清空回收站：逐场彻底删，逐场报告，不整体回滚。 */
  emptyTrash(): { removed: number; failed: string[] } {
    const failed: string[] = []
    let removed = 0
    for (const session of this.listTrash(1000)) {
      if (this.deleteSession(session.id).ok) removed++
      else failed.push(session.title)
    }
    if (removed) this.reconcileTrashedNodes()
    return { removed, failed }
  }

  /** 到期清理：在回收站里躺够天数的，真正删掉。返回删了几场。 */
  purgeExpiredTrash(days = TRASH_RETENTION_DAYS): number {
    if (days <= 0) return 0
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    const rows = this.db.prepare('SELECT id FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
      .all(cutoff) as Array<{ id: string }>
    let removed = 0
    for (const row of rows) if (this.deleteSession(row.id).ok) removed++
    if (removed) this.reconcileTrashedNodes()
    return removed
  }
}
