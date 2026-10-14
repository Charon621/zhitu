import { safeStorage } from 'electron'
import type { ConfigStore } from './config-store'
import type { AppSettings, SettingsView, ProviderId, LearnerLevel } from '@shared/types'
import { getProvider, normalizeBaseURL } from '@shared/providers'

const KEY_SETTINGS = 'settings'
const KEY_SECRET_LEGACY = 'secret.apiKey'
const secretKey = (providerId: ProviderId): string => `secret.apiKey.${providerId}`

export const DEFAULT_SETTINGS: AppSettings = {
  onboarded: false,
  providerId: 'deepseek',
  baseURL: getProvider('deepseek').baseURL,
  model: getProvider('deepseek').defaultModel,
  utilityModel: '',
  visionEnabled: false,
  visionModel: '',
  learnerLevel: 'beginner',
  nickname: '',
  explanationDepth: 'medium'
}

/** 密钥的落盘格式：加密可用时存信封，不可用时退回明文并如实标注 */
interface SecretEnvelope {
  v: 1
  encrypted: boolean
  data: string
}

export class SettingsService {
  constructor(private config: ConfigStore) {}

  read(): AppSettings {
    const raw = this.config.getJSON<Partial<AppSettings>>(KEY_SETTINGS, {})
    return { ...DEFAULT_SETTINGS, ...raw }
  }

  write(patch: Partial<AppSettings>): AppSettings {
    this.migrateLegacyKey()
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    ) as Partial<AppSettings>
    const next: AppSettings = { ...this.read(), ...definedPatch }

    // 换了服务商但没手动改地址/模型时，自动带出该服务商的默认值
    if (patch.providerId && !patch.baseURL && !patch.model) {
      const preset = getProvider(next.providerId)
      if (!preset.needsBaseURL) {
        next.baseURL = preset.baseURL
        next.model = preset.defaultModel
      }
    }

    next.baseURL = normalizeBaseURL(next.baseURL)
    this.config.setJSON(KEY_SETTINGS, next)
    return next
  }

  /** 给渲染进程看的版本，去掉密钥，只告诉它"有没有、能不能用" */
  view(): SettingsView {
    const settings = this.read()
    return { ...settings, ...this.keyStatus(settings.providerId) }
  }

  /** 取密钥（主进程内部用，绝不外传） */
  apiKey(providerId: ProviderId = this.read().providerId): string {
    return this.readSecret(providerId).value
  }

  hasApiKey(providerId: ProviderId = this.read().providerId): boolean {
    return !!this.readSecret(providerId).value
  }

  keyStatus(providerId: ProviderId): { hasApiKey: boolean; keyEncrypted: boolean; keyUsable: boolean } {
    const secret = this.readSecret(providerId)
    // keyUsable：密钥记录还在、但这台机器用不了它（解不开或已损坏）时为 false。
    // 界面据此显示"密钥失效，请重新粘贴"，而不是让人以为一切正常却每次对话都失败。
    return { hasApiKey: !!secret.value, keyEncrypted: secret.encrypted,
      keyUsable: !!secret.value || !secret.exists }
  }

  setApiKey(plain: string, providerId: ProviderId = this.read().providerId): void {
    this.migrateLegacyKey()
    const trimmed = plain.trim()
    if (!trimmed) {
      this.config.delete(secretKey(providerId))
      return
    }
    if (safeStorage.isEncryptionAvailable()) {
      const cipher = safeStorage.encryptString(trimmed)
      const envelope: SecretEnvelope = {
        v: 1,
        encrypted: true,
        data: cipher.toString('base64')
      }
      this.config.setRaw(secretKey(providerId), JSON.stringify(envelope))
    } else {
      const envelope: SecretEnvelope = { v: 1, encrypted: false, data: trimmed }
      this.config.setRaw(secretKey(providerId), JSON.stringify(envelope))
    }
  }

  private migrateLegacyKey(): void {
    const raw = this.config.getRaw(KEY_SECRET_LEGACY)
    if (!raw) return
    const destination = secretKey(this.read().providerId)
    if (!this.config.getRaw(destination)) this.config.setRaw(destination, raw)
    this.config.delete(KEY_SECRET_LEGACY)
  }

  private readSecret(providerId: ProviderId): { value: string; encrypted: boolean; exists: boolean; broken?: boolean } {
    const raw = this.config.getRaw(secretKey(providerId)) ??
      (providerId === this.read().providerId ? this.config.getRaw(KEY_SECRET_LEGACY) : null)
    if (!raw) return { value: '', encrypted: false, exists: false }
    let envelope: SecretEnvelope | null = null
    try {
      const parsed = JSON.parse(raw) as SecretEnvelope
      if (parsed && typeof parsed.data === 'string') envelope = parsed
    } catch {
      // 最早期直接存明文，不是 JSON。下面按明文处理。
    }
    if (envelope?.encrypted) {
      if (!safeStorage.isEncryptionAvailable()) {
        // 密文还在，但这台机器现在解不开（换过账户、拷过数据目录、系统重装）。
        // exists = true 让界面能说实话，而不是显示成"没有密钥"。
        return { value: '', encrypted: true, exists: true, broken: true }
      }
      try {
        const value = safeStorage.decryptString(Buffer.from(envelope.data, 'base64'))
        // 密文损坏时 decryptString 可能不抛错、直接返回空串。别把它当成一把好钥匙。
        if (!value) return { value: '', encrypted: true, exists: true, broken: true }
        return { value, encrypted: true, exists: true }
      } catch {
        // 解不开就是解不开。绝不能退回"把整段信封当密钥用"，
        // 那会让界面显示成一切正常，然后每次对话都失败在服务商那里。
        return { value: '', encrypted: true, exists: true, broken: true }
      }
    }
    if (envelope) return { value: envelope.data ?? '', encrypted: false, exists: true }
    // 兼容最早期直接存明文的情况
    return { value: raw, encrypted: false, exists: true }
  }
}

export const LEVEL_LABELS: Record<LearnerLevel, string> = {
  beginner: '完全是外行，从零开始',
  some: '有一些基础，但不成体系',
  targeted: '有基础，想补特定方向',
  casual: '就想随便看看'
}

export const PROVIDER_IDS: ProviderId[] = [
  'deepseek',
  'moonshot',
  'zhipu',
  'dashscope',
  'openai',
  'custom'
]
