import { useState } from 'react'
import type { Bootstrap, TestResult } from '../api'
import { saveSettings, testConnection } from '../api'
import type { ProviderId } from '../types'

/**
 * 首次启动向导。
 *
 * 方案书里说过：这一步不做好的话，用户会对着空白页面发呆然后关掉，
 * 再也不打开。只问服务商和密钥，第 2 步可以直接测试连接。
 */

interface Props {
  bootstrap: Bootstrap
  onDone: (settings: Bootstrap['settings']) => void
}

const STEPS = ['选服务商', '填密钥并测试连接']

export function Onboarding({ bootstrap, onDone }: Props): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [providerId, setProviderId] = useState<ProviderId>(bootstrap.settings.providerId)
  const [apiKey, setApiKey] = useState('')
  const [customBaseURL, setCustomBaseURL] = useState(
    bootstrap.settings.providerId === 'custom' ? bootstrap.settings.baseURL : ''
  )
  const [customModel, setCustomModel] = useState(
    bootstrap.settings.providerId === 'custom' ? bootstrap.settings.model : ''
  )
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const provider = bootstrap.providers.find((p) => p.id === providerId) ?? bootstrap.providers[0]

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      const res = await testConnection({
        providerId,
        apiKey,
        ...(providerId === 'custom' ? { baseURL: customBaseURL, model: customModel } : {})
      })
      setResult(res)
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        advice: '再试一次，或者换一个服务商。'
      })
    } finally {
      setTesting(false)
    }
  }

  const finish = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const { settings } = await saveSettings({
        providerId,
        apiKey,
        onboarded: true,
        ...(providerId === 'custom' ? { baseURL: customBaseURL, model: customModel } : {})
      })
      onDone(settings)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const canLeaveStep1 = (): boolean => {
    if (!apiKey.trim()) return false
    if (providerId === 'custom' && (!customBaseURL.trim() || !customModel.trim())) return false
    return true
  }

  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="onboard-brand">
          <div className="brand-name">织图</div>
          <div className="brand-tagline">把好奇心织成一张地图</div>
        </div>

        <div className="steps">
          {STEPS.map((label, index) => (
            <div key={label} className={`step ${index === step ? 'active' : ''} ${index < step ? 'done' : ''}`}>
              <span className="step-dot">{index < step ? '✓' : index + 1}</span>
              <span className="step-label">{label}</span>
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="onboard-body">
            <h2>选一个 AI 服务商</h2>
            <p className="muted">
              你的对话会发给它，费用由你的账号承担。选错了也没关系，随时能改。
            </p>
            <div className="provider-list">
              {bootstrap.providers.map((p) => (
                <label key={p.id} className={`provider-item ${p.id === providerId ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="provider"
                    checked={p.id === providerId}
                    onChange={() => setProviderId(p.id)}
                  />
                  <span className="provider-text">
                    <span className="provider-label">{p.label}</span>
                    <span className="provider-hint">{p.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="onboard-body">
            <h2>粘贴你的密钥</h2>
            <p className="muted">
              密钥保存在这台电脑上；连接 AI 时会发送给你选的服务商。
            </p>

            {provider.needsBaseURL ? (
              <>
                <label className="field">
                  <span className="field-label">接口地址</span>
                  <input
                    type="text"
                    className="input"
                    placeholder="https://你的服务商/v1"
                    value={customBaseURL}
                    onChange={(e) => {
                      setCustomBaseURL(e.target.value)
                      setResult(null)
                    }}
                  />
                </label>
                <label className="field">
                  <span className="field-label">模型名</span>
                  <input
                    type="text"
                    className="input"
                    placeholder="比如 deepseek-chat"
                    value={customModel}
                    onChange={(e) => {
                      setCustomModel(e.target.value)
                      setResult(null)
                    }}
                  />
                  <span className="field-hint">任何 OpenAI 兼容接口都行，包括本机跑的模型。</span>
                </label>
              </>
            ) : (
              <div className="field">
                <span className="field-label">接口地址</span>
                <div className="readonly-value">{provider.baseURL}</div>
                <span className="field-hint">
                  模型：{bootstrap.settings.model || provider.defaultModel}（可在设置里改）
                </span>
              </div>
            )}

            <label className="field">
              <span className="field-label">API Key</span>
              <input
                type="password"
                className="input"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setResult(null)
                }}
                autoFocus
              />
            </label>

            <div className="row">
              <button className="btn" onClick={runTest} disabled={testing || !apiKey.trim()}>
                {testing ? '正在测试…' : '测试连接'}
              </button>
              {provider.consoleURL && (
                <a className="link" href={provider.consoleURL} target="_blank" rel="noreferrer">
                  去哪里申请密钥 →
                </a>
              )}
            </div>

            {result && (
              <div className={`test-result ${result.ok ? 'ok' : 'fail'}`}>
                {result.ok ? (
                  <>
                    <div className="test-title">✓ 连接成功</div>
                    <div className="test-detail">模型回复：{result.reply}</div>
                  </>
                ) : (
                  <>
                    <div className="test-title">✕ 没连上</div>
                    <div className="test-detail">{result.message}</div>
                    {result.advice && <div className="test-advice">建议：{result.advice}</div>}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {error && <div className="banner error">{error}</div>}

        <div className="onboard-footer">
          <button
            className="btn ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
          >
            上一步
          </button>

          {step < 1 ? (
            <button
              className="btn primary"
              onClick={() => setStep((s) => s + 1)}
              disabled={step === 1 && !canLeaveStep1()}
            >
              下一步
            </button>
          ) : (
            <button className="btn primary" onClick={finish} disabled={saving || !canLeaveStep1()}>
              {saving ? '正在保存…' : '开始使用'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
