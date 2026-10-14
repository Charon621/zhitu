/** 第 1 步笔记对抗性验证；内存数据库和本机假模型，不读取用户数据。 */
const { buildSync } = require('esbuild')
const { createServer } = require('node:http')
const { Module } = require('node:module')
const { join } = require('node:path')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const Database = require('better-sqlite3')

const root = join(__dirname, '..')
function loadSource(path) {
  const filename = join(root, path)
  const bundle = buildSync({
    entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false,
    tsconfig: join(root, 'tsconfig.node.json'), external: ['better-sqlite3', 'zod']
  })
  const loaded = new Module(filename + '.cjs', module)
  loaded.filename = filename + '.cjs'
  loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(bundle.outputFiles[0].text, loaded.filename)
  return loaded.exports
}

const { openDatabase } = loadSource('src/main/core/db.ts')
const { NoteService } = loadSource('src/main/core/notes.ts')
const { Store } = loadSource('src/main/core/store.ts')
const { WorkingSetService } = loadSource('src/main/core/working-set.ts')
const { HomewardService } = loadSource('src/main/core/homeward.ts')
const results = []
let sequence = 0
let server = null
let baseURL = ''
let responses = []
let lastModelInput = ''
let lastExtractionInput = ''
let verificationResponses = []

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail: condition ? '' : detail })
}

function payload(blocks = [], patch = {}) {
  return JSON.stringify({
    hasNewContent: blocks.length > 0,
    blocks,
    nodeAction: blocks.length ? 'create' : 'none',
    nodePatch: { title: blocks.length ? 'softmax 为什么减最大值' : '', masteryDelta: 1 },
    edges: [],
    discarded: blocks.length ? [] : [{ reason: '无新信息' }],
    ...patch
  })
}

function block(content, blockType = 'claim', groundedIn = 'conversation') {
  return { blockType, content, groundedIn, isNewRelativeToExisting: true }
}

function fixture(userText = 'softmax 为什么减最大值？', assistantText = '减去最大值能避免指数溢出，分子分母同乘相同因子，结果保持不变。') {
  sequence++
  const handle = openDatabase(':memory:')
  const db = handle.db
  const topicId = `topic-${sequence}`
  const sessionId = `session-${sequence}`
  const userId = `user-${sequence}`
  const assistantId = `assistant-${sequence}`
  const now = new Date().toISOString()
  db.prepare('INSERT INTO topics (id, title, created_at) VALUES (?, ?, ?)').run(topicId, 'AI', now)
  db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, topicId, 'AI', now)
  db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, sessionId, 'user', userText, now)
  db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(assistantId, sessionId, 'assistant', assistantText, now)
  const notes = new NoteService(db, new Store(db), () => ({ baseURL, apiKey: 'sk-local-test', model: 'mock' }))
  return { db, close: handle.close, notes, topicId, sessionId, userId, assistantId, now }
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
}

function status(db, turnId) {
  return db.prepare('SELECT status FROM extractions WHERE turn_id = ?').get(turnId)?.status
}

