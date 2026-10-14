/** Synthetic source fixtures + loopback model only. No user data or paid API requests. */
const { buildSync } = require('esbuild')
const { Module } = require('node:module')
const { createServer } = require('node:http')
const { join } = require('node:path')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const JSZip = require('jszip')
const root = join(__dirname, '..')
function load(path) {
  const file = join(root, path)
  const bundle = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['better-sqlite3', 'zod', 'jszip', 'pdfjs-dist/*', 'mammoth', 'exceljs', '@napi-rs/canvas'], tsconfig: join(root, 'tsconfig.node.json') })
  const m = new Module(file + '.cjs', module); m.filename = file + '.cjs'; m.paths = Module._nodeModulePaths(root)
  m._compile(bundle.outputFiles[0].text, m.filename); return m.exports
}
const { openDatabase } = load('src/main/core/db.ts')
const { AttachmentService } = load('src/main/core/attachments.ts')
const { LibraryService } = load('src/main/core/library.ts')
const { ExportService } = load('src/main/core/exports.ts')
const results = []
const check = (name, value) => { results.push({ name, ok: !!value }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(30) } throw new Error('Timed out') }
const text1 = '林舟牵着女儿林夏走进旧城。林夏是林舟的女儿。'
const text2 = '林夏在钟楼遇见江月。江月帮助林夏找到了图书馆。'
const noteText = '细胞膜由磷脂双分子层构成。线粒体是细胞呼吸的主要场所。[无法辨认]'
async function epubFixture() {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/book.opf" /></rootfiles></container>')
  zip.file('OEBPS/book.opf', '<package><manifest><item id="second" href="2.xhtml" media-type="application/xhtml+xml"/><item id="first" href="1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>')
  zip.file('OEBPS/2.xhtml', `<html><body><p>${text2}</p></body></html>`)
  zip.file('OEBPS/1.xhtml', `<html><body><h1>第一章 旧城</h1><p>${text1}</p></body></html>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'zhitu-library-regression-'))
  const handle = openDatabase(join(dir, 'zhitu.db')); const db = handle.db
  const now = new Date().toISOString()
  db.prepare('INSERT INTO topics(id,title,created_at) VALUES(?,?,?)').run('t', '合成资料测试', now)
  db.prepare('INSERT INTO sessions(id,topic_id,title,started_at) VALUES(?,?,?,?)').run('s', 't', '测试', now)
  const attachments = new AttachmentService(db, dir)
  let failSecond = false; let malformed = false; let hallucinate = false; let delayed = false; let count = 0
  const requests = []
  const server = createServer((req, res) => {
    const buffers = []; req.on('data', (c) => buffers.push(c)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(buffers).toString()); requests.push(body); count++
      const system = body.messages[0].content
      const user = body.messages[1].content
      const text = typeof user === 'string' ? user.split('<原文>\n')[1]?.split('\n</原文>')[0] || '' : ''
      let answer
      if (typeof user !== 'string') answer = noteText
      else if (system.includes('手写笔记整理员')) answer = JSON.stringify({ notes: [{ category: '细胞生物学', title: '细胞膜', content: '细胞膜由磷脂双分子层构成。', evidence: text.includes('胆固醇') ? '细胞膜也含胆固醇' : '细胞膜由磷脂双分子层构成' },
        { category: '细胞生物学', title: '细胞呼吸', content: '线粒体是细胞呼吸的主要场所。', evidence: '线粒体是细胞呼吸的主要场所' }] })
      else if (hallucinate) answer = JSON.stringify({ characters: [{ name: '不存在的人', description: '补造内容', evidence: '这一句话没有在任何上传原文中出现' }], events: [], relations: [] })
      else if (malformed || failSecond && text.includes('江月')) answer = '{"characters":['
      else if (text.includes('江月')) answer = JSON.stringify({ characters: [{ name: '林夏', description: '林舟的女儿', evidence: '林夏在钟楼遇见江月' }, { name: '江月', description: '帮助林夏的人', evidence: '江月帮助林夏找到了图书馆' }],
        events: [{ title: '钟楼相遇', summary: '林夏遇见江月并得到帮助。', characters: ['林夏', '江月'], evidence: '林夏在钟楼遇见江月' }],
        relations: [{ from: '江月', to: '林夏', label: '帮助', evidence: '江月帮助林夏找到了图书馆' }, { from: '幽灵', to: '林夏', label: '朋友', evidence: '林夏在钟楼遇见江月' }] })
      else answer = JSON.stringify({ characters: [{ name: '林舟', description: '林夏的父亲', evidence: '林舟牵着女儿林夏走进旧城' }, { name: '林夏', description: '林舟的女儿', evidence: '林夏是林舟的女儿' }],
        events: [{ title: '走进旧城', summary: '林舟和林夏来到旧城。', characters: ['林舟', '林夏'], evidence: '林舟牵着女儿林夏走进旧城' }],
        relations: [{ from: '林舟', to: '林夏', label: '父女', evidence: '林夏是林舟的女儿' }] })
      const respond = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: answer } }] })) }
      if (delayed) setTimeout(respond, 2000); else respond()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const config = { baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-test', model: 'mock-text', utilityModel: '', visionEnabled: false, visionModel: '' }
  let library = new LibraryService(db, attachments, () => config)
  try {
    const bytes = await epubFixture(); writeFileSync(join(dir, '合成小说.epub'), bytes)
    const book = attachments.add('s', '合成小说.epub', bytes)
    await until(() => attachments.get(book.id).extract_status !== 'pending')
    check('EPUB 按 spine 顺序提取而非文件名或 ZIP 顺序', attachments.getChunks(book.id)[0].text.includes('林舟') && attachments.getChunks(book.id).at(-1).text.includes('江月'))
    const plan = library.plan(book.id, 'book')
    check('用量方案覆盖全部两个章节', plan.segments === 2 && plan.estimatedCalls === 2)
    failSecond = true; library.start(book.id, 'book')
    let job = await until(() => { const j = library.get(book.id); return j.status === 'failed' && j })
    check('后段 JSON 截断保留首段进度与原文', job.completed === 1 && job.sources.length === 2 && job.result.characters.length === 2)
    await until(() => !library.isRunning(book.id))
    // Simulate a process exit after the checkpoint was written.
    job.status = 'running'; db.prepare('UPDATE document_analyses SET payload_json = ? WHERE attachment_id = ?').run(JSON.stringify(job), book.id)
    library = new LibraryService(db, attachments, () => config)
    check('重启把中断任务标成可续接', library.get(book.id).status === 'failed')
    failSecond = false; const prior = count; library.start(book.id, 'book')
    job = await until(() => { const j = library.get(book.id); return j.status === 'done' && j })
    check('续接只调用失败片段，不重复成功片段', count - prior === 1 && job.completed === 2)
    check('跨章人物去重且保留两类有标签关系', job.result.characters.length === 3 && job.result.relations.length === 2)
    check('剧情关联有效人物并保留来源章节', job.result.events.length === 2 && job.result.events[1].source === 1 && job.result.events[1].characters.length === 2)
    check('没有端点的人物关系被过滤', !job.result.relations.some((r) => r.label === '朋友') && job.warnings.length > 0)
    check('人物首次出现片段供防剧透过滤', job.result.characters.find((c) => c.name === '江月').segment === 2)
    const before = JSON.stringify(job.result)
    await until(() => !library.isRunning(book.id)); malformed = true; library.start(book.id, 'book', { restart: true })
    job = await until(() => { const j = library.get(book.id); return j.status === 'failed' && j })
    check('重新分析失败保留上次完整结果与出处', JSON.stringify(job.previousResult) === before && job.previousSources[1].text.includes('江月'))
    malformed = false; await until(() => !library.isRunning(book.id))

    const image = attachments.add('s', '手写笔记.png', readFileSync(join(__dirname, 'fixtures', 'attachments', 'sample.png')))
    const beforeGate = count
    try { library.start(image.id, 'handwriting'); check('视觉关闭阻止发送图片', false) } catch (e) { check('视觉关闭阻止发送图片', /视觉识别/.test(e.message) && count === beforeGate) }
    config.visionEnabled = true
    try { library.start(image.id, 'handwriting'); check('视觉模型未填写阻止调用', false) } catch (e) { check('视觉模型未填写阻止调用', /视觉模型/.test(e.message)) }
    config.visionModel = 'mock-vision'
    library.start(image.id, 'handwriting')
    job = await until(() => { const j = library.get(image.id); return j.status === 'done' && j })
    check('图片经过 OCR 后自动分类成笔记', job.ocrCompleted === 1 && job.result.notes.length === 2 && job.sources[0].text === noteText)
    check('视觉与文字整理使用各自模型', requests.some((r) => r.model === 'mock-vision' && Array.isArray(r.messages[1].content)) && requests.at(-1).model === 'mock-text')
    check('无法辨认的文字提示校对', job.warnings.some((w) => w.includes('无法辨认')))
    const note = job.result.notes[0]
    library.editNote(image.id, note.id, { category: '期末复习', title: '膜结构', content: '细胞膜由磷脂双分子层构成，已手动核对。' })
    check('修改分类和内容落盘', library.get(image.id).result.notes[0].edited && library.get(image.id).result.notes[0].category === '期末复习')
    await until(() => !library.isRunning(image.id))
    library.editSources(image.id, [{ ...job.sources[0], text: noteText + '\n细胞膜也含胆固醇。' }])
    const calls = count; library.start(image.id, 'handwriting', { restart: true })
    job = await until(() => { const j = library.get(image.id); return j.status === 'done' && j })
    check('校对后只重新分类，不重复 OCR 且不丢校对', count - calls === 1 && job.sources[0].text.includes('胆固醇') && job.result.notes[0].quote.includes('胆固醇'))
    check('重新整理成功后清理旧结果快照', !job.previousResult && !job.previousSources)
    const scanned = attachments.add('s', '扫描手写笔记.pdf', readFileSync(join(__dirname, 'fixtures', 'attachments', 'scanned.pdf')))
    await until(() => attachments.get(scanned.id).extract_status !== 'pending')
    const scannedPlan = library.plan(scanned.id, 'handwriting')
    check('扫描 PDF 识别范围覆盖原件页码', scannedPlan.ocrPages === attachments.get(scanned.id).page_count && scannedPlan.ocrPages > 0)
    library.start(scanned.id, 'handwriting')
    const scannedJob = await until(() => { const j = library.get(scanned.id); return j.status === 'done' && j })
    check('扫描 PDF 实际渲染后识别分类并保留页码', scannedJob.ocrCompleted === scannedPlan.ocrPages && scannedJob.sources[0].page === 1 && scannedJob.result.notes.length === 2)
    await until(() => !library.isRunning(image.id))
    delayed = true; library.start(image.id, 'handwriting', { restart: true }); await sleep(60)
    library.cancel(image.id)
    job = await until(() => { const j = library.get(image.id); return j.status === 'cancelled' && j })
    check('停止中断请求并保留上次笔记', job.previousResult.notes.length === 2 && job.completed === 0)
    await until(() => !library.isRunning(image.id)); delayed = false

    const bogus = attachments.add('s', '无依据.txt', Buffer.from('这个小镇的原文里没有任何人物名字。'))
    await until(() => attachments.get(bogus.id).extract_status !== 'pending'); hallucinate = true
    library.start(bogus.id, 'book'); job = await until(() => { const j = library.get(bogus.id); return j.status === 'failed' && j })
    check('模型补造的原文摘录不会入图', job.result.characters.length === 0 && job.completed === 0)
    await until(() => !library.isRunning(bogus.id)); hallucinate = false
    const exported = new ExportService(db, dir)
    const backup = JSON.parse(exported.allJson())
    check('全部备份包含资料库结果且不包含测试密钥', backup.document_analyses.length === 4 && !JSON.stringify(backup).includes('synthetic-test'))
    const zip = await JSZip.loadAsync(await exported.notesZip())
    check('笔记导出包含资料库整理文件', Object.keys(zip.files).filter((f) => f.startsWith('资料库/') && f.endsWith('.md')).length === 4)
    check('整理不伪造任何对话轮次', db.prepare('SELECT COUNT(*) AS n FROM turns').get().n === 0)
    check('持久化与原件仍完整', attachments.readOriginal(book.id).bytes.equals(bytes) && new LibraryService(db, attachments, () => config).get(image.id).previousResult.notes.length === 2)
  } finally { await new Promise((r) => server.close(r)); handle.close() }
  const report = `${results.filter((r) => r.ok).length}/${results.length} library checks passed\n${results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join('\n')}\nSandbox: ${dir}\n`
  if (process.env.ZHITU_LIBRARY_REPORT) writeFileSync(process.env.ZHITU_LIBRARY_REPORT, report)
  console.log(report); process.exitCode = results.some((r) => !r.ok) ? 1 : 0
}
module.exports = { epubFixture, text1, text2, noteText }
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1 })
