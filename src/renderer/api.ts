import type { AppSettings, ProviderPreset, SettingsView, TurnRow } from './types'
import type { AnalysisMode, AnalysisPlan, DocumentAnalysis, DocumentSource } from '../shared/library'

/**
 * 界面跟本地服务说话的客户端。
 * 所有请求都带一个凭证头，防止本机上别的程序乱调。
 */

const base = window.zhitu?.baseURL ?? ''
const token = window.zhitu?.token ?? ''

export class ApiError extends Error {
  constructor(
    message: string,
    readonly advice = '',
    readonly status = 0
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(base + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Zhitu-Token': token,
        ...(init?.headers ?? {})
      }
    })
  } catch (err) {
    throw new ApiError(
      `连不上本地服务：${err instanceof Error ? err.message : String(err)}`,
      '这是软件内部的问题，重启一下织图试试。'
    )
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string
      advice?: string
    }
    throw new ApiError(body.message ?? `请求失败（${response.status}）`, body.advice ?? '', response.status)
  }

  return (await response.json()) as T
}

// ── 数据结构 ────────────────────────────────

export interface Bootstrap {
  version: string
  dataDir: string
  settings: SettingsView
  providers: ProviderPreset[]
  levels: Record<string, string>
  stats: { sessions: number; turns: number }
  latestSessionId: string | null
}

export interface TestResult {
  ok: boolean
  reply?: string
  message?: string
  advice?: string
  status?: number
}

// ── 接口 ────────────────────────────────────

export function getBootstrap(): Promise<Bootstrap> {
  return request<Bootstrap>('/bootstrap')
}
export interface SessionSummary {
  id: string
  title: string
  started_at: string
  ended_at: string | null
  archived_at: string | null
  /** 非空 = 这场在回收站里 */
  deleted_at: string | null
}
export interface TrashStats {
  sessions: number
  turns: number
  nodes: number
  bytes: number
  oldestAt: string | null
  nextPurgeAt: string | null
}
export interface SessionsPayload {
  sessions: SessionSummary[]
  archived: SessionSummary[]
  trash: SessionSummary[]
  trashStats: TrashStats
  retentionDays: number
}
export function getSessions(): Promise<SessionsPayload> {
  return request('/sessions')
}
export interface HistoryPage { sessions: SessionSummary[]; total: number; offset: number; limit: number; counts: { active: number; archived: number } }
export function getHistoryPage(query: string, archived: boolean, offset: number): Promise<HistoryPage> {
  return request(`/sessions/history?q=${encodeURIComponent(query)}&state=${archived ? 'archived' : 'active'}&offset=${offset}&limit=25`)
}
export interface BackupPreview { exportedAt: string; schemaVersion: number; sessions: number; notes: number; attachments: number; fileBytes: number; archived: number; trash: number }
export function previewBackup(data: unknown): Promise<{ preview: BackupPreview }> {
  return request('/backups/preview', { method: 'POST', body: JSON.stringify(data) })
}
export function restoreBackup(data: unknown): Promise<{ preview: BackupPreview; snapshotPath: string; snapshotWarning?: string }> {
  return request('/backups/restore', { method: 'POST', body: JSON.stringify(data) })
}

/** 历史记录管理：重命名、归档、回收站、删除。 */
export function renameSession(id: string, title: string): Promise<{ session: SessionSummary }> {
  return request(`/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ title })
  })
}

export function setSessionArchived(id: string, archived: boolean): Promise<{ session: SessionSummary }> {
  return request(`/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ archived })
  })
}

/** 移入回收站：30 天内可以恢复，界面据此给撤销条。 */
export function trashSession(id: string): Promise<{ ok: boolean; nodes: number }> {
  return request(`/sessions/${encodeURIComponent(id)}?mode=trash`, { method: 'DELETE' })
}

export function restoreSession(id: string): Promise<{ ok: boolean; session: SessionSummary }> {
  return request(`/sessions/${encodeURIComponent(id)}/restore`, { method: 'POST' })
}

/** 批量：逐场结果，界面要能如实说出哪几场没成功。 */
export function batchSessions(ids: string[], action: 'trash' | 'restore'): Promise<{
  ok: string[]; failed: Array<{ id: string; reason: string }>; trashStats: TrashStats
}> {
  return request('/sessions/batch', { method: 'POST', body: JSON.stringify({ ids, action }) })
}

