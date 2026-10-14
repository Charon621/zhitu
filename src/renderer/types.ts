export type ProviderId =
  | 'deepseek'
  | 'moonshot'
  | 'zhipu'
  | 'dashscope'
  | 'openai'
  | 'custom'

export interface ProviderPreset {
  id: ProviderId
  label: string
  hint: string
  baseURL: string
  defaultModel: string
  altModels: string[]
  consoleURL: string
  needsBaseURL?: boolean
}

export type LearnerLevel = 'beginner' | 'some' | 'targeted' | 'casual'

export interface AppSettings {
  onboarded: boolean
  providerId: ProviderId
  baseURL: string
  model: string
  utilityModel: string
  visionEnabled: boolean
  visionModel: string
  learnerLevel: LearnerLevel
  nickname: string
  explanationDepth: 'less' | 'medium' | 'more'
}

export interface SettingsView extends AppSettings {
  hasApiKey: boolean
  keyEncrypted: boolean
  /** 密钥现在能不能用；密文存在但解不开时为 false */
  keyUsable: boolean
}

export interface TurnRow {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
  attachmentIds?: string[]
}
