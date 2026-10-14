import { useEffect, useState } from 'react'
import { getWeekStats, type OpenThread, type WeekStats } from '../api'

interface Props { onContinue: (thread: OpenThread) => void }

export function StatsPage({ onContinue }: Props): React.JSX.Element {
  const [stats, setStats] = useState<WeekStats | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const monday = new Date()
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    monday.setHours(0, 0, 0, 0)
    let active = true
    void getWeekStats(monday.toISOString()).then((result) => { if (active) setStats(result) })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [])
  return <section className="stats-page">
    <header className="notes-page-head"><div><h1>本周回顾</h1><p>只记录学过什么，没有打卡或排名。</p></div></header>
    {error && <div className="banner error">{error}</div>}
    {!stats && !error && <p className="sidebar-note">正在整理本周记录…</p>}
    {stats && <div className="stats-content">
      <div className="stats-numbers">
        <div><strong>{stats.sessions}</strong><span>场学习</span></div>
        <div><strong>{stats.noteBlocks}</strong><span>条新笔记</span></div>
        <div><strong>{stats.unfinished.length}</strong><span>个未收线问题</span></div>
      </div>
      <section><h2>这周学过</h2>
        {stats.topics.length ? <div className="stats-list">{stats.topics.map((topic) =>
          <div key={topic.id}><strong>{topic.title}</strong><span>{topic.sessions} 场</span></div>)}</div>
          : <p>这周还没有学习记录。开始一场对话后，这里会出现主题。</p>}
      </section>
      <section><h2>还开着的问题</h2>
        {stats.unfinished.length ? <div className="stats-list">{stats.unfinished.map((thread) =>
          <div key={thread.id}><strong>{thread.title}</strong><button onClick={() => onContinue(thread)}>继续</button></div>)}</div>
          : <p>目前没有未收线的问题。遇到想继续追的方向，它会留在这里。</p>}
      </section>
    </div>}
  </section>
}
