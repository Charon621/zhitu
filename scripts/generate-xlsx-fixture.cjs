const ExcelJS = require('exceljs')
const { join } = require('node:path')

async function main() {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('学习记录')
  sheet.addRow(['概念', '说明', '分数'])
  sheet.addRow(['softmax', 'XLSX_ANCHOR：稳定化计算', 95])
  await workbook.xlsx.writeFile(join(__dirname, 'fixtures', 'attachments', 'sample.xlsx'))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
