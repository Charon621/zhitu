/**
 * 界面能看到的"桥"。
 * 只包含三个字段，没有函数 —— 界面通过 HTTP 跟本地服务打交道。
 */
interface ZhituBridge {
  port: number
  token: string
  baseURL: string
  platform: string
  saveExport(name: string, bytes: Uint8Array): Promise<boolean>
}

declare global {
  interface Window {
    zhitu: ZhituBridge
  }
}

export {}