export function emptyTrash(): Promise<{ removed: number; failed: string[] }> {
  return request('/sessions/trash/empty?confirm=true', { method: 'POST' })
}

/** 删除会删掉什么、会留下什么。删除不可逆，必须先让用户看到这份预演。 */
export interface DeletionPreview {
  title: string
  turns: number
  leaves: number
  nodes: string[]
  keeps: number
  notes: number
  attachments: number
}
export function getDeletionPreview(id: string): Promise<{ preview: DeletionPreview }> {
  return request(`/sessions/${encodeURIComponent(id)}/deletion-preview`)
}

/** 彻底删除：唯一不可逆的那条路，调用前必须先展示预演并二次确认。 */
export function deleteSession(id: string): Promise<{
  ok: boolean; deletedNodes: number; filesRemoved: number
}> {
  return request(`/sessions/${encodeURIComponent(id)}?mode=purge&confirm=true`, { method: 'DELETE' })
}
export interface WeekStats {
  sessions: number
  noteBlocks: number
  topics: Array<{ id: string; title: string; sessions: number }>
  unfinished: OpenThread[]
}
export function getWeekStats(since: string): Promise<WeekStats> {
  return request(`/stats/week?since=${encodeURIComponent(since)}`)
}

export async function downloadExport(path: string, name: string): Promise<boolean> {
  let response: Response
  try { response = await fetch(base + path, { headers: { 'X-Zhitu-Token': token } }) }
  catch (error) { throw new ApiError(`连不上本地服务：${error instanceof Error ? error.message : String(error)}`) }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string }
    throw new ApiError(body.message ?? '导出失败', '', response.status)
  }
  return window.zhitu.saveExport(name, new Uint8Array(await response.arrayBuffer()))
}

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
export function globalSearch(query: string): Promise<{ hits: SearchHit[] }> {
  return request(`/search?q=${encodeURIComponent(query)}`)
}

export function saveSettings(patch: Partial<AppSettings> & { apiKey?: string }): Promise<{
  settings: SettingsView
}> {
  return request('/settings', { method: 'POST', body: JSON.stringify(patch) })
}
export function getProviderKeyStatus(providerId: string): Promise<{
  hasApiKey: boolean; keyEncrypted: boolean; keyUsable: boolean
}> {
  return request(`/settings/provider-key?providerId=${encodeURIComponent(providerId)}`)
}

export function testConnection(payload: {
  providerId?: string
  baseURL?: string
  model?: string
  apiKey?: string
}): Promise<TestResult> {
  return request('/settings/test', { method: 'POST', body: JSON.stringify(payload) })
}

export function getTurns(
  sessionId: string
): Promise<{ session: { id: string; title: string }; turns: TurnRow[] }> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/turns`)
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

export function getUnfinished(): Promise<{ threads: OpenThread[] }> {
  return request('/unfinished')
}

export function closeUnfinished(id: string, reason: 'mastered' | 'uninterested'): Promise<{ ok: boolean }> {
  return request(`/unfinished/${encodeURIComponent(id)}/close`, {
    method: 'POST', body: JSON.stringify({ reason })
  })
}

export function endSession(id: string): Promise<{ results: HomewardResult[]; summary: string }> {
  return request(`/sessions/${encodeURIComponent(id)}/end`, { method: 'POST' })
}

export function getHomeward(id: string): Promise<{ homeward: { results: HomewardResult[]; summary: string } | null }> {
  return request(`/sessions/${encodeURIComponent(id)}/homeward`)
}

export type GoalKind = 'principle' | 'hands_on' | 'casual'
export interface StartEntry { question: string; why: string }

export interface NoteBlock {
  id: string
  node_id: string
  block_type: 'claim' | 'mece' | 'example' | 'contrast' | 'pitfall' | 'question' | 'formula' | 'source_quote' | 'user_note'
  content_md: string
  ordinal: number
  origin_turn_id: string | null
  origin_chunk_ids_json: string
  pinned: number
  edited_by_user: number
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
  blocks: NoteBlock[]
}

export interface Attachment {
  id: string
  session_id: string
  turn_id: string | null
  kind: string
  original_name: string
  bytes: number
  sha256: string
  extract_status: 'pending' | 'ok' | 'partial' | 'failed'
  extract_error: string | null
  page_count: number | null
  resource_node_id?: string | null
}

export function getAttachment(id: string): Promise<{ attachment: Attachment }> {
  return request(`/attachments/${encodeURIComponent(id)}`)
}

export async function uploadAttachment(file: File, sessionId?: string, libraryImport = false): Promise<{
  sessionId: string; attachment: Attachment
}> {
  const form = new FormData()
  form.append('file', file)
  if (sessionId) form.append('sessionId', sessionId)
  if (libraryImport) form.append('libraryImport', 'true')
  let response: Response
  try {
    response = await fetch(base + '/attachments', {
      method: 'POST', headers: { 'X-Zhitu-Token': token }, body: form
    })
  } catch (error) {
    throw new ApiError(`文件没能传进软件：${error instanceof Error ? error.message : String(error)}`)
  }
  const data = await response.json() as { sessionId?: string; attachment?: Attachment; message?: string }
  if (!response.ok || !data.sessionId || !data.attachment) {
    throw new ApiError(data.message ?? '文件导入失败', '', response.status)
  }
  return { sessionId: data.sessionId, attachment: data.attachment }
}

export function getSessionAttachments(sessionId: string): Promise<{ attachments: Attachment[] }> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/attachments`)
}

