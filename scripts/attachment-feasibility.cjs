const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const mammoth = require('mammoth')
const ExcelJS = require('exceljs')
const JSZip = require('jszip')

const sample = (name) => readFileSync(join(__dirname, 'fixtures', 'attachments', name))

async function main() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(sample('sample.pdf')), useSystemFonts: true }).promise
  const pages = []
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => item.str ?? '').join(' '))
  }
  if (pdf.numPages !== 3 || !pages[2].includes('SOFTMAX_STABILITY_ANCHOR')) {
    throw new Error(`PDF extraction failed: ${JSON.stringify(pages)}`)
  }
  console.log('PDF: 3 pages, page 3 anchor found')
  const { createCanvas } = require('@napi-rs/canvas')
  const page3 = await pdf.getPage(3)
  const viewport = page3.getViewport({ scale: 1 })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  await page3.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  const raster = canvas.toBuffer('image/png')
  if (raster.length < 1000) throw new Error('PDF page rendering failed')
  console.log(`PDF render: page 3 PNG ${raster.length} bytes`)
  const scanPdf = await pdfjs.getDocument({ data: new Uint8Array(sample('scanned.pdf')), useSystemFonts: true }).promise
  const scanPage = await scanPdf.getPage(1)
  const scanViewport = scanPage.getViewport({ scale: 1 })
  const scanCanvas = createCanvas(Math.ceil(scanViewport.width), Math.ceil(scanViewport.height))
  await scanPage.render({ canvasContext: scanCanvas.getContext('2d'), viewport: scanViewport }).promise
  console.log(`Scan render: ${scanCanvas.toBuffer('image/png').length} bytes`)

  const docx = await mammoth.convertToHtml({ buffer: sample('sample.docx') })
  if (!docx.value.includes('DOCX_ANCHOR')) throw new Error('DOCX extraction failed')
  console.log('DOCX: anchor found')

  const archive = await JSZip.loadAsync(sample('sample.pptx'))
  const slide = await archive.file('ppt/slides/slide1.xml').async('string')
  if (!slide.includes('PPTX_ANCHOR')) throw new Error('PPTX slide XML extraction failed')
  console.log('PPTX: slide 1 anchor found in XML')

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(sample('sample.xlsx'))
  const cells = []
  workbook.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.text)))))
  if (!cells.some((value) => value.includes('XLSX_ANCHOR'))) throw new Error('XLSX extraction failed')
  console.log('XLSX: anchor found')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
