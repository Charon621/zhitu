import type Database from 'better-sqlite3'
import { z } from 'zod'
import { newId } from './ids'
import { completeChat, type ProviderConfig } from './provider'
import { NOTE_EXTRACT_PROMPT, NOTE_VERIFY_PROMPT } from './prompts'
import type { Store } from './store'

const blockType = z.enum([
  'claim', 'mece', 'example', 'contrast', 'pitfall', 'question', 'formula', 'source_quote'
])
const extractionSchema = z.object({
  hasNewContent: z.boolean(),
  blocks: z.array(z.object({
    blockType,
    content: z.string(),
    groundedIn: z.string(),
    isNewRelativeToExisting: z.boolean()
  })).max(3),
  nodeAction: z.enum(['create', 'update', 'none']),
  nodePatch: z.object({ title: z.string(), masteryDelta: z.number().min(-5).max(5) }),
  edges: z.array(z.object({
    toNodeId: z.string(),
    type: z.enum(['parent', 'prereq', 'related'])
  })),
  discarded: z.array(z.object({ reason: z.string() }))
})
const verificationSchema = z.object({
  approved: z.array(z.boolean()),
  reasons: z.array(z.string())
})

export type ExtractionResult = z.infer<typeof extractionSchema>

interface ChunkContext {
  id: string
  attachment_id: string
  resource_node_id: string | null
  ordinal: number
  page: number | null
  text: string
  original_name: string
}

interface TurnContext {
  turnRowId: number
  assistantId: string
  assistantText: string
  userId: string
  userText: string
  lastUserText: string
  batchedAssistantIds: string[]
  sessionId: string
  topicId: string
  topicTitle: string
  currentNodeId: string | null
  parentNodeId: string | null
  originalNodeId: string | null
  currentNodeTitle: string
  existingNotes: string[]
  recentTopicNotes: string[]
  chunks: ChunkContext[]
  knownNodes: Array<{ id: string; title: string }>
}

export interface NoteBlockRow {
  id: string
  node_id: string
  block_type: string
  content_md: string
  ordinal: number
  origin_chunk_ids_json: string
  origin_turn_id: string | null
  pinned: number
  edited_by_user: number
  deleted_by_user: number
  created_at: string
  updated_at: string
  source_name: string | null
  source_page: number | null
  source_attachment_id: string | null
  source_partial: boolean
}

export interface NoteCard {
  id: string
  topic_id?: string | null
  topic_title?: string | null
  origin_session_id?: string | null
  title: string
  kind: string
  status: string
  mastery: number
  origin_turn_id: string | null
  updated_at: string
  blocks: NoteBlockRow[]
}

const forbiddenMeta = /本段讨论了|文中提到|作者认为|综上所述|值得注意的是|总而言之|让我们来看看|这是个好问题/
const bulletLine = /^\s*[•*-]\s/m
const uncertainNumber = /(大约|大概|差不多|估计|约).{0,8}[\d一二三四五六七八九十百千]+\s*(倍|%|％|年|天|分钟|秒|元)/
const numericClaim = /([\d一二三四五六七八九十百千]+)\s*(倍|%|％|年|天|分钟|秒|元)/g
const unsupportedHabitNumber = /(实践中|通常|一般|常见|普遍).{0,12}\d+\s*(到|至|－|—|-)?\s*\d*/
const sweepingClaim = /必然|总是|一定会|唯一区别/

function bigrams(value: string): Set<string> {
  const clean = value.replace(/[\s，。；、：？！,.!?;:"“”'（）()]/g, '')
  const grams = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) grams.add(clean.slice(i, i + 2))
  return grams
}

function similarity(a: string, b: string): number {
  if (a.trim() === b.trim()) return 1
  const left = bigrams(a)
  const right = bigrams(b)
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const gram of left) if (right.has(gram)) intersection++
  return (2 * intersection) / (left.size + right.size)
}