export function deleteAttachment(id: string): Promise<{ ok: boolean }> {
  return request(`/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function getAttachmentChunks(id: string): Promise<{
  chunks: Array<{ id: string; ordinal: number; text: string; page: number | null }>
}> {
  return request(`/attachments/${encodeURIComponent(id)}/chunks`)
}

export async function getAttachmentFile(id: string): Promise<Blob> {
  const response = await fetch(base + `/attachments/${encodeURIComponent(id)}/file`, {
    headers: { 'X-Zhitu-Token': token }
  })
  if (!response.ok) throw new ApiError('没能打开资料原件', '', response.status)
  return response.blob()
}

export function getSessionNotes(sessionId: string): Promise<{ cards: NoteCard[] }> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/notes`)
}

export function getAllNotes(): Promise<{ cards: NoteCard[]; edges: Array<{ src_id: string; dst_id: string }> }> {
  return request('/notes')
}

export interface MapNode {
  id: string
  title: string
  kind: string
  status: string
  mastery: number
  updated_at: string
  summary: string
  origin_session_id: string | null
}
export interface MapEdge { id: string; src_id: string; dst_id: string; type: string }
export interface MapData {
  topics: Array<{ id: string; title: string }>
  selectedTopicId: string | null
  nodes: MapNode[]
  edges: MapEdge[]
}
export function getMap(topicId?: string): Promise<MapData> {
  return request(`/map${topicId ? `?topicId=${encodeURIComponent(topicId)}` : ''}`)
}

export interface LibraryItem {
  attachment: Attachment
  analysis: Pick<DocumentAnalysis, 'mode' | 'status' | 'stage' | 'completed' | 'total' | 'updatedAt'> | null
}
export function getLibrary(): Promise<{ items: LibraryItem[] }> { return request('/library') }
export function getDocumentAnalysis(id: string): Promise<{ analysis: DocumentAnalysis | null }> {
  return request(`/library/${encodeURIComponent(id)}`)
}
export function getAnalysisPlan(id: string, mode: AnalysisMode, startPage: number, endPage: number): Promise<{ plan: AnalysisPlan }> {
  return request(`/library/${encodeURIComponent(id)}/plan`, { method: 'POST', body: JSON.stringify({ mode, startPage, endPage }) })
}
export function startDocumentAnalysis(id: string, mode: AnalysisMode, options: { startPage: number; endPage: number; restart?: boolean }): Promise<{ analysis: DocumentAnalysis }> {
  return request(`/library/${encodeURIComponent(id)}/start`, { method: 'POST', body: JSON.stringify({ mode, ...options }) })
}
export function cancelDocumentAnalysis(id: string): Promise<{ ok: boolean }> {
  return request(`/library/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}
export function saveDocumentSources(id: string, sources: DocumentSource[]): Promise<{ analysis: DocumentAnalysis }> {
  return request(`/library/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ sources }) })
}
export function saveOrganizedNote(id: string, noteId: string, patch: { category: string; title: string; content: string }): Promise<{ analysis: DocumentAnalysis }> {
  return request(`/library/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ noteId, ...patch }) })
}

export interface ReviewQuestion { attemptId: string; nodeId: string; title: string; question: string }
export interface ReviewGrade {
  correct: boolean; quality: number; masteryDelta: number; feedback: string; mastery: number; nextDueAt: string
}
export function getDueReviewCount(): Promise<{ count: number }> { return request('/reviews/due') }
export function getReviewQuestion(): Promise<{ review: ReviewQuestion | null }> {
  return request('/reviews/question', { method: 'POST' })
}
export function gradeReview(attemptId: string, answer: string): Promise<{ result: ReviewGrade }> {
  return request(`/reviews/${encodeURIComponent(attemptId)}/grade`, {
    method: 'POST', body: JSON.stringify({ answer })
  })
}

export function updateNoteBlock(id: string, patch: { content?: string; pinned?: boolean }): Promise<{ ok: boolean }> {
  return request(`/note-blocks/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(patch)
  })
}

