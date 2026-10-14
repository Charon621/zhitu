/**
 * 端到端验证：伪装成一个真实用户，把软件从头走一遍。
 *
 * 阶段 1（首次使用）：
 *   打开 → 向导里选服务商、填密钥 → 点"测试连接" → 开始使用
 *   → 聊一轮（流式）→ 故意用错密钥看报错 → 关掉
 *
 * 阶段 2（重新打开）：
 *   验证设置还在、密钥还能解密、对话记录一条不少
 *
 * 这样"能连通"和"数据存得住"两件事就不用靠人眼确认了。
 */

const { app } = require('electron')
const { join } = require('node:path')

// 关键一步：先把应用本体加载起来（它会开数据库、起本地服务、开窗口），
// 然后再跑我们自己的检查。顺序不能颠倒，否则本地服务还没准备好。
require(join(__dirname, '..', 'out', 'main', 'index.js'))

const PHASE = process.env.ZHITU_E2E_PHASE || '1'

const results = []
let failed = 0

function record(ok, name, detail = '') {
  results.push({ ok, name, detail })
  if (!ok) failed++
}

function check(name, condition, detail = '') {
  record(!!condition, name, detail)
}

/**
 * 报告同时写到控制台和文件。
 * 必须写文件：Windows 上 Electron 是 GUI 程序，stdout 不一定能被调用方接到。
 * 也必须写文件：被单实例锁挡下来的进程退出码是 0，只看退出码会误判成成功，
 * 所以调用方一定要读这份报告，以"检查项数量"为准。
 */
function writeReport(report) {
  console.log('\n' + report + '\n')
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const os = require('node:os')
    fs.appendFileSync(path.join(os.tmpdir(), 'zhitu-e2e-report.txt'), `\n[阶段 ${PHASE}]\n${report}\n`, 'utf-8')
  } catch (err) {
    console.log('写报告文件失败：' + (err instanceof Error ? err.message : String(err)))
  }
}

async function api(port, path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Zhitu-Token': globalThis.__zhitu.token,
      ...(options.headers ?? {})
    }
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text }
}

/** 像界面那样消费流式响应 */
async function chat(port, content, sessionId, topic = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Zhitu-Token': globalThis.__zhitu.token },
    body: JSON.stringify({ content, sessionId, ...topic })
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return { ok: false, error: body }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let text = ''
  let gotSession = null
  let errorEvent = null
  let done = false

  while (true) {
    const { done: streamDone, value } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true })

    let idx = buffer.indexOf('\n\n')
    while (idx !== -1) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) {
        try {
          const payload = JSON.parse(data)
          if (event === 'meta') gotSession = payload.sessionId
          else if (event === 'delta') text += payload.text
          else if (event === 'done') done = true
          else if (event === 'error') errorEvent = payload
        } catch {
          /* 忽略解析不了的行 */
        }
      }
      idx = buffer.indexOf('\n\n')
    }
  }

  return { ok: true, text, sessionId: gotSession, done, errorEvent }
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    // 注意：必须在循环里每次都重新读。
    // 应用是异步启动的，端口不是一开始就有的。
    const port = globalThis.__zhitu?.port
    if (port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        if (res.ok) return port
      } catch {
        /* 服务还没起来，继续等 */
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('本地服务在 20 秒内没有就绪')
}

