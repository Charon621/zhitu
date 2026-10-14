/** 用真实模型跑 20 轮学习对话；只读用户密钥，笔记写在内存数据库。 */
const { app, safeStorage } = require('electron')
const { buildSync } = require('esbuild')
const { Module } = require('node:module')
const { join } = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const Database = require('better-sqlite3')

const root = join(__dirname, '..')
const output = 'E:\\CodexOutputs\\织图\\验证\\第1步-20轮真实学习对话.json'
const errorOutput = 'E:\\CodexOutputs\\织图\\验证\\第1步-20轮检查错误.txt'
const questions = [
  '注意力机制最初想解决什么问题？',
  '为什么只看邻近的词不够？',
  '注意力里的查询、键、值分别在做什么？',
  '用一个日常例子解释查询和键怎样匹配。',
  '匹配分数为什么还要经过 softmax？',
  'softmax 为什么要减去最大值？',
  '这一步会不会改变 softmax 的结果？',
  '如果两个分数特别接近，会发生什么？',
  '注意力权重乘值向量是什么意思？',
  '为什么不能直接把最相关的那个词拿来？',
  '自注意力和交叉注意力的区别在哪？',
  'Transformer 为什么需要多头注意力？',
  '头越多就一定越好吗？',
  '位置编码解决了哪个问题？',
  '位置编码和注意力是怎么配合的？',
  '残差连接为什么能帮助训练？',
  '层归一化和 softmax 是一回事吗？',
  '训练时为什么要遮住未来的词？',
  '推理时还需要这个遮罩吗？',
  '把刚才的内容串起来，我应该怎样理解 Transformer 的一层？'
]

function loadSource(path) {
  const filename = join(root, path)
  const bundle = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['better-sqlite3', 'zod', 'electron'], tsconfig: join(root, 'tsconfig.node.json') })
  const loaded = new Module(filename + '.cjs', module)
  loaded.filename = filename + '.cjs'
  loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(bundle.outputFiles[0].text, loaded.filename)
  return loaded.exports
}

app.setName('zhitu')
app.whenReady().then(async () => {
  mkdirSync(join(output, '..'), { recursive: true })
  const saved = new Database(join(app.getPath('userData'), 'zhitu.db'), { readonly: true })
  const settings = JSON.parse(saved.prepare("SELECT value FROM app_config WHERE key = 'settings'").get()?.value ?? '{}')
  const row = saved.prepare('SELECT value FROM app_config WHERE key IN (?, ?) ORDER BY key DESC LIMIT 1')
    .get(`secret.apiKey.${settings.providerId ?? 'deepseek'}`, 'secret.apiKey')
  saved.close()
  if (!row) throw new Error('没有已配置的密钥')
  const secret = JSON.parse(row.value)
  const apiKey = secret.encrypted
    ? safeStorage.decryptString(Buffer.from(secret.data, 'base64')) : secret.data
  const usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  const originalFetch = global.fetch
  global.fetch = async (...args) => {
    const response = await originalFetch(...args)
    try {
      const json = await response.clone().json()
      for (const key of Object.keys(usage)) usage[key] += Number(json.usage?.[key] ?? 0)
    } catch { /* streamed or failed response; handled by caller */ }
    return response
  }

  const { openDatabase } = loadSource('src/main/core/db.ts')
  const { NoteService } = loadSource('src/main/core/notes.ts')
  const { completeChat } = loadSource('src/main/core/provider.ts')
  const { SYSTEM_PROMPT } = loadSource('src/main/core/prompts.ts')
  const handle = openDatabase(':memory:')
  const db = handle.db
  const now = new Date().toISOString()
  db.prepare('INSERT INTO topics (id, title, created_at) VALUES (?, ?, ?)').run('quality-topic', '注意力机制', now)
  db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
    .run('quality-session', 'quality-topic', '注意力机制', now)
  const config = { baseURL: 'https://api.deepseek.com', apiKey, model: 'deepseek-chat' }
  const notes = new NoteService(db, () => config)
  const history = []
  const report = []
  try {
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i]
      const answer = await completeChat(config,
        [{ role: 'system', content: SYSTEM_PROMPT }, ...history.slice(-16), { role: 'user', content: question }],
        AbortSignal.timeout(45_000))
      const turnId = `user-${i + 1}`
      const answerId = `assistant-${i + 1}`
      db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(turnId, 'quality-session', 'user', question, new Date().toISOString())
      db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(answerId, 'quality-session', 'assistant', answer, new Date().toISOString())
      const extraction = await notes.extractTurn(answerId)
      const blocks = db.prepare('SELECT block_type, content_md FROM note_blocks WHERE origin_turn_id = ? AND deleted_by_user = 0')
        .all(answerId)
      const error = db.prepare('SELECT error FROM extractions WHERE turn_id = ?').get(answerId)?.error ?? null
      report.push({ round: i + 1, question, answer, extraction, blocks, error })
      history.push({ role: 'user', content: question }, { role: 'assistant', content: answer })
      writeFileSync(output, JSON.stringify({ progress: i + 1, report, usage }, null, 2), 'utf8')
    }
  } finally {
    const summary = { rounds: report.length, nodes: db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n,
      blocks: db.prepare('SELECT COUNT(*) AS n FROM note_blocks').get().n, usage }
    writeFileSync(output, JSON.stringify({ summary, report }, null, 2), 'utf8')
    handle.close()
  }
  app.exit(report.length === 20 ? 0 : 1)
}).catch((error) => {
  mkdirSync(join(errorOutput, '..'), { recursive: true })
  writeFileSync(errorOutput, error instanceof Error ? error.stack ?? error.message : String(error), 'utf8')
  app.exit(1)
})
