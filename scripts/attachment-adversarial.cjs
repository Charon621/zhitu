/** 第 2 步基础资料管线验证：独立临时目录，不碰用户数据。 */
const { buildSync } = require('esbuild')
const { Module } = require('node:module')
const { join } = require('node:path')
const { mkdtempSync, existsSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const root = join(__dirname, '..')
function load(path) {
  const filename = join(root, path)
  const bundle = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['better-sqlite3', 'zod', 'pdfjs-dist/*', 'mammoth', 'jszip', 'exceljs', '@napi-rs/canvas'],
    tsconfig: join(root, 'tsconfig.node.json') })
  const compiled = new Module(filename + '.cjs', module)
  compiled.filename = filename + '.cjs'
  compiled.paths = Module._nodeModulePaths(root)
  compiled._compile(bundle.outputFiles[0].text, compiled.filename)
  return compiled.exports
}
const { openDatabase } = load('src/main/core/db.ts')
const { AttachmentService, AttachmentError } = load('src/main/core/attachments.ts')
const results = []
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail: ok ? '' : detail }) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(service, id) {
  for (let n = 0; n < 200; n++) {
    const row = service.get(id)
    if (row.extract_status !== 'pending') return row
    await sleep(50)
  }
  return service.get(id)
}

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'zhitu-attachment-test-'))
  const handle = openDatabase(join(dir, 'zhitu.db'))
  const db = handle.db
  const now = new Date().toISOString()
  db.prepare('INSERT INTO topics (id,title,created_at) VALUES (?,?,?)').run('topic', '测试资料', now)
  db.prepare('INSERT INTO sessions (id,topic_id,title,started_at) VALUES (?,?,?,?)')
    .run('session', 'topic', '测试资料', now)
  const service = new AttachmentService(db, dir)
  try {
    const txt = service.add('session', '概念.txt', Buffer.from('梯度下降通过损失函数的梯度更新参数。', 'utf8'))
    const txtDone = await waitFor(service, txt.id)
    check('TXT 提取中文并写入切片', txtDone.extract_status === 'ok' &&
      service.getChunks(txt.id)[0]?.text.includes('梯度下降'))

    const duplicate = service.add('session', '重命名.txt', Buffer.from('梯度下降通过损失函数的梯度更新参数。', 'utf8'))
    check('同一场相同 SHA256 复用附件', duplicate.id === txt.id && service.listSession('session').length === 1)

    const md = service.add('session', '说明.md', Buffer.from('# 主题\n注意力机制用权重汇总信息。'))
    const mdDone = await waitFor(service, md.id)
    check('Markdown 保留标题与正文', mdDone.extract_status === 'ok' &&
      service.getChunks(md.id)[0]?.text.includes('# 主题') && service.getChunks(md.id)[0]?.text.includes('权重'))

    const code = service.add('session', 'main.py', Buffer.from('def softmax(values):\n    return values\n'))
    const codeDone = await waitFor(service, code.id)
    check('代码文件保留函数名', codeDone.extract_status === 'ok' &&
      service.getChunks(code.id)[0]?.text.includes('def softmax'))

    const gbk = service.add('session', '旧编码.txt', Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
    const gbkDone = await waitFor(service, gbk.id)
    check('UTF-8 失败后正确读取 GBK', gbkDone.extract_status === 'ok' &&
      service.getChunks(gbk.id)[0]?.text === '你好')

    const html = service.add('session', '网页.html', Buffer.from('<h1>知识地图</h1><script>evil()</script><p>节点之间有连接。</p>'))
    const htmlDone = await waitFor(service, html.id)
    check('HTML 只留正文，剥掉脚本', htmlDone.extract_status === 'ok' &&
      htmlDone.extracted_md.includes('知识地图') && !htmlDone.extracted_md.includes('evil'))

    const fixture = (name) => readFileSync(join(__dirname, 'fixtures', 'attachments', name))
    const pdf = service.add('session', 'sample.pdf', fixture('sample.pdf'))
    const pdfDone = await waitFor(service, pdf.id)
    check('PDF 逐页提取且保留第 3 页页码', pdfDone.extract_status === 'ok' &&
      pdfDone.page_count === 3 && service.getChunks(pdf.id).some((chunk) =>
        chunk.page === 3 && chunk.text.includes('SOFTMAX_STABILITY_ANCHOR')),
      pdfDone.extract_error || '')

    const scanned = service.add('session', 'scanned.pdf', fixture('scanned.pdf'))
    const scannedDone = await waitFor(service, scanned.id)
    const scannedImage = await service.renderPdfPage(scanned.id, 1)
    check('扫描 PDF 不冒充文字且能渲染成视觉输入', scannedDone.extract_status === 'partial' &&
      service.getChunks(scanned.id).length === 0 && scannedDone.extract_error?.includes('扫描页') &&
      scannedImage.length > 1000, scannedDone.extract_error || '')
    service.addOcrPage(scanned.id, 1, 'SCANNED_PAGE_ANCHOR is only in pixels')
    check('视觉转录写回对应页并可供笔记回指', service.getChunks(scanned.id).some((chunk) =>
      chunk.page === 1 && chunk.text.includes('SCANNED_PAGE_ANCHOR')))

    const docx = service.add('session', 'sample.docx', fixture('sample.docx'))
    const docxDone = await waitFor(service, docx.id)
    check('Word 样本文字可提取', ['ok', 'partial'].includes(docxDone.extract_status) &&
      docxDone.extracted_md?.includes('DOCX_ANCHOR'), docxDone.extract_error || '')

    const pptx = service.add('session', 'sample.pptx', fixture('sample.pptx'))
    const pptxDone = await waitFor(service, pptx.id)
    check('PPT 样本文字可提取且提示图表限制', pptxDone.extract_status === 'partial' &&
      pptxDone.extracted_md?.includes('PPTX_ANCHOR') && pptxDone.extract_error?.includes('图表'),
      pptxDone.extract_error || '')

    const xlsx = service.add('session', 'sample.xlsx', fixture('sample.xlsx'))
    const xlsxDone = await waitFor(service, xlsx.id)
    check('Excel 样本保留工作表和字段', xlsxDone.extract_status === 'ok' &&
      xlsxDone.extracted_md?.includes('学习记录') && xlsxDone.extracted_md?.includes('XLSX_ANCHOR'),
      xlsxDone.extract_error || '')

    const image = service.add('session', '图.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
    check('图片原件保存且状态就绪', image.kind === 'image' && image.extract_status === 'ok' &&
      service.readOriginal(image.id)?.bytes.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])))

    const matches = service.search('session', '梯度下降怎样更新参数', 5)
    check('FTS 检索只返回本场相关切片', matches.some((row) => row.attachment_id === txt.id &&
      row.text.includes('梯度下降')))

    let rejected = false
    try { service.add('session', '危险.exe', Buffer.from('MZ...')) } catch (error) {
      rejected = error instanceof AttachmentError && error.message.includes('不能导入')
    }
    check('可执行文件被明确拒绝', rejected)

    const broken = service.add('session', '损坏.txt', Buffer.from([0x41, 0x00, 0x42]))
    const brokenDone = await waitFor(service, broken.id)
    check('损坏文本只标记失败而不影响其他附件', brokenDone.extract_status === 'failed' &&
      !!brokenDone.extract_error && service.get(txt.id)?.extract_status === 'ok')

    const deleted = service.remove(image.id)
    check('未引用附件可删且原件也移除', deleted && !service.get(image.id) &&
      !existsSync(join(dir, image.stored_path)))

    db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('use-turn', 'session', 'user', '请解释说明', now)
    const used = service.markUsed('session', 'use-turn', [md.id])[0]
    const resource = db.prepare('SELECT kind, title FROM nodes WHERE id = ?').get(used.resource_node_id)
    check('首次用到资料自动创建 resource 节点', used.resource_node_id &&
      resource?.kind === 'resource' && resource.title === '说明.md')

    db.prepare('INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('turn', 'session', 'user', '请看资料', now)
    db.prepare('INSERT INTO turn_meta (turn_id, attachment_ids_json) VALUES (?, ?)')
      .run('turn', JSON.stringify([txt.id]))
    let protectedSource = false
    try { service.remove(txt.id) } catch (error) {
      protectedSource = error instanceof AttachmentError && error.status === 409
    }
    check('已被对话引用的原件受到保护', protectedSource && !!service.get(txt.id))
  } finally {
    handle.close()
  }
}

run().catch((error) => check('资料管线运行没有异常', false, error.stack ?? String(error)))
  .finally(() => {
    const lines = ['──── 资料导入基础验证 ────']
    for (const result of results) lines.push(`  ${result.ok ? '✓' : '✕'} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`)
    lines.push(`共 ${results.length} 项，失败 ${results.filter((result) => !result.ok).length} 项`)
    console.log(lines.join('\n'))
    process.exit(results.length === 19 && results.every((result) => result.ok) ? 0 : 1)
  })
