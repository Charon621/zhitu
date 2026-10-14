/**
 * 历史记录删除（v0.11.0）后台专项验收。
 *
 * 只用合成数据与本机文件，不联网、不启动界面、不碰用户真实数据。
 * 覆盖：软删除可见性、回收站、恢复、独占/共享知识点、共享原件、
 * 主题保留、彻底删除预演、到期清理、批量、搜索/复习/未收线/导出/统计的排除。
 *
 * 运行：node scripts\history-regression.cjs
 * 可用 ZHITU_HISTORY_REPORT 指定报告落盘路径。
 */
const { buildSync } = require('esbuild')
const { Module } = require('node:module')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const root = join(__dirname, '..')
function load(path) {
  const file = join(root, path)
  const bundle = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['better-sqlite3', 'zod', 'jszip', 'pdfjs-dist/*', 'mammoth', 'exceljs', '@napi-rs/canvas'],
    tsconfig: join(root, 'tsconfig.node.json') })
  const m = new Module(file + '.cjs', module); m.filename = file + '.cjs'; m.paths = Module._nodeModulePaths(root)
  m._compile(bundle.outputFiles[0].text, m.filename); return m.exports
}

const { openDatabase } = load('src/main/core/db.ts')
const { Store, TRASH_RETENTION_DAYS } = load('src/main/core/store.ts')
const { AttachmentService } = load('src/main/core/attachments.ts')
const { HomewardService } = load('src/main/core/homeward.ts')
const { ReviewService } = load('src/main/core/reviews.ts')
const { SearchService } = load('src/main/core/search.ts')
const { ExportService } = load('src/main/core/exports.ts')