async function phase1(port, mock) {
  // ── 0. 安全前提 ──
  // 验证脚本会反复清空数据。如果它跑在用户真实的数据目录上，
  // 就会把用户的学习记录和密钥冲掉 —— 这事真的发生过一次。
  // 所以这里先确认自己活在沙箱里，不是就直接报警。
  const dataDir = app.getPath('userData')
  const realDir = join(process.env.APPDATA || '', 'zhitu')
  check(
    '运行在沙箱数据目录里（不会污染用户的真实数据）',
    process.env.ZHITU_DATA_DIR && dataDir === process.env.ZHITU_DATA_DIR && dataDir !== realDir,
    dataDir
  )
  check('沙箱目录不在用户真实数据目录下', !dataDir.startsWith(realDir), `沙箱=${dataDir}`)

  // ── 1. 首次打开的样子 ──
  const boot = await api(port, '/bootstrap')
  check('首次打开能拿到引导信息', boot.status === 200 && !!boot.json)
  check('还没配置过密钥', boot.json?.settings?.hasApiKey === false)
  check('还没走过向导', boot.json?.settings?.onboarded === false)
  const noKeyEntries = await api(port, '/start/entries', {
    method: 'POST', body: JSON.stringify({ domain: 'AI', goalKind: 'casual' })
  })
  check('没配置密钥时不会生成入口问题', noKeyEntries.status === 400 && !!noKeyEntries.json?.message)
  check(
    '内置了 6 个服务商可选',
    Array.isArray(boot.json?.providers) && boot.json.providers.length === 6,
    `实际 ${boot.json?.providers?.length} 个`
  )

  // ── 2. 密钥写错时的提示 ──
  const badTest = await api(port, '/settings/test', {
    method: 'POST',
    body: JSON.stringify({ baseURL: mock.baseURL, model: 'mock-model', apiKey: '' })
  })
  check(
    '没填密钥就测试会被明确拒绝',
    badTest.json?.ok === false && typeof badTest.json.message === 'string',
    badTest.json?.message ?? ''
  )

  // ── 3. 正常填写并测试连接 ──
  const goodTest = await api(port, '/settings/test', {
    method: 'POST',
    body: JSON.stringify({ baseURL: mock.baseURL, model: 'mock-model', apiKey: 'sk-mock-123' })
  })
  check('测试连接成功并拿到回复', goodTest.json?.ok === true, `回复：${goodTest.json?.reply}`)
  check(
    '请求真的带上了密钥（Authorization 头）',
    mock.requests.some((r) => r.authorization === 'Bearer sk-mock-123')
  )
  check(
    '测试用的是非流式请求',
    mock.requests.some((r) => r.stream === false)
  )

  // ── 4. 保存设置（相当于点了"开始使用"）──
  const saved = await api(port, '/settings', {
    method: 'POST',
    body: JSON.stringify({
      providerId: 'custom',
      baseURL: mock.baseURL,
      model: 'mock-model',
      apiKey: 'sk-mock-123',
      learnerLevel: 'beginner',
      onboarded: true
    })
  })
  check('设置保存成功', saved.status === 200 && saved.json?.settings?.onboarded === true)
  check('保存后不再回传密钥明文', saved.json?.settings?.apiKey === undefined)
  check('密钥处于加密存储状态', saved.json?.settings?.keyEncrypted === true)
  await api(port, '/settings', { method: 'POST', body: JSON.stringify({ learnerLevel: 'targeted' }) })
  const legacySetting = await api(port, '/settings', { method: 'POST', body: JSON.stringify({ model: 'mock-model' }) })
  check('旧水平字段仍保留且普通设置保存不会覆盖它', legacySetting.json?.settings?.learnerLevel === 'targeted')
  const secondProvider = await api(port, '/settings', { method: 'POST', body: JSON.stringify({
    providerId: 'deepseek', baseURL: mock.baseURL, model: 'mock-model', apiKey: 'sk-deepseek-test'
  }) })
  check('切到另一家服务商可单独保存密钥', secondProvider.json?.settings?.hasApiKey === true &&
    !!globalThis.__zhitu.db.db.prepare("SELECT 1 FROM app_config WHERE key = 'secret.apiKey.deepseek'").get())
  const customKeyStatus = await api(port, '/settings/provider-key?providerId=custom')
  check('切走后旧服务商密钥仍在', customKeyStatus.json?.hasApiKey === true &&
    !!globalThis.__zhitu.db.db.prepare("SELECT 1 FROM app_config WHERE key = 'secret.apiKey.custom'").get())
  const backToCustom = await api(port, '/settings', { method: 'POST', body: JSON.stringify({
    providerId: 'custom', baseURL: mock.baseURL, model: 'mock-model'
  }) })
  check('切回服务商不用重新填密钥', backToCustom.json?.settings?.hasApiKey === true)
  check('密钥可用时如实报告为可用', backToCustom.json?.settings?.keyUsable === true)
  // 密文还在、但这台机器解不开（换过系统账户或拷过数据目录）时，
  // 界面必须说"密钥失效"，而不是显示一切正常却每次对话都失败。
  // 做法是真的把密文改坏一个字节：DPAPI 会解不开。
  {
    const db = globalThis.__zhitu.db.db
    const row = db.prepare("SELECT value FROM app_config WHERE key = 'secret.apiKey.custom'").get()
    const envelope = JSON.parse(row.value)
    // 做法是把密文中间真的改坏一个字节：DPAPI 会解不开。
    // 注意不能只改 base64 的最后一个字符——那是填充位，改了等于没改。
    const cipher = Buffer.from(envelope.data, 'base64')
    const middle = Math.max(0, Math.floor(cipher.length / 2))
    cipher[middle] ^= 0xff
    db.prepare("UPDATE app_config SET value = ? WHERE key = 'secret.apiKey.custom'")
      .run(JSON.stringify({ ...envelope, data: cipher.toString('base64') }))
    const damaged = await api(port, '/settings/provider-key?providerId=custom')
    check('解不开的密钥不会被谎报成可用', damaged.json?.keyUsable === false && damaged.json?.hasApiKey === false,
      `keyUsable=${damaged.json?.keyUsable} hasApiKey=${damaged.json?.hasApiKey}`)
    db.prepare("UPDATE app_config SET value = ? WHERE key = 'secret.apiKey.custom'").run(row.value)
    const restored = await api(port, '/settings/provider-key?providerId=custom')
    check('原密钥恢复后重新可用', restored.json?.keyUsable === true && restored.json?.hasApiKey === true)
  }
  const oldKeyTest = await api(port, '/settings/test', { method: 'POST', body: JSON.stringify({
    providerId: 'custom', baseURL: mock.baseURL, model: 'mock-model'
  }) })
  check('切回后的测试连接使用原来的密钥', oldKeyTest.json?.ok === true &&
    mock.requests.at(-1)?.authorization === 'Bearer sk-mock-123')
  const depthSetting = await api(port, '/settings', { method: 'POST',
    body: JSON.stringify({ explanationDepth: 'more' }) })
  check('讲解深度可由用户手动设置', depthSetting.json?.settings?.explanationDepth === 'more')

  const suggestions = await api(port, '/start/entries', {
    method: 'POST', body: JSON.stringify({ domain: 'AI', goalKind: 'hands_on' })
  })
  const suggestionRequest = mock.requests.filter((r) =>
    r.messages?.[0]?.content?.includes('挑三个起点')
  ).pop()
  check('领域入口生成了恰好三个具体问题', suggestions.status === 200 && suggestions.json?.entries?.length === 3)
  check('每个入口都有问题与简短理由', suggestions.json?.entries?.every((e) =>
    e.question?.includes('？') && e.why?.length > 0 && e.why.length <= 30
  ) === true)
  check('入口生成使用已选倾向和辅助模型回退', suggestionRequest?.model === 'mock-model' &&
    suggestionRequest.messages?.[1]?.content?.includes('hands_on'))
  const entryPrompt = suggestionRequest?.messages?.[0]?.content ?? ''
  check('入口提示词禁用符号列表', entryPrompt.includes('•') && entryPrompt.includes('不要用'))
  check('入口提示词要求连贯段落', entryPrompt.includes('连贯的段落'))
  check('入口提示词要求自然分点', entryPrompt.includes('第一') && entryPrompt.includes('最后'))
  check('入口提示词只允许操作步骤编号', entryPrompt.includes('1. 2. 3.'))
  check('入口提示词禁用套话', entryPrompt.includes('作为AI') && entryPrompt.includes('套话'))
  const entryBulletLines = (entryPrompt.match(/\n\s*[-*•]\s[^\n]*/g) ?? [])
  check('入口提示词自身没有符号列表', entryBulletLines.length === 0,
    entryBulletLines.length === 0 ? '提示词是纯段落' : `发现 ${entryBulletLines.length} 行`)

  // ── 5. 聊一轮（流式）──
  const first = await chat(port, 'softmax 为什么要减去最大值？')
  check('对话有返回内容', first.ok && first.text.length > 20, `收到 ${first.text?.length} 字`)
  check('对话是流式逐段到达的（不是一次性）', first.text.includes('减去最大值'))
  check('对话正常收尾', first.done === true)
  check('拿到了会话 id', typeof first.sessionId === 'string' && first.sessionId.length > 0)
  check('没有错误事件', first.errorEvent === null)

  const { MOCK_REPLY } = require('./mock-provider.cjs')
  check('收到的内容与模型输出完全一致', first.text.trim() === MOCK_REPLY.trim())
  const firstSystemPrompt = mock.requests.find((request) => request.stream)?.messages?.[0]?.content ?? ''
  check('画像置信度低时不在对话里猜水平', !firstSystemPrompt.includes('根据你之前的提问方式判断'))
  const profileDb = globalThis.__zhitu.db.db
  let observed = false
  for (let attempt = 0; attempt < 80; attempt++) {
    observed = profileDb.prepare('SELECT COUNT(*) AS n FROM profile_observations').get().n >= 1
    if (observed) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check('后台按本轮提问更新行为画像', observed &&
    profileDb.prepare("SELECT confidence FROM learner_profile WHERE id = 'singleton'").get()?.confidence > 0)
  profileDb.prepare("UPDATE learner_profile SET confidence = 0.6 WHERE id = 'singleton'").run()

  // ── 6. 第二轮，验证上下文有带上历史 ──
  const second = await chat(port, '那不减会怎样？', first.sessionId)
  check('第二轮对话成功', second.ok && second.text.length > 0)
  const lastRequest = mock.requests.filter((r) => r.stream).pop()
  check(
    '第二轮把历史对话带进了上下文',
    (lastRequest?.messages?.length ?? 0) >= 3,
    `带上了 ${lastRequest?.messages?.length} 条消息`
  )

  const systemPrompt = lastRequest?.messages?.[0]?.content ?? ''
  check('系统提示词里有教学要求', systemPrompt.includes('织图'))
  check('画像置信度足够才注入一条深度提示', systemPrompt.includes('根据你之前的提问方式判断') &&
    systemPrompt.includes('不要假设他不知道某个具体的词'))
  check('手动讲解深度进入对话提示词', systemPrompt.includes('用户希望多解释'))
  check('旧水平字段不再进入系统提示词', !systemPrompt.includes('学习者的水平自述') &&
    !systemPrompt.includes('完全是外行'))

  // 排版要求（用户明确提的三条），必须真的出现在发给模型的提示词里。
  // 这几条写成断言，是为了防止以后改提示词时把它们弄丢。
  check(
    '提示词禁止用项目符号列表',
    systemPrompt.includes('•') && systemPrompt.includes('不要用') && systemPrompt.includes('连贯的段落')
  )
  check('提示词要求用"第一…然后…最后"连接', systemPrompt.includes('第一') && systemPrompt.includes('最后'))
  check('提示词允许真正的步骤用 1. 2. 3. 编号', systemPrompt.includes('1. 2. 3.'))
  check(
    '提示词禁止"作为AI"这类套话',
    systemPrompt.includes('作为AI') && systemPrompt.includes('套话')
  )
  // 这一条的详情必须按结果给，否则通过时也会显示"检测到…"这种吓人的话
  const bulletLines = (systemPrompt.match(/\n\s*[-*•]\s[^\n]*/g) ?? []).map((s) => s.trim())
  check(
    '提示词本身没用符号列表开头（否则是反面示范）',
    bulletLines.length === 0,
    bulletLines.length === 0 ? '提示词是纯段落' : `发现 ${bulletLines.length} 行：${bulletLines.join(' / ')}`
  )

  // ── 7. 关掉之前，确认记录已经落库 ──
  const turns = await api(port, `/sessions/${first.sessionId}/turns`)
  check('对话流水已经落库', turns.json?.turns?.length === 4, `库里 ${turns.json?.turns?.length} 条`)
  check(
    '用户和 AI 的话都记下了',
    turns.json?.turns?.filter((t) => t.role === 'user').length === 2 &&
      turns.json?.turns?.filter((t) => t.role === 'assistant').length === 2
  )
  check(
    '场次标题自动变成了第一句话',
    (turns.json?.session?.title ?? '').includes('softmax'),
    turns.json?.session?.title ?? ''
  )
  const topic = globalThis.__zhitu.db.db.prepare(
    'SELECT topics.title, topics.goal_kind FROM topics JOIN sessions ON sessions.topic_id = topics.id WHERE sessions.id = ?'
  ).get(first.sessionId)
  check('第一句话自动建立了主题', topic?.title?.includes('softmax') && topic?.goal_kind === 'casual')

  // 后台笔记不能阻塞对话；等它结束后再检查实际落库结果。
  const db = globalThis.__zhitu.db.db
  let extractionRows = []
  for (let i = 0; i < 80; i++) {
    extractionRows = db.prepare('SELECT status FROM extractions ORDER BY rowid').all()
    if (extractionRows.length >= 2 && extractionRows.every((row) => row.status !== 'pending')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const noteResponse = await api(port, `/sessions/${first.sessionId}/notes`)
  const cards = noteResponse.json?.cards ?? []
  const blocks = cards.flatMap((card) => card.blocks ?? [])
  const noteRequest = mock.requests.find((request) =>
    request.stream === false && request.messages?.[0]?.content?.includes('知识萃取器'))
  const notePrompt = noteRequest?.messages?.[0]?.content ?? ''
  check('数据库已迁移到 v10 且笔记、归档、回收站与原文版本字段都在', db.pragma('user_version', { simple: true }) === 10 &&
    !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'note_blocks'").get() &&
    db.pragma('table_info(sessions)').some((column) => column.name === 'archived_at') &&
    db.pragma('table_info(sessions)').some((column) => column.name === 'deleted_at') &&
    db.pragma('table_info(nodes)').some((column) => column.name === 'trashed_at') &&
    db.pragma('table_info(attachments)').some((column) => column.name === 'active_source_version'))
  check('助手回复后后台生成了一张笔记卡', noteResponse.status === 200 && cards.length === 1,
    `实际 ${cards.length} 张`)
  const allNotes = await api(port, '/notes')
  const dbNoteCount = db.prepare('SELECT COUNT(DISTINCT node_id) AS n FROM note_blocks WHERE deleted_by_user = 0').get().n
  check('完整笔记接口卡片数与数据库一致', allNotes.status === 200 &&
    allNotes.json?.cards?.length === dbNoteCount, `接口 ${allNotes.json?.cards?.length}，数据库 ${dbNoteCount}`)
  const mapData = await api(port, '/map')
  const mapTopicId = db.prepare('SELECT topic_id FROM sessions WHERE id = ?').get(first.sessionId)?.topic_id
  const mapDbCount = db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE topic_id = ?').get(mapTopicId)?.n
  check('地图接口返回当前主题的真实节点', mapData.status === 200 &&
    mapData.json?.nodes?.length === mapDbCount, `接口 ${mapData.json?.nodes?.length}，数据库 ${mapDbCount}`)
  check('地图默认选中的主题有知识点可画', mapData.status === 200 &&
    !!mapData.json?.selectedTopicId && mapData.json?.nodes?.length > 0)
  check('重复讲同一点只写一条笔记块', blocks.length === 1, `实际 ${blocks.length} 条`)
  check('笔记有实指且不超过 120 字', blocks[0]?.content_md?.includes('最大项变成 1') &&
    [...blocks[0].content_md].length <= 120)
  check('笔记没有符号列表或元话语', blocks.every((block) =>
    !/^\s*[•*-]\s/m.test(block.content_md) && !/本段讨论了|综上所述/.test(block.content_md)))
  check('两轮抽取分别记录完成与跳过', extractionRows.length === 2 &&
    extractionRows[0].status === 'ok' && extractionRows[1].status === 'skipped',
    extractionRows.map((row) => row.status).join('、'))
  check('笔记提示词复用了排版约束', notePrompt.includes('连贯的段落') &&
    notePrompt.includes('作为AI') && notePrompt.includes('1. 2. 3.'))
  const noteBulletLines = notePrompt.match(/\n\s*[-*•]\s[^\n]*/g) ?? []
  check('笔记提示词自身没有符号列表', notePrompt.length > 0 && noteBulletLines.length === 0,
    noteBulletLines.length === 0 ? '提示词是纯段落' : `发现 ${noteBulletLines.length} 行`)
  const promptPath = join(__dirname, '..', 'src', 'main', 'core', 'prompts.ts')
  const promptSource = require('node:fs').readFileSync(promptPath, 'utf8')
  const ts = require('typescript')
  const compiledPrompt = ts.transpileModule(promptSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const promptModule = new (require('node:module'))(promptPath, module)
  promptModule.filename = promptPath
  promptModule.paths = module.paths
  promptModule._compile(compiledPrompt, promptPath)
  const verifyPrompt = promptModule.exports.NOTE_VERIFY_PROMPT ?? ''
  check('核对提示词禁用符号列表', verifyPrompt.includes('•') && verifyPrompt.includes('不要用'))
  check('核对提示词要求连贯段落', verifyPrompt.includes('连贯的段落'))
  check('核对提示词要求自然分点', verifyPrompt.includes('第一') && verifyPrompt.includes('最后'))
  check('核对提示词只允许操作步骤编号', verifyPrompt.includes('1. 2. 3.'))
  check('核对提示词禁用套话', verifyPrompt.includes('作为AI') && verifyPrompt.includes('套话'))
  const verifyBulletLines = verifyPrompt.match(/\n\s*[-*•]\s[^\n]*/g) ?? []
  check('核对提示词自身没有符号列表', verifyPrompt.length > 0 && verifyBulletLines.length === 0,
    verifyBulletLines.length === 0 ? '提示词是纯段落' : `发现 ${verifyBulletLines.length} 行`)
  const documentPrompt = promptModule.exports.DOCUMENT_CONTEXT_PROMPT ?? ''
  check('资料提示词禁用符号列表', documentPrompt.includes('•') && documentPrompt.includes('不要用'))
  check('资料提示词要求连贯段落', documentPrompt.includes('连贯的段落'))
  check('资料提示词要求自然分点', documentPrompt.includes('第一') && documentPrompt.includes('最后'))
  check('资料提示词只允许操作步骤编号', documentPrompt.includes('1. 2. 3.'))
  check('资料提示词禁用套话', documentPrompt.includes('作为AI') && documentPrompt.includes('套话'))
  const documentBulletLines = documentPrompt.match(/\n\s*[-*•]\s[^\n]*/g) ?? []
  check('资料提示词自身没有符号列表', documentPrompt.length > 0 && documentBulletLines.length === 0,
    documentBulletLines.length === 0 ? '提示词是纯段落' : `发现 ${documentBulletLines.length} 行`)
  const ocrPrompt = promptModule.exports.OCR_PROMPT ?? ''
  check('视觉转录提示词禁用符号列表', ocrPrompt.includes('•') && ocrPrompt.includes('不要用'))
  check('视觉转录提示词要求连贯段落', ocrPrompt.includes('连贯的段落'))
  check('视觉转录提示词要求自然分点', ocrPrompt.includes('第一') && ocrPrompt.includes('最后'))
  check('视觉转录提示词只允许操作步骤编号', ocrPrompt.includes('1. 2. 3.'))
  check('视觉转录提示词禁用套话', ocrPrompt.includes('作为AI') && ocrPrompt.includes('套话'))
  const ocrBulletLines = ocrPrompt.match(/\n\s*[-*•]\s[^\n]*/g) ?? []
  check('视觉转录提示词自身没有符号列表', ocrPrompt.length > 0 && ocrBulletLines.length === 0,
    ocrBulletLines.length === 0 ? '提示词是纯段落' : `发现 ${ocrBulletLines.length} 行`)
  const profilePrompt = promptModule.exports.PROFILE_SIGNAL_PROMPT ?? ''
  check('画像提示词禁用符号列表', profilePrompt.includes('•') && profilePrompt.includes('不要用'))
  check('画像提示词要求连贯段落', profilePrompt.includes('连贯的段落'))
  check('画像提示词要求自然分点', profilePrompt.includes('第一') && profilePrompt.includes('最后'))
  check('画像提示词只允许操作步骤编号', profilePrompt.includes('1. 2. 3.'))
  check('画像提示词禁用套话', profilePrompt.includes('作为AI') && profilePrompt.includes('套话'))
  const profileBulletLines = profilePrompt.match(/\n\s*[-*•]\s[^\n]*/g) ?? []
  check('画像提示词自身没有符号列表', profilePrompt.length > 0 && profileBulletLines.length === 0,
    profileBulletLines.length === 0 ? '提示词是纯段落' : `发现 ${profileBulletLines.length} 行`)
  const fixtureBytes = require('node:fs').readFileSync(join(__dirname, 'fixtures', 'attachments', 'sample.pdf'))
  const upload = async () => {
    const form = new FormData()
    form.append('file', new Blob([fixtureBytes], { type: 'application/pdf' }), 'sample.pdf')
    form.append('sessionId', first.sessionId)
    const response = await fetch(`http://127.0.0.1:${port}/attachments`, {
      method: 'POST', headers: { 'X-Zhitu-Token': globalThis.__zhitu.token }, body: form
    })
    return { status: response.status, json: await response.json() }
  }
  const uploaded = await upload()
  const attachmentId = uploaded.json?.attachment?.id
  check('上传 PDF 立即返回附件记录', uploaded.status === 200 && !!attachmentId)
  let state = uploaded.json?.attachment
  for (let attempt = 0; attempt < 100 && state?.extract_status === 'pending'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    state = (await api(port, `/attachments/${attachmentId}`)).json?.attachment
  }
  check('PDF 后台解析到就绪且识别 3 页', state?.extract_status === 'ok' && state.page_count === 3,
    state?.extract_error || '')
  const chunkResponse = await api(port, `/attachments/${attachmentId}/chunks`)
  check('PDF 切片标明真实第 3 页', chunkResponse.json?.chunks?.some((chunk) =>
    chunk.page === 3 && chunk.text.includes('SOFTMAX_STABILITY_ANCHOR')))
  const searchResponse = await api(port, '/documents/search', {
    method: 'POST', body: JSON.stringify({ sessionId: first.sessionId, query: 'SOFTMAX_STABILITY_ANCHOR', limit: 3 })
  })
  check('资料搜索返回相关切片', searchResponse.json?.chunks?.some((chunk) =>
    chunk.attachment_id === attachmentId && chunk.page === 3))
  const originalResponse = await fetch(`http://127.0.0.1:${port}/attachments/${attachmentId}/file`, {
    headers: { 'X-Zhitu-Token': globalThis.__zhitu.token }
  })
  check('原件预览接口返回 PDF', originalResponse.status === 200 &&
    originalResponse.headers.get('content-type')?.includes('application/pdf'))
  const duplicateUpload = await upload()
  check('同场重复上传复用原附件', duplicateUpload.json?.attachment?.id === attachmentId)
  const listed = await api(port, `/sessions/${first.sessionId}/attachments`)
  check('本场附件列表只有一份原件', listed.json?.attachments?.length === 1)
  const removed = await api(port, `/attachments/${attachmentId}`, { method: 'DELETE' })
  check('未引用资料可以连原件一起删除', removed.status === 200 &&
    (await api(port, `/attachments/${attachmentId}`)).status === 404)
  const imageForm = new FormData()
  const imageBytes = require('node:fs').readFileSync(join(__dirname, 'fixtures', 'attachments', 'sample.png'))
  imageForm.append('file', new Blob([imageBytes], { type: 'image/png' }), 'sample.png')
  imageForm.append('sessionId', first.sessionId)
  const imageUploadResponse = await fetch(`http://127.0.0.1:${port}/attachments`, {
    method: 'POST', headers: { 'X-Zhitu-Token': globalThis.__zhitu.token }, body: imageForm
  })
  const imageUpload = await imageUploadResponse.json()
  const imageId = imageUpload.attachment?.id
  check('图片原件可上传到当前场次', imageUploadResponse.status === 200 && !!imageId)
  const blockedImage = await chat(port, '这张图是什么？', first.sessionId, { attachmentIds: [imageId] })
  check('视觉开关关闭时不会暗中发图片给模型', !blockedImage.ok &&
    blockedImage.error?.message?.includes('开启视觉识别'))
  const visionSetting = await api(port, '/settings', {
    method: 'POST', body: JSON.stringify({ visionEnabled: true, visionModel: 'deepseek-flash' })
  })
  check('视觉开关及模型可保存', visionSetting.json?.settings?.visionEnabled === true &&
    visionSetting.json?.settings?.visionModel === 'deepseek-flash')
  const imageChat = await chat(port, '这张图是什么？', first.sessionId, { attachmentIds: [imageId] })
  check('开启后图片可参与对话', imageChat.ok && imageChat.text?.length > 0)
  const imageRequest = [...mock.requests].reverse().find((request) => request.stream === true &&
    request.messages?.some((message) => Array.isArray(message.content)))
  check('模型收到真正的图片内容而非文件名', imageRequest?.model === 'deepseek-flash' &&
    imageRequest.messages.some((message) => Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,'))))
  const protectedImage = await api(port, `/attachments/${imageId}`, { method: 'DELETE' })
  check('已经进入对话的图片原件不能彻底删除', protectedImage.status === 409)
  const scanForm = new FormData()
  const scanBytes = require('node:fs').readFileSync(join(__dirname, 'fixtures', 'attachments', 'scanned.pdf'))
  scanForm.append('file', new Blob([scanBytes], { type: 'application/pdf' }), 'scanned.pdf')
  scanForm.append('sessionId', first.sessionId)
  const scanUploadResponse = await fetch(`http://127.0.0.1:${port}/attachments`, {
    method: 'POST', headers: { 'X-Zhitu-Token': globalThis.__zhitu.token }, body: scanForm
  })
  const scanUpload = await scanUploadResponse.json()
  const scanId = scanUpload.attachment?.id
  check('扫描 PDF 可导入且保留原件', scanUploadResponse.status === 200 && !!scanId)
  let scanStatus = scanUpload.attachment
  for (let attempt = 0; attempt < 100 && scanStatus?.extract_status === 'pending'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    scanStatus = (await api(port, `/attachments/${scanId}`)).json?.attachment
  }
  check('扫描 PDF 被明确标为部分提取', scanStatus?.extract_status === 'partial' &&
    scanStatus.extract_error?.includes('扫描页'))
  const scanChat = await chat(port, '第 1 页写了什么？', first.sessionId, { attachmentIds: [scanId] })
  check('扫描页渲染后可交给视觉模型', scanChat.ok && scanChat.text?.length > 0)
  const scanChunks = await api(port, `/attachments/${scanId}/chunks`)
  check('扫描页转录结果保留原页码', scanChunks.json?.chunks?.some((chunk) =>
    chunk.page === 1 && chunk.text.includes('SCANNED_PAGE_ANCHOR')))
  const scanRequest = [...mock.requests].reverse().find((request) => request.stream === true &&
    request.messages?.some((message) => Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'text' && part.text?.includes('scanned.pdf'))))
  check('视觉请求标明 PDF 真正的页码', scanRequest?.model === 'deepseek-flash' &&
    scanRequest.messages.some((message) => Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,'))))
  const utilitySaved = await api(port, '/settings', {
    method: 'POST', body: JSON.stringify({ utilityModel: 'mock-utility' })
  })
  check('可保存单独的后台整理模型', utilitySaved.status === 200 &&
    utilitySaved.json?.settings?.utilityModel === 'mock-utility')

  const homewardPrompt = promptModule.exports.HOMEWARD_PROMPT ?? ''
  check('归航提示词复用了排版约束', homewardPrompt.includes('绝对不要用') &&
    homewardPrompt.includes('连贯的段落') && homewardPrompt.includes('作为AI'))
  check('归航提示词自身没有符号列表', homewardPrompt.length > 0 &&
    (homewardPrompt.match(/\n\s*[-*•]\s[^\n]*/g) ?? []).length === 0)
  for (const [label, prompt] of [
    ['复习出题', promptModule.exports.REVIEW_QUESTION_PROMPT ?? ''],
    ['复习判题', promptModule.exports.REVIEW_GRADE_PROMPT ?? '']
  ]) {
    check(`${label}提示词禁用符号列表`, prompt.includes('•') && prompt.includes('不要用'))
    check(`${label}提示词要求连贯段落`, prompt.includes('连贯的段落'))
    check(`${label}提示词要求自然分点`, prompt.includes('第一') && prompt.includes('最后'))
    check(`${label}提示词只允许操作步骤编号`, prompt.includes('1. 2. 3.'))
    check(`${label}提示词禁用套话`, prompt.includes('作为AI') && prompt.includes('套话'))
    check(`${label}提示词自身没有符号列表`, prompt.length > 0 &&
      (prompt.match(/\n\s*[-*•]\s[^\n]*/g) ?? []).length === 0)
  }
  const now = new Date().toISOString()
  const topicId = db.prepare('SELECT topic_id FROM sessions WHERE id = ?').get(first.sessionId).topic_id
  // 记下补归航支线之前的原始对话条数：后面的导出检查要确认"对话原件没被改动"。
  const turnsBeforeHomewardFixture = db.prepare('SELECT COUNT(*) AS n FROM turns').get().n
  const rootId = 'nod-homeward-root'
  const ids = [rootId, 'nod-homeward-2', 'nod-homeward-3', 'nod-homeward-4']
  const titles = ['注意力机制', '多头注意力', 'softmax 数值稳定性', '浮点数的二进制表示']
  db.transaction(() => {
    // 节点在真实流程里都来自本场某一轮对话。这里补上对应的轮次并写进
    // origin_turn_id，否则它们不属于任何场次，归航不会把它们算作本场的支线。
    ids.forEach((id, index) => {
      const userTurn = `trn-homeward-user-${index}`
      const assistantTurn = `trn-homeward-assistant-${index}`
      db.prepare("INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
        .run(userTurn, first.sessionId, `${titles[index]}是怎么回事？`, now)
      db.prepare("INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)")
        .run(assistantTurn, first.sessionId, `${titles[index]}还要继续往下讲。`, now)
      db.prepare(`INSERT INTO nodes (id, topic_id, title, kind, status, mastery, origin_turn_id,
        created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, 'question', 'open', 1, ?, ?, ?, ?)`)
        .run(id, topicId, titles[index], userTurn, now, now, now)
      db.prepare(`INSERT INTO note_blocks (id, node_id, block_type, content_md, ordinal, created_at, updated_at)
        VALUES (?, ?, 'question', ?, 1, ?, ?)`).run(`blk-homeward-${index}`, id, `${titles[index]}还有待解释`, now, now)
      if (index) db.prepare(`INSERT INTO edges (id, src_id, dst_id, type, created_at)
        VALUES (?, ?, ?, 'parent', ?)`).run(`edg-homeward-${index}`, ids[index - 1], id, now)
    })
  })()
  const ended = await api(port, `/sessions/${first.sessionId}/end`, { method: 'POST' })
  check('四层支线归航判为未走完', ended.status === 200 &&
    ended.json?.results?.some((row) => row.rootNodeId === rootId && row.isClosed === false))
  check('归航指出正确的下次起点', ended.json?.results?.find((row) => row.rootNodeId === rootId)?.nextStep ===
    '从浮点数的二进制表示继续')
  check('归航调用后台模型且携带四层路径', mock.requests.some((request) =>
    request.model === 'mock-utility' && request.messages?.[0]?.content?.includes('判断学习者的几条支线') &&
    request.messages?.[1]?.content?.includes('注意力机制 → 多头注意力 → softmax 数值稳定性 → 浮点数的二进制表示')))
  const unfinished = await api(port, '/unfinished')
  check('未收线清单含四层支线与下一步', unfinished.json?.threads?.some((row) =>
    row.id === rootId && row.nextStep === '从浮点数的二进制表示继续'))
  const stored = db.prepare('SELECT content_md FROM note_blocks WHERE node_id = ? AND origin_turn_id IS NULL ORDER BY rowid DESC LIMIT 1')
    .get(rootId)
  check('停靠点与下一步写入问题笔记块', stored?.content_md?.includes('停在：浮点数的二进制表示还没解释') &&
    stored.content_md.includes('下次：从浮点数的二进制表示继续'))
  const close = await api(port, `/unfinished/${ids[3]}/close`, {
    method: 'POST', body: JSON.stringify({ reason: 'uninterested' })
  })
  check('不感兴趣可关闭支线但不标成已掌握', close.status === 200 &&
    db.prepare('SELECT status, mastery FROM nodes WHERE id = ?').get(ids[3])?.status === 'gathered')
  check('不感兴趣会降低同主题推荐权重', db.prepare('SELECT recommendation_weight FROM topic_preferences WHERE topic_id = ?')
    .get(topicId)?.recommendation_weight < 1)
  const summary = await api(port, `/sessions/${first.sessionId}/homeward`)
  check('本场小结被保存', summary.json?.homeward?.summary?.includes('下次可以从这里接着问'))
  const reviewNodeId = cards[0].id
  db.prepare('UPDATE reviews SET due_at = ? WHERE node_id = ?')
    .run(new Date(Date.now() - 86_400_000).toISOString(), reviewNodeId)
  const due = await api(port, '/reviews/due')
  check('已到期的知识点出现在复习入口', due.json?.count >= 1)
  const reviewQuestion = await api(port, '/reviews/question', { method: 'POST' })
  const review = reviewQuestion.json?.review
  check('复习只出能检验应用的题', reviewQuestion.status === 200 &&
    review?.nodeId === reviewNodeId && review.question.includes('特别大') && !review.question.includes('是什么'))
  check('出题请求使用后台模型和共享排版约束', mock.requests.some((request) =>
    request.model === 'mock-utility' && request.messages?.[0]?.content?.includes('检验理解的应用题') &&
    request.messages[0].content.includes('绝对不要用')))
  const beforeMastery = db.prepare('SELECT mastery FROM nodes WHERE id = ?').get(reviewNodeId).mastery
  const graded = await api(port, `/reviews/${review.attemptId}/grade`, {
    method: 'POST', body: JSON.stringify({ answer: '先减去最大值避免 exp 溢出，比例不变，因为分子分母同乘一个因子。' })
  })
  check('复习判题给出具体反馈与掌握度变化', graded.status === 200 && graded.json?.result?.correct === true &&
    graded.json.result.mastery === beforeMastery + 1 && graded.json.result.feedback.includes('溢出'))
  const schedule = db.prepare('SELECT due_at, last_reviewed_at FROM reviews WHERE node_id = ?').get(reviewNodeId)
  check('SM-2 简化排程把下一次复习推到未来', schedule?.due_at > new Date().toISOString() &&
    !!schedule.last_reviewed_at)
  const gradeAgain = await api(port, `/reviews/${review.attemptId}/grade`, {
    method: 'POST', body: JSON.stringify({ answer: '重复提交' })
  })
  check('重复提交同一题不会重复加掌握度', gradeAgain.json?.result?.mastery === beforeMastery + 1 &&
    db.prepare('SELECT mastery FROM nodes WHERE id = ?').get(reviewNodeId).mastery === beforeMastery + 1)
  check('复习题和回答有独立记录而对话原件不变',
    db.prepare('SELECT answer, quality FROM review_attempts WHERE id = ?').get(review.attemptId)?.quality === 4 &&
    db.prepare('SELECT COUNT(*) AS n FROM turns').get().n === turnsBeforeHomewardFixture + 8)
  const searchTurn = await api(port, '/search?q=' + encodeURIComponent('softmax'))
  check('全局搜索找到对话原文且能返回场次', searchTurn.json?.hits?.some((hit) =>
    hit.kind === 'turn' && hit.sessionId === first.sessionId))
  check('全局搜索找到知识点或笔记块', searchTurn.json?.hits?.some((hit) =>
    (hit.kind === 'node' || hit.kind === 'note_block') && hit.nodeId))
  const searchChunk = await api(port, '/search?q=' + encodeURIComponent('SCANNED_PAGE_ANCHOR'))
  check('全局搜索找到资料原页码', searchChunk.json?.hits?.some((hit) =>
    hit.kind === 'chunk' && hit.attachmentId === scanId && hit.page === 1))
  const shortSearch = await api(port, '/search?q=AI')
  check('两个字的搜索词也可搜索', shortSearch.status === 200 && Array.isArray(shortSearch.json?.hits))
  const notesArchive = await fetch(`http://127.0.0.1:${port}/exports/notes`, {
    headers: { 'X-Zhitu-Token': globalThis.__zhitu.token }
  })
  const notesZip = await require('jszip').loadAsync(await notesArchive.arrayBuffer())
  const mdPaths = Object.keys(notesZip.files).filter((path) => path.endsWith('.md') && path !== '导出说明.md')
  check('笔记导出为每节点一份 Markdown', notesArchive.status === 200 &&
    mdPaths.length === db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n)
  const mdTexts = await Promise.all(mdPaths.map((path) => notesZip.file(path).async('string')))
  const parsed = mdTexts.map((value) => require('marked').lexer(value))
  check('导出笔记可以重新解析且保留标题与内容', parsed.every((tokens) =>
    tokens.some((token) => token.type === 'heading' && token.depth === 1)) &&
    mdTexts.some((value) => value.includes('最大项变成 1')))
  check('导出笔记保留节点双链关系', mdTexts.some((value) => /\[\[[^\]]+\|[^\]]+\]\]/.test(value)))
  const sessionExport = await api(port, `/exports/sessions/${first.sessionId}`)
  const sessionTurnCount = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
    .get(first.sessionId).n
  check('单场对话导出保留原始顺序和小结', sessionExport.status === 200 &&
    (sessionExport.text.match(/^## (我|AI) ·/gm) ?? []).length === sessionTurnCount &&
    sessionExport.text.includes('## 本场小结'))
  const allExport = await api(port, '/exports/all')
  const backup = allExport.json
  check('全部数据备份包含流水和原件', allExport.status === 200 &&
    backup?.format === 'zhitu-backup-v1' &&
    backup.turns?.length === db.prepare('SELECT COUNT(*) AS n FROM turns').get().n &&
    backup.attachments_files?.some((file) => file.attachmentId === imageId &&
      Buffer.from(file.base64, 'base64').equals(imageBytes)))
  check('备份排除 API 密钥', backup?.app_config?.every((row) => !row.key.startsWith('secret.')))
  const originalPath = db.prepare('SELECT stored_path FROM attachments WHERE id = ?').get(imageId).stored_path
  db.prepare('UPDATE attachments SET stored_path = ? WHERE id = ?').run('Z:\\zhitu-missing-original', imageId)
  const missingOriginal = await api(port, '/exports/all')
  db.prepare('UPDATE attachments SET stored_path = ? WHERE id = ?').run(originalPath, imageId)
  check('原件缺失时备份明确失败而不生成残缺文件', missingOriginal.status === 500)
  const anonymousExport = await fetch(`http://127.0.0.1:${port}/exports/all`)
  check('没有本机凭证不能读取导出数据', anonymousExport.status === 403)
  const thisWeek = await api(port, `/stats/week?since=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString())}`)
  check('本周回顾使用真实场次和笔记计数', thisWeek.status === 200 &&
    thisWeek.json?.sessions >= 1 && thisWeek.json?.noteBlocks >= 1 &&
    thisWeek.json?.topics?.some((topic) => topic.title.includes('softmax')) &&
    Array.isArray(thisWeek.json?.unfinished))
  const olderDate = new Date(Date.now() - 14 * 86_400_000).toISOString()
  db.prepare('INSERT INTO topics (id, title, goal_kind, created_at) VALUES (?, ?, ?, ?)')
    .run('top-week-resume', '跨周学习', 'casual', olderDate)
  db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
    .run('ses-week-resume', 'top-week-resume', '跨周学习', olderDate)
  db.prepare("INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
    .run('trn-week-resume', 'ses-week-resume', '本周继续上周的问题', new Date().toISOString())
  const resumedWeek = await api(port, `/stats/week?since=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString())}`)
  check('本周续聊上周场次也计入回顾', resumedWeek.json?.sessions === thisWeek.json.sessions + 1 &&
    resumedWeek.json.topics.some((topic) => topic.title === '跨周学习'))
  db.prepare("DELETE FROM sessions WHERE id = 'ses-week-resume'").run()
  db.prepare("DELETE FROM topics WHERE id = 'top-week-resume'").run()
  const badWeek = await api(port, '/stats/week?since=not-a-date')
  check('本周回顾拒绝无效日期', badWeek.status === 400)
  const workingTopic = 'top-working-set'
  const workingSession = 'ses-working-set'
  const workingNow = new Date().toISOString()
  db.prepare('INSERT INTO topics (id, title, goal_kind, created_at) VALUES (?, ?, ?, ?)')
    .run(workingTopic, '注意力机制', 'principle', workingNow)
  db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
    .run(workingSession, workingTopic, '注意力机制', workingNow)
  for (let n = 0; n < 30; n++) db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`trn-working-${n}`, workingSession, n % 2 ? 'assistant' : 'user',
      n === 0 ? '我们从注意力机制为什么会关注不同位置开始。' : `第 ${n} 轮继续理解 softmax 的计算。`, workingNow)
  // 这两个节点也来自本场的轮次：工作集只认本场涉及的知识点。
  for (const [id, title, turnIndex] of [
    ['nod-working-root', '注意力机制', 0],
    ['nod-working-child', 'softmax 数值稳定性', 2]
  ]) {
    db.prepare(`INSERT INTO nodes (id, topic_id, title, kind, status, origin_turn_id, created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, 'question', 'open', ?, ?, ?, ?)`)
      .run(id, workingTopic, title, `trn-working-${turnIndex}`, workingNow, workingNow, workingNow)
  }
  db.prepare("INSERT INTO edges (id, src_id, dst_id, type, created_at) VALUES (?, ?, ?, 'parent', ?)")
    .run('edg-working-parent', 'nod-working-root', 'nod-working-child', workingNow)
  const workingChat = await chat(port, '我们最开始从哪儿聊起来的？', workingSession, { mode: 'free' })
  const workingRequest = mock.requests.filter((request) => request.stream).at(-1)
  const workingSystem = workingRequest?.messages?.[0]?.content ?? ''
  check('第三十轮仍带着本场起点和当前祖先链', workingChat.ok &&
    workingSystem.includes('注意力机制 → softmax 数值稳定性'))
  check('工作集只带最近八轮完整对话而非全部三十轮', workingRequest?.messages?.length <= 17 &&
    !workingRequest.messages.some((message) => typeof message.content === 'string' &&
      message.content.includes('第 1 轮继续')))
  check('工作集总量保持在六千 token 估算内', workingRequest?.messages?.reduce((sum, message) =>
    sum + (typeof message.content === 'string' ? (message.content.match(/[\u3400-\u9fff]/g) ?? []).length * 1.7 +
      (message.content.length - (message.content.match(/[\u3400-\u9fff]/g) ?? []).length) / 2 : 0), 0) <= 6000)
  check('自由模式写入流水元数据并只答不引导', workingSystem.includes('只回答用户所问') &&
    db.prepare('SELECT mode FROM turn_meta WHERE turn_id = (SELECT id FROM turns WHERE session_id = ? AND role = ? ORDER BY rowid DESC LIMIT 1)')
      .get(workingSession, 'user')?.mode === 'free')
  const streamedBeforeOversize = mock.requests.filter((request) => request.stream).length
  const oversized = await api(port, '/chat', { method: 'POST',
    body: JSON.stringify({ content: '过长的提问。'.repeat(2200), sessionId: workingSession }) })
  check('过长提问明确拒绝且不会把超预算内容发给模型', oversized.status === 413 &&
    oversized.json?.message?.includes('上下文容量') &&
    mock.requests.filter((request) => request.stream).length === streamedBeforeOversize)
  check('过长提问的原文先落库而没有丢失',
    db.prepare('SELECT content FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(workingSession)?.content === '过长的提问。'.repeat(2200))
  db.prepare('DELETE FROM sessions WHERE id = ?').run(workingSession)
  db.prepare('DELETE FROM topics WHERE id = ?').run(workingTopic)
  const storedCustomKey = db.prepare("SELECT value FROM app_config WHERE key = 'secret.apiKey.custom'").get()?.value
  db.prepare("DELETE FROM app_config WHERE key = 'secret.apiKey.custom'").run()
  db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('secret.apiKey', ?, ?)")
    .run(storedCustomKey, new Date().toISOString())
  const legacyKeyView = await api(port, '/bootstrap')
  check('旧版单密钥仍可被当前服务商读到', legacyKeyView.json?.settings?.hasApiKey === true)
  await api(port, '/settings', { method: 'POST', body: JSON.stringify({ model: 'mock-model' }) })
  check('旧版单密钥在设置写入时迁移到服务商专属键',
    !!db.prepare("SELECT 1 FROM app_config WHERE key = 'secret.apiKey.custom'").get() &&
    !db.prepare("SELECT 1 FROM app_config WHERE key = 'secret.apiKey'").get())
  const idleTopicId = 'top-idle-check'
  const idleSessionId = 'ses-idle-check'
  const idleTurnId = 'trn-idle-check'
  const old = new Date(Date.now() - 21 * 60_000).toISOString()
  db.prepare('INSERT INTO topics (id, title, goal_kind, created_at) VALUES (?, ?, ?, ?)')
    .run(idleTopicId, '闲置检查', 'casual', old)
  db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
    .run(idleSessionId, idleTopicId, '闲置检查', old)
  db.prepare("INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
    .run(idleTurnId, idleSessionId, '暂时聊到这里', old)
  let idleEnded = false
  for (let attempt = 0; attempt < 30; attempt++) {
    idleEnded = !!db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(idleSessionId)?.ended_at
    if (idleEnded) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check('闲置超过二十分钟会自动归航', idleEnded)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(idleSessionId)
  db.prepare('DELETE FROM topics WHERE id = ?').run(idleTopicId)

  return { sessionId: first.sessionId }
}

async function phase2(port) {
  const boot = await api(port, '/bootstrap')

  check('重新打开后：设置还在', boot.json?.settings?.onboarded === true)
  check('重新打开后：密钥还在（能解密）', boot.json?.settings?.hasApiKey === true)
  check(
    '重新打开后：接口地址没变',
    boot.json?.settings?.baseURL?.startsWith('http://127.0.0.1:'),
    boot.json?.settings?.baseURL ?? ''
  )
  check('重新打开后：旧水平字段保留', boot.json?.settings?.learnerLevel === 'targeted')
  check('重新打开后：后台整理模型配置仍在', boot.json?.settings?.utilityModel === 'mock-utility')
  check('重新打开后：讲解深度还在', boot.json?.settings?.explanationDepth === 'more')

  const sessionId = boot.json?.latestSessionId
  check('重新打开后：找到了上次那一场', typeof sessionId === 'string' && sessionId.length > 0)

  if (sessionId) {
    const turns = await api(port, `/sessions/${sessionId}/turns`)
    // 原始对话是"原件"，重启后必须一条不少。这里比对数据库里的真实条数，
    // 而不是写死一个数字——别处补的测试数据不应该让这条断言变成假警报。
    const storedTurns = globalThis.__zhitu.db.db
      .prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?').get(sessionId).n
    check(
      '重新打开后：对话一条不少',
      turns.json?.turns?.length === storedTurns && storedTurns >= 8,
      `库里 ${storedTurns} 条，接口 ${turns.json?.turns?.length} 条`
    )
    check(
      '重新打开后：内容完整没被截断',
      (turns.json?.turns?.[1]?.content ?? '').includes('减去最大值')
    )
    check(
      '重新打开后：标题还是那句',
      (turns.json?.session?.title ?? '').includes('softmax')
    )
  }

  const storedTotal = globalThis.__zhitu.db.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n
  check('统计数字对得上', boot.json?.stats?.turns === storedTotal && storedTotal >= 8,
    `接口 ${boot.json?.stats?.turns} 条，库里 ${storedTotal} 条`)
  check('数据库文件确实存在', require('node:fs').existsSync(require('node:path').join(app.getPath('userData'), 'zhitu.db')))
  const notes = await api(port, `/sessions/${sessionId}/notes`)
  check('重启后笔记仍在', notes.status === 200 && notes.json?.cards?.length === 1)
}

app.whenReady().then(async () => {
  let mock = null
  try {
    const port = await waitForServer()

    if (PHASE === '1') {
      const { startMockProvider } = require('./mock-provider.cjs')
      mock = await startMockProvider()
      await phase1(port, mock)
    } else {
      await phase2(port)
    }
  } catch (err) {
    record(false, '验证过程本身出错了', err instanceof Error ? err.message : String(err))
  }

  const lines = []
  lines.push(`──── 端到端验证 · 阶段 ${PHASE} ────`)
  for (const r of results) {
    lines.push(`${r.ok ? '  ✓' : '  ✕'} ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`)
  }
  lines.push('──────────────────────────────────')
  lines.push(
    failed === 0 ? `阶段 ${PHASE} 全部通过（${results.length} 项）` : `阶段 ${PHASE} 有 ${failed} 项未通过`
  )

  const report = lines.join('\n')
  writeReport(report)

  if (mock) await mock.close()
  app.exit(failed === 0 ? 0 : 1)
})
