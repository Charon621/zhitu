import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bootstrap } from '../api'
import { batchSessions, closeUnfinished, deleteAttachment, deleteSession, emptyTrash, endSession,
  getAttachment, getAttachmentChunks,
  getAttachmentFile, getDeletionPreview, getHomeward, getSessionAttachments, getSessionNotes, getSessions, getHistoryPage,
  getTurns, getUnfinished, renameSession, restoreSession, setSessionArchived, streamChat, trashSession,
  uploadAttachment,
  type Attachment, type DeletionPreview, type GoalKind, type NoteCard as NoteCardData, type OpenThread,
  type SearchHit, type HistoryPage, type SessionSummary, type TrashStats } from '../api'
import type { SettingsView } from '../types'
import { Markdown } from '../components/Markdown'
import { SettingsDialog } from './SettingsDialog'
import { StartCard } from '../components/StartCard'
import { NoteCard } from '../components/NoteCard'
import { NotesPage } from './NotesPage'
import { MapPage } from './MapPage'
import { ReviewPage } from './ReviewPage'
import { ExportDialog } from './ExportDialog'
import { SearchDialog } from './SearchDialog'
import { UnfinishedPage } from './UnfinishedPage'
import { StatsPage } from './StatsPage'
import { LibraryPage } from './LibraryPage'
import { HistoryRecords } from '../components/HistoryRecords'

/** 回收站里显示的占用：小于 1MB 就说 KB，别让人看一串小数。 */
const formatBytes = (bytes: number): string => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** 距离回收站自动清理还有几天。 */
const daysUntil = (iso: string | null): number => iso
  ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000))
  : 0

interface Props {
  bootstrap: Bootstrap
  settings: SettingsView
  onSettingsChanged: (settings: SettingsView) => void
}

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachmentIds: string[]
  interrupted?: boolean
}

/**
 * 对话界面。
 *
 * 对话是原件；右侧笔记卡由后台从助手回复中抽取，失败不影响对话。
 */