/** 模型输出的结构与硬性内容约束。校验失败会带着原因让模型重试一次。 */
export function validateExtraction(raw: string, chunks: ChunkContext[] = [], assistantText = ''): ExtractionResult {
  const parsed = extractionSchema.parse(JSON.parse(raw))
  if (!parsed.hasNewContent && parsed.blocks.length) {
    throw new Error('hasNewContent 为 false 时 blocks 必须为空')
  }
  if (parsed.hasNewContent && parsed.blocks.length === 0) {
    throw new Error('hasNewContent 为 true 时必须有笔记块')
  }
  parsed.nodePatch.title = [...parsed.nodePatch.title.trim()].slice(0, 30).join('')
  const accepted = [] as ExtractionResult['blocks']
  const discarded = parsed.discarded.slice()
  const reject = (reason: string): void => { discarded.push({ reason }) }
  const uncertainSourceNumbers = [...assistantText.matchAll(new RegExp(uncertainNumber.source, 'g'))]
    .flatMap((match) => match[0].match(numericClaim) ?? [])
  for (const block of parsed.blocks) {
    const content = block.content.trim()
    let reason = ''
    if (!content || [...content].length > 120) reason = '笔记正文为空或超过 120 字'
    else if (bulletLine.test(content)) reason = '笔记正文出现符号列表'
    else if (forbiddenMeta.test(content)) reason = '笔记正文出现元话语或套话'
    else if (block.blockType === 'claim' && uncertainNumber.test(content)) reason = '没有依据的模糊数字不能写成断言'
    else if (unsupportedHabitNumber.test(content)) reason = '没有引用来源的经验数字不能写进笔记'
    else if (block.blockType === 'claim' && sweepingClaim.test(content)) reason = '没有写清适用条件的绝对化断言不能进笔记'
    else if (block.blockType === 'claim' && uncertainSourceNumbers.some((number) => content.includes(number))) {
      reason = '助手的存疑数字不能去掉限定词后写成断言'
    }
    if (!/^(conversation|inference|document:\d+)$/.test(block.groundedIn)) {
      reason ||= 'groundedIn 来源格式错误'
    }
    if (block.blockType === 'source_quote') {
      const ordinal = Number(block.groundedIn.split(':')[1])
      const source = chunks.find((chunk) => chunk.ordinal === ordinal && chunk.text.includes(content))
      if (!source || !source.text.includes(content)) {
        reason ||= '资料引用必须是提供的片段里的原文'
      }
    }
    if (reason) reject(reason)
    else accepted.push({ ...block, content })
  }
  if (!accepted.length) return {
    ...parsed, hasNewContent: false, blocks: [], nodeAction: 'none',
    nodePatch: { title: '', masteryDelta: 0 }, edges: [], discarded
  }
  return { ...parsed, blocks: accepted, discarded }
}

export interface ExtractOptions {
  /** 重算：忽略已有结果，重新抽取这一轮。 */
  force?: boolean
  /** 重算时保留用户已经调好的卡片标题，不采用模型新给的名字。 */
  keepTitles?: boolean
}

/** 重算本场笔记时的可选行为。 */
export interface RecalculateOptions {
  keepTitles?: boolean
}

export interface RecalculateResult {
  total: number; ok: number; skipped: number; failed: number; merged: number
}

