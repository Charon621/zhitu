import { app, BrowserWindow, safeStorage, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import type { ServerType } from '@hono/node-server'
import { openDatabase, type DbHandle } from './core/db'
import { createServer } from './server'
import { log, logError, initLogger } from './log'
import { version as appVersion } from '../../package.json'

// 应用名决定 userData 目录的位置。
// 必须在这里钉死，否则以脚本方式启动时 Electron 会退回默认的 "Electron" 目录，
// 结果就是"开发时一套数据、双击打开又是另一套"。
// 目录名故意保留英文：中文目录名在个别 Windows 环境下有编码风险，
// 而界面上显示的仍然是"织图"。
app.setName('zhitu')

// 允许把数据目录改到别处，供自动化验证使用。
//
// 这一条是必须的：验证脚本要反复"清空数据再重启"，
// 如果它和正常使用共用同一个目录，就会把用户真实的学习记录和密钥冲掉。
// 设了这个环境变量，验证脚本就活在自己的沙箱里，碰不到用户的数据。
if (process.env.ZHITU_DATA_DIR) {
  app.setPath('userData', process.env.ZHITU_DATA_DIR)
}

// 单实例：用户双击两次图标时，把已有窗口叫到前面来，而不是开第二个进程。
// 两个进程同时读写同一个数据库是会出事的，所以这个检查必须放在最前面。
//
// 注意：被抢锁的第二个进程会自己退出，且退出码是 0。
// 自动化脚本如果只看退出码会误判成"成功"，所以脚本里必须同时检查报告内容。
if (!app.requestSingleInstanceLock()) {
  app.quit()
  app.exit(0)
}

let mainWindow: BrowserWindow | null = null
let dbHandle: DbHandle | null = null
let nodeServer: ServerType | null = null
let serverPort = 0

ipcMain.handle('zhitu:save-export', async (event, name: unknown, bytes: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof name !== 'string' ||
    !/^织图-[^\\/:*?"<>|\x00-\x1f]{1,80}\.(zip|md|json|png|jpg|jpeg|webp|pdf|epub|txt|docx|pptx|xlsx|markdown|csv|html|htm|js|jsx|ts|tsx|py|java|c|cpp|h|hpp|rs|go|sql|css|scss|sh|yaml|yml|xml)$/.test(name) ||
    !(bytes instanceof Uint8Array)) throw new Error('导出文件无效')
  const choice = await dialog.showSaveDialog(mainWindow, { title: '保存织图导出文件', defaultPath: name,
    filters: [{ name: '织图导出文件', extensions: [name.split('.').pop() ?? 'json'] }] })
  if (choice.canceled || !choice.filePath) return false
  await writeFile(choice.filePath, Buffer.from(bytes))
  return true
})

/** 每个进程一份的临时凭证，防止本机上别的程序乱调我们的接口 */
const serverToken = randomUUID()

async function startLocalServer(): Promise<number> {
  const userData = app.getPath('userData')
  const dbPath = join(userData, 'zhitu.db')

  log(`数据目录: ${userData}`)
  log(`数据库文件: ${dbPath}`)

  dbHandle = openDatabase(dbPath)
  log(`数据库就绪；密钥加密可用: ${safeStorage.isEncryptionAvailable()}`)

  const hono = createServer({
    db: dbHandle.db,
    token: serverToken,
    // 用 package.json 里的版本号，而不是 app.getVersion()。
    // 以脚本方式启动时，Electron 的 getVersion() 返回的是 Electron 自己的版本，
    // 会让设置页显示成 v38.8.6 这种让人看不懂的东西。
    version: appVersion,
    dataDir: userData
  })

  return await new Promise<number>((resolve, reject) => {
    // 监听 0 端口 = 让操作系统随便分配一个空闲端口，避免跟别的软件撞车
    const server = serve(
      { fetch: hono.fetch, hostname: '127.0.0.1', port: 0 },
      (info: AddressInfo) => resolve(info.port)
    )
    server.on('error', reject)
    nodeServer = server
  })
}

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#faf9f6',
    title: '织图',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 关键：把端口和凭证通过启动参数传给 preload。
      // 这样一定早于页面脚本就绪，不存在"读太早还没准备好"的时序问题。
      additionalArguments: [`--zhitu-port=${port}`, `--zhitu-token=${serverToken}`]
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    log('窗口已显示')
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 外部链接交给系统浏览器打开，不在应用内部开新窗口
    if (/^https?:\/\//i.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url)).catch((err) => logError('打开链接失败', err))
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url)).catch((err) => logError('打开链接失败', err))
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // userData 目录此时才可用，所以日志要在 ready 之后初始化
  initLogger(app.getPath('userData'))

  const missing = checkRuntimeDependencies()

  try {
    if (missing) throw new Error(missing)
    serverPort = await startLocalServer()
    log(`本地服务已启动: http://127.0.0.1:${serverPort}`)
    createWindow(serverPort)

    // 自动化验证脚本需要一个入口拿到端口和凭证。
    // 只在被脚本加载时才会读到这里，正常运行时没有任何影响。
    ;(globalThis as Record<string, unknown>).__zhitu = {
      port: serverPort,
      token: serverToken,
      db: dbHandle
    }
    writeReadyFile()
  } catch (err) {
    logError('启动失败', err)
    dialog.showErrorBox(
      '织图启动失败',
      [
        '本地数据服务没能启动。',
        '',
        `原因：${err instanceof Error ? err.message : String(err)}`,
        '',
        `日志文件：${join(app.getPath('userData'), 'logs', 'app.log')}`
      ].join('\n')
    )
    app.quit()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow(serverPort)
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  log('正在关闭…')
  // 先停本地服务再关数据库：反过来会让正在处理的请求打到一个已经关掉的连接上。
  // close() 会等已有连接结束，所以关完再关数据库。
  try {
    nodeServer?.close()
  } catch (err) {
    logError('关闭本地服务时出错', err)
  }
  try {
    dbHandle?.close()
  } catch (err) {
    logError('关闭数据库时出错', err)
  }
})

