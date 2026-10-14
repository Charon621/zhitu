/**
 * 在独立临时数据目录里运行完整的界面验证并保存真实窗口截图。
 * 截图位于 %TEMP%\zhitu-shots。
 */
const { mkdtempSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

process.env.ZHITU_DATA_DIR = mkdtempSync(join(tmpdir(), 'zhitu-shot-data-'))
// Windows 双击式 Electron 启动会先让调用终端返回。保留原 stdout 时，
// 界面验证结束后打印报告会写入已关闭的管道，触发 EPIPE 错误弹窗。
// ui-smoke 已把报告写到临时文件；这个截图入口只需保存图片。
console.log = () => {}
require('./ui-smoke.cjs')
