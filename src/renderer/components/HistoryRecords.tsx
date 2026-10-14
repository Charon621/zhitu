import type { HistoryPage, SessionSummary } from '../api'

interface Props {
  page: HistoryPage | null; loading: boolean; error: string; offset: number; onOffset: (n: number) => void
  current: string | null; busy: string; selected: string[]; renaming: string | null; draft: string
  onDraft: (value: string) => void; onRename: (item: SessionSummary) => void; onSave: () => void; onCancel: () => void
  onPick: (id: string) => void; onOpen: (id: string) => void; onArchive: (item: SessionSummary, value: boolean) => void; onDelete: (item: SessionSummary) => void
}
export function HistoryRecords(p: Props): React.JSX.Element {
  return <><div className="search-results history-records" aria-busy={p.loading}>
    {p.error && <p className="banner error" role="alert">{p.error}</p>}
    {p.loading && !p.page && <p className="sidebar-note" role="status">正在查找全部学习记录…</p>}
    {p.page?.sessions.map((item) => <div key={item.id} className={`history-row ${item.archived_at ? 'archived' : ''} ${item.id === p.current ? 'current' : ''}`}>
      {p.renaming === item.id ? <><input className="input history-rename" aria-label="新的名字" value={p.draft} autoFocus maxLength={60} onChange={(e) => p.onDraft(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); p.onSave() }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.onCancel() }
      }} /><span className="history-actions"><button className="btn small" disabled={!p.draft.trim() || !!p.busy} onClick={p.onSave}>保存</button><button className="btn small" onClick={p.onCancel}>取消</button></span></> : <>
        <input type="checkbox" className="history-pick" aria-label={`选择 ${item.title}`} checked={p.selected.includes(item.id)} onChange={() => p.onPick(item.id)} />
        <button className="history-open" onClick={() => p.onOpen(item.id)}><strong>{item.title}</strong><span>{new Date(item.started_at).toLocaleString('zh-CN')}{item.archived_at ? ' · 已归档' : item.ended_at ? ' · 已收线' : ''}</span></button>
        <span className="history-actions"><button className="btn small" disabled={!!p.busy} onClick={() => p.onRename(item)}>改名</button><button className="btn small" disabled={!!p.busy} onClick={() => p.onArchive(item, !item.archived_at)}>{item.archived_at ? '恢复' : '归档'}</button><button className="btn small danger" disabled={!!p.busy} onClick={() => p.onDelete(item)}>删除</button></span>
      </>}
    </div>)}
    {!p.loading && !p.error && !p.page?.sessions.length && <p className="sidebar-note">没有匹配的学习记录。试试其他标题或切换到已归档。</p>}
  </div><div className="history-pagination"><span>共 {p.page?.total ?? 0} 场{p.page?.total ? ` · 第 ${Math.floor(p.offset / 25) + 1} / ${Math.ceil(p.page.total / 25)} 页` : ''}</span><button className="btn small" disabled={p.loading || !p.offset} onClick={() => p.onOffset(Math.max(0, p.offset - 25))}>上一页</button><button className="btn small" disabled={p.loading || p.offset + 25 >= (p.page?.total ?? 0)} onClick={() => p.onOffset(p.offset + 25)}>下一页</button></div></>
}
