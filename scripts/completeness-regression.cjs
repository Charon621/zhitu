/** Isolated SQLite + local synthetic provider. No real user files or paid model. */
const { buildSync } = require('esbuild')
const { Module } = require('node:module')
const { join } = require('node:path')
const { mkdtempSync, readFileSync, readdirSync, renameSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const root = join(__dirname, '..')
function load(path) {
  const file = join(root, path)
  const bundle = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron', 'better-sqlite3', 'zod', 'jszip', 'pdfjs-dist/*', 'mammoth', 'exceljs', '@napi-rs/canvas'], tsconfig: join(root, 'tsconfig.node.json') })
  const m = new Module(file + '.cjs', module); m.filename = file + '.cjs'; m.paths = Module._nodeModulePaths(root)
  const requireModule = m.require.bind(m)
  m.require = id => id === 'electron' ? { safeStorage: { isEncryptionAvailable: () => false } } : requireModule(id)
  m._compile(bundle.outputFiles[0].text, m.filename); return m.exports
}
const { openDatabase } = load('src/main/core/db.ts')
const { Store } = load('src/main/core/store.ts')
const { AttachmentService } = load('src/main/core/attachments.ts')
const { LibraryService } = load('src/main/core/library.ts')
const { ExportService } = load('src/main/core/exports.ts')
const { SearchService } = load('src/main/core/search.ts')
const { BackupService } = load('src/main/core/backups.ts')
const { createServer } = load('src/main/server.ts')
let failures = 0; let passes = 0
function check(name, ok) { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'zhitu-complete-')); process.env.ZHITU_DATA_DIR = dir
  const handle = openDatabase(join(dir, 'zhitu.db')); const db = handle.db
  const store = new Store(db, dir); const attachmentService = new AttachmentService(db, dir)
  const library = new LibraryService(db, attachmentService, () => ({ baseURL: '', apiKey: '', model: '' }))
  const search = new SearchService(db); const backups = new BackupService(db, dir)
  const topic = store.createTopic('完整性合成验收', 'principle')
  for (let i = 0; i < 120; i++) {
    const session = store.createSession(`课程 ${i} ${i === 0 ? '最早哨兵' : ''}`, topic)
    db.prepare('UPDATE sessions SET started_at=? WHERE id=?').run(new Date(Date.now() + i * 1000).toISOString(), session.id)
    if (i % 3 === 0) store.setArchived(session.id, true)
  }
  const pages = [0, 25, 50, 75].flatMap(offset => store.historyPage('', 'active', offset, 25).sessions)
  check('120 场历史的普通记录可逐页到达且不重复', pages.length === 80 && new Set(pages.map(s => s.id)).size === 80)
  check('归档最早记录可通过全库标题搜索找到', store.historyPage('最早哨兵', 'archived', 0, 25).total === 1)
  check('归档标题筛选不会显示不相关记录', store.historyPage('不存在课程', 'archived', 0, 25).sessions.length === 0)
  const session = store.createSession('资料校对验收', topic)
  const original = '原始错字独有哨兵：细胞膜由错误结构构成。'
  const row = attachmentService.add(session.id, '校对原文.txt', Buffer.from(original))
  for (let i = 0; i < 200 && attachmentService.get(row.id).extract_status === 'pending'; i++) await sleep(50)
  const oldChunk = attachmentService.getChunks(row.id)[0]
  const now = new Date().toISOString()
  const job = { attachmentId: row.id, mode: 'handwriting', status: 'done', stage: '已完成', completed: 1, total: 1, ocrCompleted: 0, ocrTotal: 0,
    sources: [{ text: original, page: null, label: '全文' }], result: { notes: [{ id: 'n1', category: '生物', title: '整理检索标题哨兵', content: '整理独有正文哨兵', source: 0, quote: original }],
      characters: [{ id: 'p1', name: '人物检索哨兵', description: '人物独有介绍哨兵', segment: 1, source: 0, quote: original }],
      events: [{ id: 'e1', title: '剧情检索哨兵', summary: '剧情独有总结哨兵', characters: ['p1'], segment: 1, source: 0, quote: original }],
      relations: [{ id: 'r1', from: 'p1', to: 'p1', label: '关系检索哨兵', segment: 1, source: 0, quote: original }] }, warnings: [], error: null, updatedAt: now, startPage: 1, endPage: 1, revision: 1 }
  db.prepare('INSERT INTO document_analyses VALUES(?,?,?)').run(row.id, JSON.stringify(job), now); library.rebuildIndex()
  for (const term of ['整理检索标题哨兵', '整理独有正文哨兵', '人物独有介绍哨兵', '剧情独有总结哨兵', '关系检索哨兵']) check(`全局搜索资料库：${term}`, search.find(term).some(h => h.kind === 'library' && h.attachmentId === row.id && h.libraryItemId))
  const corrected = '校对后独有正确哨兵：细胞膜由磷脂双分子层构成。'
  library.editSources(row.id, [{ text: corrected, page: null, label: '全文' }])
  check('校对后的切片成为唯一活动原文', attachmentService.getChunks(row.id).every(c => c.text.includes('正确哨兵')))
  check('历史引用 ID 保留旧内容', db.prepare('SELECT text FROM chunks WHERE id=?').get(oldChunk.id).text === oldChunk.text)
  check('原件字节保持不变', attachmentService.readOriginal(row.id).bytes.toString() === original)
  check('全局原文搜索不暴露旧版本', search.find('原始错字独有哨兵').filter(h => h.kind === 'chunk').length === 0)
  check('全局原文搜索可命中校对版本', search.find('校对后独有正确哨兵').some(h => h.kind === 'chunk'))
  const mock = await require('./mock-provider.cjs').startMockProvider()
  const api = createServer({ db, dataDir: dir, token: 'local-test-token', version: 'test' })
  const request = (path, body, method = 'POST') => api.request(path, { method, headers: { 'Content-Type': 'application/json', 'X-Zhitu-Token': 'local-test-token' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  await request('/settings', { providerId: 'custom', baseURL: mock.baseURL, model: 'mock-text', apiKey: 'synthetic-regression-key', onboarded: true })
  const reply = await request('/chat', { sessionId: session.id, content: '请解释它', attachmentIds: [row.id] })
  await reply.text()
  const sent = JSON.stringify(mock.requests.filter(r => r.stream).map(r => r.messages))
  check('真实聊天请求优先使用校对原文，即使问题不含资料关键词', reply.ok && sent.includes('正确哨兵') && !sent.includes('原始错字独有哨兵'))
  await sleep(800)
  const backup = JSON.parse(new ExportService(db, dir).allJson())
  check('备份预览包含 121 场及原件大小', backups.preview(backup).sessions === 121 && backups.preview(backup).attachments === 1)
  const before = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  const configBefore = JSON.stringify(db.prepare('SELECT * FROM app_config ORDER BY key').all())
  const restore = await backups.restore(backup, () => library.rebuildIndex())
  check('恢复以新副本完整合并，当前场次保留', db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n === before * 2 && !!store.getSession(session.id))
  check('恢复前完整快照确实可解析', JSON.parse(readFileSync(restore.snapshotPath, 'utf8')).sessions.length === before)
  check('恢复保留当前设置和测试密钥', JSON.stringify(db.prepare('SELECT * FROM app_config ORDER BY key').all()) === configBefore)
  check('数据库引用恢复后均完整', db.pragma('foreign_key_check').length === 0)
  const copied = db.prepare('SELECT * FROM attachments WHERE id!=?').get(row.id)
  check('附件原件落到新的安全位置并保留字节', copied.stored_path !== row.stored_path && readFileSync(join(dir, copied.stored_path)).toString() === original)
  check('恢复后的校对切片和整理索引仍可检索', attachmentService.getChunks(copied.id)[0].text === corrected && search.find('整理独有正文哨兵').some(h => h.attachmentId === copied.id))
  const copiedMeta = db.prepare('SELECT * FROM turn_meta WHERE turn_id NOT IN (SELECT turn_id FROM turn_meta WHERE turn_id IN (SELECT id FROM turns WHERE session_id=?))').all(session.id)
  check('恢复后的嵌套引用已重新绑定', copiedMeta.some(m => JSON.parse(m.attachment_ids_json).includes(copied.id)))
  const invalids = [ { ...backup, format: 'other' }, { ...backup, schemaVersion: 999 }, { ...backup, attachments_files: [] },
    { ...backup, attachments_files: [{ ...backup.attachments_files[0], base64: Buffer.from('wrong bytes').toString('base64') }] },
    { ...backup, sessions: [{ ...backup.sessions[0], topic_id: 'missing-topic' }] } ]
  for (let i = 0; i < invalids.length; i++) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
    let failed = false; try { await backups.restore(invalids[i], () => library.rebuildIndex()) } catch { failed = true }
    check(`无效备份 ${i + 1} 拒绝且不改当前数据`, failed && db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n === count)
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  const filesBefore = readdirSync(join(dir, 'attachments')).length
  let rolledBack = false
  try { await backups.restore(backup, () => { throw new Error('synthetic late failure') }) } catch { rolledBack = true }
  check('恢复中途失败回滚全部数据库记录与新原件', rolledBack && db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n === count && readdirSync(join(dir, 'attachments')).length === filesBefore)
  const missingPath = join(dir, row.stored_path)
  renameSync(missingPath, missingPath + '.synthetic-missing')
  try {
    const recovered = await backups.restore(backup, () => library.rebuildIndex())
    check('当前原件已丢失时仍能从完整备份恢复新副本', !!recovered.snapshotWarning && existsSync(recovered.snapshotPath))
    check('原件缺失场景明确保存缺失清单及仍存在的原件', existsSync(join(recovered.snapshotPath, '..', '原件缺失清单.json')) && existsSync(join(recovered.snapshotPath, '..', copied.stored_path)))
  } finally { renameSync(missingPath + '.synthetic-missing', missingPath) }
  store.trashSession(session.id)
  check('回收站资料的整理内容不出现在全局搜索', !search.find('整理独有正文哨兵').some(h => h.attachmentId === row.id))
  await mock.close(); handle.close()
  console.log(`Completeness: ${passes} passed, ${failures} failed. Sandbox: ${dir}`)
  process.exit(failures ? 1 : 0)
}
main().catch(error => { console.error(error.stack); process.exit(1) })
