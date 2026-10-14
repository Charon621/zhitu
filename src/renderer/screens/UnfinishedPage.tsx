import type { OpenThread } from '../api'

interface Props {
  threads: OpenThread[]
  onContinue: (thread: OpenThread) => void
  onClose: (thread: OpenThread, reason: 'mastered' | 'uninterested') => void
}

export function UnfinishedPage({ threads, onContinue, onClose }: Props): React.JSX.Element {
  return <section className="unfinished-page">
    <header className="review-head"><h1>未收线</h1><p>走远了也没关系，停过的地方都在这里。</p></header>
    <div className="unfinished-page-list">
      {threads.length ? threads.map((thread) => <article className="unfinished-card" key={thread.id}>
        <strong>{thread.title}</strong>
        {thread.stoppedAt && <p>停在：{thread.stoppedAt}</p>}
        {thread.nextStep && <p>下次：{thread.nextStep}</p>}
        <div className="unfinished-actions">
          <button onClick={() => onContinue(thread)}>继续</button>
          <button onClick={() => onClose(thread, 'mastered')}>我懂了</button>
          <button onClick={() => onClose(thread, 'uninterested')}>不感兴趣</button>
        </div>
      </article>) : <p className="sidebar-note">还没有未收线的问题。回到对话随意探索，没聊完的会留在这里。</p>}
    </div>
  </section>
}