async function startProvider() {
  server = createServer((request, response) => {
    const parts = []
    request.on('data', (part) => parts.push(part))
    request.on('end', () => {
      let parsed = {}
      try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { /* invalid request checked elsewhere */ }
      lastModelInput = parsed.messages?.at(-1)?.content ?? ''
      const isVerification = parsed.messages?.[0]?.content?.includes('矛盾核对员')
      if (!isVerification) lastExtractionInput = lastModelInput
      // 归航请求也走同一个假服务：按用户消息里给出的支线原样回一份判定。
      if (typeof lastModelInput === 'string' && lastModelInput.includes('rootNodeId：')) {
        const roots = [...lastModelInput.matchAll(/rootNodeId：(\S+)/g)].map((match) => match[1])
        const answer = JSON.stringify({ threads: roots.map((rootNodeId) => ({ rootNodeId, isClosed: false,
          conclusion: '', stoppedAt: `停在 ${rootNodeId}`, nextStep: `继续问 ${rootNodeId}` })) })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: answer } }] }))
        return
      }
      const candidateCount = isVerification ? JSON.parse(lastModelInput).candidateBlocks?.length ?? 0 : 0
      const answer = isVerification
        ? (verificationResponses.shift() ?? JSON.stringify({ approved: Array(candidateCount).fill(true), reasons: Array(candidateCount).fill('') }))
        : (responses.shift() ?? payload([]))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: answer } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${server.address().port}`
}

async function stopProvider() {
  if (!server) return
  await new Promise((resolve) => server.close(resolve))
  server = null
}

async function run() {
  await startProvider()

  {
    const f = fixture('谢谢', '不客气。')
    const result = await f.notes.extractTurn(f.assistantId)
    check('1 谢谢不会产生笔记', result === 'skipped' && count(f.db, 'note_blocks') === 0 &&
      status(f.db, f.assistantId) === 'skipped')
    f.close()
  }

  {
    const f = fixture('这个问题呢？', '这是个好问题，让我们来看看。这确实很有意思。')
    const bad = payload([block('本段讨论了这个问题，值得注意的是它很重要。')])
    responses = [bad, bad]
    const result = await f.notes.extractTurn(f.assistantId)
    const saved = f.db.prepare('SELECT status, payload_json FROM extractions WHERE turn_id = ?').get(f.assistantId)
    check('2 客套空话只被丢弃，不拖垮整轮抽取', result === 'skipped' && count(f.db, 'note_blocks') === 0 &&
      saved?.status === 'skipped' && JSON.parse(saved.payload_json).discarded.some((item) => item.reason.includes('元话语')))
    f.close()
  }

  {
    const f = fixture()
    responses = [payload([block('减去最大值可避免指数溢出，而且不改变 softmax 结果。')])]
    const first = await f.notes.extractTurn(f.assistantId)
    const second = await f.notes.extractTurn(f.assistantId)
    check('3 同一轮重复抽取不会新增块', first === 'ok' && second === 'skipped' &&
      count(f.db, 'note_blocks') === 1 && count(f.db, 'extractions') === 1)
    f.close()
  }

  {
    const f = fixture('性能如何？', '大概快十倍，但没有给出测量条件。')
    const bad = payload([block('这个算法大概快十倍。')])
    responses = [bad, bad]
    const result = await f.notes.extractTurn(f.assistantId)
    check('4 无依据的模糊数字不能进 claim', result === 'skipped' && count(f.db, 'note_blocks') === 0)
    f.close()
  }

  {
    const f = fixture('性能如何？', '大概快十倍，但没有给出测量条件。')
    const overconfident = payload([block('这个算法快十倍。')])
    responses = [overconfident, overconfident]
    const result = await f.notes.extractTurn(f.assistantId)
    check('存疑数字去掉限定词后仍不能进断言', result === 'skipped' && count(f.db, 'note_blocks') === 0)
    f.close()
  }

  {
    const f = fixture('头越多越好吗？', '要看总维度与任务，没有一个通用头数。')
    const bad = payload([block('头数增加必然提高参数量。'), block('实践中常用 8 到 16 头。', 'example')])
    responses = [bad, bad]
    const result = await f.notes.extractTurn(f.assistantId)
    check('绝对化断言和无出处经验数字不进笔记', result === 'skipped' && count(f.db, 'note_blocks') === 0)
    f.close()
  }

  {
    const f = fixture('请解释清楚', '只有输入有限且最大值有限时，减最大值才让指数最大项变成一。'.repeat(12))
    responses = [payload([block('当输入和最大值均有限时，减最大值使指数最大项为 1，其他项不大于 1；分子分母同乘一因子，结果不变。')])]
    const result = await f.notes.extractTurn(f.assistantId)
    const content = f.db.prepare('SELECT content_md FROM note_blocks').get()?.content_md ?? ''
    check('5 长解释压到 120 字且保留条件', result === 'ok' && [...content].length <= 120 &&
      content.includes('均有限') && content.length < f.db.prepare('SELECT content FROM turns WHERE id = ?').get(f.assistantId).content.length)
    f.close()
  }

  {
    const f = fixture()
    responses = [payload([block('减去最大值可避免指数溢出，而且不改变 softmax 结果。')])]
    await f.notes.extractTurn(f.assistantId)
    for (let n = 2; n <= 5; n++) {
      const userId = `same-user-${n}`
      const assistantId = `same-assistant-${n}`
      f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, f.sessionId, 'user', '还是这个点，能再解释吗？', f.now)
      f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(assistantId, f.sessionId, 'assistant', '这仍然是对同一个数值稳定性问题的解释。', f.now)
      responses = [payload([])]
      await f.notes.extractTurn(assistantId)
    }
    check('6 连续五轮同一点只留一节点一块', count(f.db, 'nodes') === 1 &&
      count(f.db, 'note_blocks') === 1)
    f.close()
  }

  {
    const f = fixture()
    responses = [payload([block('第一问的核心结论。')])]
    await f.notes.extractTurn(f.assistantId)
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('rebuild-user-2', f.sessionId, 'user', '第二个独立问题？', f.now)
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('rebuild-assistant-2', f.sessionId, 'assistant', '第二问的核心结论。', f.now)
    responses = [payload([block('第二问的核心结论。')], {
      nodePatch: { title: '第二个独立问题', masteryDelta: 1 }
    })]
    await f.notes.extractTurn('rebuild-assistant-2')
    const originalTurns = count(f.db, 'turns')
    responses = [
      payload([block('重整后的第一问结论。')], { nodePatch: { title: '重整后的第一张卡', masteryDelta: 1 } }),
      payload([block('重整后的第二问结论。')], { nodePatch: { title: '重整后的第二张卡', masteryDelta: 1 } })
    ]
    const result = await f.notes.recalculateSession(f.sessionId)
    const nodes = f.db.prepare('SELECT id, title FROM nodes ORDER BY created_at, id').all()
    const edge = f.db.prepare("SELECT 1 FROM edges WHERE type = 'parent' AND src_id = ? AND dst_id = ?")
      .get(nodes[0]?.id, nodes[1]?.id)
    check('重算可把旧的合并卡拆开，原始对话保留且不留空节点', result.ok === 2 &&
      nodes.length === 2 && !!edge && nodes[0].title === '重整后的第一张卡' &&
      nodes[1].title === '重整后的第二张卡' && count(f.db, 'turns') === originalTurns)
    f.close()
  }

  {
    const f = fixture()
    responses = [payload([block('第一轮记下的条件。')])]
    await f.notes.extractTurn(f.assistantId)
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('merge-user-2', f.sessionId, 'user', '同一个问题再补一个条件。', f.now)
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('merge-assistant-2', f.sessionId, 'assistant', '第二轮补充的条件。', f.now)
    responses = [payload([block('第二轮补充的条件。')])]
    await f.notes.extractTurn('merge-assistant-2')
    responses = [
      payload([block('重整后的第一轮条件。')]),
      payload([block('重整后的第二轮条件。')], { nodeAction: 'update' })
    ]
    const result = await f.notes.recalculateSession(f.sessionId)
    const node = f.db.prepare('SELECT mastery FROM nodes').get()
    check('重算把同一知识点的新旧轮次合并到当前卡且掌握度不丢', result.ok === 2 &&
      count(f.db, 'nodes') === 1 && count(f.db, 'note_blocks') === 2 && node?.mastery === 2)
    f.close()
  }

  {
    const f = fixture()
    responses = [payload([
      block('减去最大值可避免指数溢出，而且不改变 softmax 结果。'),
      block('这个算法大概快十倍。')
    ])]
    const result = await f.notes.extractTurn(f.assistantId)
    const saved = f.db.prepare('SELECT payload_json FROM extractions WHERE turn_id = ?').get(f.assistantId)
    check('单条不可靠候选被丢弃，可靠笔记仍可入库', result === 'ok' && count(f.db, 'note_blocks') === 1 &&
      JSON.parse(saved.payload_json).discarded.some((item) => item.reason.includes('模糊数字')))
    f.close()
  }

  {
    const f = fixture()
    responses = [payload([block('减去最大值可避免指数溢出，而且不改变 softmax 结果。')])]
    await f.notes.extractTurn(f.assistantId)
    const secondUserId = 'path-user-2'
    const secondAssistantId = 'path-assistant-2'
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(secondUserId, f.sessionId, 'user', '反向传播怎样计算梯度？', f.now)
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(secondAssistantId, f.sessionId, 'assistant', '反向传播按链式法则逐层计算损失对参数的梯度。', f.now)
    responses = [payload([block('反向传播按链式法则逐层计算损失对参数的梯度。')], {
      nodePatch: { title: '反向传播怎样计算梯度', masteryDelta: 1 }
    })]
    await f.notes.extractTurn(secondAssistantId)
    const firstNode = f.db.prepare('SELECT node_id FROM extractions WHERE turn_id = ?').get(f.assistantId).node_id
    const secondNode = f.db.prepare('SELECT node_id FROM extractions WHERE turn_id = ?').get(secondAssistantId).node_id
    const pathEdge = f.db.prepare("SELECT 1 FROM edges WHERE src_id = ? AND dst_id = ? AND type = 'parent'")
      .get(firstNode, secondNode)

    const otherSession = 'separate-session'
    f.db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
      .run(otherSession, f.topicId, '另一个学习场次', f.now)
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('separate-user', otherSession, 'user', '注意力机制怎样分配权重？', f.now)
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('separate-assistant', otherSession, 'assistant', '注意力按查询和键的相关程度计算权重，再汇总对应的值。', f.now)
    responses = [payload([block('注意力按查询和键的相关程度计算权重，再汇总对应的值。')], {
      nodePatch: { title: '注意力怎样分配权重', masteryDelta: 1 }
    })]
    await f.notes.extractTurn('separate-assistant')
    const separateNode = f.db.prepare('SELECT node_id FROM extractions WHERE turn_id = ?')
      .get('separate-assistant').node_id
    const crossSessionEdge = f.db.prepare("SELECT 1 FROM edges WHERE type = 'parent' AND dst_id = ?")
      .get(separateNode)
    check('独立问题分卡并按本场追问连线，另一个场次另起根节点', !!pathEdge &&
      firstNode !== secondNode && !crossSessionEdge && count(f.db, 'nodes') === 3)
    f.close()
  }

  {
    const f = fixture('第一问', '第一轮讲清了输入条件。')
    for (let n = 2; n <= 7; n++) {
      f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`batch-user-${n}`, f.sessionId, 'user', `第${n}问`, f.now)
      f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`batch-assistant-${n}`, f.sessionId, 'assistant', `第${n}轮补充了具体条件。`, f.now)
    }
    responses = [payload([block('七轮短回复合起来说明输入条件与数值稳定性的关系。')])]
    const result = await f.notes.extractTurn('batch-assistant-7')
    const covered = f.db.prepare("SELECT COUNT(*) AS n FROM extractions WHERE status = 'skipped'").get().n
    check('七轮短回复合并抽取且前六轮标记已覆盖', result === 'ok' &&
      lastExtractionInput.includes('第一轮讲清了输入条件') && lastExtractionInput.includes('第7轮补充') &&
      covered === 6 && count(f.db, 'note_blocks') === 1)
    f.close()
  }

  {
    const f = fixture('推理时有未来词吗？', '未来词尚未生成，本就不可见。')
    responses = [payload([block('推理时未来词尚未生成，本就不可见。')])]
    await f.notes.extractTurn(f.assistantId)
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('conflict-user', f.sessionId, 'user', '推理时还要遮罩吗？', f.now)
    f.db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('conflict-assistant', f.sessionId, 'assistant', '不遮就会看到尚未生成的未来词。', f.now)
    responses = [payload([block('推理时不遮会关注尚未生成的未来词。')])]
    verificationResponses = [JSON.stringify({ approved: [false], reasons: ['旧笔记说未来词尚不存在，新笔记却说会关注它'] })]
    const result = await f.notes.extractTurn('conflict-assistant')
    const extra = f.db.prepare('SELECT payload_json FROM extractions WHERE turn_id = ?').get('conflict-assistant')
    check('矛盾核对拒绝新断言且保留旧笔记', result === 'skipped' &&
      lastExtractionInput.includes('本场最近的笔记') && lastExtractionInput.includes('未来词尚未生成') &&
      JSON.parse(extra.payload_json).discarded.some((item) => item.reason.includes('矛盾核对')) &&
      count(f.db, 'note_blocks') === 1)
    f.close()
  }

  {
    const f = fixture('第 3 页说了什么？', '第 3 页说明减最大值可避免指数计算溢出。')
    const quote = '减去最大值可避免指数计算溢出'
    f.db.prepare(`INSERT INTO attachments
      (id, session_id, kind, original_name, stored_path, bytes, sha256, extract_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('pdf-1', f.sessionId, 'pdf', '讲义.pdf', 'attachments/example.pdf', 100, 'hash-1', 'ok', f.now)
    f.db.prepare('INSERT INTO chunks (id, attachment_id, ordinal, text, page) VALUES (?, ?, ?, ?, ?)')
      .run('chunk-1', 'pdf-1', 1, `这里说明：${quote}。`, 3)
    f.db.prepare(`INSERT INTO nodes (id, topic_id, title, kind, status, created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, 'resource', 'gathered', ?, ?, ?)`).run('resource-1', f.topicId, '讲义.pdf', f.now, f.now, f.now)
    f.db.prepare('UPDATE attachments SET resource_node_id = ? WHERE id = ?').run('resource-1', 'pdf-1')
    f.db.prepare('INSERT INTO turn_meta (turn_id, attachment_ids_json) VALUES (?, ?)')
      .run(f.userId, JSON.stringify(['pdf-1']))
    responses = [payload([block(quote, 'source_quote', 'document:1')])]
    const result = await f.notes.extractTurn(f.assistantId)
    const card = f.notes.listSessionCards(f.sessionId)[0]
    check('7 PDF 原文引用回指正确页码', result === 'ok' &&
      card?.blocks?.[0]?.source_page === 3 && card.blocks[0].source_name === '讲义.pdf' &&
      card.blocks[0].origin_chunk_ids_json === '["chunk-1"]' &&
      card.kind === 'resource' && card.id === 'resource-1' && count(f.db, 'nodes') === 1)
    f.close()
  }

  {
    const f = fixture()
    const bad = payload([block('- 这样写成项目符号是违规的。')])
    responses = [bad, bad]
    const result = await f.notes.extractTurn(f.assistantId)
    check('符号列表候选只被丢弃', result === 'skipped' && count(f.db, 'note_blocks') === 0)
    f.close()
  }

  {
    const f = fixture()
    const bad = payload([block('本段讨论了 softmax 的作用。')])
    responses = [bad, bad]
    const result = await f.notes.extractTurn(f.assistantId)
    check('元话语候选只被丢弃', result === 'skipped' && count(f.db, 'note_blocks') === 0)
    f.close()
  }

  {
    const f = fixture()
    await stopProvider()
    const failed = await f.notes.extractTurn(f.assistantId)
    const originalTurns = count(f.db, 'turns')
    await startProvider()
    responses = [payload([block('减去最大值可避免指数溢出，而且不改变 softmax 结果。')])]
    const retried = await f.notes.extractTurn(f.assistantId)
    check('10 断网只让抽取失败，恢复后可重试', failed === 'failed' &&
      originalTurns === 2 && retried === 'ok' && count(f.db, 'turns') === 2 &&
      count(f.db, 'note_blocks') === 1)
    f.close()
  }

  {
    const path = join(mkdtempSync(join(tmpdir(), 'zhitu-v1-migration-')), 'old.db')
    const old = new Database(path)
    old.exec(`
      CREATE TABLE topics(id TEXT PRIMARY KEY, title TEXT, goal_kind TEXT, created_at TEXT, archived_at TEXT);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, topic_id TEXT, title TEXT, started_at TEXT, ended_at TEXT, summary_md TEXT);
      CREATE TABLE turns(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT);
      CREATE TABLE nodes(id TEXT PRIMARY KEY, topic_id TEXT, title TEXT, body_md TEXT);
      CREATE TABLE extractions(id TEXT PRIMARY KEY, turn_id TEXT, node_id TEXT, status TEXT, payload_json TEXT, error TEXT, attempt INTEGER, created_at TEXT, updated_at TEXT);
      INSERT INTO topics(id,title) VALUES ('old-topic','旧主题');
      INSERT INTO sessions(id,topic_id,title) VALUES ('old-session','old-topic','旧场次');
      INSERT INTO turns(id,session_id,role,content) VALUES ('old-turn','old-session','user','旧对话不能丢');
      PRAGMA user_version = 1;
    `)
    old.close()
    const migrated = openDatabase(path)
    const kept = migrated.db.prepare("SELECT content FROM turns WHERE id = 'old-turn'").get()?.content
    const indexed = migrated.db.prepare("SELECT ref_id FROM search_fts WHERE text MATCH '旧对话'").get()?.ref_id
    const columns = migrated.db.pragma('table_info(sessions)').map((column) => column.name)
    check('v1 数据库原地升级并保留原始对话', migrated.db.pragma('user_version', { simple: true }) === 10 &&
      kept === '旧对话不能丢' && indexed === 'old-turn' && columns.includes('archived_at'))
    migrated.close()
  }

  {
    // v6 是最接近的一版：sessions 还没有 archived_at。
    // 这条守住"老用户升级不会因为重复加列而打不开软件"。
    const path = join(mkdtempSync(join(tmpdir(), 'zhitu-v6-migration-')), 'old.db')
    const old = new Database(path)
    old.exec(`
      CREATE TABLE sessions(id TEXT PRIMARY KEY, topic_id TEXT, title TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, summary_md TEXT);
      INSERT INTO sessions(id,title,started_at) VALUES ('v6-session','旧场次','2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 6;
    `)
    old.close()
    const migrated = openDatabase(path)
    const columns = migrated.db.pragma('table_info(sessions)').map((column) => column.name)
    const archived = migrated.db.prepare('SELECT archived_at FROM sessions WHERE id = ?').get('v6-session')
    check('v6 老库能补上归档字段并保住原有场次',
      migrated.db.pragma('user_version', { simple: true }) === 10 &&
      columns.includes('archived_at') && archived !== undefined && archived.archived_at === null)
    migrated.close()
  }

  {
    const f = fixture('把这个记下来：有限输入时减最大值不改变 softmax 结果。', '好的，我会记下。')
    f.notes.rememberUserNote(f.sessionId, f.userId, '有限输入时减最大值不改变 softmax 结果。')
    const saved = f.db.prepare('SELECT block_type, content_md, edited_by_user FROM note_blocks').get()
    check('用户要求记下时无条件创建 user_note', count(f.db, 'nodes') === 1 &&
      saved?.block_type === 'user_note' && saved.edited_by_user === 1 && saved.content_md.includes('有限输入'))
    f.close()
  }

  {
    const f = fixture()
    f.notes.rememberUserNote(f.sessionId, f.userId, '我原来的理解。')
    const id = f.db.prepare('SELECT id FROM note_blocks').get().id
    const changed = f.notes.editBlock(id, '我亲自改过的理解。')
    const row = f.db.prepare('SELECT content_md, edited_by_user FROM note_blocks WHERE id = ?').get(id)
    check('手改笔记标记为用户编辑并保留内容', changed && row.content_md === '我亲自改过的理解。' &&
      row.edited_by_user === 1)
    f.close()
  }

  {
    const f = fixture()
    f.notes.rememberUserNote(f.sessionId, f.userId, '不想再看这条。')
    const id = f.db.prepare('SELECT id FROM note_blocks').get().id
    const deleted = f.notes.deleteBlock(id)
    check('删除笔记从卡片与搜索隐藏但留删除标记', deleted && f.notes.listSessionCards(f.sessionId).length === 0 &&
      f.db.prepare('SELECT deleted_by_user FROM note_blocks WHERE id = ?').get(id).deleted_by_user === 1 &&
      f.db.prepare("SELECT COUNT(*) AS n FROM search_fts WHERE ref_kind = 'note_block' AND ref_id = ?").get(id).n === 0)
    f.close()
  }

  {
    const f = fixture()
    f.notes.rememberUserNote(f.sessionId, f.userId, '重要内容。')
    const id = f.db.prepare('SELECT id FROM note_blocks').get().id
    const pinned = f.notes.setPinned(id, true)
    check('用户可置顶笔记块', pinned && f.notes.listSessionCards(f.sessionId)[0].blocks[0].pinned === 1)
    f.close()
  }

  {
    const f = fixture()
    responses = [payload([block('减去最大值可避免指数溢出，而且不改变 softmax 结果。')])]
    await f.notes.extractTurn(f.assistantId)
    responses = [payload([block('指数先减去最大值，最大项成为 1，计算时更稳定且归一化结果不变。')])]
    const result = await f.notes.recalculateSession(f.sessionId)
    const notes = f.db.prepare('SELECT content_md FROM note_blocks').all()
    check('重算成功后原子替换自动笔记且不动对话', result.ok === 1 && notes.length === 1 &&
      notes[0].content_md.includes('最大项成为 1') && count(f.db, 'turns') === 2)
    f.close()
  }

  {
    const f = fixture()
    const original = '减去最大值可避免指数溢出，而且不改变 softmax 结果。'
    responses = [payload([block(original)])]
    await f.notes.extractTurn(f.assistantId)
    const invalid = payload([block('本段讨论了 softmax。')])
    responses = [invalid, invalid]
    const result = await f.notes.recalculateSession(f.sessionId)
    const saved = f.db.prepare('SELECT content_md FROM note_blocks').get()?.content_md
    const mastery = f.db.prepare('SELECT mastery FROM nodes').get()?.mastery
    check('重算遇到无效候选保留旧笔记、掌握度和原始对话', result.skipped === 1 &&
      saved === original && mastery === 1 && count(f.db, 'turns') === 2)
    f.close()
  }

  {
    // 一个主题下可以有很多场学习。这三项守住"场次归属"这条线：
    // 工作集、归航、未收线清单都不能把别的场次的节点当成这一场的。
    const db = openDatabase(':memory:').db
    const now = new Date().toISOString()
    db.prepare('INSERT INTO topics (id, title, goal_kind, created_at) VALUES (?, ?, ?, ?)')
      .run('cross-topic', 'AI 入门', 'principle', now)
    const addTurn = (id, sessionId, role, content) =>
      db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, sessionId, role, content, now)
    const addNode = (id, title, kind, status, turnId) =>
      db.prepare(`INSERT INTO nodes (id, topic_id, title, kind, status, mastery, origin_turn_id,
        created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
        .run(id, 'cross-topic', title, kind, status, turnId, now, now, now)

    db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
      .run('cross-ses-A', 'cross-topic', '第一场', now)
    addTurn('cross-uA', 'cross-ses-A', 'user', '梯度下降为什么要乘学习率？')
    addTurn('cross-aA', 'cross-ses-A', 'assistant', '学习率决定每一步走多远，太大就会跨过最低点。')
    addNode('cross-node-A', '梯度下降的学习率', 'question', 'open', 'cross-uA')
    db.prepare(`INSERT INTO extractions (id, turn_id, node_id, status, attempt, created_at, updated_at)
      VALUES (?, ?, ?, 'ok', 1, ?, ?)`).run('cross-ext-A', 'cross-aA', 'cross-node-A', now, now)

    db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
      .run('cross-ses-B', 'cross-topic', '第二场', now)
    addTurn('cross-uB', 'cross-ses-B', 'user', '注意力是怎么算权重的？')
    addTurn('cross-aB', 'cross-ses-B', 'assistant', '按查询和键的相关程度算权重，再汇总对应的值。')
    addNode('cross-node-B', '注意力的权重计算', 'question', 'open', 'cross-uB')
    // 概念型节点也要能被收线：标题里没有问题词，kind 会是 concept。
    addNode('cross-node-C', '残差连接', 'concept', 'open', 'cross-uB')
    db.prepare(`INSERT INTO extractions (id, turn_id, node_id, status, attempt, created_at, updated_at)
      VALUES (?, ?, ?, 'ok', 1, ?, ?)`).run('cross-ext-B', 'cross-aB', 'cross-node-B', now, now)

    const workingSet = new WorkingSetService(db, new Store(db))
    const assembled = workingSet.assemble('cross-ses-A', 'cross-topic', '那学习率太大会怎么样？', '系统提示词')
    check('工作集的当前知识点只来自本场', assembled.context.includes('梯度下降的学习率') &&
      !assembled.context.includes('注意力的权重计算'),
    assembled.context.replace(/\n/g, ' ').slice(0, 160))

    const homeward = new HomewardService(db, new Store(db),
      () => ({ baseURL, apiKey: 'sk-local-test', model: 'mock' }))
    const ended = await homeward.evaluate('cross-ses-B')
    check('归航只判定本场的支线', ended.results.length === 2 &&
      ended.results.every((row) => row.rootNodeId !== 'cross-node-A') &&
      ended.results.some((row) => row.rootNodeId === 'cross-node-B'),
    ended.results.map((row) => row.rootNodeId).join(', '))

    const open = homeward.listOpen()
    check('未收线清单包含 concept 节点且不收别的场次',
      open.some((row) => row.id === 'cross-node-C') && open.some((row) => row.id === 'cross-node-A') &&
      homeward.close('cross-node-C', 'mastered'))
    db.close()
  }

  {
    // 历史记录管理：删除的粒度是"删对话 + 它独占的知识点"。
    // 关键在于"独占"怎么算：别的场次还在用的点必须留下，
    // 否则回到旧场次追问过的知识点会被连带删掉，那张地图就断了。
    const handle = openDatabase(':memory:')
    const db = handle.db
    const store = new Store(db)
    const now = new Date().toISOString()
    db.prepare('INSERT INTO topics (id, title, goal_kind, created_at) VALUES (?, ?, ?, ?)')
      .run('del-topic', 'AI 入门', 'principle', now)
    const addSession = (id, title) => db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
      .run(id, 'del-topic', title, now)
    const addTurn = (id, sessionId, role, content) =>
      db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, sessionId, role, content, now)
    const addNode = (id, title, turnId) => db.prepare(`INSERT INTO nodes
      (id, topic_id, title, kind, status, origin_turn_id, created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, 'question', 'open', ?, ?, ?, ?)`).run(id, 'del-topic', title, turnId, now, now, now)
    const link = (turnId, nodeId) => db.prepare(`INSERT INTO extractions
      (id, turn_id, node_id, status, attempt, created_at, updated_at) VALUES (?, ?, ?, 'ok', 1, ?, ?)`)
      .run(`ext-${turnId}-${nodeId}`, turnId, nodeId, now, now)

    addSession('del-ses-A', '要删掉的那一场')
    addTurn('del-uA', 'del-ses-A', 'user', 'softmax 为什么要减最大值？')
    addTurn('del-aA', 'del-ses-A', 'assistant', '减去最大值能避免指数溢出。')
    addTurn('del-aA2', 'del-ses-A', 'assistant', '同一个点还可以这样理解。')
    addNode('del-node-only', '只有这一场建的点', 'del-uA')
    link('del-aA', 'del-node-only')

    addSession('del-ses-B', '另一场还在用')
    addTurn('del-uB', 'del-ses-B', 'user', '那这个点还能再讲讲吗？')
    addTurn('del-aB', 'del-ses-B', 'assistant', '可以，接着讲。')
    addNode('del-node-shared', '两场共用的点', 'del-uA')
    // 同一轮只能有一条抽取记录（extractions.turn_id 唯一），所以共用点挂在另一轮上。
    link('del-aA2', 'del-node-shared')
    link('del-aB', 'del-node-shared')
    db.prepare(`INSERT INTO note_blocks (id, node_id, block_type, content_md, ordinal, origin_turn_id, created_at, updated_at)
      VALUES (?, ?, 'claim', ?, 1, ?, ?, ?)`).run('del-blk-1', 'del-node-only', '独占点的笔记', 'del-aA', now, now)
    db.prepare('INSERT INTO attachments (id, session_id, kind, original_name, stored_path, bytes, sha256, extract_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('del-att', 'del-ses-A', 'txt', '资料.txt', 'attachments/ab/abc.txt', 10, 'hash', 'ok', now)

    const preview = store.deletionPreview('del-ses-A')
    check('删除预演分清了会删和会留', preview?.turns === 3 && preview.leaves === 1 &&
      preview.keeps === 1 && preview.notes === 1 && preview.nodes[0] === '只有这一场建的点' &&
      preview.attachments === 1, JSON.stringify(preview))

    const removed = store.deleteSession('del-ses-A')
    check('删除只带走这一场独占的知识点', removed.ok && removed.deletedNodes === 1 &&
      !db.prepare('SELECT 1 FROM nodes WHERE id = ?').get('del-node-only') &&
      !!db.prepare('SELECT 1 FROM nodes WHERE id = ?').get('del-node-shared') &&
      !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('del-ses-A'),
    JSON.stringify(removed))

    check('删完之后别的场次仍然可用', !!store.getSession('del-ses-B') &&
      store.sessionNodeIds('del-ses-B').has('del-node-shared') &&
      db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?').get('del-ses-B').n === 2 &&
      db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE topic_id = ?').get('del-topic').n === 1)

    // 归档：数据一条不动，只是从"未归档"列表里消失。
    store.setArchived('del-ses-B', true)
    check('归档不动数据只改标记', !!store.getSession('del-ses-B')?.archived_at &&
      db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?').get('del-ses-B').n === 2 &&
      store.latestSession()?.id !== 'del-ses-B' &&
      store.listArchivedSessions().some((row) => row.id === 'del-ses-B'))
    store.setArchived('del-ses-B', false)
    check('取消归档后重新回到列表', store.getSession('del-ses-B')?.archived_at === null)

    // 主题是地图的单位：只剩空主题时一起清掉，免得地图下拉框里堆一串空主题。
    // 用一个干净的例子单独验，避免和上面"知识点比对话活得久"那条混在一起。
    db.prepare('INSERT INTO topics (id, title, goal_kind, created_at) VALUES (?, ?, ?, ?)')
      .run('del-topic-2', '只有一场的主题', 'casual', now)
    db.prepare('INSERT INTO sessions (id, topic_id, title, started_at) VALUES (?, ?, ?, ?)')
      .run('del-ses-C', 'del-topic-2', '单独一场', now)
    addTurn('del-uC', 'del-ses-C', 'user', '随便问一句')
    store.deleteSession('del-ses-C')
    check('删掉最后一场且无知识点时主题一起清理',
      !db.prepare('SELECT 1 FROM topics WHERE id = ?').get('del-topic-2') &&
      !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('del-ses-C'))

    // 把两场都删掉。共用点没有"独占"于任何一场，所以它和主题都应该留下——
    // 这正是这个粒度选择的含义：知识能比产生它的那场对话活得更久。
    store.deleteSession('del-ses-B')
    if (process.env.ZHITU_DEBUG_NOTES) {
      console.log('[DBG] after final delete: topics', JSON.stringify(db.prepare('SELECT id FROM topics').all()),
        'sessions', JSON.stringify(db.prepare('SELECT id FROM sessions').all()),
        'nodes', JSON.stringify(db.prepare('SELECT id FROM nodes').all()))
    }
    check('删光两场后共用知识点与主题都留下', db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n === 0 &&
      !!db.prepare('SELECT 1 FROM nodes WHERE id = ?').get('del-node-shared') &&
      !!db.prepare('SELECT 1 FROM topics WHERE id = ?').get('del-topic'))

    db.close()
  }

  await stopProvider()
}

run().catch((error) => {
  check('对抗性验证过程没有异常', false, error instanceof Error ? error.stack : String(error))
}).finally(async () => {
  await stopProvider()
  const lines = ['──── 笔记对抗性验证 ────']
  for (const result of results) lines.push(`  ${result.ok ? '✓' : '✕'} ${result.name}${result.detail ? `  —  ${result.detail}` : ''}`)
  lines.push(`共 ${results.length} 项，失败 ${results.filter((item) => !item.ok).length} 项`)
  console.log(lines.join('\n'))
  process.exit(results.length === 36 && results.every((item) => item.ok) ? 0 : 1)
})
