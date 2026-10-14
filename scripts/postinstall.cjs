/**
 * 安装后的收尾工作。
 *
 * 为什么需要这个文件：
 * npm 12 默认禁止第三方包运行安装脚本，而 Electron 恰恰靠这个脚本
 * 下载真正的可执行文件。如果不补这一步，装完会得到一个
 * "Electron failed to install correctly" 的报错——对新手极不友好。
 *
 * 所以这里主动检查一次：缺什么就补什么，并且把话说清楚。
 */

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const root = join(__dirname, '..')

function log(msg) {
  process.stdout.write(`[织图] ${msg}\n`)
}

function electronExe() {
  return join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
}

function ensureElectron() {
  const distDir = join(root, 'node_modules', 'electron', 'dist')
  if (existsSync(electronExe())) {
    log('Electron 已就绪。')
    return
  }
  const installer = join(root, 'node_modules', 'electron', 'install.js')
  if (!existsSync(installer)) {
    log('没找到 Electron，请先执行 npm install。')
    return
  }
  log('正在补下载 Electron（约 110MB，只需一次）…')
  try {
    execFileSync(process.execPath, [installer], { cwd: join(root, 'node_modules', 'electron'), stdio: 'inherit' })
    log(existsSync(electronExe()) ? 'Electron 下载完成。' : 'Electron 仍未就绪，请重试。')
  } catch (err) {
    log(`Electron 下载失败：${err.message}`)
    log('如果反复失败，可以设置镜像后重试：')
    log('  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/')
    process.exitCode = 1
  }
  void distDir
}

ensureElectron()
