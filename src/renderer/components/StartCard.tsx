import { useState } from 'react'
import { suggestEntries, type GoalKind, type StartEntry } from '../api'

const EXAMPLES = [
  '神经网络到底是怎么“学”的？',
  '为什么 AI 能看懂一句话是什么意思？',
  '大模型为什么会“胡说”？'
]

const TENDENCIES: Array<{ value: GoalKind; label: string; hint: string }> = [
  { value: 'principle', label: '偏原理', hint: '先弄清它为什么这样工作' },
  { value: 'hands_on', label: '偏动手', hint: '从能试一试的事情开始' },
  { value: 'casual', label: '随便看看', hint: '先找一个有意思的问题' }
]

interface Props {
  onQuestion: (question: string, topic?: { domain: string; goalKind: GoalKind }) => void
  onOwnQuestion: () => void
  onImportClick: () => void
}

export function StartCard({ onQuestion, onOwnQuestion, onImportClick }: Props): React.JSX.Element {
  const [stage, setStage] = useState<'start' | 'preference' | 'entries'>('start')
  const [domain, setDomain] = useState('')
  const [goalKind, setGoalKind] = useState<GoalKind>('casual')
  const [entries, setEntries] = useState<StartEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const generate = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await suggestEntries(domain.trim(), goalKind)
      setEntries(result.entries)
      setStage('entries')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="start-card" aria-label="开始学习">
      <div className="start-topline">学习工作台 / A PLACE TO THINK</div>
      {stage === 'start' && (
        <>
          <h1>让好奇心，有迹可循。</h1>
          <p className="start-intro">从一个问题出发。在对话里理解，在笔记里沉淀，慢慢织成自己的知识地图。</p>

          <div className="start-section">
            <label className="start-label" htmlFor="start-domain">想学点什么？</label>
            <div className="start-domain-row">
              <input
                id="start-domain"
                className="input"
                value={domain}
                maxLength={60}
                placeholder="例如：统计学、摄影、动物营养…"
                onChange={(event) => setDomain(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing && domain.trim()) setStage('preference')
                }}
              />
              <button className="btn primary" disabled={!domain.trim()} onClick={() => setStage('preference')}>
                开始
              </button>
            </div>
          </div>

          <div className="start-section">
            <div className="start-label">或者，直接问一个问题：</div>
            <div className="start-examples">
              {EXAMPLES.map((question) => (
                <button key={question} className="start-example" onClick={() => onQuestion(question)}>
                  {question}<span aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          </div>

          <button className="start-files" onClick={onImportClick}>或者，把资料拖进来，先从这份资料开始。也可以点这里选文件 →</button>
          <button className="start-own-question" onClick={onOwnQuestion}>我有具体问题，直接提问 →</button>
        </>
      )}

      {stage === 'preference' && (
        <>
          <h1>从「{domain.trim()}」的哪儿开始？</h1>
          <p className="start-intro">选一个倾向，让 AI 帮你挑三个能立刻开聊的问题。这不锁定什么，随时可以改。</p>
          <div className="start-tendencies" role="radiogroup" aria-label="学习倾向">
            {TENDENCIES.map((item) => (
              <label key={item.value} className={`start-tendency ${goalKind === item.value ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="goal-kind"
                  value={item.value}
                  checked={goalKind === item.value}
                  onChange={() => setGoalKind(item.value)}
                />
                <span><strong>{item.label}</strong><small>{item.hint}</small></span>
              </label>
            ))}
          </div>
          <div className="start-footer">
            <button className="btn ghost" disabled={busy} onClick={() => setStage('start')}>返回</button>
            <button className="btn primary" disabled={busy} onClick={() => void generate()}>
              {busy ? '正在挑起点…' : '帮我挑三个起点'}
            </button>
          </div>
        </>
      )}

      {stage === 'entries' && (
        <>
          <h1>给「{domain.trim()}」挑了三个起点</h1>
          <p className="start-intro">点一个问题，就从这里聊起来。</p>
          <div className="start-entries">
            {entries.map((entry, index) => (
              <button
                key={`${index}-${entry.question}`}
                className="start-entry"
                onClick={() => onQuestion(entry.question, { domain: domain.trim(), goalKind })}
              >
                <span className="start-entry-number">{String(index + 1).padStart(2, '0')}</span>
                <span><strong>{entry.question}</strong><small>{entry.why}</small></span>
                <span aria-hidden="true">→</span>
              </button>
            ))}
          </div>
          <div className="start-footer">
            <button className="btn ghost" onClick={() => setStage('preference')}>换个倾向</button>
          </div>
        </>
      )}

      {error && <div className="start-error" role="alert">{error}</div>}
    </section>
  )
}
