import { useRef, useState } from 'react'
import type { Bootstrap, TestResult } from '../api'
import { getProviderKeyStatus, recalculateSessionNotes, saveSettings, testConnection } from '../api'
import type { ProviderId, SettingsView } from '../types'

interface Props {
  bootstrap: Bootstrap
  onClose: () => void
  onSaved: (settings: SettingsView) => void
  sessionId: string | null
  onNotesRecalculated: () => void
  onConnectionRestored?: () => void
}

/**
 * 设置。
 * 第 0 步只放最要紧的几项：服务商、密钥、模型、水平。
 * 以后代理、后台整理模型、导出导入都加在这里。
 */
export function SettingsDialog({ bootstrap, onClose, onSaved, sessionId, onNotesRecalculated,
  onConnectionRestored }: Props): React.JSX.Element {
  const [providerId, setProviderId] = useState<ProviderId>(bootstrap.settings.providerId)
  const [apiKey, setApiKey] = useState('')
  const [keyStatus, setKeyStatus] = useState({ hasApiKey: bootstrap.settings.hasApiKey,
    keyEncrypted: bootstrap.settings.keyEncrypted, keyUsable: bootstrap.settings.keyUsable })
  const [baseURL, setBaseURL] = useState(bootstrap.settings.baseURL)
  const [model, setModel] = useState(bootstrap.settings.model)
  const [utilityModel, setUtilityModel] = useState(bootstrap.settings.utilityModel)
  const [visionEnabled, setVisionEnabled] = useState(bootstrap.settings.visionEnabled)
  const [visionModel, setVisionModel] = useState(bootstrap.settings.visionModel)
  const [explanationDepth, setExplanationDepth] = useState(bootstrap.settings.explanationDepth)
  const [customModel, setCustomModel] = useState(
    bootstrap.settings.providerId === 'custom' ? bootstrap.settings.model : ''
  )
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const providerRequest = useRef(0)
  const [recalculating, setRecalculating] = useState(false)
  const [recalculateMessage, setRecalculateMessage] = useState('')

  const provider = bootstrap.providers.find((p) => p.id === providerId) ?? bootstrap.providers[0]
  const isCustom = !!provider.needsBaseURL
  const knownModels = [provider.defaultModel, ...provider.altModels].filter(Boolean)
  const modelIsKnown = knownModels.includes(model)

  const onPickProvider = (id: ProviderId): void => {
    setProviderId(id)
    setResult(null)
    setSaved(false)
    setApiKey('')
    setKeyStatus({ hasApiKey: false, keyEncrypted: false, keyUsable: true })
    const generation = ++providerRequest.current
    void getProviderKeyStatus(id).then((status) => { if (generation === providerRequest.current) setKeyStatus(status) }).catch(() => undefined)
    const preset = bootstrap.providers.find((p) => p.id === id)
    if (preset && !preset.needsBaseURL) {
      setBaseURL(preset.baseURL)
      setModel(preset.defaultModel)
    } else {
      setModel('')
    }
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      const res = await testConnection({
        providerId,
        apiKey: apiKey || undefined,
        baseURL: isCustom ? baseURL : undefined,
        model: isCustom ? customModel : model
      })
      setResult(res)
      if (res.ok) onConnectionRestored?.()
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    if (saving || testing) return
    setSaving(true)
    setSaveError('')
    setSaved(false)
    try {
      const patch: Record<string, unknown> = { providerId }
      if (isCustom) {
        patch.baseURL = baseURL
        patch.model = customModel
      } else {
        patch.baseURL = provider.baseURL
        patch.model = model
      }
      if (apiKey.trim()) patch.apiKey = apiKey
      patch.utilityModel = utilityModel.trim()
      patch.visionEnabled = visionEnabled
      patch.visionModel = visionModel.trim()
      patch.explanationDepth = explanationDepth

      const { settings } = await saveSettings(patch)
      onSaved(settings)
      setKeyStatus({ hasApiKey: settings.hasApiKey, keyEncrypted: settings.keyEncrypted,
        keyUsable: settings.keyUsable })
      setSaved(true)
      setApiKey('')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  const recalculate = async (keepTitles: boolean): Promise<void> => {
    if (!sessionId || recalculating) return
    setRecalculating(true)
    setRecalculateMessage('')
    try {
      const result = await recalculateSessionNotes(sessionId, keepTitles)
      const merged = result.merged ? `，${result.merged} 条短回复并入相邻轮次` : ''
      setRecalculateMessage(result.failed
        ? `已处理 ${result.total} 轮${merged}，其中 ${result.failed} 轮失败；失败轮次原有笔记仍保留。`
        : `已重新整理 ${result.total} 轮对话${merged}。`)
      onNotesRecalculated()
    } catch (err) {
      setRecalculateMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setRecalculating(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>设置</h2>
          <button className="btn ghost small" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="modal-body" onChangeCapture={() => { setSaved(false); setSaveError(''); setResult(null) }}>
          <fieldset className="settings-fields" disabled={testing || saving}>
          <div className="field">
            <span className="field-label">服务商</span>
            <span className="field-hint">当前使用：{bootstrap.providers.find((item) => item.id === bootstrap.settings.providerId)?.label} · {bootstrap.settings.model}</span>
            <select
              className="input"
              aria-label="服务商"
              value={providerId}
              onChange={(e) => onPickProvider(e.target.value as ProviderId)}
            >
              {bootstrap.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {isCustom && (
            <>
              <label className="field">
                <span className="field-label">接口地址</span>
                <input
                  className="input"
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder="https://服务商/v1"
                />
              </label>
              <label className="field">
                <span className="field-label">模型名</span>
                <input
                  className="input"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="模型名"
                />
              </label>
            </>
          )}

          {!isCustom && knownModels.length > 0 && (
            <label className="field">
              <span className="field-label">模型</span>
              <select className="input" value={modelIsKnown ? model : ''} onChange={(e) => setModel(e.target.value)}>
                {!modelIsKnown && <option value="">{model || '请选择模型'}</option>}
                {knownModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span className="field-label">API Key</span>
            <input
              type="password"
              className="input"
              placeholder={keyStatus.hasApiKey ? '这家服务商已保存密钥，留空表示不改' : 'sk-...'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setResult(null)
              }}
            />
            <span className="field-hint">
              {!keyStatus.keyUsable
                ? '注意：这家服务商的密钥存在，但这台电脑现在解不开它（换过系统账户或拷过数据目录）。请重新粘贴一次。'
                : keyStatus.hasApiKey ? keyStatus.keyEncrypted
                  ? '这家服务商的密钥已加密存储在这台电脑上。'
                  : '注意：这台机器不支持系统级加密，这家服务商的密钥以明文保存在本地文件里。'
                  : '这家服务商还没有保存密钥。切回以前的服务商可继续使用原来的密钥。'}
            </span>
          </label>

          <label className="field">
            <span className="field-label">后台整理模型（可选）</span>
            <input className="input" value={utilityModel}
              onChange={(event) => setUtilityModel(event.target.value)}
              placeholder="留空时使用对话模型" />
            <span className="field-hint">用来整理笔记和生成学习入口，可填一个更便宜的模型。</span>
          </label>

          <label className="field">
            <span className="field-label">讲解深度：{explanationDepth === 'less' ? '少解释' : explanationDepth === 'more' ? '多解释' : '适中'}</span>
            <input type="range" min="0" max="2" step="1" value={['less', 'medium', 'more'].indexOf(explanationDepth)}
              onChange={(event) => setExplanationDepth((['less', 'medium', 'more'] as const)[Number(event.target.value)])} />
            <span className="field-hint">这只控制你想听多少解释，不会要求你自报水平。</span>
          </label>

          <label className="field">
            <span className="field-label">视觉识别（图片与扫描页）</span>
            <span><input type="checkbox" checked={visionEnabled}
              onChange={(event) => {
                setVisionEnabled(event.target.checked)
                if (event.target.checked && providerId === 'deepseek' && !visionModel) setVisionModel('deepseek-flash')
              }} /> 允许把图片发给视觉模型</span>
            <span className="field-hint">默认关闭。开启后可能增加 API 费用；原件仍保存在本机，提问时才发送相关图片。</span>
          </label>
          {visionEnabled && <label className="field">
            <span className="field-label">视觉模型名（可选）</span>
            <input className="input" value={visionModel} onChange={(event) => setVisionModel(event.target.value)}
              placeholder={providerId === 'deepseek' ? 'deepseek-flash' : '留空则沿用对话模型'} />
            <span className="field-hint">DeepSeek 可填 deepseek-flash；其他服务商请填写支持图片的模型名。</span>
          </label>}

          <div className="row">
            <button className="btn" onClick={runTest} disabled={testing}>
              {testing ? '正在测试…' : '测试连接'}
            </button>
            <button className="btn primary" onClick={save} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            {saved && <span className="saved-hint">已保存</span>}
          </div>
          {saveError && <div className="banner error" role="alert">{saveError}</div>}
          </fieldset>

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

          <div className="divider" />

          <div className="field">
            <span className="field-label">本场笔记</span>
            <span className="field-hint">从原始对话重新整理，保留你手工改过或删掉的笔记。这会调用所选 AI 服务商。</span>
            <div className="row">
              <button className="btn" onClick={() => void recalculate(true)} disabled={!sessionId || recalculating}>
                {recalculating ? '正在重算…' : '重算（保留现有卡片）'}
              </button>
              <button className="btn ghost" onClick={() => void recalculate(false)} disabled={!sessionId || recalculating}>
                重算并允许重新分卡
              </button>
            </div>
            <span className="field-hint">保留现有卡片时按你现在的分卡只刷新内容；允许重新分卡时模型可能把几张卡合并或拆开。</span>
            {recalculateMessage && <span className="field-hint">{recalculateMessage}</span>}
          </div>

          <div className="divider" />

          <div className="meta-grid">
            <div>
              <span className="field-label">数据目录</span>
              <div className="mono tiny">{bootstrap.dataDir}</div>
            </div>
            <div>
              <span className="field-label">版本</span>
              <div className="mono tiny">v{bootstrap.version}</div>
            </div>
            <div>
              <span className="field-label">已记录</span>
              <div className="tiny">
                {bootstrap.stats.sessions} 场 · {bootstrap.stats.turns} 条对话
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