// 兜底：启动早期就出错时，别把退出路径上的意外变成"关不掉的进程"。
process.on('unhandledRejection', (reason) => {
  logError('未处理的 Promise 拒绝', reason)
})

/**
 * 启动前自检。
 * better-sqlite3 是原生模块，如果打包时没被正确带上，
 * 与其让用户看到一个看不懂的报错，不如在这里给出明确的中文说明。
 */
function checkRuntimeDependencies(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('better-sqlite3')
    return null
  } catch (err) {
    return [
      '织图的数据库组件没有正确安装。',
      `${err instanceof Error ? err.message : String(err)}`,
      '如果你是自行编译的，请在项目目录执行：npm install'
    ].join(' ')
  }
}

/**
 * 把一个"我已经启动好了"的小纸条写到临时目录，内容包含端口和凭证。
 *
 * 这是给自动化验证脚本用的：
 * Electron 是 GUI 程序，它的 stdout 不一定能被调用方接到，
 * 所以用它自己写的文件来传递信息最可靠。
 *
 * 只在脚本模式（设了 ZHITU_DATA_DIR）下写：文件里带着本地接口的凭证，
 * 正常使用时没必要把它落在临时目录里给同机其他账户看。
 */
function writeReadyFile(): void {
  if (!process.env.ZHITU_DATA_DIR) return
  try {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const target = join(app.getPath('userData'), 'zhitu-ready.json')
    writeFileSync(
      target,
      JSON.stringify({ port: serverPort, token: serverToken, pid: process.pid }),
      { encoding: 'utf-8', mode: 0o600 }
    )
    log(`就绪标记已写入: ${target}`)
  } catch (err) {
    logError('写就绪标记失败', err)
  }
}
