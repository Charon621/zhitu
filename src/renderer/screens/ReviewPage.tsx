import { useEffect, useState } from 'react'
import { getDueReviewCount, getReviewQuestion, gradeReview,
  type ReviewGrade, type ReviewQuestion } from '../api'

interface Props { onNotes: () => void }

export function ReviewPage({ onNotes }: Props): React.JSX.Element {
  const [due, setDue] = useState(0)
  const [question, setQuestion] = useState<ReviewQuestion | null>(null)
  const [answer, setAnswer] = useState('')
  const [grade, setGrade] = useState<ReviewGrade | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const refreshDue = (): void => {
    void getDueReviewCount().then((data) => setDue(data.count))
      .catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取复习计划'))
      .finally(() => setLoading(false))
  }
  useEffect(() => { refreshDue() }, [])

  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setGrade(null)
    setQuestion(null)
    setAnswer('')
    try {
      const result = await getReviewQuestion()
      setQuestion(result.review)
      refreshDue()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const submit = async (): Promise<void> => {
    if (!question || !answer.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await gradeReview(question.attemptId, answer.trim())
      setGrade(result.result)
      refreshDue()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return <section className="review-page">
    <header className="review-head"><h1>复习</h1><p>用一个新情境试试自己是否真的理解了。</p></header>
    <div className="review-body">
      <div className="review-card">
        {!question ? <>
          <h2>{loading ? '正在读取复习计划…' : due ? `有 ${due} 个知识点到了复习时间` : '现在没有到期的复习'}</h2>
          <p>{due ? '一次只做一道。回答后会调整掌握度和下次复习时间。' :
            '回到笔记看看已学过的内容，新的复习会在合适的时候出现。'}</p>
          <div className="review-actions">{due > 0 && <button className="btn primary" onClick={() => void start()} disabled={busy}>
            {busy ? '正在出题…' : '开始复习'}</button>}
            <button className="btn" onClick={onNotes}>看笔记</button></div>
        </> : <>
          <div className="review-eyebrow">关于「{question.title}」</div>
          <h2>{question.question}</h2>
          {!grade ? <>
            <textarea aria-label="复习回答" value={answer} onChange={(event) => setAnswer(event.target.value)}
              placeholder="写下你的想法，尽量说明原因和适用条件…" rows={6} maxLength={4000} disabled={busy} />
            <div className="review-actions"><button className="btn primary" onClick={() => void submit()}
              disabled={busy || !answer.trim()}>{busy ? '正在判断…' : '提交回答'}</button></div>
          </> : <>
            <div className={`review-feedback ${grade.correct ? 'correct' : 'retry'}`}>
              <strong>{grade.correct ? '理解到位' : '还可以再想想'}</strong>
              <p>{grade.feedback}</p>
              <small>掌握度 {grade.mastery} / 5 · 下次复习 {new Date(grade.nextDueAt).toLocaleDateString('zh-CN')}</small>
            </div>
            <div className="review-actions"><button className="btn primary" onClick={() => void start()} disabled={busy}>
              {busy ? '正在出题…' : '下一题'}</button><button className="btn" onClick={onNotes}>看笔记</button></div>
          </>}
        </>}
        {error && <div className="banner error" role="alert">{error}<button className="btn small" onClick={refreshDue}>刷新计划</button></div>}
      </div>
    </div>
  </section>
}