export function Chat({ bootstrap, settings, onSettingsChanged }: Props): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(bootstrap.latestSessionId)
  const [sessionTitle, setSessionTitle] = useState('新的一场')
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [waitPhase, setWaitPhase] = useState<0 | 1 | 2>(0)
  const [error, setError] = useState<{ message: string; advice: string } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(!!bootstrap.latestSessionId)
  const [manualStart, setManualStart] = useState(false)
  const [noteCards, setNoteCards] = useState<NoteCardData[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<{ attachment: Attachment; page: number | null; url: string | null; text: string } | null>(null)
  const [unfinished, setUnfinished] = useState<OpenThread[]>([])
  const [showAllUnfinished, setShowAllUnfinished] = useState(false)
  const [homewardSummary, setHomewardSummary] = useState<string | null>(null)
  const [ending, setEnding] = useState(false)
  const [page, updatePage] = useState<'chat' | 'notes' | 'map' | 'review' | 'unfinished' | 'stats' | 'library'>('chat')
  const libraryDraftBlocked = useRef(false)
  const setPage = (next: typeof page): void => {
    if (page === 'library' && next !== page && libraryDraftBlocked.current && !window.confirm('本机草稿保存失败。离开会丢失尚未保存的修改，仍要离开吗？')) return
    if (next !== 'library') setLibrarySelection(null)
    updatePage(next)
  }
  useEffect(() => {
    const listener = (event: Event) => { libraryDraftBlocked.current = !!(event as CustomEvent<boolean>).detail }
    window.addEventListener('zhitu:library-draft-error', listener)
    return () => window.removeEventListener('zhitu:library-draft-error', listener)
  }, [])
  const [focusMode, setFocusMode] = useState(false)
  const [chatMode, setChatMode] = useState<'guide' | 'free'>('guide')
  const [noteSelection, setNoteSelection] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [keyWarning, setKeyWarning] = useState(false)
  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>([])
  const [historyPage, setHistoryPage] = useState<HistoryPage | null>(null)
  const [historyOffset, setHistoryOffset] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyRevision, setHistoryRevision] = useState(0)
  const [librarySelection, setLibrarySelection] = useState<{ attachmentId: string; itemId: string } | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<{ session: SessionSummary; preview: DeletionPreview } | null>(null)
  const [historyBusy, setHistoryBusy] = useState('')
  const [trashSessions, setTrashSessions] = useState<SessionSummary[]>([])
  const [trashStats, setTrashStats] = useState<TrashStats | null>(null)
  const [retentionDays, setRetentionDays] = useState(30)
  const [showTrash, setShowTrash] = useState(false)
  const [historySelected, setHistorySelected] = useState<string[]>([])
  // 彻底删除要用户亲手打出"删除"两个字，避免把不可逆的动作点成顺手动作。
  const [purgeStage, setPurgeStage] = useState<'choose' | 'confirm'>('choose')
  const [purgeText, setPurgeText] = useState('')
  const [undoTrash, setUndoTrash] = useState<{ ids: string[]; label: string } | null>(null)
  const undoTrashTimer = useRef<number | null>(null)
  const [notice, setNotice] = useState('')
  const [showContext, setShowContext] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const historyGeneration = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepth = useRef(0)
  const streamGeneration = useRef(0)
  const partialReply = useRef('')
  const drafts = useRef(new Map<string, string>())

  useEffect(() => { drafts.current.set(sessionId ?? 'new', input) }, [input, sessionId])
  useEffect(() => () => { abortRef.current?.abort() }, [])
  // ── 载入最近一场 ──────────────────────────

  useEffect(() => {
    if (!bootstrap.latestSessionId) return
    let cancelled = false
    const generation = historyGeneration.current
    void getTurns(bootstrap.latestSessionId)
      .then((data) => {
        if (cancelled || generation !== historyGeneration.current) return
        setSessionTitle(data.session.title)
        setMessages(
          data.turns
            .filter((t) => t.role !== 'system')
            .map((t) => ({
              id: t.id,
              role: t.role === 'user' ? 'user' : 'assistant',
              content: t.content,
              attachmentIds: t.attachmentIds ?? []
            }))
        )
      })
      .catch(() => {
        if (!cancelled && generation === historyGeneration.current) setSessionId(null)
      })
      .finally(() => {
        if (!cancelled && generation === historyGeneration.current) setLoadingHistory(false)
      })
    return () => {
      cancelled = true
    }
  }, [bootstrap.latestSessionId])

  useEffect(() => {
    if (!sessionId) {
      setNoteCards([])
      setHomewardSummary(null)
      return
    }
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const data = await getSessionNotes(sessionId)
        if (active) setNoteCards(data.cards)
      } catch {
        // 后台笔记故障不能打断对话；下一次轮询会重试。
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    let active = true
    setHomewardSummary(null)
    void getHomeward(sessionId).then((data) => { if (active) setHomewardSummary(data.homeward?.summary ?? null) })
      .catch(() => undefined)
    return () => { active = false }
  }, [sessionId])

  const refreshUnfinished = (): void => {
    void getUnfinished().then((data) => setUnfinished(data.threads)).catch(() => undefined)
  }

  // ── 历史记录管理 ──────────────────────────

  const beginRename = (item: SessionSummary): void => {
    setRenamingId(item.id)
    setRenameDraft(item.title)
  }

  const commitRename = async (): Promise<void> => {
    const id = renamingId
    const title = renameDraft.trim()
    if (!id || !title || historyBusy) return
    setHistoryBusy(id)
    try {
      await renameSession(id, title)
      setRenamingId(null)
      if (id === sessionId) setSessionTitle(title)
      refreshSessions()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    } finally { setHistoryBusy('') }
  }

  const toggleArchived = async (item: SessionSummary, archived: boolean): Promise<void> => {
    if (historyBusy) return
    setHistoryBusy(item.id)
    try {
      await setSessionArchived(item.id, archived)
      if (!archived) { setShowArchived(false); setHistoryOffset(0) }
      // 归档的是当前这一场时，回到开始卡片，免得停在一个已经收起来的场次里。
      if (archived && item.id === sessionId) newSession()
      refreshSessions()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    } finally { setHistoryBusy('') }
  }

  /**
   * 删除前先看一眼会删掉什么。不能只弹一个"确定吗"——
   * 这个软件里知识点是跨场次共享的，用户有权知道哪几个点会被留下。
   */
  const askDelete = async (item: SessionSummary): Promise<void> => {
    if (historyBusy) return
    setHistoryBusy(item.id)
    try {
      const { preview } = await getDeletionPreview(item.id)
      setPurgeStage('choose'); setPurgeText('')
      setPendingDelete({ session: item, preview })
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    } finally { setHistoryBusy('') }
  }

  /** 撤销条：10 秒内点得到。过时它自己消失，东西仍在回收站里。 */
  const showUndo = (ids: string[], label: string): void => {
    if (undoTrashTimer.current) window.clearTimeout(undoTrashTimer.current)
    setUndoTrash({ ids, label })
    undoTrashTimer.current = window.setTimeout(() => setUndoTrash(null), 10_000)
  }

  const afterTrashed = (ids: string[]): void => {
    setHistorySelected([])
    // 删掉的正是当前这一场时，退回开始卡片，免得停在一场已经删掉的学习里。
    // 但列表要留着：撤销条在弹窗里，关掉弹窗就等于把"后悔"这条路也关了。
    if (sessionId && ids.includes(sessionId)) { newSession(); setShowHistory(true) }
  }

  /** 移入回收站：日常动作。不弹确认框——它可恢复，删完给撤销条就够了。 */
  const trashOne = async (item: SessionSummary): Promise<void> => {
    if (historyBusy) return
    setHistoryBusy(item.id)
    try {
      await trashSession(item.id)
      setNotice(`《${item.title}》已移入回收站，${retentionDays} 天内可以恢复。`)
      showUndo([item.id], `《${item.title}》`)
      afterTrashed([item.id])
      refreshSessions()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    } finally { setHistoryBusy('') }
  }

  /** 批量移入回收站：一次预演、一次操作、一条撤销，不弹 N 个确认框。 */
  const bulkTrash = async (): Promise<void> => {
    if (!historySelected.length || historyBusy) return
    const ids = historySelected
    setHistoryBusy('batch')
    try {
      const result = await batchSessions(ids, 'trash')
      const first = historyPage?.sessions.find((item) => item.id === result.ok[0]) ?? recentSessions.find((item) => item.id === result.ok[0])
      const label = result.ok.length === 1 ? `《${first?.title ?? '这一场'}》` : `${result.ok.length} 场学习`
      if (result.ok.length) {
        setNotice(`已把 ${label} 移入回收站，${retentionDays} 天内可以恢复。`)
        showUndo(result.ok, label)
      }
      if (result.failed.length) {
        setError({ message: `有 ${result.failed.length} 场没能删除：${result.failed[0].reason}`, advice: '刷新列表后再试一次。' })
      }
      afterTrashed(result.ok)
      refreshSessions()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    } finally { setHistoryBusy('') }
  }

  const undoLastTrash = async (): Promise<void> => {
    const undo = undoTrash
    if (!undo || historyBusy) return
    if (undoTrashTimer.current) window.clearTimeout(undoTrashTimer.current)
    setUndoTrash(null); setHistoryBusy('undo')
    try {
      const result = await batchSessions(undo.ids, 'restore')
      setNotice(result.failed.length ? `恢复了 ${result.ok.length} 场，还有 ${result.failed.length} 场没恢复。` : `已恢复 ${undo.label}。`)
      refreshSessions()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '回收站里还留着，可以在「回收站」里手动恢复。' })
    } finally { setHistoryBusy('') }
  }

  const restoreOne = async (item: SessionSummary): Promise<void> => {
    if (historyBusy) return
    setHistoryBusy(item.id)
    try {
      await restoreSession(item.id)
      setNotice(`《${item.title}》已恢复。`)
      refreshSessions()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    } finally { setHistoryBusy('') }
  }

  /** 彻底删除：唯一不可逆的路。预演看过、还要亲手打出"删除"两个字才放行。 */
  const confirmPurge = async (): Promise<void> => {
    const target = pendingDelete
    if (!target || historyBusy || purgeText.trim() !== '删除') return
    setHistoryBusy(target.session.id)
    try {
      await deleteSession(target.session.id)
      setNotice(`《${target.session.title}》已彻底删除。`)
      setPendingDelete(null); setPurgeStage('choose'); setPurgeText('')
      if (target.session.id === sessionId) newSession()
      else refreshNotes()
      refreshSessions()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '还没有删掉，可以再试一次。' })
    } finally { setHistoryBusy('') }
  }

  const emptyTrashAll = async (): Promise<void> => {
    if (historyBusy) return
    if (!window.confirm(`彻底删除回收站里的 ${trashSessions.length} 场学习？这一步不能撤销，原件也会从磁盘上删掉。`)) return
    setHistoryBusy('empty-trash')
    try {
      const result = await emptyTrash()
      setNotice(result.failed.length ? `已删除 ${result.removed} 场，${result.failed.length} 场没能删除。` : `回收站已清空（${result.removed} 场）。`)
      refreshSessions()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    } finally { setHistoryBusy('') }
  }

  const toggleHistorySelect = (id: string): void => {
    setHistorySelected((old) => old.includes(id) ? old.filter((item) => item !== id) : [...old, id])
  }

  /** 预演看完了，选「移入回收站」——这是默认动作，可恢复，所以直接做。 */
  const confirmTrash = async (): Promise<void> => {
    const target = pendingDelete
    if (!target || historyBusy) return
    setPendingDelete(null); setPurgeStage('choose'); setPurgeText('')
    await trashOne(target.session)
  }

  useEffect(() => {
    refreshUnfinished()
    const timer = window.setInterval(refreshUnfinished, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const refreshSessions = useCallback((): void => {
    void getSessions().then((data) => {
      setRecentSessions(data.sessions.filter((item) => !item.archived_at))
      setHistoryRevision((old) => old + 1)
      setTrashSessions(data.trash ?? [])
      setTrashStats(data.trashStats ?? null)
      if (data.retentionDays) setRetentionDays(data.retentionDays)
    }).catch(() => undefined)
  }, [])

  useEffect(() => { setHistoryOffset(0); setHistorySelected([]); setRenamingId(null) }, [historyQuery, showArchived])
  useEffect(() => {
    if (!showHistory || showTrash) return
    let alive = true
    setHistoryLoading(true)
    const timer = window.setTimeout(() => {
      void getHistoryPage(historyQuery, showArchived, historyOffset).then((data) => {
        if (!alive) return
        if (historyOffset && historyOffset >= data.total) { setHistoryOffset(Math.max(0, Math.ceil(data.total / 25) - 1) * 25); return }
        setHistoryPage(data); setHistoryError('')
      }, (cause) => { if (alive) setHistoryError(cause instanceof Error ? cause.message : '记录加载失败') })
        .finally(() => { if (alive) setHistoryLoading(false) })
    }, 160)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [showHistory, showTrash, showArchived, historyQuery, historyOffset, historyRevision])

  useEffect(() => {
    refreshSessions()
    const timer = window.setInterval(refreshSessions, 5000)
    return () => window.clearInterval(timer)
  }, [refreshSessions, sessionId])

  useEffect(() => {
    if (!sessionId) { setAttachments([]); return }
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const data = await getSessionAttachments(sessionId)
        if (active) setAttachments(data.attachments)
      } catch { /* 对话仍可使用，下一次刷新再试。 */ }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [sessionId])

  useEffect(() => {
    if (!preview?.url) return
    return () => URL.revokeObjectURL(preview.url!)
  }, [preview?.url])

  useEffect(() => {
    if (!busy || streaming) { setWaitPhase(0); return }
    const first = window.setTimeout(() => setWaitPhase(1), 300)
    const second = window.setTimeout(() => setWaitPhase(2), 3000)
    return () => { window.clearTimeout(first); window.clearTimeout(second) }
  }, [busy, streaming])

  const refreshNotes = (): void => {
    if (!sessionId) return
    void getSessionNotes(sessionId).then((data) => setNoteCards(data.cards)).catch(() => undefined)
  }

  const showOriginalTurn = async (turnId: string): Promise<void> => {
    if (!sessionId || busy || uploading) return
    const generation = ++historyGeneration.current
    try {
      const data = await getTurns(sessionId)
      if (generation !== historyGeneration.current) return
      setMessages(data.turns.filter((turn) => turn.role !== 'system').map((turn) => ({
        id: turn.id,
        role: turn.role === 'user' ? 'user' : 'assistant',
        content: turn.content,
        attachmentIds: turn.attachmentIds ?? []
      })))
      window.setTimeout(() => {
        document.querySelector(`[data-turn-id="${turnId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 80)
    } catch {
      setError({ message: '没能找到这段原文', advice: '稍后再试一次。' })
    }
  }

  const showNoteSource = async (turnId: string, targetSessionId: string | null): Promise<void> => {
    if (!targetSessionId) return
    setPage('chat')
    if (targetSessionId === sessionId) { void showOriginalTurn(turnId); return }
    try {
      if (!await openSession(targetSessionId)) return
      window.setTimeout(() => document.querySelector(`[data-turn-id="${turnId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120)
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    }
  }

  const askFromNote = async (question: string, targetSessionId: string | null): Promise<void> => {
    if (busy || uploading || ending) { setNotice('请先停止当前回复或等待操作完成，再继续这个问题。'); return }
    if (targetSessionId && targetSessionId !== sessionId) {
      try {
        if (!await openSession(targetSessionId)) return
      } catch (err) {
        setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
        return
      }
    }
    setPage('chat')
    setInput(question)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  // ── 自动滚动：只有用户本来就在底部时才跟着走 ──

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  const openDocument = async (attachmentId: string, page: number | null): Promise<void> => {
    try {
      const attachment = attachments.find((item) => item.id === attachmentId)
        ?? (await getAttachment(attachmentId)).attachment
      const ext = attachment.original_name.split('.').pop()?.toLowerCase()
      const isOriginalPreview = ext === 'pdf' || ['png', 'jpg', 'jpeg', 'webp'].includes(ext ?? '')
      const [file, chunks] = await Promise.all([
        isOriginalPreview ? getAttachmentFile(attachmentId) : Promise.resolve(null),
        getAttachmentChunks(attachmentId)
      ])
      setPreview({ attachment, page, url: file ? URL.createObjectURL(file) : null,
        text: chunks.chunks.map((chunk) => chunk.text).join('\n\n') })
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    }
  }

  const importFiles = async (files: File[]): Promise<void> => {
    if (!files.length || uploading) return
    if (busy || ending || loadingHistory) { setNotice('请等待当前操作完成后再导入资料。'); return }
    setPage('chat')
    setUploading(true)
    setError(null)
    let targetSession = sessionId ?? undefined
    try {
      for (const file of files) {
        const result = await uploadAttachment(file, targetSession)
        targetSession = result.sessionId
        setSessionId(result.sessionId)
        setSessionTitle((current) => current === '新的一场'
          ? file.name.replace(/\.[^.]+$/, '').slice(0, 30) : current)
        setManualStart(true)
        setAttachments((current) => current.some((item) => item.id === result.attachment.id)
          ? current : [...current, result.attachment])
        setSelectedIds((current) => current.includes(result.attachment.id)
          ? current : [...current, result.attachment.id])
        if (files.length === 1 && !sessionId && result.attachment.kind === 'image' && !settings.visionEnabled) {
          setInput('这张图片里有什么？')
          setError({ message: '图片已保存', advice: '要向图片提问，请先在设置里开启视觉识别。' })
        }
        if (files.length === 1 && !sessionId &&
          (result.attachment.kind !== 'image' || settings.visionEnabled)) {
          let ready = result.attachment
          for (let attempt = 0; attempt < 60 && ready.extract_status === 'pending'; attempt++) {
            await new Promise((resolve) => window.setTimeout(resolve, 500))
            ready = (await getAttachment(ready.id)).attachment
          }
          setAttachments((current) => current.map((item) => item.id === ready.id ? ready : item))
          if (ready.extract_status === 'ok' || ready.extract_status === 'partial') {
            void send(ready.kind === 'image' ? '这张图片里有什么？' : '这份资料讲了什么？',
              undefined, [ready.id], result.sessionId)
          } else if (ready.extract_status === 'failed') {
            setError({ message: ready.extract_error || '这份资料解析失败', advice: '原件还在，可移除后换一份文件。' })
          }
        }
      }
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '请检查文件格式和大小。' })
    } finally { setUploading(false) }
  }

  // ── 发送 ─────────────────────────────────

  const send = async (
    rawContent = input,
    topic?: { domain: string; goalKind: GoalKind },
    attachmentOverride?: string[],
    sessionOverride?: string
  ): Promise<void> => {
    const content = rawContent.trim()
    if (!content || busy || abortRef.current || loadingHistory || ending) return
    const usedAttachments = attachmentOverride ?? selectedIds
    const pending = attachments.find((item) => usedAttachments.includes(item.id) && item.extract_status === 'pending')
    if (pending && !attachmentOverride) {
      setError({ message: `${pending.original_name} 还在解析`, advice: '等资料卡片显示就绪后再提问。' })
      return
    }

    setError(null)
    setInput('')
    setBusy(true)
    setHomewardSummary(null)
    stickToBottom.current = true

    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', content,
      attachmentIds: usedAttachments }])
    if (topic) setSessionTitle(topic.domain)
    setStreaming('')

    const controller = new AbortController()
    abortRef.current = controller
    const generation = ++streamGeneration.current
    partialReply.current = ''

    let accumulated = ''

    const finish = (): void => {
      if (generation !== streamGeneration.current) return
      setBusy(false)
      abortRef.current = null
      setStreaming('')
      partialReply.current = ''
      if (accumulated.trim()) {
        setMessages((prev) => [
          ...prev,
          { id: `local-a-${Date.now()}`, role: 'assistant', content: accumulated, attachmentIds: [] }
        ])
      }
      // 第一句话说过之后，标题会由后台自动改成那句话
      if (sessionTitle === '新的一场' && !topic) setSessionTitle(content.slice(0, 30))
    }

    await streamChat(
      { sessionId: sessionOverride ?? sessionId ?? undefined, content, attachmentIds: usedAttachments,
        mode: chatMode, ...topic },
      {
        onSession: (id) => { if (generation === streamGeneration.current) setSessionId(id) },
        onDelta: (text) => {
          if (generation !== streamGeneration.current) return
          accumulated += text
          partialReply.current = accumulated
          setStreaming(accumulated)
        },
        onDone: finish,
        onError: (message, advice, status) => {
          if (generation !== streamGeneration.current) return
          setError({ message, advice })
          if (status === 401) setKeyWarning(true)
          setBusy(false)
          abortRef.current = null
          setStreaming('')
          if (accumulated.trim()) setMessages((prev) => [...prev, {
            id: `partial-${Date.now()}`, role: 'assistant', content: accumulated, attachmentIds: [], interrupted: true
          }])
          partialReply.current = ''
          setInput(content)
        }
      },
      controller.signal
    )
  }

  const stop = (): void => {
    streamGeneration.current++
    abortRef.current?.abort()
    setBusy(false)
    abortRef.current = null
    setStreaming('')
    if (partialReply.current.trim()) {
      const content = partialReply.current
      setMessages((prev) => [...prev, { id: `partial-${Date.now()}`, role: 'assistant', content,
        attachmentIds: [], interrupted: true }])
    }
    partialReply.current = ''
    setNotice('已停止生成。未完成的回复仅保留在当前页面。')
  }

  const newSession = (): void => {
    if (uploading || ending) { setNotice('请等待资料导入或本场整理完成。'); return }
    if (busy) stop()
    historyGeneration.current++
    setLoadingHistory(false)
    setSessionId(null)
    setSessionTitle('新的一场')
    setMessages([])
    setStreaming('')
    setError(null)
    setManualStart(false)
    setNoteCards([])
    setAttachments([])
    setSelectedIds([])
    setPreview(null)
    setHomewardSummary(null)
    setPage('chat')
    setInput('')
    setNotice('')
    setShowHistory(false)
  }

  const openSession = async (id: string): Promise<boolean> => {
    if (uploading || ending) { setNotice('请等待资料导入或本场整理完成。'); return false }
    if (busy) stop()
    const generation = ++historyGeneration.current
    setLoadingHistory(true)
    try {
      const data = await getTurns(id)
      if (generation !== historyGeneration.current) return false
      if (id !== sessionId) { setSelectedIds([]); setAttachments([]); setNoteCards([]) }
      setInput(drafts.current.get(id) ?? '')
      setError(null); setNotice(''); setPreview(null); setHomewardSummary(null)
      setSessionId(id)
      setSessionTitle(data.session.title)
      setMessages(data.turns.filter((turn) => turn.role !== 'system').map((turn) => ({
        id: turn.id, role: turn.role === 'user' ? 'user' : 'assistant', content: turn.content,
        attachmentIds: turn.attachmentIds ?? []
      })))
      setManualStart(true); setLoadingHistory(false); setPage('chat')
      setShowHistory(false)
      stickToBottom.current = true
      return true
    } catch (error) {
      if (generation === historyGeneration.current) setError({ message: error instanceof Error ? error.message : '没能打开这场学习', advice: '稍后再试一次。' })
      return false
    } finally { if (generation === historyGeneration.current) setLoadingHistory(false) }
  }

  const openSearchHit = (hit: SearchHit): void => {
    if (hit.kind === 'library' && hit.attachmentId && hit.libraryItemId) {
      setShowSearch(false); setLibrarySelection({ attachmentId: hit.attachmentId, itemId: hit.libraryItemId }); setPage('library'); return
    }
    setShowSearch(false)
    if (hit.nodeId) { setNoteSelection(hit.nodeId); setPage('notes') }
    else if (hit.kind === 'turn' && hit.sessionId) void showNoteSource(hit.id, hit.sessionId)
    else if (hit.attachmentId) void openDocument(hit.attachmentId, hit.page)
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setShowSearch(false); setShowExport(false); setShowSettings(false)
        setShowAllUnfinished(false); setShowShortcuts(false); setPreview(null)
        setShowHistory(false)
        setShowContext(false)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setShowSearch(true)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault(); newSession()
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '/') {
        event.preventDefault(); setShowShortcuts(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const openMapNote = (nodeId: string): void => {
    setNoteSelection(nodeId)
    setPage('notes')
  }

  const finishSession = async (): Promise<void> => {
    if (!sessionId || busy || ending) return
    setEnding(true)
    setError(null)
    try {
      const result = await endSession(sessionId)
      setHomewardSummary(result.summary)
      refreshNotes()
      refreshUnfinished()
      stickToBottom.current = true
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '可稍后再点一次“今天到这儿”。' })
    } finally { setEnding(false) }
  }

  const continueThread = async (thread: OpenThread): Promise<void> => {
    if (busy || uploading || ending) { setNotice('请先停止当前回复或等待操作完成。'); return }
    if (thread.sessionId && thread.sessionId !== sessionId) {
      try {
        if (!await openSession(thread.sessionId)) return
      } catch (err) {
        setError({ message: err instanceof Error ? err.message : '没能打开原来的学习', advice: '稍后再试一次。' })
        return
      }
    }
    setInput(thread.nextStep || thread.title)
    setShowAllUnfinished(false)
    setPage('chat')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const dismissThread = async (thread: OpenThread, reason: 'mastered' | 'uninterested'): Promise<void> => {
    try {
      await closeUnfinished(thread.id, reason)
      refreshUnfinished()
      refreshNotes()
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), advice: '稍后再试一次。' })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const providerLabel =
    bootstrap.providers.find((p) => p.id === settings.providerId)?.label ?? settings.providerId
  const showStartCard = !loadingHistory && !manualStart && !sessionId && messages.length === 0 && !busy

  return (
    <div className={`shell ${page !== 'chat' ? 'notes-layout' : ''} ${page === 'chat' && focusMode ? 'focus-mode' : ''} ${showContext ? 'context-open' : ''}`}>
      {/* ── 左栏 ── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-name small">织图</span>
          <span className="brand-caption">个人学习工作台</span>
        </div>

        <button className="btn primary block" onClick={newSession}>
          ＋ 新的一场
        </button>

        <nav className="main-nav" aria-label="主页面">
          <button className={page === 'chat' ? 'active' : ''} onClick={() => setPage('chat')}>对话</button>
          <button className={page === 'notes' ? 'active' : ''} onClick={() => { setNoteSelection(null); setPage('notes') }}>笔记</button>
          <button className={page === 'map' ? 'active' : ''} onClick={() => setPage('map')}>地图</button>
          <button className={page === 'library' ? 'active' : ''} onClick={() => setPage('library')}>资料库</button>
          <button className={page === 'unfinished' ? 'active' : ''} onClick={() => setPage('unfinished')}>未收线（{unfinished.length}）</button>
          <button className={page === 'stats' ? 'active' : ''} onClick={() => setPage('stats')}>本周回顾</button>
          <button className={page === 'review' ? 'active' : ''} onClick={() => setPage('review')}>复习</button>
          {/* 删除学习记录的唯一入口。放在主菜单里，不再塞在「最近的学习」列表尾巴上——
              2026-10-01 用户反馈"没看见删除功能"，就是因为原来那行入口会被 5 条记录挤出可视区。 */}
          <button className={showHistory ? 'active' : ''} onClick={() => {
            setShowTrash(false); setHistorySelected([]); setShowHistory(true)
          }}>学习记录{trashSessions.length ? `（回收站 ${trashSessions.length}）` : ''}</button>
        </nav>

        <button className="btn ghost block" onClick={() => setShowSearch(true)}>搜索　Ctrl+K</button>

        <div className="sidebar-section grow">
          <div className="sidebar-label">最近的学习</div>
          {recentSessions.length ? recentSessions.slice(0, 5).map((item) => <button key={item.id}
            className={`recent-session ${item.id === sessionId ? 'active' : ''}`}
            title={item.title} onClick={() => void openSession(item.id)}>
            <span>{new Date(item.started_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</span>
            <strong>{item.title}</strong>
          </button>) : <p className="sidebar-note">还没有历史记录。开始第一场后，这里会帮你找回来。</p>}
          {recentSessions.length > 0 && <button className="history-more" onClick={() => {
            setShowTrash(false); setHistorySelected([]); setShowHistory(true)
          }}>学习记录 · 改名 / 归档 / 删除 →</button>}
        </div>

        <div className="sidebar-footer">
        <button className="btn ghost block" onClick={() => setShowSettings(true)}>
          设置
        </button>
        <button className="btn ghost block" onClick={() => setShowExport(true)}>导出</button>
        <button className="btn ghost block" onClick={() => setShowShortcuts(true)}>快捷键</button>
        </div>
      </aside>

      {/* ── 中栏 ── */}
      <main className="main"
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault(); dragDepth.current++; setDragging(true)
        }}
        onDragLeave={(event) => {
          event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (!dragDepth.current) setDragging(false)
        }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
        onDrop={(event) => {
          event.preventDefault(); dragDepth.current = 0; setDragging(false)
          void importFiles(Array.from(event.dataTransfer.files))
        }}
      >
        {keyWarning && <div className="key-warning" role="alert">
          <span>API 密钥可能已失效，去设置检查。</span>
          <button onClick={() => setShowSettings(true)}>打开设置</button>
          <button aria-label="关闭密钥提醒" onClick={() => setKeyWarning(false)}>关闭</button>
        </div>}
        {notice && <div className="inline-notice" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
        {error && <div className="banner error" role="alert"><div><strong>{error.message}</strong>
          {error.advice && <div className="banner-advice">{error.advice}</div>}</div>
          <button className="btn small" onClick={() => setShowSettings(true)}>去设置</button>
          <button className="btn small" onClick={() => setError(null)} aria-label="关闭错误提示">×</button></div>}
        {page === 'library' ? <LibraryPage settings={settings} selection={librarySelection} onSettings={() => setShowSettings(true)}
          onDiscuss={(id, title, attachmentId) => { void openSession(id).then((opened) => {
            if (!opened) return
            setSelectedIds([attachmentId]); setInput(`请结合《${title}》解答我的问题：`); setPage('chat')
          }) }} />
          : page === 'notes' ? <NotesPage key={noteSelection ?? 'all'} initialSelected={noteSelection}
          onSource={(turnId, originSessionId) => void showNoteSource(turnId, originSessionId)}
          onDocument={(attachmentId, docPage) => void openDocument(attachmentId, docPage)}
          onAsk={(question, originSessionId) => void askFromNote(question, originSessionId)}
        /> : page === 'map' ? <MapPage onOpenNote={openMapNote}
          onContinue={(question, originSessionId) => void askFromNote(question, originSessionId)} />
          : page === 'review' ? <ReviewPage onNotes={() => setPage('notes')} />
            : page === 'stats' ? <StatsPage onContinue={(thread) => void continueThread(thread)} />
            : page === 'unfinished' ? <UnfinishedPage threads={unfinished}
              onContinue={(thread) => void continueThread(thread)}
              onClose={(thread, reason) => void dismissThread(thread, reason)} /> : <>
        {dragging && <div className="drop-overlay">松手就加进来</div>}
        <input ref={fileInputRef} type="file" multiple hidden
          onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        <header className="main-head">
          <div>
            <div className="main-title">{sessionTitle}</div>
            <div className="main-sub">
              {providerLabel} · {settings.model}
            </div>
          </div>
          <div className="main-head-actions"><button className="context-toggle focus-toggle" onClick={() => setShowContext(!showContext)} aria-pressed={showContext}>本场笔记</button><button className="focus-toggle" onClick={() => setFocusMode(!focusMode)}
            aria-pressed={focusMode}>{focusMode ? '退出专注' : '专注阅读'}</button><div className="mode-switch">
            <button className={`mode ${chatMode === 'guide' ? 'active' : ''}`}
              onClick={() => setChatMode('guide')}>引导</button>
            <button className={`mode ${chatMode === 'free' ? 'active' : ''}`}
              onClick={() => setChatMode('free')}>
              自由
            </button>
            <button className="mode" onClick={() => setPage('review')}>
              复习
            </button>
          </div></div>
        </header>

        <div className="scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="messages">
            {loadingHistory && <div className="thinking">正在找回上次的对话…</div>}
            {showStartCard && (
              <StartCard
                onQuestion={(question, topic) => void send(question, topic)}
                onImportClick={() => fileInputRef.current?.click()}
                onOwnQuestion={() => {
                  setManualStart(true)
                  requestAnimationFrame(() => textareaRef.current?.focus())
                }}
              />
            )}

            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`} data-turn-id={m.id}>
                <div className="msg-role">{m.role === 'user' ? '我' : 'AI'}</div>
                <div className="msg-body">
                  {m.role === 'user' && m.attachmentIds.length > 0 && <div className="message-attachments">
                    {m.attachmentIds.map((id) => {
                      const item = attachments.find((attachment) => attachment.id === id)
                      return item && <button key={id} className="message-attachment"
                        onClick={() => void openDocument(id, null)}>
                        ▤ {item.original_name} · {item.page_count ? `${item.page_count} 页` : `${Math.ceil(item.bytes / 1024)} KB`}
                      </button>
                    })}
                  </div>}
                  {m.role === 'user' ? <div className="plain">{m.content}</div> : <Markdown text={m.content} />}
                  {m.interrupted && <small className="interrupted-label">回复未完成 · 仅保留在当前页面</small>}
                </div>
              </div>
            ))}

            {homewardSummary && <div className="homeward-summary" data-testid="homeward-summary">
              <div className="homeward-summary-title">本场小结</div>
              <div>{homewardSummary}</div>
            </div>}

            {streaming && (
              <div className="msg assistant">
                <div className="msg-role">AI</div>
                <div className="msg-body">
                  <Markdown text={streaming} />
                  <span className="caret" />
                </div>
              </div>
            )}

            {busy && !streaming && waitPhase > 0 && (
              <div className="msg assistant">
                <div className="msg-role">AI</div>
                <div className="msg-body">
                  {waitPhase === 1 ? <span className="caret" aria-label="正在思考" />
                    : <span className="thinking">正在想…</span>}
                </div>
              </div>
            )}
          </div>
        </div>

        {!loadingHistory && !showStartCard && <div className="composer">
          {attachments.length > 0 && <div className="attachment-chips">
            {attachments.map((item) => <div key={item.id} className={`attachment-chip ${selectedIds.includes(item.id) ? 'selected' : ''}`}>
              <button onClick={() => void openDocument(item.id, null)} title="查看资料">▤ {item.original_name}</button>
              <span>{item.extract_status === 'pending' ? '正在解析…' : item.extract_status === 'failed' ? '解析失败'
                : item.extract_status === 'partial' ? '部分提取' : '就绪'}</span>
              <button title={selectedIds.includes(item.id) ? '从本次提问移除' : '本次提问使用'}
                onClick={() => setSelectedIds((current) => current.includes(item.id)
                  ? current.filter((id) => id !== item.id) : [...current, item.id])}>
                {selectedIds.includes(item.id) ? '×' : '＋'}
              </button>
              {!item.resource_node_id && <button title="删除未引用的原件" onClick={() => {
                void deleteAttachment(item.id).then(() => {
                  setAttachments((current) => current.filter((entry) => entry.id !== item.id))
                  setSelectedIds((current) => current.filter((id) => id !== item.id))
                }).catch((err: unknown) => setError({ message: err instanceof Error ? err.message : String(err), advice: '' }))
              }}>删</button>}
            </div>)}
          </div>}
          <textarea
            ref={textareaRef}
            className="textarea"
            aria-label="输入问题"
            rows={3}
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
              if (files.length) { event.preventDefault(); void importFiles(files) }
            }}
            disabled={busy}
            autoFocus
          />
          <div className="composer-actions">
            <button className="btn" title="添加资料" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? '导入中…' : '＋ 添加资料'}
            </button>
            {sessionId && <button className="btn" onClick={() => void finishSession()} disabled={busy || ending}>
              {ending ? '正在整理…' : '今天到这儿'}
            </button>}
            {busy ? (
              <button className="btn" onClick={stop}>
                停止
              </button>
            ) : (
              <button className="btn primary" onClick={() => void send()} disabled={!input.trim()}>
                发送
              </button>
            )}
          </div>
        </div>}
        </>}
      </main>

      {/* ── 右栏 ── */}
      {page === 'chat' && <aside className="rightbar">
        <div className="rightbar-heading"><strong>学习手记</strong><span>{noteCards.length} 个知识点</span>
          <button className="context-toggle btn ghost small" aria-label="收起本场笔记" onClick={() => setShowContext(false)}>×</button></div>
        <div className="sidebar-section">
          <div className="sidebar-label">本场记下的点</div>
          {noteCards.length ? noteCards.map((card) => (
            <NoteCard key={card.id} card={card} onChanged={refreshNotes}
              onSource={(turnId) => void showOriginalTurn(turnId)}
              onDocument={(attachmentId, page) => void openDocument(attachmentId, page)}
              onAsk={(question) => void send(question)} />
          )) : <div className="placeholder">
            <div className="placeholder-icon">◌</div>
            <p className="sidebar-note">这一场还没有可复习的笔记。聊清一个知识点后，它会出现在这里。</p>
          </div>}
        </div>

        <div className="divider" />

        <div className="sidebar-section">
          <div className="sidebar-label">未收线（{unfinished.length}）</div>
          {unfinished.length ? unfinished.slice(0, 5).map((thread) => <div className="unfinished-card" key={thread.id}>
            <strong>{thread.title}</strong>
            {thread.stoppedAt && <p>停在：{thread.stoppedAt}</p>}
            {thread.nextStep && <p>下次：{thread.nextStep}</p>}
            <div className="unfinished-actions">
              <button onClick={() => void continueThread(thread)}>继续</button>
              <button onClick={() => void dismissThread(thread, 'mastered')}>我懂了</button>
              <button onClick={() => void dismissThread(thread, 'uninterested')}>不感兴趣</button>
            </div>
          </div>) : <div className="placeholder"><p className="sidebar-note">还没有未收线的问题。继续探索，没走完的线会留在这里。</p></div>}
          {unfinished.length > 5 && <button className="btn small" onClick={() => setShowAllUnfinished(true)}>全部（{unfinished.length}）</button>}
        </div>
      </aside>}

      {showHistory && <div className="modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setShowHistory(false)
      }}><div className="modal history-modal" role="dialog" aria-label="学习记录">
        <div className="modal-head"><h2>学习记录</h2><button className="btn" onClick={() => setShowHistory(false)}>关闭</button></div>
        <div className="history-tabs">
          <button className={`btn small ${showTrash ? '' : 'primary'}`} aria-pressed={!showTrash}
            onClick={() => setShowTrash(false)}>学习记录（{historyPage ? historyPage.counts.active + historyPage.counts.archived : recentSessions.length}）</button>
          <button className={`btn small ${showTrash ? 'primary' : ''}`} aria-pressed={showTrash}
            onClick={() => setShowTrash(true)}>回收站（{trashSessions.length}）</button>
        </div>
        {undoTrash && <div className="history-undo" role="status">
          <span>已把 {undoTrash.label} 移入回收站，{retentionDays} 天内可以恢复。</span>
          <button className="btn small" disabled={!!historyBusy} onClick={() => void undoLastTrash()}>撤销</button>
        </div>}
        {showTrash ? <div className="history-trash">
          <p className="history-trash-head">{trashStats?.sessions
            ? `回收站里 ${trashStats.sessions} 场 · ${trashStats.turns} 条对话 · 占用 ${formatBytes(trashStats.bytes)}`
              + ` · 最早一场还有 ${daysUntil(trashStats.nextPurgeAt)} 天自动清理`
            : `回收站是空的。删除的场次会在这里放 ${retentionDays} 天，期间随时能恢复。`}</p>
          {!!trashSessions.length && <div className="history-actions">
            <button className="btn small danger" disabled={!!historyBusy} onClick={() => void emptyTrashAll()}>清空回收站</button>
          </div>}
          {trashSessions.map((item) => <div key={item.id} className="history-row trash">
            <div className="history-open as-row">
              <strong>{item.title}</strong>
              <span>删除于 {item.deleted_at ? new Date(item.deleted_at).toLocaleString('zh-CN') : ''}</span>
            </div>
            <span className="history-actions">
              <button className="btn small" disabled={!!historyBusy}
                onClick={() => void restoreOne(item)}>恢复</button>
              <button className="btn small danger" disabled={!!historyBusy}
                onClick={() => void askDelete(item)}>彻底删除</button>
            </span>
          </div>)}
        </div> : <>
        <input className="search-input" aria-label="筛选学习记录" placeholder="按标题查找全部学习记录"
          value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} />
        <p className="history-hint">每行右侧可以改名、归档或删除；勾选多行后用批量条一次处理。删掉的会先进回收站。</p>
        {!!historySelected.length && <div className="history-batch" role="status">
          <span>已选 {historySelected.length} 场</span>
          <button className="btn small" disabled={!!historyBusy} onClick={() => void bulkTrash()}>移入回收站</button>
          <button className="btn small" onClick={() => setHistorySelected([])}>取消选择</button>
        </div>}
        <div className="history-tabs">
          <button className={`btn small ${showArchived ? '' : 'primary'}`} aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>进行中与已收线（{historyPage?.counts.active ?? 0}）</button>
          <button className={`btn small ${showArchived ? 'primary' : ''}`} aria-pressed={showArchived} onClick={() => setShowArchived(true)}>已归档（{historyPage?.counts.archived ?? 0}）</button>
        </div>
        <HistoryRecords page={historyPage} loading={historyLoading} error={historyError} offset={historyOffset} onOffset={setHistoryOffset}
          current={sessionId} busy={historyBusy} selected={historySelected} renaming={renamingId} draft={renameDraft}
          onDraft={setRenameDraft} onRename={beginRename} onSave={() => void commitRename()} onCancel={() => setRenamingId(null)}
          onPick={toggleHistorySelect} onOpen={(id) => void openSession(id)} onArchive={(item, value) => void toggleArchived(item, value)} onDelete={(item) => void askDelete(item)} />
        </>}
      </div></div>}

      {pendingDelete && <div className="modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPendingDelete(null)
      }}><div className="modal delete-modal" role="dialog" aria-label="确认删除">
        <div className="modal-head"><h2>删除「{pendingDelete.session.title}」</h2></div>
        <div className="delete-body">
          <p className="delete-warning">移入回收站后可以恢复；彻底删除不能撤销。删除后原始对话会消失，导出和搜索里也找不回来。</p>
          <div className="delete-grid">
            <div><span className="field-label">会删掉</span>
              <ul className="delete-list">
                <li>{pendingDelete.preview.turns} 条对话</li>
                <li>{pendingDelete.preview.leaves} 个知识点</li>
                <li>{pendingDelete.preview.notes} 条笔记</li>
                {pendingDelete.preview.attachments > 0 && <li>{pendingDelete.preview.attachments} 份导入的资料原件</li>}
              </ul>
            </div>
            <div><span className="field-label">会留下</span>
              <ul className="delete-list">
                <li>{pendingDelete.preview.keeps} 个知识点（别的场次还在用，只断开与这一场的连线）</li>
              </ul>
            </div>
          </div>
          {pendingDelete.preview.nodes.length > 0 && <div className="delete-nodes">
            <span className="field-label">即将删掉的知识点</span>
            <p>{pendingDelete.preview.nodes.join('、')}</p>
          </div>}
          {pendingDelete.preview.keeps > 0 && <p className="delete-note">
            这些点会留在主题地图上，但这一场与它们的连接会被切断。
          </p>}
          {pendingDelete.session.id === sessionId && !!input.trim() && <p className="delete-note">
            这一场还有没发出去的草稿，删除后会一起消失。
          </p>}
          {purgeStage === 'confirm' && <div className="delete-purge">
            <p className="delete-warning">彻底删除后无法恢复：对话、笔记、原件都会从这台电脑上抹掉，搜索、复习和导出里也不会再出现。
              已经发给 AI 服务商的内容无法收回；之前导出过的备份文件里仍然留着。</p>
            <label className="field"><span className="field-label">输入「删除」两个字确认</span>
              <input className="input" aria-label="彻底删除确认" value={purgeText} autoFocus
                onChange={(event) => setPurgeText(event.target.value)} /></label>
          </div>}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => { setPendingDelete(null); setPurgeStage('choose'); setPurgeText('') }}
            disabled={!!historyBusy}>取消</button>
          {purgeStage === 'choose' ? <>
            <button className="btn small danger" disabled={!!historyBusy}
              onClick={() => setPurgeStage('confirm')}>彻底删除…</button>
            <button className="btn primary" disabled={!!historyBusy}
              onClick={() => void confirmTrash()}>{historyBusy ? '正在处理…' : '移入回收站'}</button>
          </> : <>
            <button className="btn small" disabled={!!historyBusy}
              onClick={() => { setPurgeStage('choose'); setPurgeText('') }}>返回</button>
            <button className="btn danger" disabled={!!historyBusy || purgeText.trim() !== '删除'}
              onClick={() => void confirmPurge()}>{historyBusy ? '正在删除…' : '彻底删除'}</button>
          </>}
        </div>
      </div></div>}

      {showSettings && (
        <SettingsDialog
          bootstrap={{ ...bootstrap, settings }}
          onClose={() => setShowSettings(false)}
          onSaved={(next) => onSettingsChanged(next)}
          sessionId={sessionId}
          onNotesRecalculated={refreshNotes}
          onConnectionRestored={() => setKeyWarning(false)}
        />
      )}
      {showExport && <ExportDialog sessionId={sessionId} onClose={() => setShowExport(false)} />}
      {showSearch && <SearchDialog onClose={() => setShowSearch(false)} onOpen={openSearchHit}
        onCommand={(command) => {
          setShowSearch(false)
          if (command === 'new') newSession()
          if (command === 'settings') setShowSettings(true)
          if (command === 'export') setShowExport(true)
        }} />}
      {showShortcuts && <div className="modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setShowShortcuts(false)
      }}><div className="modal shortcuts-modal" role="dialog" aria-label="快捷键">
        <div className="modal-head"><h2>快捷键</h2><button className="btn" onClick={() => setShowShortcuts(false)}>关闭</button></div>
        <div className="shortcuts-body">
          <p><kbd>Ctrl+N</kbd> 新的一场</p><p><kbd>Ctrl+K</kbd> 搜索</p>
          <p><kbd>Ctrl+/</kbd> 快捷键列表</p><p><kbd>Esc</kbd> 关闭弹窗</p>
          <p><kbd>Enter</kbd> 发送</p><p><kbd>Shift+Enter</kbd> 换行</p>
          <p><kbd>Ctrl+Enter</kbd> 强制发送</p>
        </div>
      </div></div>}
      {showAllUnfinished && <div className="modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setShowAllUnfinished(false)
      }}><div className="modal unfinished-modal">
        <div className="modal-head"><h2>全部未收线</h2><button className="btn" onClick={() => setShowAllUnfinished(false)}>关闭</button></div>
        {unfinished.map((thread) => <div className="unfinished-card" key={thread.id}>
          <strong>{thread.title}</strong><p>{thread.nextStep || thread.stoppedAt || '接着聊这个问题'}</p>
          <div className="unfinished-actions">
            <button onClick={() => void continueThread(thread)}>继续</button>
            <button onClick={() => void dismissThread(thread, 'mastered')}>我懂了</button>
            <button onClick={() => void dismissThread(thread, 'uninterested')}>不感兴趣</button>
          </div>
        </div>)}
      </div></div>}
      {preview && <div className="modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPreview(null)
      }}>
        <div className="modal document-preview">
          <div className="modal-head"><h2>{preview.attachment.original_name}{preview.page ? ` · 第 ${preview.page} 页` : ''}</h2>
            <button className="btn" onClick={() => setPreview(null)}>关闭</button></div>
          {preview.attachment.extract_status === 'partial' && <div className="document-warning">
            {preview.attachment.extract_error || '资料只提取出一部分，请核对原件。'}
          </div>}
          {preview.url && preview.attachment.kind === 'image'
            ? <img src={preview.url} alt={preview.attachment.original_name} />
            : preview.url && preview.attachment.kind === 'pdf'
              ? <iframe src={`${preview.url}${preview.page ? `#page=${preview.page}` : ''}`} title={preview.attachment.original_name} />
              : <pre className="document-text">{preview.text || '没有提取到可预览的文字。'}</pre>}
        </div>
      </div>}
    </div>
  )
}