function parseStringArray(raw: string | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw || '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** 短回复合并抽取时留下的占位记录：内容已经算进别的轮次了。 */
function isBatchedPlaceholder(payloadJson: string | null): boolean {
  if (!payloadJson) return false
  try {
    const value = JSON.parse(payloadJson) as { batchedInto?: unknown }
    return typeof value?.batchedInto === 'string'
  } catch {
    return false
  }
}

/** 笔记是 turns 的可重算派生物；这里的任何失败都不回滚或修改原始对话。 */
export class NoteService {
  private queues = new Map<string, Promise<void>>()

  constructor(private db: Database.Database, private store: Store,
    private utilityConfig: () => ProviderConfig) {}

  schedule(sessionId: string, assistantTurnId: string, assistantLength: number): void {
    const unanswered = this.db.prepare(`
      SELECT COUNT(*) AS n FROM turns t
      WHERE t.session_id = ? AND t.role = 'assistant'
        AND NOT EXISTS (SELECT 1 FROM extractions e WHERE e.turn_id = t.id AND e.status IN ('ok', 'skipped'))
    `).get(sessionId) as { n: number }
    if (assistantLength < 80 && unanswered.n <= 6) return
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined)
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 1500)))
      .then(async () => { await this.extractTurn(assistantTurnId) })
      .catch(() => undefined)
    this.queues.set(sessionId, next)
    void next.finally(() => {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId)
    })
  }

  async flushSession(sessionId: string): Promise<void> {
    await this.queues.get(sessionId)?.catch(() => undefined)
    const pending = this.db.prepare(`SELECT t.id FROM turns t WHERE t.session_id = ? AND t.role = 'assistant'
      AND NOT EXISTS (SELECT 1 FROM extractions e WHERE e.turn_id = t.id AND e.status IN ('ok', 'skipped'))
      ORDER BY t.rowid`).all(sessionId) as Array<{ id: string }>
    for (const turn of pending) await this.extractTurn(turn.id)
    const failed = this.db.prepare(`SELECT COUNT(*) AS n FROM turns t
      LEFT JOIN extractions e ON e.turn_id = t.id
      WHERE t.session_id = ? AND t.role = 'assistant' AND (e.id IS NULL OR e.status = 'failed' OR e.status = 'pending')`)
      .get(sessionId) as { n: number }
    if (failed.n) throw new Error(`本场还有 ${failed.n} 条笔记没有整理成功，归航暂缓。请检查连接后重试。`)
  }

  async extractTurn(assistantTurnId: string, force = false, options: ExtractOptions = {}): Promise<'ok' | 'skipped' | 'failed'> {
    const existing = this.db.prepare('SELECT id, status, attempt, node_id, payload_json FROM extractions WHERE turn_id = ?')
      .get(assistantTurnId) as {
        id: string; status: string; attempt: number; node_id: string | null; payload_json: string | null
      } | undefined
    if (!force && (existing?.status === 'ok' || existing?.status === 'skipped')) return 'skipped'

    let oldMasteryDelta = 0
    try {
      const oldPayload = JSON.parse(existing?.payload_json || 'null') as ExtractionResult | null
      oldMasteryDelta = oldPayload?.nodePatch?.masteryDelta ?? 0
    } catch {
      // 旧版可能存过不完整的调试结果；重算仍可继续。
    }

    const context = this.contextFor(assistantTurnId, force ? existing?.node_id : null, force)
    if (!context) return 'failed'
    const now = new Date().toISOString()
    const extractionId = existing?.id ?? newId('ext')
    if (existing) {
      this.db.prepare("UPDATE extractions SET status = 'pending', error = NULL, attempt = attempt + 1, updated_at = ? WHERE id = ?")
        .run(now, extractionId)
    } else {
      this.db.prepare(`INSERT INTO extractions (id, turn_id, status, attempt, created_at, updated_at)
        VALUES (?, ?, 'pending', 1, ?, ?)`).run(extractionId, assistantTurnId, now, now)
    }

    if (/^(谢谢|谢了|好的|明白了|嗯|哦)[。！!\s]*$/.test(context.lastUserText.trim())) {
      const empty: ExtractionResult = { hasNewContent: false, blocks: [], nodeAction: 'none',
        nodePatch: { title: '', masteryDelta: 0 }, edges: [], discarded: [{ reason: '无新信息' }] }
      this.applyResult(extractionId, context, empty, force, oldMasteryDelta, options)
      return 'skipped'
    }

    const input = this.buildInput(context)
    let lastError = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const userContent = attempt === 0 ? input : `${input}\n\n上次输出校验失败：${lastError}。请修正后只输出合法 JSON。`
        const raw = await completeChat(this.utilityConfig(), [
          { role: 'system', content: NOTE_EXTRACT_PROMPT },
          { role: 'user', content: userContent }
        ], AbortSignal.timeout(45_000))
        const payload = validateExtraction(raw, context.chunks, context.assistantText)
        const checked = await this.verifyAgainstPriorNotes(context, payload)
        return this.applyResult(extractionId, context, checked, force, oldMasteryDelta, options)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    this.db.prepare("UPDATE extractions SET status = 'failed', error = ?, attempt = attempt + 1, updated_at = ? WHERE id = ?")
      .run(lastError.slice(0, 1000), new Date().toISOString(), extractionId)
    return 'failed'
  }

  private contextFor(assistantTurnId: string, originalNodeId: string | null = null, force = false): TurnContext | null {
    const assistant = this.db.prepare(`
      SELECT t.rowid AS turn_rowid, t.id, t.content, t.session_id, s.topic_id, tp.title AS topic_title
      FROM turns t JOIN sessions s ON s.id = t.session_id
      LEFT JOIN topics tp ON tp.id = s.topic_id
      WHERE t.id = ? AND t.role = 'assistant'
    `).get(assistantTurnId) as {
      turn_rowid: number; id: string; content: string; session_id: string;
      topic_id: string | null; topic_title: string | null
    } | undefined
    if (!assistant?.topic_id) return null
    const user = this.db.prepare(`
      SELECT id, content FROM turns WHERE session_id = ? AND role = 'user' AND rowid < ?
      ORDER BY rowid DESC LIMIT 1
    `).get(assistant.session_id, assistant.turn_rowid) as { id: string; content: string } | undefined
    if (!user) return null
    let userText = user.content
    let assistantText = assistant.content
    const batchedAssistantIds: string[] = []
    if (!force && assistant.content.length < 80) {
      const pending = this.db.prepare(`
        SELECT t.id, t.content, t.rowid AS turn_rowid FROM turns t
        WHERE t.session_id = ? AND t.role = 'assistant' AND t.rowid <= ?
          AND NOT EXISTS (SELECT 1 FROM extractions e WHERE e.turn_id = t.id AND e.status IN ('ok', 'skipped'))
        ORDER BY t.rowid DESC LIMIT 7
      `).all(assistant.session_id, assistant.turn_rowid) as Array<{ id: string; content: string; turn_rowid: number }>
      if (pending.length >= 7) {
        const pairs = pending.reverse().map((turn) => {
          const precedingUser = this.db.prepare(`
            SELECT content FROM turns WHERE session_id = ? AND role = 'user' AND rowid < ?
            ORDER BY rowid DESC LIMIT 1
          `).get(assistant.session_id, turn.turn_rowid) as { content: string } | undefined
          return { id: turn.id, user: precedingUser?.content ?? '', assistant: turn.content }
        })
        userText = pairs.map((pair) => pair.user).join('\n')
        assistantText = pairs.map((pair) => pair.assistant).join('\n')
        batchedAssistantIds.push(...pairs.slice(0, -1).map((pair) => pair.id))
      }
    }
    const knownNodes = this.db.prepare("SELECT id, title FROM nodes WHERE topic_id = ? AND kind != 'resource' ORDER BY rowid DESC LIMIT 20")
      .all(assistant.topic_id) as Array<{ id: string; title: string }>
    const originalNode = originalNodeId ? (this.db.prepare('SELECT id, title FROM nodes WHERE id = ?')
      .get(originalNodeId) as { id: string; title: string } | undefined) : undefined
    // A topic can contain many separate sessions. Continue the active path only
    // from this session's most recent extracted node (strictly earlier in this
    // session), never from an unrelated node that happened to be created last in
    // the topic. The rule itself lives in Store so that the working set and
    // homeward use exactly the same one.
    const previousSessionNode = this.store.currentNodeFor(assistant.session_id, assistant.turn_rowid)
    const currentNode = previousSessionNode ?? originalNode
    const existingNotes = currentNode ? (this.db.prepare(`
      SELECT b.content_md FROM note_blocks b
      LEFT JOIN turns t ON t.id = b.origin_turn_id
      WHERE b.node_id = ? AND (? = 0 OR t.rowid < ? OR b.edited_by_user = 1)
      ORDER BY b.ordinal
    `).all(currentNode.id, force ? 1 : 0, assistant.turn_rowid) as Array<{ content_md: string }>).map((row) => row.content_md) : []
    const recentTopicNotes = (this.db.prepare(`
      SELECT b.content_md FROM note_blocks b JOIN nodes n ON n.id = b.node_id
      LEFT JOIN turns t ON t.id = b.origin_turn_id
      WHERE n.topic_id = ? AND b.deleted_by_user = 0
        AND (? = 0 OR t.rowid < ? OR b.edited_by_user = 1)
      ORDER BY b.rowid DESC LIMIT 20
    `).all(assistant.topic_id, force ? 1 : 0, assistant.turn_rowid) as Array<{ content_md: string }>).map((row) => row.content_md)
    const meta = (this.db.prepare('SELECT attachment_ids_json, cited_chunk_ids_json FROM turn_meta WHERE turn_id = ?')
      .get(assistant.id) ?? this.db.prepare('SELECT attachment_ids_json, cited_chunk_ids_json FROM turn_meta WHERE turn_id = ?')
        .get(user.id)) as { attachment_ids_json: string; cited_chunk_ids_json: string } | undefined
    const attachmentIds = parseStringArray(meta?.attachment_ids_json)
    const citedChunkIds = parseStringArray(meta?.cited_chunk_ids_json)
    const chunks: ChunkContext[] = []
    if (citedChunkIds.length) {
      const placeholders = citedChunkIds.map(() => '?').join(',')
      chunks.push(...this.db.prepare(`
        SELECT c.id, c.attachment_id, c.ordinal, c.page, c.text, a.original_name, a.resource_node_id
        FROM chunks c JOIN attachments a ON a.id = c.attachment_id
        WHERE c.id IN (${placeholders})
      `).all(...citedChunkIds) as ChunkContext[])
      chunks.sort((left, right) => citedChunkIds.indexOf(left.id) - citedChunkIds.indexOf(right.id))
    } else for (const id of attachmentIds.slice(0, 3)) {
      chunks.push(...this.db.prepare(`
        SELECT c.id, c.attachment_id, c.ordinal, c.page, c.text, a.original_name, a.resource_node_id
        FROM chunks c JOIN attachments a ON a.id = c.attachment_id
        WHERE c.attachment_id = ? ORDER BY c.ordinal LIMIT 3
      `).all(id) as ChunkContext[])
    }
    return {
      turnRowId: assistant.turn_rowid,
      assistantId: assistant.id,
      assistantText,
      userId: user.id,
      userText,
      lastUserText: user.content,
      batchedAssistantIds,
      sessionId: assistant.session_id,
      topicId: assistant.topic_id,
      topicTitle: assistant.topic_title ?? '未命名主题',
      currentNodeId: currentNode?.id ?? null,
      parentNodeId: previousSessionNode?.id ?? null,
      originalNodeId: originalNode?.id ?? null,
      currentNodeTitle: currentNode?.title ?? user.content.slice(0, 30),
      existingNotes,
      recentTopicNotes,
      chunks,
      knownNodes
    }
  }

  private buildInput(context: TurnContext): string {
    const existing = context.existingNotes.length ? context.existingNotes.join('\n') : '（空）'
    const recent = context.recentTopicNotes.length
      ? context.recentTopicNotes.map((note) => note.slice(0, 120)).join('\n') : '（空）'
    const chunks = context.chunks.length ? context.chunks.map((chunk) =>
      `[片段 ${chunk.ordinal} · 第 ${chunk.page ?? '?'} 页 · ${chunk.original_name}] ${chunk.text.slice(0, 500)}`
    ).join('\n') : '（空）'
    return `【本场主题】${context.topicTitle}
【当前节点】${context.currentNodeTitle}
【已有节点】${context.knownNodes.map((node) => `${node.id} ${node.title}`).join('；') || '（空）'}
【已有笔记】${existing}
【本场最近的笔记，供查重和检查矛盾】${recent}
【本段对话】用户：${context.userText}\n助手：${context.assistantText}
【用户导入的资料片段】${chunks}`
  }

  private async verifyAgainstPriorNotes(context: TurnContext, payload: ExtractionResult): Promise<ExtractionResult> {
    if (!payload.hasNewContent || payload.blocks.length === 0 || context.recentTopicNotes.length === 0) {
      return payload
    }
    const input = JSON.stringify({
      question: context.lastUserText,
      assistantReply: context.assistantText,
      previousNotes: context.recentTopicNotes,
      candidateBlocks: payload.blocks.map((block) => ({ type: block.blockType, content: block.content }))
    })
    const raw = await completeChat(this.utilityConfig(), [
      { role: 'system', content: NOTE_VERIFY_PROMPT },
      { role: 'user', content: input }
    ], AbortSignal.timeout(45_000))
    const decision = verificationSchema.parse(JSON.parse(raw))
    if (decision.approved.length !== payload.blocks.length || decision.reasons.length !== payload.blocks.length) {
      throw new Error('矛盾核对结果与候选笔记数量不一致')
    }
    const accepted = payload.blocks.filter((_, index) => decision.approved[index])
    const discarded = payload.discarded.slice()
    decision.approved.forEach((approved, index) => {
      if (!approved) discarded.push({ reason: `矛盾核对：${decision.reasons[index] || '与已有笔记冲突或条件不清'}` })
    })
    return {
      ...payload,
      hasNewContent: accepted.length > 0,
      blocks: accepted,
      nodeAction: accepted.length ? payload.nodeAction : 'none',
      nodePatch: accepted.length ? payload.nodePatch : { title: '', masteryDelta: 0 },
      edges: accepted.length ? payload.edges : [],
      discarded
    }
  }

  private markSkipped(id: string, payload: ExtractionResult): void {
    this.db.prepare("UPDATE extractions SET status = 'skipped', payload_json = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(payload), new Date().toISOString(), id)
  }

  private markBatchedTurns(context: TurnContext): void {
    const now = new Date().toISOString()
    for (const turnId of context.batchedAssistantIds) {
      this.db.prepare(`INSERT OR IGNORE INTO extractions
        (id, turn_id, status, attempt, payload_json, created_at, updated_at)
        VALUES (?, ?, 'skipped', 0, ?, ?, ?)`)
        .run(newId('ext'), turnId, JSON.stringify({ batchedInto: context.assistantId }), now, now)
    }
  }

  private applyResult(
    id: string, context: TurnContext, payload: ExtractionResult, force = false,
    oldMasteryDelta = 0, options: ExtractOptions = {}
  ): 'ok' | 'skipped' {
    if (!payload.hasNewContent || payload.blocks.length === 0) {
      this.db.transaction(() => {
        // An empty or fully rejected re-extraction is not evidence that an
        // existing note should be erased. Keep the previous derived note intact.
        this.markSkipped(id, payload)
        this.markBatchedTurns(context)
      })()
      return 'skipped'
    }
    return this.db.transaction(() => {
      const now = new Date().toISOString()
      if (force) this.removeOldAutoBlocks(context.assistantId)
      const resourceOnlyNode = payload.blocks.every((block) => block.blockType === 'source_quote')
        ? context.chunks.find((chunk) => chunk.resource_node_id)?.resource_node_id ?? null : null
      let nodeId = resourceOnlyNode ?? context.currentNodeId
      if (!resourceOnlyNode && (payload.nodeAction === 'create' || !nodeId)) {
        nodeId = newId('nod')
        const title = payload.nodePatch.title.trim() || context.userText.trim().slice(0, 30)
        const isQuestion = /[?？]|为什么|怎么|如何|什么/.test(title)
        this.db.prepare(`INSERT INTO nodes
          (id, topic_id, title, kind, status, mastery, origin_turn_id, created_at, updated_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(nodeId, context.topicId, title, isQuestion ? 'question' : 'concept',
            isQuestion ? 'open' : 'gathered', Math.max(0, Math.min(5, Math.round(payload.nodePatch.masteryDelta))),
            context.userId, now, now, now)
        if (force && context.originalNodeId && oldMasteryDelta) {
          this.db.prepare('UPDATE nodes SET mastery = MIN(5, MAX(0, mastery - ?)) WHERE id = ?')
            .run(Math.round(oldMasteryDelta), context.originalNodeId)
        }
        if (context.parentNodeId && context.parentNodeId !== nodeId) {
          this.insertEdge(context.parentNodeId, nodeId, 'parent', now)
        }
        // 这一轮旧节点刚被替换掉，抽取记录必须立刻指向新节点。
        // 否则本场后面几轮读到的"本场最近节点"还是那个已经删掉的旧 id，
        // 它们之间的父边会因此插不进去，本场的路径就断了。
        if (force) {
          this.db.prepare('UPDATE extractions SET node_id = ? WHERE id = ?').run(nodeId, id)
        }
      } else if (!resourceOnlyNode) {
        const previousDeltaOnTarget = force && context.originalNodeId === nodeId ? oldMasteryDelta : 0
        // 模型这一轮给的名字也要落到卡片上，否则用户在界面上永远看不到标题更新。
        // 只有名字确实变了才动它，避免每轮都写一次没意义的 UPDATE。
        const proposedTitle = payload.nodePatch.title.trim()
        const renamed = !options.keepTitles && proposedTitle
          && this.db.prepare('SELECT 1 FROM nodes WHERE id = ? AND title != ?').get(nodeId, proposedTitle)
        if (renamed) {
          this.db.prepare(`UPDATE nodes SET title = ?, mastery = MIN(5, MAX(0, mastery + ?)),
            last_seen_at = ?, updated_at = ? WHERE id = ?`)
            .run(proposedTitle, Math.round(payload.nodePatch.masteryDelta - previousDeltaOnTarget), now, now, nodeId)
        } else {
          this.db.prepare(`UPDATE nodes SET mastery = MIN(5, MAX(0, mastery + ?)),
            last_seen_at = ?, updated_at = ? WHERE id = ?`)
            .run(Math.round(payload.nodePatch.masteryDelta - previousDeltaOnTarget), now, now, nodeId)
        }
        if (force && context.originalNodeId && context.originalNodeId !== nodeId && oldMasteryDelta) {
          this.db.prepare('UPDATE nodes SET mastery = MIN(5, MAX(0, mastery - ?)) WHERE id = ?')
            .run(Math.round(oldMasteryDelta), context.originalNodeId)
        }
      }

      const existingTexts = (this.db.prepare(`
        SELECT b.content_md FROM note_blocks b LEFT JOIN turns t ON t.id = b.origin_turn_id
        WHERE b.node_id = ? AND (? = 0 OR t.rowid < ? OR b.edited_by_user = 1)
      `).all(nodeId, force ? 1 : 0, context.turnRowId) as Array<{ content_md: string }>).map((row) => row.content_md)
      let ordinal = (this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS n FROM note_blocks WHERE node_id = ?')
        .get(nodeId) as { n: number }).n
      let inserted = 0
      for (const block of payload.blocks) {
        if (!block.isNewRelativeToExisting) {
          payload.discarded.push({ reason: '重复已有' })
          continue
        }
        const content = block.content.trim()
        if (existingTexts.some((old) => similarity(content, old) > 0.9)) {
          payload.discarded.push({ reason: '重复已有' })
          continue
        }
        const sourceOrdinal = block.groundedIn.startsWith('document:')
          ? Number(block.groundedIn.slice('document:'.length)) : NaN
        const sourceChunk = context.chunks.find((chunk) => chunk.ordinal === sourceOrdinal &&
          (block.blockType !== 'source_quote' || chunk.text.includes(content)))
        const targetNodeId: string = block.blockType === 'source_quote' && sourceChunk?.resource_node_id
          ? sourceChunk.resource_node_id : nodeId!
        const targetOrdinal = targetNodeId === nodeId ? ++ordinal
          : (this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS n FROM note_blocks WHERE node_id = ?')
            .get(targetNodeId) as { n: number }).n + 1
        this.db.prepare(`INSERT INTO note_blocks
          (id, node_id, block_type, content_md, ordinal, origin_chunk_ids_json,
           origin_turn_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(newId('blk'), targetNodeId, block.blockType, content, targetOrdinal,
            JSON.stringify(sourceChunk ? [sourceChunk.id] : []), context.assistantId, now, now)
        existingTexts.push(content)
        inserted++
      }

      if (inserted === 0) {
        if (!force) {
          this.db.prepare('DELETE FROM nodes WHERE id = ? AND id NOT IN (SELECT node_id FROM note_blocks) AND origin_turn_id = ?')
            .run(nodeId, context.userId)
        }
        this.markSkipped(id, payload)
        this.markBatchedTurns(context)
        return 'skipped'
      }

      if (!resourceOnlyNode) this.db.prepare('INSERT OR IGNORE INTO reviews (node_id, due_at) VALUES (?, ?)')
        .run(nodeId, new Date(Date.now() + 86_400_000).toISOString())

      for (const edge of resourceOnlyNode ? [] : payload.edges) {
        if (edge.toNodeId !== nodeId && context.knownNodes.some((known) => known.id === edge.toNodeId)) {
          // Parent edges describe the actual question path and are created from
          // the previous node in this session above. Do not trust an LLM edge
          // to reverse the path or connect unrelated sessions.
          if (edge.type === 'parent') continue
          this.insertEdge(nodeId!, edge.toNodeId, edge.type, now)
        }
      }
      this.db.prepare("UPDATE extractions SET node_id = ?, status = 'ok', payload_json = ?, error = NULL, updated_at = ? WHERE id = ?")
        .run(nodeId, JSON.stringify(payload), now, id)
      this.markBatchedTurns(context)
      return 'ok'
    })()
  }

  private removeOldAutoBlocks(assistantTurnId: string): void {
    this.db.prepare(`DELETE FROM note_blocks
      WHERE origin_turn_id = ? AND edited_by_user = 0 AND block_type != 'user_note'`)
      .run(assistantTurnId)
  }

  async recalculateSession(sessionId: string, options: RecalculateOptions = {}): Promise<RecalculateResult> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const job = previous.catch(() => undefined).then(async () => {
      const rows = this.db.prepare(`SELECT t.id, e.payload_json FROM turns t
        LEFT JOIN extractions e ON e.turn_id = t.id
        WHERE t.session_id = ? AND t.role = 'assistant' ORDER BY t.rowid`)
        .all(sessionId) as Array<{ id: string; payload_json: string | null }>
      // 短回复合并抽取时，前几轮被标成 skipped 并合并进最后一轮。重算必须沿用同一条
      // 合并规则，否则同一段内容会被一轮一轮重新计费，还会把一条笔记拆成好几条。
      const turns = rows.filter((row) => !isBatchedPlaceholder(row.payload_json))
      const result: RecalculateResult = { total: turns.length, ok: 0, skipped: 0, failed: 0,
        merged: rows.length - turns.length }
      for (const turn of turns) {
        const status = await this.extractTurn(turn.id, true, { force: true, keepTitles: options.keepTitles })
        result[status]++
      }
      // Recalculation can move notes away from their old auto-generated nodes.
      // Remove only nodes from this session that have no note blocks at all
      // (including user-deleted or user-authored blocks) and no remaining
      // extraction references.
      this.rebuildPath(sessionId)
      return result
    })
    const settled = job.then(() => undefined, () => undefined)
    this.queues.set(sessionId, settled)
    try {
      return await job
    } finally {
      if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId)
    }
  }

  /**
   * 重算收尾：本场的路径按"这一场的实际学习顺序"重连，再删掉空节点。
   *
   * 为什么必须重连：重算会把笔记搬到新卡片上，中间那些旧节点就空了。删掉它们会
   * 连带 CASCADE 掉它们两端的父边，本场的学习路径会整段消失（地图上就是几个
   * 互不相连的孤点）。靠"把被删节点的父边接到下一个幸存者"去补是不可靠的：
   * 一条链上的节点可能全部被替换掉，往上根本找不到还活着的祖先。
   *
   * 所以直接按本场的轮次顺序重连：谁的"最近一次出现的轮次"更靠前，谁就是上一层。
   * 这正是正常抽取时父边的来路，重算后保持一致。
   */
  private rebuildPath(sessionId: string): void {
    this.db.transaction(() => {
      // 顺序很重要：先删空节点，再连路径。
      // 反过来的话，删掉中间那个空节点时 CASCADE 会把刚连好的父边一起带走，
      // 本场的路径反而更碎。
      const emptied = this.db.prepare(`SELECT n.id FROM nodes n JOIN turns t ON t.id = n.origin_turn_id
        WHERE t.session_id = ? AND n.kind != 'resource'
          AND NOT EXISTS (SELECT 1 FROM note_blocks b WHERE b.node_id = n.id)
          AND NOT EXISTS (SELECT 1 FROM extractions e WHERE e.node_id = n.id)`).all(sessionId) as Array<{ id: string }>
      const remove = this.db.prepare('DELETE FROM nodes WHERE id = ?')
      for (const node of emptied) remove.run(node.id)

      const nodes = this.store.sessionNodeOrder(sessionId).filter((row) =>
        !!this.db.prepare(`SELECT 1 FROM nodes WHERE id = ? AND kind != 'resource'`).get(row.id))
      nodes.sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
      const now = new Date().toISOString()
      for (let index = 1; index < nodes.length; index++) {
        const previous = nodes[index - 1]
        const current = nodes[index]
        if (previous.rank === current.rank) continue
        this.insertEdge(previous.id, current.id, 'parent', now)
      }
    })()
  }

  /**
   * 插一条边。
   *
   * 两端都必须还存在：重算会删掉被拆开或合并的旧节点，而上下文里可能还留着
   * 这些旧 id。外键会把不存在的端点拒掉，而 `INSERT OR IGNORE` 会让这个失败
   * 无声无息——本场的父路径就这么断了。所以这里显式判断一次。
   */
  private insertEdge(src: string, dst: string, type: string, now: string): void {
    if (src === dst) return
    const alive = this.db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE id IN (?, ?)`).get(src, dst) as { n: number }
    if (alive.n !== 2) return
    this.db.prepare(`INSERT OR IGNORE INTO edges (id, src_id, dst_id, type, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(newId('edg'), src, dst, type, now)
  }

  listSessionCards(sessionId: string): NoteCard[] {
    const nodes = this.db.prepare(`
      SELECT DISTINCT n.id, n.title, n.kind, n.status, n.mastery, n.origin_turn_id, n.updated_at
      FROM nodes n JOIN note_blocks b ON b.node_id = n.id AND b.deleted_by_user = 0
      JOIN turns t ON t.id = b.origin_turn_id
      WHERE t.session_id = ? ORDER BY n.updated_at DESC
    `).all(sessionId) as Array<Omit<NoteCard, 'blocks'>>
    return this.hydrateCards(nodes)
  }

  listAllCards(): { cards: NoteCard[]; edges: Array<{ src_id: string; dst_id: string }> } {
    const nodes = this.db.prepare(`SELECT DISTINCT n.id, n.topic_id, tp.title AS topic_title,
      n.title, n.kind, n.status, n.mastery, n.origin_turn_id, t.session_id AS origin_session_id, n.updated_at
      FROM nodes n JOIN note_blocks b ON b.node_id = n.id AND b.deleted_by_user = 0
      LEFT JOIN topics tp ON tp.id = n.topic_id
      LEFT JOIN turns t ON t.id = n.origin_turn_id
      WHERE n.trashed_at IS NULL
      ORDER BY n.updated_at DESC`).all() as Array<Omit<NoteCard, 'blocks'>>
    const ids = new Set(nodes.map((node) => node.id))
    const edges = (this.db.prepare("SELECT src_id, dst_id FROM edges WHERE type = 'parent'")
      .all() as Array<{ src_id: string; dst_id: string }>).filter((edge) => ids.has(edge.src_id) && ids.has(edge.dst_id))
    return { cards: this.hydrateCards(nodes), edges }
  }

  private hydrateCards(nodes: Array<Omit<NoteCard, 'blocks'>>): NoteCard[] {
    return nodes.map((node) => {
      const rows = this.db.prepare('SELECT * FROM note_blocks WHERE node_id = ? AND deleted_by_user = 0 ORDER BY pinned DESC, ordinal ASC')
        .all(node.id) as Array<Omit<NoteBlockRow, 'source_name' | 'source_page' | 'source_attachment_id' | 'source_partial'>>
      const blocks = rows.map((row) => {
        const chunkId = parseStringArray(row.origin_chunk_ids_json)[0]
        const source = chunkId ? this.db.prepare(`
          SELECT a.id AS attachment_id, a.original_name, a.extract_status, c.page FROM chunks c
          JOIN attachments a ON a.id = c.attachment_id WHERE c.id = ?
        `).get(chunkId) as { attachment_id: string; original_name: string; extract_status: string;
          page: number | null } | undefined : undefined
        return { ...row, source_name: source?.original_name ?? null, source_page: source?.page ?? null,
          source_attachment_id: source?.attachment_id ?? null, source_partial: source?.extract_status === 'partial' }
      })
      return { ...node, blocks }
    })
  }

  editBlock(id: string, content: string): boolean {
    const trimmed = content.trim()
    if (!trimmed || trimmed.length > 2000) return false
    const result = this.db.prepare(`UPDATE note_blocks
      SET content_md = ?, edited_by_user = 1, updated_at = ?
      WHERE id = ? AND deleted_by_user = 0`).run(trimmed, new Date().toISOString(), id)
    return result.changes === 1
  }

  deleteBlock(id: string): boolean {
    const result = this.db.prepare(`UPDATE note_blocks
      SET deleted_by_user = 1, edited_by_user = 1, updated_at = ?
      WHERE id = ? AND deleted_by_user = 0`).run(new Date().toISOString(), id)
    return result.changes === 1
  }

  setPinned(id: string, pinned: boolean): boolean {
    const result = this.db.prepare(`UPDATE note_blocks SET pinned = ?, updated_at = ?
      WHERE id = ? AND deleted_by_user = 0`).run(pinned ? 1 : 0, new Date().toISOString(), id)
    return result.changes === 1
  }

  rememberUserNote(sessionId: string, userTurnId: string, content: string): void {
    const session = this.db.prepare('SELECT topic_id FROM sessions WHERE id = ?')
      .get(sessionId) as { topic_id: string | null } | undefined
    if (!session?.topic_id) return
    const now = new Date().toISOString()
    const title = content.replace(/\s+/g, ' ').slice(0, 30) || '我记下的内容'
    this.db.transaction(() => {
      const currentTurn = this.db.prepare('SELECT rowid FROM turns WHERE id = ? AND session_id = ?')
        .get(userTurnId, sessionId) as { rowid: number } | undefined
      const previous = currentTurn ? this.db.prepare(`
        SELECT n.id FROM nodes n JOIN note_blocks b ON b.node_id = n.id
        JOIN turns t ON t.id = b.origin_turn_id
        WHERE n.topic_id = ? AND t.session_id = ? AND t.rowid < ? AND b.deleted_by_user = 0
        ORDER BY t.rowid DESC, b.rowid DESC LIMIT 1
      `).get(session.topic_id, sessionId, currentTurn.rowid) as { id: string } | undefined : undefined
      const nodeId = newId('nod')
      this.db.prepare(`INSERT INTO nodes
        (id, topic_id, title, kind, status, origin_turn_id, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, 'fact', 'gathered', ?, ?, ?, ?)`)
        .run(nodeId, session.topic_id, title, userTurnId, now, now, now)
      this.db.prepare(`INSERT INTO note_blocks
        (id, node_id, block_type, content_md, ordinal, origin_turn_id, edited_by_user, created_at, updated_at)
        VALUES (?, ?, 'user_note', ?, 1, ?, 1, ?, ?)`)
        .run(newId('blk'), nodeId, content, userTurnId, now, now)
      this.db.prepare('INSERT OR IGNORE INTO reviews (node_id, due_at) VALUES (?, ?)')
        .run(nodeId, new Date(Date.now() + 86_400_000).toISOString())
      if (previous) this.insertEdge(previous.id, nodeId, 'parent', now)
    })()
  }
}
