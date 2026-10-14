/** Isolated parser. A malformed document can terminate this process without closing Zhitu. */
const { readFileSync } = require('node:fs')

const decodeXmlText = (value) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")

function decodeText(bytes) {
  if (bytes.includes(0)) throw new Error('文件包含二进制内容，无法按文本解析')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('gbk', { fatal: true }).decode(bytes) }
}

function htmlToText(html) {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

async function parse(kind, bytes) {
  if (kind === 'epub') {
    const JSZip = require('jszip')
    const { posix } = require('node:path')
    const archive = await JSZip.loadAsync(bytes)
    const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)]
      .map((m) => [m[1], decodeXmlText(m[3])]))
    const container = archive.file('META-INF/container.xml')
    if (!container) throw new Error('EPUB 缺少容器目录，无法读取')
    const xml = await container.async('string')
    const packageName = attributes(xml.match(/<(?:[\w-]+:)?rootfile\b[^>]*>/)?.[0] || '')['full-path']
    const packageFile = packageName && archive.file(packageName)
    if (!packageFile) throw new Error('EPUB 缺少书籍目录')
    const opf = await packageFile.async('string')
    const manifest = new Map([...opf.matchAll(/<(?:[\w-]+:)?item\b[^>]*>/g)].map((m) => {
      const a = attributes(m[0]); return [a.id, a]
    }))
    const spine = [...opf.matchAll(/<(?:[\w-]+:)?itemref\b[^>]*>/g)].map((m) => attributes(m[0]))
      .filter((a) => a.linear !== 'no')
    if (!spine.length) throw new Error('EPUB 没有可读取的章节顺序')
    const pages = []; let total = 0; let truncated = false
    for (let i = 0; i < spine.length; i++) {
      const item = manifest.get(spine[i].idref)
      if (!item || !['application/xhtml+xml', 'text/html'].includes(item['media-type'])) throw new Error('EPUB 章节格式不受支持，请转换成 TXT 或 PDF')
      if (/^[a-z]+:|^\//i.test(item.href)) throw new Error('EPUB 含外部章节，不能在本地完整读取')
      const name = posix.normalize(posix.join(posix.dirname(packageName), decodeURIComponent(item.href.split('#')[0])))
      if (name.startsWith('../')) throw new Error('EPUB 章节路径无效')
      const file = archive.file(name)
      if (!file) throw new Error('EPUB 章节缺失或受保护，请导入可提取文字的版本')
      if (file._data?.uncompressedSize > 8 * 1024 * 1024) throw new Error('EPUB 单章解压内容过大')
      const html = await file.async('string')
      if (!/<(?:html|body|p|div)\b/i.test(html)) throw new Error('EPUB 章节可能加密，无法提取文字')
      const text = htmlToText(html).slice(0, Math.max(0, 2_000_000 - total))
      if (text) pages.push({ number: i + 1, text })
      total += text.length
      if (total >= 2_000_000) { truncated = i < spine.length - 1; break }
    }
    if (!pages.length) throw new Error('EPUB 没有可提取的文字，可能是图片书或受保护的版本')
    return { pages, pageCount: spine.length, warning: truncated ? '提取文字超过 200 万字，后续章节未处理' : null }
  }
  if (kind === 'pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise
    const pages = []
    const count = Math.min(document.numPages, 200)
    for (let number = 1; number <= count; number++) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').trim()
      if (text) pages.push({ number, text })
      page.cleanup()
    }
    return { pages, pageCount: document.numPages,
      warning: document.numPages > count ? '超过 200 页，当前只提取前 200 页'
        : pages.length < document.numPages ? '部分页面没有可提取文字；扫描页需要视觉识别' : null }
  }
  if (kind === 'docx') {
    const mammoth = require('mammoth')
    const result = await mammoth.convertToHtml({ buffer: bytes })
    return { pages: [{ number: null, text: htmlToText(result.value) }], pageCount: null,
      warning: result.messages.length ? '部分 Word 内容未能完整转换' : null }
  }
  if (kind === 'pptx') {
    const JSZip = require('jszip')
    const archive = await JSZip.loadAsync(bytes)
    const names = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => Number(left.match(/slide(\d+)/)?.[1]) - Number(right.match(/slide(\d+)/)?.[1]))
    const pages = []
    for (const name of names.slice(0, 200)) {
      const xml = await archive.file(name).async('string')
      const words = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((match) => decodeXmlText(match[1]))
      pages.push({ number: Number(name.match(/slide(\d+)/)?.[1]), text: words.join(' ').trim() })
    }
    return { pages, pageCount: names.length,
      warning: names.length > 200 ? '超过 200 页，当前只提取前 200 页；图表与排版未提取'
        : '只提取幻灯片文字；图表与排版未提取' }
  }
  if (kind === 'xlsx') {
    const ExcelJS = require('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes)
    const pages = []
    let truncated = false
    workbook.eachSheet((sheet, index) => {
      const lines = [`工作表：${sheet.name}`]
      sheet.eachRow((row) => {
        if (lines.length > 10_000) { truncated = true; return }
        lines.push(row.values.slice(1).map((value) => {
          const string = value === null || value === undefined ? '' : String(value)
          return /[",\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string
        }).join(','))
      })
      pages.push({ number: index, text: lines.join('\n') })
    })
    return { pages, pageCount: workbook.worksheets.length,
      warning: truncated ? '工作表超过 10000 行，后续内容未提取' : null }
  }
  let text = decodeText(bytes)
  if (kind === 'html' || kind === 'htm') text = htmlToText(text)
  return { pages: [{ number: null, text }], pageCount: null, warning: null }
}

async function render(path, pageNumber) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const { createCanvas } = require('@napi-rs/canvas')
  const document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true }).promise
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
    throw new Error(`这份 PDF 只有 ${document.numPages} 页，没有第 ${pageNumber} 页`)
  }
  const page = await document.getPage(pageNumber)
  const initial = page.getViewport({ scale: 1 })
  const scale = Math.min(1.5, 2048 / Math.max(initial.width, initial.height))
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  page.cleanup()
  return canvas.toBuffer('image/png').toString('base64')
}

async function main() {
  const [mode, kindOrPage, path] = process.argv.slice(2)
  if (mode === 'parse') {
    const result = await parse(kindOrPage, readFileSync(path))
    const total = result.pages.reduce((sum, page) => sum + page.text.length, 0)
    if (total > 2_000_000) {
      let remaining = 2_000_000
      result.pages = result.pages.map((page) => {
        const text = page.text.slice(0, Math.max(0, remaining))
        remaining -= text.length
        return { ...page, text }
      }).filter((page) => page.text)
      result.warning = '提取文字超过 200 万字，后续内容未处理'
    }
    process.stdout.write(JSON.stringify(result))
  } else if (mode === 'render') {
    process.stdout.write(JSON.stringify({ png: await render(path, Number(kindOrPage)) }))
  } else throw new Error('Unknown worker mode')
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
