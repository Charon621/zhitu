/**
 * 主进程 / 渲染进程 / 本地服务共用的类型定义。
 * 这个文件里不写任何业务逻辑，只描述"数据长什么样"。
 */

// ─────────────────────────────────────────────
// AI 服务商
// ─────────────────────────────────────────────

export type ProviderId =
  | 'deepseek'
  | 'moonshot'
  | 'zhipu'
  | 'dashscope'
  | 'openai'
  | 'custom'

export interface ProviderPreset {
  id: ProviderId
  /** 界面上显示的名字 */
  label: string
  /** 一句话说明，帮用户选 */
  hint: string
  /** 接口地址（OpenAI 兼容协议） */
  baseURL: string
  /** 默认对话模型 */
  defaultModel: string
  /** 备选模型 */
  altModels: string[]
  /** 去哪里申请密钥 */
  consoleURL: string
  /** 是否需要自己填接口地址（自定义服务商） */
  needsBaseURL?: boolean
}

// ─────────────────────────────────────────────
// 设置
// ─────────────────────────────────────────────

/** 旧版学习者水平，仅保留以兼容已保存的设置 */
export type LearnerLevel = 'beginner' | 'some' | 'targeted' | 'casual'

export interface AppSettings {
  /** 用户是否走完了首次向导 */
  onboarded: boolean
  providerId: ProviderId
  /** 接口地址（选自定义服务商时由用户填） */
  baseURL: string
  /** 对话模型 */
  model: string
  /** 入口问题等短任务使用；留空时使用对话模型 */
  utilityModel: string
  /** 图片或扫描页是否允许送到视觉模型；默认关闭，避免意外增加费用 */
  visionEnabled: boolean
  /** 视觉模型名；留空时沿用对话模型 */
  visionModel: string
  /** 学习者水平 */
  learnerLevel: LearnerLevel
  /** 界面上的昵称，暂时没用上，先留着 */
  nickname: string
  /** 用户选择的讲解深度，不代表学习者水平 */
  explanationDepth: 'less' | 'medium' | 'more'
}

/** 返回给渲染进程的设置（绝不含密钥明文） */
export interface SettingsView extends AppSettings {
  /** 是否已经填过密钥 */
  hasApiKey: boolean
  /** 密钥是否处于加密存储状态 */
  keyEncrypted: boolean
  /**
   * 密钥现在能不能用。
   * 密文存在但系统解不开时为 false：界面要如实说"密钥失效，请重新粘贴"，
   * 而不是让人以为一切正常却每次对话都失败。
   */
  keyUsable: boolean
}

// ─────────────────────────────────────────────
// 对话
// ─────────────────────────────────────────────

export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  role: Role
  content: string | Array<{ type: 'text'; text: string } | {
    type: 'image_url'; image_url: { url: string }
  }>
}

// ─────────────────────────────────────────────
// 本地服务对外的接口
// ─────────────────────────────────────────────

export interface BootstrapInfo {
  port: number
  token: string
}

export interface ChatRequestBody {
  /** 会话 id，不传就新建一个 */
  sessionId?: string
  content: string
  domain?: string
  goalKind?: 'principle' | 'hands_on' | 'casual'
  attachmentIds?: string[]
  mode?: 'guide' | 'free' | 'review'
}

export interface ChatStreamEvent {
  type: 'meta' | 'delta' | 'done' | 'error'
  /** meta: 会话 id */
  sessionId?: string
  /** delta: 本次新增的一小段文字 */
  text?: string
  /** error: 出错说明 */
  message?: string
}
