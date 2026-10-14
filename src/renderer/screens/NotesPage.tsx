import { useEffect, useMemo, useState } from 'react'
import { getAllNotes, type NoteCard as NoteCardData } from '../api'
import { NoteCard } from '../components/NoteCard'

interface Props {
  initialSelected?: string | null
  onSource: (turnId: string, sessionId: string | null) => void
  onDocument: (attachmentId: string, page: number | null) => void
  onAsk: (question: string, sessionId: string | null) => void
}

export function NotesPage({ initialSelected = null, onSource, onDocument, onAsk }: Props): React.JSX.Element {
  const [cards, setCards] = useState<NoteCardData[]>([])
  const [edges, setEdges] = useState<Array<{ src_id: string; dst_id: string }>>([])
  const [selected, setSelected] = useState<string | null>(initialSelected)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [kind, setKind] = useState('all')
  const [mastery, setMastery] = useState('all')
  const [time, setTime] = useState('all')
  const [openOnly, setOpenOnly] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const refresh = (): void => {
    void getAllNotes().then((data) => {
      setCards(data.cards)
      setEdges(data.edges)
      setError('')
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }
  useEffect(() => { refresh() }, [])

  const visible = useMemo(() => cards.filter((card) => {
    if (query.trim() && !`${card.title} ${card.blocks.map((block) => block.content_md).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())) return false
    if (kind !== 'all' && card.kind !== kind) return false
    if (mastery !== 'all' && card.mastery !== Number(mastery)) return false
    if (openOnly && card.status !== 'open') return false
    if (time !== 'all' && Date.now() - Date.parse(card.updated_at) > Number(time) * 86_400_000) return false
    return true
  }), [cards, kind, mastery, time, openOnly, query])

  useEffect(() => {
    if (loading) return
    if (!visible.some((card) => card.id === selected)) setSelected(visible[0]?.id ?? null)
  }, [visible, selected, loading])

  const selectedCard = visible.find((card) => card.id === selected) ?? null
  const visibleIds = new Set(visible.map((card) => card.id))
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  for (const edge of edges) if (visibleIds.has(edge.src_id) && visibleIds.has(edge.dst_id) &&
    !parentOf.has(edge.dst_id) && edge.src_id !== edge.dst_id) {
    let ancestor: string | undefined = edge.src_id
    const seen = new Set<string>([edge.dst_id])
    while (ancestor && !seen.has(ancestor)) { seen.add(ancestor); ancestor = parentOf.get(ancestor) }
    if (ancestor) continue
    parentOf.set(edge.dst_id, edge.src_id)
    childrenOf.set(edge.src_id, [...(childrenOf.get(edge.src_id) ?? []), edge.dst_id])
  }
  const byId = new Map(visible.map((card) => [card.id, card]))
  const topicNames = new Map(visible.map((card) => [card.topic_id ?? 'none', card.topic_title ?? '未命名主题']))
  const topics = [...topicNames.keys()]
  const toggle = (id: string): void => setCollapsed((old) => {
    const next = new Set(old)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const renderNode = (card: NoteCardData, depth: number, ancestors: Set<string>): React.JSX.Element => {
    const children = (childrenOf.get(card.id) ?? []).map((id) => byId.get(id)).filter((item): item is NoteCardData => !!item)
    const cyclic = ancestors.has(card.id)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(card.id)
    return <div key={card.id}>
      <div className={`note-tree-row ${selected === card.id ? 'selected' : ''}`} style={{ paddingLeft: 10 + Math.min(depth, 8) * 14 }}>
        {children.length && !cyclic ? <button className="note-tree-toggle" onClick={() => toggle(card.id)}
          aria-label={collapsed.has(card.id) ? '展开子节点' : '收起子节点'}>{collapsed.has(card.id) ? '▸' : '▾'}</button>
          : <span className="note-tree-toggle-spacer" />}
        <button className="note-tree-title" onClick={() => setSelected(card.id)} title={card.title}>{card.title}</button>
      </div>
      {!collapsed.has(card.id) && !cyclic && children.map((child) => renderNode(child, depth + 1, nextAncestors))}
    </div>
  }

  return <section className="notes-page">
    <header className="notes-page-head">
      <div><h1>笔记</h1><p>从一个点往下看，记下的内容都在这里。</p></div>
      <span>{visible.length} 张卡片</span>
    </header>
    <div className="notes-filters">
      <input className="input notes-query" aria-label="筛选笔记" placeholder="搜索标题或笔记内容" value={query} onChange={(event) => setQuery(event.target.value)} />
      <label>类型 <select value={kind} onChange={(event) => setKind(event.target.value)}>
        <option value="all">全部</option><option value="question">问题</option><option value="concept">概念</option>
        <option value="fact">结论</option><option value="example">例子</option><option value="resource">资料</option>
      </select></label>
      <label>掌握度 <select value={mastery} onChange={(event) => setMastery(event.target.value)}>
        <option value="all">全部</option>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} / 5</option>)}
      </select></label>
      <label>时间 <select value={time} onChange={(event) => setTime(event.target.value)}>
        <option value="all">全部</option><option value="7">最近一周</option><option value="30">最近一月</option>
      </select></label>
      <label className="notes-open-filter"><input type="checkbox" checked={openOnly}
        onChange={(event) => setOpenOnly(event.target.checked)} />只看未收线</label>
      {(query || kind !== 'all' || mastery !== 'all' || time !== 'all' || openOnly) && <button className="btn ghost small" onClick={() => {
        setQuery(''); setKind('all'); setMastery('all'); setTime('all'); setOpenOnly(false)
      }}>清除筛选</button>}
    </div>
    {error && <div className="banner error">{error}</div>}
    <div className="notes-columns">
      <nav className="notes-tree" aria-label="笔记节点树">
        <div className="notes-outline-label">大纲 · 点标题跳到知识点</div>
        {topics.map((topicId) => <div key={topicId}>
          <div className="notes-topic">{topicNames.get(topicId)}</div>
          {visible.filter((card) => (card.topic_id ?? 'none') === topicId && !parentOf.has(card.id))
            .map((card) => renderNode(card, 0, new Set()))}
        </div>)}
        {!visible.length && <p className="sidebar-note">{loading ? '正在读取笔记…' : cards.length ? '没有匹配的笔记，请调整或清除筛选。' : '还没有笔记。聊清一个知识点后，内容会出现在这里。'}</p>}
      </nav>
      <div className="notes-detail">
        {selectedCard ? <NoteCard key={selectedCard.id} card={selectedCard} full onChanged={refresh}
          onSource={(turnId) => onSource(turnId, selectedCard.origin_session_id ?? null)}
          onDocument={onDocument} onAsk={(question) => onAsk(question, selectedCard.origin_session_id ?? null)} />
          : <div className="placeholder"><p className="sidebar-note">选一张左侧的卡片，就能读完整笔记。</p></div>}
      </div>
    </div>
  </section>
}
