import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Context, Next } from 'hono'
import type Database from 'better-sqlite3'
import { PROVIDERS } from '@shared/providers'
import type { ChatMessage, ChatRequestBody, SettingsView, ProviderId } from '@shared/types'
import { SettingsService, LEVEL_LABELS } from './core/settings'
import { ConfigStore } from './core/config-store'
import { Store, TRASH_RETENTION_DAYS, type GoalKind } from './core/store'
import { streamChat, testConnection, completeChat, ProviderError, type ProviderConfig } from './core/provider'
import { SYSTEM_PROMPT, START_ENTRIES_PROMPT, DOCUMENT_CONTEXT_PROMPT, OCR_PROMPT } from './core/prompts'
import { NoteService } from './core/notes'
import { AttachmentService, AttachmentError } from './core/attachments'
import { LibraryService } from './core/library'
import type { AnalysisMode, DocumentSource } from '@shared/library'
import { HomewardService } from './core/homeward'
import { ReviewService } from './core/reviews'
import { ExportService } from './core/exports'
import { SearchService } from './core/search'
import { BackupService } from './core/backups'
import { ProfileService } from './core/profile'
import { WorkingSetService } from './core/working-set'
import { extname } from 'node:path'
import { createHash } from 'node:crypto'
import { log, logError } from './log'

export interface ServerOptions {
  db: Database.Database
  token: string
  version: string
  dataDir: string
}