export function deleteNoteBlock(id: string): Promise<{ ok: boolean }> {
  return request(`/note-blocks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface RecalculateResult {
  total: number; ok: number; skipped: number; failed: number; merged: number
}

/**
 * 重算本场笔记。
 * `keepTitles` 为 true 时保留用户已经调好的卡片标题，只重算笔记内容——
 * 重算会按模型这一轮的判断重新分卡，不锁标题的话，用户整理好的结构会被合并掉。
 */
export function recalculateSessionNotes(sessionId: string, keepTitles = false): Promise<RecalculateResult> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/notes/recalculate`, {
    method: 'POST', body: JSON.stringify({ keepTitles })
  })
}

export function suggestEntries(domain: string, goalKind: GoalKind): Promise<{ entries: StartEntry[] }> {
  return request('/start/entries', {
    method: 'POST',
    body: JSON.stringify({ domain, goalKind })
  })
}

// ── 流式对话 ────────────────────────────────

export interface StreamHandlers {
  onSession?: (sessionId: string) => void
  onDelta: (text: string) => void
  onDone: () => void
  onError: (message: string, advice: string, status?: number) => void
}

export async function streamChat(
  body: { sessionId?: string; content: string; domain?: string; goalKind?: GoalKind;
    attachmentIds?: string[]; mode?: 'guide' | 'free' | 'review' },
  handlers: StreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  let response: Response
  try {
    response = await fetch(base + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Zhitu-Token': token },
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return
    handlers.onError(
      `连不上本地服务：${err instanceof Error ? err.message : String(err)}`,
      '重启一下织图试试。'
    )
    return
  }

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      message?: string
      advice?: string
    }
    handlers.onError(data.message ?? `请求失败（${response.status}）`, data.advice ?? '', response.status)
    return
  }

  if (!response.body) {
    handlers.onError('本地服务没有返回内容', '重启一下织图试试。')
    return
  }

  // 手工解析 SSE：每两个换行分隔一个事件
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let finished = false

  const handleBlock = (block: string): void => {
    if (finished || signal?.aborted) return
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) return

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }

    if (event === 'meta' && typeof payload.sessionId === 'string') {
      handlers.onSession?.(payload.sessionId)
    } else if (event === 'delta' && typeof payload.text === 'string') {
      handlers.onDelta(payload.text)
    } else if (event === 'done') {
      finished = true
      handlers.onDone()
    } else if (event === 'error') {
      finished = true
      handlers.onError(
        typeof payload.message === 'string' ? payload.message : '出错了',
        typeof payload.advice === 'string' ? payload.advice : '',
        typeof payload.status === 'number' ? payload.status : 0
      )
    }
  }

  try {
    while (!finished && !signal?.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = /\r?\n\r?\n/.exec(buffer)
      while (boundary) {
        handleBlock(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
        boundary = /\r?\n\r?\n/.exec(buffer)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) handleBlock(buffer)
    if (!finished && !signal?.aborted) handlers.onError('回复连接已中断', '已保留收到的文字，可以继续追问。')
  } catch (err) {
    if (!signal?.aborted) handlers.onError('回复连接已中断', err instanceof Error ? err.message : '请稍后重新提问。')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
