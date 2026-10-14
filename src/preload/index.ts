import { contextBridge, ipcRenderer } from 'electron'

/**
 * preload 是主进程和界面之间唯一的桥。
 *
 * 它只做一件事：把"本地服务在哪个端口、凭证是什么"告诉界面。
 * 其他所有功能都走 HTTP，界面拿不到任何 Node 的能力，
 * 这样即使以后某个网页有漏洞，也碰不到你的文件系统。
 */

function readArg(prefix: string): string {
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : ''
}

const port = Number(readArg('--zhitu-port=')) || 0
const token = readArg('--zhitu-token=')

contextBridge.exposeInMainWorld('zhitu', {
  port,
  token,
  baseURL: `http://127.0.0.1:${port}`,
  platform: process.platform,
  saveExport: (name: string, bytes: Uint8Array): Promise<boolean> =>
    ipcRenderer.invoke('zhitu:save-export', name, bytes)
})