export function createServer(options: ServerOptions) {
  const { db, token, version, dataDir } = options
  const config = new ConfigStore(db)
  const settings = new SettingsService(config)
  const store = new Store(db, dataDir)
  const notes = new NoteService(db, store, () => {
    const s = settings.read()
    return { ...providerConfig(), model: s.utilityModel || s.model }
  })
  const attachments = new AttachmentService(db, dataDir)
  const library = new LibraryService(db, attachments, () => {
    const s = settings.read()
    return { ...providerConfig(), utilityModel: s.utilityModel, visionEnabled: s.visionEnabled, visionModel: s.visionModel }
  })
  const homeward = new HomewardService(db, store, () => {
    const s = settings.read()
    return { ...providerConfig(), model: s.utilityModel || s.model }
  })
  const reviews = new ReviewService(db, () => {
    const s = settings.read()
    return { ...providerConfig(), model: s.utilityModel || s.model }
  })
  const exportsService = new ExportService(db, dataDir)
  const searchService = new SearchService(db)
  const backups = new BackupService(db, dataDir)
  let restoringBackup = false
  const profile = new ProfileService(db, () => {
    const s = settings.read()
    return { ...providerConfig(), model: s.utilityModel || s.model }
  })
  const workingSet = new WorkingSetService(db, store)
  const homewardJobs = new Map<string, Promise<{ results: import('./core/homeward').HomewardResult[]; summary: string }>>()
  const endSession = (id: string): Promise<{ results: import('./core/homeward').HomewardResult[]; summary: string }> => {
    const existing = homewardJobs.get(id)
    if (existing) return existing
    const job = (async () => {
      await notes.flushSession(id)
      return homeward.evaluate(id)
    })()
    homewardJobs.set(id, job)
    void job.finally(() => { if (homewardJobs.get(id) === job) homewardJobs.delete(id) }).catch(() => undefined)
    return job
  }
  // 闲置自动归航：失败要让下一轮还能重试，否则断网一次这场就永远不再自动整理了。
  const idleAttempts = new Map<string, number>()
  const IDLE_MAX_ATTEMPTS = 5
  const idlePollMs = process.env.ZHITU_DATA_DIR && process.env.ZHITU_E2E_IDLE_POLL_MS
    ? Math.max(100, Number(process.env.ZHITU_E2E_IDLE_POLL_MS) || 60_000) : 60_000
  const idleTimer = setInterval(() => {
    if (!settings.hasApiKey()) return
    const cutoff = new Date(Date.now() - 20 * 60_000).toISOString()
    const rows = db.prepare(`SELECT s.id FROM sessions s
      WHERE s.ended_at IS NULL AND s.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id)
      AND (SELECT MAX(t.created_at) FROM turns t WHERE t.session_id = s.id) < ?`)
      .all(cutoff) as Array<{ id: string }>
    for (const row of rows) {
      const tried = idleAttempts.get(row.id) ?? 0
      if (tried >= IDLE_MAX_ATTEMPTS) continue
      idleAttempts.set(row.id, tried + 1)
      void endSession(row.id).then(() => { idleAttempts.delete(row.id) },
        () => undefined)
    }
  }, idlePollMs)
  idleTimer.unref()
  attachments.resumePending()
  // 回收站到期清理：单场失败只记日志，不阻塞启动，也不影响其它场次。
  try {
    const purged = store.purgeExpiredTrash(TRASH_RETENTION_DAYS)
    if (purged) log(`回收站已按 ${TRASH_RETENTION_DAYS} 天保留期清理 ${purged} 场`)
  } catch (error) {
    logError('回收站清理失败', error)
  }
  store.reconcileTrashedNodes()
  const app = new Hono<{ Variables: Record<string, never> }>()
  const recalculating = new Set<string>()

  // 只允许本机的界面访问
  app.use('*', async (c: Context, next: Next) => {
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Headers', 'Content-Type, X-Zhitu-Token')
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    if (c.req.method === 'OPTIONS') return c.body(null, 204)

    const path = c.req.path
    if (path === '/health' || path === '/bootstrap') return next()

    if (c.req.header('X-Zhitu-Token') !== token) {
      return c.json({ error: 'forbidden', message: '请求缺少有效凭证' }, 403)
    }
    return next()
  })

  const toClient = (): SettingsView => settings.view()

  const providerConfig = (): ProviderConfig => {
    const s = settings.read()
    return { baseURL: s.baseURL, apiKey: settings.apiKey(), model: s.model }
  }

  /**
   * 这个模型能不能收图片。
   *
   * 名单只是想挡住"模型根本不支持图片"的误操作，不是精确的能力数据库，
   * 所以宁可放宽：把各家的默认模型也算进来，否则用户开了视觉、填了默认的
   * gpt-4o-mini，反而被自己的软件拦住。用户在设置里填了明确的视觉模型时，
   * `visionModel` 与 `model` 不同，会先命中上面的分支。
   */
  const canSeeImages = (provider: ProviderId, model: string): boolean => {
    const name = model.trim().toLowerCase()
    if (!name) return true
    if (provider === 'deepseek') return /^deepseek-(flash|vl|vision)/.test(name)
    if (provider === 'openai') return /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o[1-9])/.test(name)
    if (provider === 'dashscope') return /vl|omni/.test(name)
    if (provider === 'zhipu') return /^(glm-4v|glm-4\.5v|glm-4-plus|glm-4-air|glm-4-flash)/.test(name)
    if (provider === 'moonshot') return /vision|vl|kimi-latest|moonshot-v1/.test(name)
    return /vision|vl|omni|gpt-4o|gpt-4\.1|gpt-5|deepseek-flash|glm-4v/.test(name)
  }

  // ── 基础 ────────────────────────────────

  app.get('/health', (c) => c.json({ ok: true, version }))

  app.get('/bootstrap', (c) =>
    c.json({
      version,
      dataDir,
      settings: toClient(),
      providers: PROVIDERS,
      levels: LEVEL_LABELS,
      stats: store.stats(),
      latestSessionId: store.latestSession()?.id ?? null
    })
  )

  // ── 设置 ────────────────────────────────

  app.post('/settings', async (c) => {
    const body = (await c.req.json()) as {
      providerId?: ProviderId
      baseURL?: string
      model?: string
      utilityModel?: string
      visionEnabled?: boolean
      visionModel?: string
      learnerLevel?: 'beginner' | 'some' | 'targeted' | 'casual'
      nickname?: string
      explanationDepth?: 'less' | 'medium' | 'more'
      onboarded?: boolean
      apiKey?: string
    }

    if (typeof body.apiKey === 'string') settings.setApiKey(body.apiKey, body.providerId ?? settings.read().providerId)

    settings.write({
      providerId: body.providerId,
      baseURL: body.baseURL,
      model: body.model,
      utilityModel: body.utilityModel,
      visionEnabled: typeof body.visionEnabled === 'boolean' ? body.visionEnabled : undefined,
      visionModel: typeof body.visionModel === 'string' ? body.visionModel.trim().slice(0, 100) : undefined,
      learnerLevel: body.learnerLevel,
      nickname: body.nickname,
      explanationDepth: ['less', 'medium', 'more'].includes(String(body.explanationDepth))
        ? body.explanationDepth : undefined,
      onboarded: body.onboarded
    })

    return c.json({ settings: toClient() })
  })

  app.get('/settings/provider-key', (c) => {
    const id = c.req.query('providerId') as ProviderId | undefined
    if (!id || !PROVIDERS.some((provider) => provider.id === id)) return c.json({ message: '服务商不存在' }, 400)
    return c.json(settings.keyStatus(id))
  })

  app.post('/settings/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      providerId?: ProviderId
      baseURL?: string
      model?: string
      apiKey?: string
    }

    // 允许"还没保存就先测"：优先用请求里带的临时值
    const saved = settings.read()
    const providerId = body.providerId ?? saved.providerId
    const preset = PROVIDERS.find((provider) => provider.id === providerId)
    const config: ProviderConfig = {
      baseURL: body.baseURL || (providerId === saved.providerId ? saved.baseURL : preset?.baseURL ?? ''),
      model: body.model || (providerId === saved.providerId ? saved.model : preset?.defaultModel ?? ''),
      apiKey: body.apiKey?.trim() || settings.apiKey(providerId)
    }

    try {
      const result = await testConnection(config, AbortSignal.timeout(45_000))
      return c.json({ ok: true, reply: result.reply })
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ ok: false, message: err.message, advice: err.advice, status: err.status })
      }
      return c.json({
        ok: false,
        message: `测试失败：${err instanceof Error ? err.message : String(err)}`,
        advice: '检查网络后重试。',
        status: 0
      })
    }
  })

  app.post('/start/entries', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      domain?: unknown
      goalKind?: unknown
    }
    const domain = typeof body.domain === 'string' ? body.domain.trim() : ''
    const goalKind = body.goalKind
    if (!domain || domain.length > 60 || !['principle', 'hands_on', 'casual'].includes(String(goalKind))) {
      return c.json({ message: '先写一个领域名，再选学习倾向。' }, 400)
    }
    if (!settings.hasApiKey()) {
      return c.json({ message: '还没有配置 AI 密钥', advice: '先去设置里填上 API Key。' }, 400)
    }

    try {
      const s = settings.read()
      const raw = await completeChat(
        { ...providerConfig(), model: s.utilityModel || s.model },
        [
          { role: 'system', content: START_ENTRIES_PROMPT },
          { role: 'user', content: `领域：${domain}\n学习者倾向：${goalKind}` }
        ],
        AbortSignal.timeout(45_000)
      )
      const parsed = JSON.parse(raw) as { entries?: Array<{ question?: unknown; why?: unknown }> }
      const entries = parsed.entries
      if (!Array.isArray(entries) || entries.length !== 3 || entries.some((entry) =>
        typeof entry.question !== 'string' || !entry.question.trim() ||
        typeof entry.why !== 'string' || !entry.why.trim() || entry.why.trim().length > 30
      )) {
        throw new Error('入口问题的格式不符合要求')
      }
      const validEntries = entries as Array<{ question: string; why: string }>
      return c.json({ entries: validEntries.map((entry) => ({ question: entry.question.trim(), why: entry.why.trim() })) })
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ message: err.message, advice: err.advice }, err.status >= 400 ? 502 : 503)
      }
      return c.json({ message: '没能生成合适的起点', advice: '再试一次，或直接选一个示例问题。' }, 502)
    }
  })

  // ── 对话 ────────────────────────────────

  app.post('/chat', async (c) => {
    const body = (await c.req.json()) as ChatRequestBody
    const content = (body.content ?? '').trim()
    if (!content) return c.json({ error: 'empty', message: '说点什么吧' }, 400)

    if (!settings.hasApiKey()) {
      return c.json(
        { error: 'no_key', message: '还没有配置 AI 密钥', advice: '先去设置里填上 API Key。' },
        400
      )
    }

    // 1) 找到或新建这一场
    let session = body.sessionId ? store.getSession(body.sessionId) : null
    if (!session) {
      const domain = typeof body.domain === 'string' ? body.domain.trim().slice(0, 60) : ''
      const goalKind: GoalKind = body.goalKind === 'principle' || body.goalKind === 'hands_on'
        ? body.goalKind : 'casual'
      const topicTitle = domain || content.replace(/\s+/g, ' ').slice(0, 30)
      const topicId = store.createTopic(topicTitle, goalKind)
      session = store.createSession(domain || '新的一场', topicId)
    }
    if (session.ended_at) db.prepare('UPDATE sessions SET ended_at = NULL WHERE id = ?').run(session.id)
    idleAttempts.delete(session.id)

    const selectedIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((id): id is string => typeof id === 'string').slice(0, 20) : []
    const selectedSettings = settings.read()
    const visionModel = selectedSettings.visionModel || selectedSettings.model
    let selectedRows: ReturnType<typeof attachments.validateSelection> = []
    let selectedImages: ReturnType<typeof attachments.validateSelection> = []
    if (selectedIds.length) {
      try {
        const selected = attachments.validateSelection(session.id, selectedIds)
        selectedRows = selected
        selectedImages = selected.filter((row) => row.kind === 'image' && !row.active_source_version)
        if (selectedImages.length && !selectedSettings.visionEnabled) {
          return c.json({ message: '图片已保存。请先在设置里开启视觉识别，再向图片提问。' }, 409)
        }
        if (selectedImages.length && !canSeeImages(selectedSettings.providerId, visionModel)) {
          return c.json({ message: `模型 ${visionModel} 未确认支持图片。请在设置里填写视觉模型名。` }, 409)
        }
        if (selectedImages.length > 3 || selectedImages.some((row) => row.bytes > 20 * 1024 * 1024)) {
          return c.json({ message: '一次最多发送 3 张图片，每张不超过 20 MB。原件仍保存在本机。' }, 413)
        }
      } catch (error) {
        if (error instanceof AttachmentError) return c.json({ message: error.message }, 409)
        throw error
      }
    }

    // 2) 先把用户这句话落库（原件，先写进去，后面出错也不丢）
    const userTurn = store.addTurn(session.id, 'user', content)
    if (selectedIds.length) attachments.markUsed(session.id, userTurn.id, selectedIds)
    if (content.includes('把这个记下来')) {
      notes.rememberUserNote(session.id, userTurn.id, content.replace('把这个记下来', '').trim() || content)
    }
    store.setSessionTitleIfDefault(session.id, content)

    const pageMatch = content.match(/第\s*(\d{1,4})\s*页/)
    const page = pageMatch ? Number(pageMatch[1]) : undefined
    const retrieved = selectedIds.length
      ? (page
        ? attachments.firstChunks(session.id, selectedIds, 5, page)
        : attachments.search(session.id, content, 5, selectedIds)) : []
    let relevant = retrieved.length ? retrieved
      : selectedIds.length
        ? attachments.firstChunks(session.id, selectedIds, 3) : []
    const visualPages: Array<{ name: string; page: number; bytes: Buffer }> = []
    const scanned = selectedRows.filter((row) => row.kind === 'pdf' && row.extract_status === 'partial' &&
      !(row.active_source_version && attachments.firstChunks(session.id, [row.id], 1, page).length) && (!!page || !relevant.length))
    if (scanned.length) {
      if (!selectedSettings.visionEnabled || !canSeeImages(selectedSettings.providerId, visionModel)) {
        return c.json({ message: '这份 PDF 含扫描页，文字提取不到。请在设置里开启视觉识别并填写支持图片的模型名。' }, 409)
      }
      try {
        for (const row of scanned.slice(0, 2)) {
          const targetPage = page ?? 1
          const bytes = await attachments.renderPdfPage(row.id, targetPage)
          visualPages.push({ name: row.original_name, page: targetPage, bytes })
          if (!attachments.firstChunks(session.id, [row.id], 1, targetPage).length) {
            try {
              const ocrText = await completeChat({ ...providerConfig(), model: visionModel }, [
                { role: 'system', content: OCR_PROMPT },
                { role: 'user', content: [
                  { type: 'text', text: `请逐字转录《${row.original_name}》第 ${targetPage} 页。` },
                  { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }
                ] }
              ], AbortSignal.timeout(45_000), 2000)
              attachments.addOcrPage(row.id, targetPage, ocrText)
              relevant = [...relevant, ...attachments.firstChunks(session.id, [row.id], 3, targetPage)]
            } catch { /* OCR 失败只影响引用切片，视觉提问仍可继续。 */ }
          }
        }
      } catch (error) {
        return c.json({ message: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
    relevant = relevant.slice(0, 3)
    const mode = body.mode === 'free' || body.mode === 'review' ? body.mode : 'guide'
    db.prepare(`INSERT INTO turn_meta (turn_id, attachment_ids_json, cited_chunk_ids_json, mode)
      VALUES (?, ?, ?, ?)`).run(userTurn.id, JSON.stringify(selectedIds),
        JSON.stringify(relevant.map((chunk) => chunk.id)), mode)

    // 3) 主题、知识路径、前置与检索结果组成工作集，再装入最近八轮。
    const documentContext = selectedIds.length ? `\n\n${DOCUMENT_CONTEXT_PROMPT}\n\n【本问相关资料切片】\n${relevant.length ? relevant.map((chunk) =>
      `[片段 ${chunk.ordinal} · ${chunk.original_name}${selectedRows.find((row) => row.id === chunk.attachment_id)?.active_source_version ? ' · 已校对原文优先' : ''}${chunk.page === null ? '' : ` · 第 ${chunk.page} 页`}] ${chunk.text.slice(0, 500)}`
    ).join('\n') : '（本问没有检索到相关片段）'}` : ''
    const modeHint = mode === 'free' ? '\n\n当前是自由模式：只回答用户所问，不主动提下一步，也不反问。' :
      mode === 'review' ? '\n\n当前是复习模式：优先用具体情境检验理解，避免只问定义。' :
        '\n\n当前是引导模式：回答后可以给一个具体的下一步建议，也可提示真正必要的前置知识。'
    const basePrompt = SYSTEM_PROMPT + profile.promptHint() +
      (selectedSettings.explanationDepth === 'less' ? '\n\n用户希望少解释，先给简洁结论。' :
        selectedSettings.explanationDepth === 'more' ? '\n\n用户希望多解释，可以讲清理由与例子。' : '') +
      modeHint + documentContext
    let assembled: ReturnType<typeof workingSet.assemble>
    try {
      assembled = workingSet.assemble(session.id, session.topic_id, content, basePrompt)
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : String(error) }, 413)
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: basePrompt + assembled.context },
      ...assembled.history
    ]

    if (selectedImages.length || visualPages.length) {
      const parts: Exclude<ChatMessage['content'], string> = [{ type: 'text', text: content }]
      for (const row of selectedImages) {
        const original = attachments.readOriginal(row.id)
        if (!original) return c.json({ message: '图片原件丢失，请重新导入' }, 409)
        const ext = extname(row.original_name).toLowerCase()
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
        parts.push({ type: 'image_url', image_url: {
          url: `data:${mime};base64,${original.bytes.toString('base64')}`
        } })
      }
      for (const visual of visualPages) {
        parts.push({ type: 'text', text: `以下图片是《${visual.name}》第 ${visual.page} 页。` })
        parts.push({ type: 'image_url', image_url: {
          url: `data:image/png;base64,${visual.bytes.toString('base64')}`
        } })
      }
      const lastUser = [...messages].reverse().find((message) => message.role === 'user')
      if (lastUser) lastUser.content = parts
    }

    const config = providerConfig()
    if (selectedImages.length || visualPages.length) config.model = visionModel
    const sessionId = session.id

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'meta',
        data: JSON.stringify({ sessionId })
      })

      try {
        const full = await streamChat(
          config,
          messages,
          async (text) => {
            await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text }) })
          },
          c.req.raw.signal
        )

        // 4) AI 这句话也落库
        if (full.trim()) {
          const assistant = store.addTurn(sessionId, 'assistant', full)
          if (selectedIds.length) {
            db.prepare(`INSERT INTO turn_meta (turn_id, attachment_ids_json, cited_chunk_ids_json, mode)
              VALUES (?, ?, ?, 'guide')`).run(assistant.id, JSON.stringify(selectedIds),
                JSON.stringify(relevant.map((chunk) => chunk.id)))
          }
          notes.schedule(sessionId, assistant.id, full.length)
          profile.schedule(sessionId, userTurn.id)
        }

        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ sessionId, length: full.length })
        })
      } catch (err) {
        const message =
          err instanceof ProviderError ? err.message : err instanceof Error ? err.message : String(err)
        const advice = err instanceof ProviderError ? err.advice : ''
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message, advice, status: err instanceof ProviderError ? err.status : 0 })
        })
      }
    })
  })

  // ── 流水与场次 ──────────────────────────

  app.get('/sessions', (c) => c.json({ sessions: store.listSessions(),
    archived: store.listArchivedSessions(), trash: store.listTrash(), trashStats: store.trashStats(),
    retentionDays: TRASH_RETENTION_DAYS }))

  app.get('/sessions/history', (c) => {
    const offset = Math.max(0, Math.min(1_000_000, Number(c.req.query('offset')) || 0))
    const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 25))
    return c.json(store.historyPage((c.req.query('q') ?? '').trim().slice(0, 100), c.req.query('state') === 'archived' ? 'archived' : 'active', Math.floor(offset), Math.floor(limit)))
  })

  app.post('/backups/preview', async (c) => {
    try { return c.json({ preview: backups.preview(await c.req.json()) }) }
    catch (error) { return c.json({ message: error instanceof Error ? error.message : '备份校验失败' }, 400) }
  })
  app.post('/backups/restore', async (c) => {
    if (restoringBackup) return c.json({ message: '正在恢复备份，请稍候。' }, 409)
    restoringBackup = true
    try { return c.json(await backups.restore(await c.req.json(), () => { library.rebuildIndex(); store.reconcileTrashedNodes() })) }
    catch (error) { return c.json({ message: error instanceof Error ? error.message : '备份恢复失败' }, 400) }
    finally { restoringBackup = false }
  })

  // ── 历史记录管理：重命名 / 归档 / 回收站 / 删除 ──────

  app.patch('/sessions/:id', async (c) => {
    const id = c.req.param('id')
    if (!store.getSession(id)) return c.json({ message: '找不到这一场' }, 404)
    if (store.isTrashed(id)) return c.json({ message: '这场在回收站里，先恢复再修改' }, 409)
    const body = await c.req.json().catch(() => ({})) as { title?: unknown; archived?: unknown }
    if (typeof body.title === 'string') {
      const title = body.title.trim().replace(/\s+/g, ' ')
      if (!title) return c.json({ message: '名字不能为空' }, 400)
      if ([...title].length > 60) return c.json({ message: '名字最多 60 个字' }, 400)
      store.renameSession(id, title)
    } else if (typeof body.archived === 'boolean') {
      store.setArchived(id, body.archived)
    } else {
      return c.json({ message: '请提供新的名字或归档状态' }, 400)
    }
    return c.json({ session: store.getSession(id) })
  })

  /**
   * 删除前的预演。界面必须先用它把"会删掉什么、会留下什么"摆给用户看，
   * 再执行删除——删除是不可逆的，不能只靠一个确认框。
   */
  app.get('/sessions/:id/deletion-preview', (c) => {
    const preview = store.deletionPreview(c.req.param('id'))
    return preview ? c.json({ preview }) : c.json({ message: '找不到这一场' }, 404)
  })

  /**
   * 两段式删除。
   *
   * 默认（mode=trash）只移入回收站：30 天内可以恢复，界面给撤销条，不再拦确认框。
   * mode=purge 才是真的抹掉，必须带 confirm=true——这是唯一不可逆的那条路。
   */
  app.delete('/sessions/:id', (c) => {
    const id = c.req.param('id')
    if (!store.getSession(id)) return c.json({ message: '找不到这一场' }, 404)
    const mode = c.req.query('mode') ?? 'trash'
    if (recalculating.has(id)) return c.json({ message: '这场笔记正在重算，先等它结束再删' }, 409)
    if (mode === 'purge') {
      if (c.req.query('confirm') !== 'true') {
        return c.json({ message: '彻底删除不可恢复，请先确认' }, 400)
      }
      const result = store.purgeSession(id)
      if (!result.ok) return c.json({ message: '找不到这一场' }, 404)
      return c.json({ mode, ...result })
    }
    if (mode !== 'trash') return c.json({ message: '删除方式不正确' }, 400)
    const result = store.trashSession(id)
    if (!result.ok) return c.json({ message: '这场已经在回收站里了' }, 409)
    return c.json({ mode, ...result })
  })

  app.post('/sessions/:id/restore', (c) => {
    const id = c.req.param('id')
    if (!store.getSession(id)) return c.json({ message: '找不到这一场' }, 404)
    if (!store.restoreSession(id)) return c.json({ message: '这场不在回收站里' }, 409)
    return c.json({ ok: true, session: store.getSession(id) })
  })

  /** 批量操作：逐场结果，不整体回滚——9 场成功 1 场失败要能如实说出来。 */
  app.post('/sessions/batch', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { ids?: unknown; action?: unknown }
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string'))] : []
    if (!ids.length) return c.json({ message: '请先选择要处理的场次' }, 400)
    if (ids.length > 200) return c.json({ message: '一次最多处理 200 场' }, 400)
    const action = body.action
    if (action !== 'trash' && action !== 'restore') return c.json({ message: '不支持的批量操作' }, 400)
    const ok: string[] = []; const failed: Array<{ id: string; reason: string }> = []
    for (const id of ids) {
      const result = action === 'trash' ? store.trashSession(id) : { ok: store.restoreSession(id) }
      if (result.ok) ok.push(id)
      else failed.push({ id, reason: action === 'trash' ? '已经在回收站里或找不到' : '不在回收站里或找不到' })
    }
    return c.json({ ok, failed, trashStats: store.trashStats() })
  })

  /** 清空回收站：逐场彻底删，如实报告失败的那几场。 */
  app.post('/sessions/trash/empty', (c) => {
    if (c.req.query('confirm') !== 'true') return c.json({ message: '清空回收站不可恢复，请先确认' }, 400)
    return c.json(store.emptyTrash())
  })

  app.get('/stats/week', (c) => {
    const since = c.req.query('since') ?? ''
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(since) ||
      !Number.isFinite(Date.parse(since))) return c.json({ message: '时间范围不正确' }, 400)
    const sessions = (db.prepare(`SELECT COUNT(DISTINCT t.session_id) AS count FROM turns t
      JOIN sessions s ON s.id = t.session_id
      WHERE t.role = 'user' AND t.created_at >= ? AND s.deleted_at IS NULL`)
      .get(since) as { count: number }).count
    const noteBlocks = (db.prepare(`SELECT COUNT(*) AS count FROM note_blocks b
      JOIN nodes n ON n.id = b.node_id
      WHERE b.created_at >= ? AND b.deleted_by_user = 0 AND n.trashed_at IS NULL`).get(since) as { count: number }).count
    const topics = db.prepare(`SELECT t.id, t.title, COUNT(DISTINCT s.id) AS sessions FROM topics t
      JOIN sessions s ON s.topic_id = t.id JOIN turns tr ON tr.session_id = s.id
      WHERE tr.role = 'user' AND tr.created_at >= ? AND s.deleted_at IS NULL
      GROUP BY t.id ORDER BY MAX(tr.created_at) DESC LIMIT 20`).all(since) as
      Array<{ id: string; title: string; sessions: number }>
    return c.json({ sessions, noteBlocks, topics, unfinished: homeward.listOpen() })
  })
  app.get('/search', (c) => {
    try { return c.json({ hits: searchService.find(c.req.query('q') ?? '') }) }
    catch (error) { return c.json({ message: error instanceof Error ? error.message : '搜索失败' }, 400) }
  })
  app.get('/exports/notes', async (c) => {
    try {
      const bytes = await exportsService.notesZip()
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      return c.body(body, 200, { 'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="zhitu-notes.zip"' })
    } catch (error) { return c.json({ message: error instanceof Error ? error.message : '笔记导出失败' }, 500) }
  })
  app.get('/exports/sessions/:id', (c) => {
    if (store.isTrashed(c.req.param('id'))) return c.json({ message: '这场在回收站里，恢复后再导出' }, 409)
    const content = exportsService.sessionMarkdown(c.req.param('id'))
    return content === null ? c.json({ message: '找不到这一场' }, 404)
      : c.text(content, 200, { 'Content-Disposition': 'attachment; filename="zhitu-session.md"' })
  })
  app.get('/exports/all', (c) => {
    try { return c.text(exportsService.allJson(), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="zhitu-backup.json"' }) }
    catch (error) { return c.json({ message: error instanceof Error ? error.message : '备份失败' }, 500) }
  })
  app.get('/map', (c) => c.json(store.map(c.req.query('topicId'))))
  app.get('/reviews/due', (c) => c.json({ count: reviews.dueCount() }))
  app.post('/reviews/question', async (c) => {
    if (!settings.hasApiKey()) return c.json({ message: '还没有配置 AI 密钥' }, 400)
    try { return c.json({ review: await reviews.question() }) }
    catch (error) { return c.json({ message: error instanceof Error ? error.message : '复习题生成失败' }, 502) }
  })
  app.post('/reviews/:id/grade', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { answer?: unknown }
    if (typeof body.answer !== 'string' || !body.answer.trim()) return c.json({ message: '先写下你的回答' }, 400)
    if (!settings.hasApiKey()) return c.json({ message: '还没有配置 AI 密钥' }, 400)
    try { return c.json({ result: await reviews.grade(c.req.param('id'), body.answer) }) }
    catch (error) { return c.json({ message: error instanceof Error ? error.message : '批改失败' }, 502) }
  })

  app.get('/unfinished', (c) => c.json({ threads: homeward.listOpen() }))

  app.post('/unfinished/:id/close', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { reason?: unknown }
    if (body.reason !== 'mastered' && body.reason !== 'uninterested') {
      return c.json({ message: '请选择“我懂了”或“不感兴趣”' }, 400)
    }
    if (!homeward.close(c.req.param('id'), body.reason)) return c.json({ message: '找不到这条未收线' }, 404)
    return c.json({ ok: true })
  })

  app.get('/sessions/:id/homeward', (c) => {
    if (!store.getSession(c.req.param('id'))) return c.json({ message: '找不到这一场' }, 404)
    if (store.isTrashed(c.req.param('id'))) return c.json({ message: '这场在回收站里，恢复后才能查看' }, 409)
    return c.json({ homeward: homeward.summary(c.req.param('id')) })
  })

  app.post('/sessions/:id/end', async (c) => {
    const id = c.req.param('id')
    if (!store.getSession(id)) return c.json({ message: '找不到这一场' }, 404)
    if (store.isTrashed(id)) return c.json({ message: '这场在回收站里，恢复后再收线' }, 409)
    if (!settings.hasApiKey()) return c.json({ message: '还没有配置 AI 密钥' }, 400)
    try { return c.json(await endSession(id)) }
    catch (error) { return c.json({ message: error instanceof Error ? error.message : '归航失败，请稍后重试' }, 502) }
  })

  app.get('/sessions/:id/turns', (c) => {
    const id = c.req.param('id')
    const session = store.getSession(id)
    if (!session) return c.json({ error: 'not_found', message: '找不到这一场' }, 404)
    if (session.deleted_at) return c.json({ error: 'trashed', message: '这场在回收站里，恢复后才能打开' }, 409)
    const turns = store.listTurns(id).map((turn) => {
      const meta = db.prepare('SELECT attachment_ids_json FROM turn_meta WHERE turn_id = ?')
        .get(turn.id) as { attachment_ids_json: string } | undefined
      return { ...turn, attachmentIds: meta ? JSON.parse(meta.attachment_ids_json) as string[] : [] }
    })
    return c.json({ session, turns })
  })

  app.get('/sessions/:id/notes', (c) => {
    const id = c.req.param('id')
    if (!store.getSession(id)) return c.json({ error: 'not_found', message: '找不到这一场' }, 404)
    if (store.isTrashed(id)) return c.json({ error: 'trashed', message: '这场在回收站里，恢复后才能打开' }, 409)
    return c.json({ cards: notes.listSessionCards(id) })
  })

  app.get('/notes', (c) => c.json(notes.listAllCards()))

  app.post('/sessions/:id/notes/recalculate', async (c) => {
    const id = c.req.param('id')
    if (!store.getSession(id)) return c.json({ message: '找不到这一场' }, 404)
    if (store.isTrashed(id)) return c.json({ message: '这场在回收站里，恢复后才能重算' }, 409)
    if (!settings.hasApiKey()) return c.json({ message: '还没有配置 AI 密钥' }, 400)
    if (recalculating.has(id)) return c.json({ message: '这场笔记正在重算，请等它结束' }, 409)
    const body = await c.req.json().catch(() => ({})) as { keepTitles?: unknown }
    recalculating.add(id)
    try {
      return c.json(await notes.recalculateSession(id, { keepTitles: body.keepTitles === true }))
    } finally {
      recalculating.delete(id)
    }
  })

  app.patch('/note-blocks/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { content?: unknown; pinned?: unknown }
    const id = c.req.param('id')
    if (typeof body.content === 'string') {
      if (!notes.editBlock(id, body.content)) return c.json({ message: '笔记不存在或内容不合适' }, 400)
    } else if (typeof body.pinned === 'boolean') {
      if (!notes.setPinned(id, body.pinned)) return c.json({ message: '找不到这条笔记' }, 404)
    } else {
      return c.json({ message: '请提供笔记内容或置顶状态' }, 400)
    }
    return c.json({ ok: true })
  })

  app.delete('/note-blocks/:id', (c) => {
    if (!notes.deleteBlock(c.req.param('id'))) return c.json({ message: '找不到这条笔记' }, 404)
    return c.json({ ok: true })
  })

  // ── 资料导入 ──────────────────────────────

  app.post('/attachments', async (c) => {
    let createdSessionId: string | null = null
    let createdTopicId: string | null = null
    try {
      const form = await c.req.formData()
      const file = form.get('file')
      if (!file || typeof file === 'string') return c.json({ message: '请先选择文件' }, 400)
      const incoming = file as File
      const requestedSessionId = form.get('sessionId')
      let session = typeof requestedSessionId === 'string' ? store.getSession(requestedSessionId) : null
      if (requestedSessionId && !session) return c.json({ message: '找不到这一场' }, 404)
      const bytes = Buffer.from(await incoming.arrayBuffer())
      if (form.get('libraryImport') === 'true' && !requestedSessionId) {
        const hash = createHash('sha256').update(bytes).digest('hex')
        const existing = attachments.listAll().find((a) => a.sha256 === hash)
        if (existing) return c.json({ sessionId: existing.session_id, attachment: existing })
      }
      if (!session) {
        const title = incoming.name.replace(extname(incoming.name), '').slice(0, 60) || '资料学习'
        const topicId = store.createTopic(title, 'casual')
        session = store.createSession(title, topicId)
        createdSessionId = session.id; createdTopicId = topicId
      }
      const row = attachments.add(session.id, incoming.name, bytes)
      return c.json({ sessionId: session.id, attachment: row })
    } catch (error) {
      // A rejected/empty file must not leave an empty topic in recent history.
      if (createdSessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(createdSessionId)
      if (createdTopicId) db.prepare('DELETE FROM topics WHERE id = ?').run(createdTopicId)
      if (error instanceof AttachmentError) return c.json({ message: error.message }, error.status as 400 | 409 | 413)
      return c.json({ message: '文件导入失败', advice: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.get('/attachments/:id', (c) => {
    const row = attachments.get(c.req.param('id'))
    return row ? c.json({ attachment: row }) : c.json({ message: '找不到这份资料' }, 404)
  })

  app.get('/attachments/:id/chunks', (c) => {
    const id = c.req.param('id')
    if (!attachments.get(id)) return c.json({ message: '找不到这份资料' }, 404)
    return c.json({ chunks: attachments.getChunks(id) })
  })

  app.get('/attachments/:id/file', (c) => {
    const original = attachments.readOriginal(c.req.param('id'))
    if (!original) return c.json({ message: '找不到这份资料' }, 404)
    const extension = extname(original.row.original_name).slice(1).toLowerCase()
    const mime = ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      webp: 'image/webp', html: 'text/html; charset=utf-8' } as Record<string, string>)[extension] ||
      'application/octet-stream'
    const bytes = original.bytes
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    return c.body(body, 200, { 'Content-Type': mime, 'Content-Disposition': 'inline' })
  })

  app.get('/sessions/:id/attachments', (c) => {
    const id = c.req.param('id')
    if (!store.getSession(id)) return c.json({ message: '找不到这一场' }, 404)
    if (store.isTrashed(id)) return c.json({ message: '这场在回收站里，恢复后才能查看资料' }, 409)
    return c.json({ attachments: attachments.listSession(id) })
  })

  app.delete('/attachments/:id', (c) => {
    try {
      if (library.isRunning(c.req.param('id'))) return c.json({ message: '请先停止这份资料的整理，再删除原件' }, 409)
      return attachments.remove(c.req.param('id'))
        ? c.json({ ok: true }) : c.json({ message: '找不到这份资料' }, 404)
    } catch (error) {
      if (error instanceof AttachmentError) return c.json({ message: error.message }, 409)
      return c.json({ message: '删除资料失败' }, 500)
    }
  })

  app.post('/documents/search', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string; query?: string; limit?: number }
    if (!body.sessionId || !store.getSession(body.sessionId)) return c.json({ message: '找不到这一场' }, 404)
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 300) : ''
    if (!query) return c.json({ message: '请填写要查找的内容' }, 400)
    return c.json({ chunks: attachments.search(body.sessionId, query, body.limit) })
  })

  // Independent import workflows keep source files, recognized text and resumable checkpoints together.
  app.get('/library', (c) => c.json({ items: library.list() }))
  app.get('/library/:id', (c) => {
    if (!attachments.get(c.req.param('id'))) return c.json({ message: '找不到这份资料' }, 404)
    return c.json({ analysis: library.get(c.req.param('id')) })
  })
  app.post('/library/:id/:action', async (c) => {
    try {
      const id = c.req.param('id'); const action = c.req.param('action')
      if (action === 'cancel') { library.cancel(id); return c.json({ ok: true }) }
      const body = await c.req.json() as { mode: AnalysisMode; startPage?: number; endPage?: number; restart?: boolean }
      if (action === 'plan') return c.json({ plan: library.plan(id, body.mode, body.startPage, body.endPage) })
      if (action === 'start') return c.json({ analysis: library.start(id, body.mode, body) })
      return c.json({ message: '未知操作' }, 404)
    } catch (error) {
      if (error instanceof AttachmentError) return c.json({ message: error.message }, error.status as 400 | 404 | 409)
      return c.json({ message: error instanceof SyntaxError ? '请求格式无效' : '无法开始整理' }, 400)
    }
  })
  app.patch('/library/:id', async (c) => {
    try {
      const body = await c.req.json() as { sources?: DocumentSource[]; noteId?: string; category?: string; title?: string; content?: string }
      if (body.sources) return c.json({ analysis: library.editSources(c.req.param('id'), body.sources) })
      if (body.noteId) return c.json({ analysis: library.editNote(c.req.param('id'), body.noteId,
        { category: body.category!, title: body.title!, content: body.content! }) })
      return c.json({ message: '没有可保存的修改' }, 400)
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : '保存失败' }, error instanceof AttachmentError ? error.status as 400 | 404 | 409 : 400)
    }
  })
  return app
}