const results = []
const check = (name, value, detail = '') => {
  results.push({ name, ok: !!value, detail })
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}${value ? '' : `  <<< ${detail}`}`)
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'zhitu-history-'))
  const handle = openDatabase(join(dir, 'zhitu.db'))
  const db = handle.db
  const store = new Store(db, dir)
  const attachments = new AttachmentService(db, dir)
  const homeward = new HomewardService(db, store, () => ({ baseURL: '', apiKey: '', model: '' }))
  const reviews = new ReviewService(db, () => ({ baseURL: '', apiKey: '', model: '' }))
  const search = new SearchService(db)
  const exportsService = new ExportService(db, dir)

  const now = '2026-01-01T00:00:00.000Z'
  const insert = (sql, ...args) => db.prepare(sql).run(...args)

  // ── 合成世界：两个主题、三场学习、独占与共享的知识点、共享的原件 ──
  insert('INSERT INTO topics(id,title,goal_kind,created_at) VALUES(?,?,?,?)', 't1', '合成主题一', 'principle', now)
  insert('INSERT INTO topics(id,title,goal_kind,created_at) VALUES(?,?,?,?)', 't2', '合成主题二', 'principle', now)
  insert('INSERT INTO sessions(id,topic_id,title,started_at) VALUES(?,?,?,?)', 'A', 't1', '旧的一场 A', '2026-01-01T00:00:00.000Z')
  insert('INSERT INTO sessions(id,topic_id,title,started_at) VALUES(?,?,?,?)', 'B', 't1', '新的一场 B', '2026-02-01T00:00:00.000Z')
  insert('INSERT INTO sessions(id,topic_id,title,started_at) VALUES(?,?,?,?)', 'C', 't2', '独苗场次 C', '2026-03-01T00:00:00.000Z')
  insert('INSERT INTO turns(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)', 'a1', 'A', 'user', 'A 的第一问：费马小定理怎么用', '2026-01-01T00:01:00.000Z')
  insert('INSERT INTO turns(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)', 'a2', 'A', 'assistant', 'A 的回答：先看模运算', '2026-01-01T00:02:00.000Z')
  insert('INSERT INTO turns(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)', 'b1', 'B', 'user', 'B 的第一问：继续上次的模运算', '2026-02-01T00:01:00.000Z')
  insert('INSERT INTO turns(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)', 'b2', 'B', 'assistant', 'B 的回答：这次看欧拉定理', '2026-02-01T00:02:00.000Z')
  insert('INSERT INTO turns(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)', 'b3', 'B', 'assistant', 'B 又回头讲了 A 里那个共享知识点', '2026-02-01T00:03:00.000Z')
  insert('INSERT INTO turns(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)', 'c1', 'C', 'user', 'C 的问题：独苗主题里的一场', '2026-03-01T00:01:00.000Z')

  const node = (id, title, originTurn, status = 'open') => insert(`INSERT INTO nodes
    (id,topic_id,title,body_md,kind,status,mastery,origin_turn_id,created_at,updated_at,last_seen_at)
    VALUES(?,?,?,'','concept',?,0,?,?,?,?)`, id, 't1', title, status, originTurn, now, now, now)
  node('nExcl', '独占知识点', 'a2')
  node('nShare', '共享知识点', 'a2')
  node('nB', 'B 的知识点', 'b2')
  insert(`INSERT INTO nodes(id,topic_id,title,body_md,kind,status,mastery,origin_turn_id,created_at,updated_at,last_seen_at)
    VALUES('nC','t2','独苗知识点','','concept','gathered',0,'c1',?,?,?)`, now, now, now)

  insert('INSERT INTO extractions(id,turn_id,node_id,status,attempt,created_at,updated_at) VALUES(?,?,?,?,0,?,?)',
    'e1', 'a2', 'nExcl', 'ok', now, now)
  insert('INSERT INTO extractions(id,turn_id,node_id,status,attempt,created_at,updated_at) VALUES(?,?,?,?,0,?,?)',
    'e2', 'b3', 'nShare', 'ok', now, now)
  insert('INSERT INTO extractions(id,turn_id,node_id,status,attempt,created_at,updated_at) VALUES(?,?,?,?,0,?,?)',
    'e3', 'b2', 'nB', 'ok', now, now)

  const block = (id, nodeId, content, turnId) => insert(`INSERT INTO note_blocks
    (id,node_id,block_type,content_md,ordinal,origin_chunk_ids_json,origin_turn_id,pinned,edited_by_user,deleted_by_user,created_at,updated_at)
    VALUES(?,?, 'claim', ?, 0, '[]', ?, 0, 0, 0, ?, ?)`, id, nodeId, content, turnId, now, now)
  block('nb1', 'nExcl', '独占笔记', 'a2')
  block('nb2', 'nShare', '共享笔记', 'a2')
  block('nb3', 'nB', 'B 的笔记', 'b2')

  mkdirSync(join(dir, 'attachments', 'ab'), { recursive: true })
  mkdirSync(join(dir, 'attachments', 'cd'), { recursive: true })
  const ownFile = join(dir, 'attachments', 'ab', 'own.txt')
  const sharedFile = join(dir, 'attachments', 'cd', 'shared.txt')
  writeFileSync(ownFile, '只有 A 用到的原件')
  writeFileSync(sharedFile, 'A 和 B 都导入过的同一份原件')
  insert(`INSERT INTO attachments(id,session_id,kind,original_name,stored_path,bytes,sha256,extract_status,created_at)
    VALUES('attOwn','A','txt','A 独有.txt','attachments/ab/own.txt',10,'sha-own','ok',?)`, now)
  insert(`INSERT INTO attachments(id,session_id,kind,original_name,stored_path,bytes,sha256,extract_status,created_at)
    VALUES('attSharedA','A','txt','共享原件.txt','attachments/cd/shared.txt',20,'sha-shared','ok',?)`, now)
  insert(`INSERT INTO attachments(id,session_id,kind,original_name,stored_path,bytes,sha256,extract_status,created_at)
    VALUES('attSharedB','B','txt','共享原件.txt','attachments/cd/shared.txt',20,'sha-shared','ok',?)`, now)
  insert('INSERT INTO chunks(id,attachment_id,ordinal,text,page,token_estimate) VALUES(?,?,?,?,NULL,?)',
    'chk1', 'attSharedB', 1, 'B 场里引用过的切片', 10)
  insert('INSERT INTO chunks(id,attachment_id,ordinal,text,page,token_estimate) VALUES(?,?,?,?,NULL,?)',
    'chk2', 'attOwn', 1, 'A 独有的切片', 10)

  const due = new Date(Date.now() - 3600_000).toISOString()
  for (const id of ['nExcl', 'nShare', 'nB']) {
    insert('INSERT INTO reviews(node_id,due_at,interval_days,ease,lapses) VALUES(?,?,1,2.5,0)', id, due)
  }

  const nodeIds = () => new Set((store.map('t1').nodes ?? []).map((n) => n.id))
  const counts = (table, where = '') => db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get().n

  // ── 1. 移入回收站：所有读取入口都不该再看见它 ──
  const before = { turns: counts('turns'), blocks: counts('note_blocks') }
  const trashResult = store.trashSession('A')
  check('移入回收站返回被一起藏起来的独占知识点数量', trashResult.ok && trashResult.nodes === 1, `nodes=${trashResult.nodes}`)
  check('列表里看不到已删场次', !store.listSessions().some((s) => s.id === 'A') && !store.listArchivedSessions().some((s) => s.id === 'A'))
  check('"最近一场"不会停在已删场次上', store.latestSession()?.id === 'C', `latest=${store.latestSession()?.id}`)
  check('按 id 打开会被识别为回收站里的场次', store.isTrashed('A') && store.getAliveSession('A') === null)
  check('回收站列表里有它，并带删除时间', store.listTrash().some((s) => s.id === 'A' && !!s.deleted_at))
  check('统计只算活着的场次', store.stats().sessions === 2, JSON.stringify(store.stats()))

  // ── 2. 软删除不动数据 ──
  check('软删除后对话轮次一条不少', counts('turns') === before.turns)
  check('软删除后笔记一条不少', counts('note_blocks') === before.blocks)
  check('软删除后原件还在磁盘上', existsSync(ownFile) && existsSync(sharedFile))
  check('回收站占用统计能算出原件字节', store.trashStats().bytes === 30, JSON.stringify(store.trashStats()))

  // ── 3. 独占的知识点藏起来，共享的留下 ──
  const visible = nodeIds()
  check('独占知识点跟着藏起来（地图上看不到）', !visible.has('nExcl'))
  check('被别的场次用过的知识点留在原地', visible.has('nShare') && visible.has('nB'))
  check('复习到期数不含藏起来的知识点', reviews.dueCount() === 2, `due=${reviews.dueCount()}`)
  check('未收线清单不含藏起来的知识点', !homeward.listOpen().some((t) => t.id === 'nExcl') && homeward.listOpen().length === 2)
  check('全局搜索搜不到已删场次的对话', !search.find('费马').some((h) => h.kind === 'turn' && h.sessionId === 'A'))
  check('全局搜索搜不到藏起来的知识点与笔记', !search.find('独占').length, JSON.stringify(search.find('独占')))

  // ── 4. 恢复 ──
  check('恢复成功', store.restoreSession('A'))
  check('恢复后场次回到列表', store.listSessions().some((s) => s.id === 'A'))
  check('恢复后独占知识点回到地图', nodeIds().has('nExcl'))
  check('恢复后复习与未收线也跟着回来', reviews.dueCount() === 3 && homeward.listOpen().length === 3)
  check('恢复后搜索又能搜到', search.find('费马').some((h) => h.kind === 'turn' && h.sessionId === 'A'))
  check('恢复不会让共享知识点被误藏', nodeIds().has('nShare') && nodeIds().has('nB'))

  // ── 5. 独苗主题：回收站期间保留，彻底删除时才清理 ──
  store.trashSession('C')
  check('回收站期间主题不删（恢复时名字才回得来）', counts('topics', "WHERE id = 't2'") === 1)
  check('空主题不进地图下拉框', !store.map().topics.some((t) => t.id === 't2'), JSON.stringify(store.map().topics))
  store.restoreSession('C')
  check('恢复后主题仍然可用且名字还在', store.map().topics.some((t) => t.id === 't2' && t.title === '合成主题二'))

  // ── 6. 彻底删除：预演 → 真删 ──
  store.trashSession('A')
  const preview = store.deletionPreview('A')
  check('回收站里的场次仍然能给出删除预演', !!preview && preview.turns === 2 && preview.leaves === 1)
  const ownedBytes = existsSync(ownFile)
  const purged = store.purgeSession('A')
  check('彻底删除返回删除的独占知识点与原件数', purged.ok && purged.deletedNodes === 1 && purged.filesRemoved === 1,
    JSON.stringify(purged))
  check('彻底删除后场次与对话真的没了', counts('sessions', "WHERE id='A'") === 0 && counts('turns', "WHERE session_id='A'") === 0)
  check('彻底删除后独占知识点与它的笔记没了', counts('nodes', "WHERE id='nExcl'") === 0 && counts('note_blocks', "WHERE id='nb1'") === 0)
  check('彻底删除后独占原件从磁盘消失', ownedBytes && !existsSync(ownFile))
  check('共享的原件因为别的场次还在用而保留', existsSync(sharedFile))
  check('共享知识点与别的场次的笔记不受影响', counts('nodes', "WHERE id='nShare'") === 1 && counts('note_blocks', "WHERE id='nb2'") === 1)
  check('全文索引没有留下已删对话的孤儿行',
    counts('search_fts', "WHERE ref_kind='turn' AND ref_id NOT IN (SELECT id FROM turns)") === 0 &&
    counts('search_fts', "WHERE ref_kind='node' AND ref_id NOT IN (SELECT id FROM nodes)") === 0)

  // ── 7. 批量与到期清理 ──
  insert('INSERT INTO sessions(id,topic_id,title,started_at) VALUES(?,?,?,?)', 'D', 't1', '批量用场次 D', '2026-04-01T00:00:00.000Z')
  insert('INSERT INTO sessions(id,topic_id,title,started_at) VALUES(?,?,?,?)', 'E', 't1', '批量用场次 E', '2026-05-01T00:00:00.000Z')
  const batch = [store.trashSession('D'), store.trashSession('E'), store.trashSession('E')]
  check('批量删除逐场给出结果（重复删除如实失败）', batch[0].ok && batch[1].ok && !batch[2].ok)
  db.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * 86_400_000).toISOString(), 'D')
  const purgedOld = store.purgeExpiredTrash(TRASH_RETENTION_DAYS)
  check('到期清理只删过期的，没过期的留着', purgedOld === 1 && counts('sessions', "WHERE id='D'") === 0 && counts('sessions', "WHERE id='E'") === 1)

  const emptied = store.emptyTrash()
  check('清空回收站把剩下的都彻底删掉', emptied.removed === 1 && emptied.failed.length === 0 && store.listTrash().length === 0)
  check('清空后共享原件仍被保留', existsSync(sharedFile))

  // ── 8. 导出：看不见的东西不该被导出 ──
  insert('INSERT INTO sessions(id,topic_id,title,started_at) VALUES(?,?,?,?)', 'F', 't1', '导出用场次 F', '2026-06-01T00:00:00.000Z')
  insert('INSERT INTO turns(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)', 'f1', 'F', 'user', '导出检查用的对话', '2026-06-01T00:01:00.000Z')
  insert('INSERT INTO nodes(id,topic_id,title,body_md,kind,status,mastery,origin_turn_id,created_at,updated_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    'nF', 't1', '导出检查知识点', '', 'concept', 'gathered', 0, 'f1', now, now, now)
  block('nbF', 'nF', '导出检查笔记', 'f1')
  check('导出单场对回收站里的场次返回空', (() => {
    store.trashSession('F')
    return exportsService.sessionMarkdown('F') === null
  })())
  store.restoreSession('F')
  check('恢复后单场导出照常', (exportsService.sessionMarkdown('F') ?? '').includes('导出检查用的对话'))

  // ── 9. 旧行为不回归 ──
  store.renameSession('B', '改过名的 B')
  store.setArchived('B', true)
  check('改名与归档仍然有效', store.listArchivedSessions().some((s) => s.id === 'B' && s.title === '改过名的 B'))
  store.setArchived('B', false)
  const previewB = store.deletionPreview('B')
  check('删除预演仍然区分会删与会留', previewB.turns === 3 && previewB.leaves === 1 && previewB.keeps === 0 &&
    previewB.nodes.length === 1, JSON.stringify(previewB))

  handle.close()
  rmSync(dir, { recursive: true, force: true })

  const passed = results.filter((r) => r.ok).length
  const report = `${passed}/${results.length} history checks passed\n` +
    `${results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `  <<< ${r.detail}`}`).join('\n')}\n`
  if (process.env.ZHITU_HISTORY_REPORT) writeFileSync(process.env.ZHITU_HISTORY_REPORT, report)
  console.log(report)
  process.exitCode = passed === results.length ? 0 : 1
}

try { main() } catch (error) { console.error(error); process.exitCode = 1 }
