import { useEffect, useRef, useState } from 'react'
import { globalSearch, type SearchHit } from '../api'

interface Props {
  onClose: () => void
  onOpen: (hit: SearchHit) => void
  onCommand: (command: 'new' | 'settings' | 'export') => void
}

const labels: Record<SearchHit['kind'], string> = {
  turn: '对话', node: '知识点', note_block: '笔记', chunk: '资料原文', library: '资料库整理'
}

export function SearchDialog({ onClose, onOpen, onCommand }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const results = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    setActiveIndex(0)
    setHits([])
    setError('')
    if (!query.trim()) { setLoading(false); return }
    setLoading(true)
    let active = true
    const timer = window.setTimeout(() => {
      void globalSearch(query).then((result) => { if (active) { setHits(result.hits); setError('') } })
        .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '搜索失败') })
        .finally(() => { if (active) setLoading(false) })
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query])
  return <div className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}><div className="modal search-modal" role="dialog" aria-label="全局搜索" onKeyDown={(event) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || event.nativeEvent.isComposing) return
    const buttons = Array.from(results.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (!buttons.length || loading) return
    if (event.key === 'Enter' && document.activeElement !== input.current) return
    event.preventDefault()
    if (event.key === 'Enter') { buttons[activeIndex]?.click(); return }
    const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    setActiveIndex(next)
    buttons[next]?.scrollIntoView({ block: 'nearest' })
  }}>
    <div className="modal-head"><h2>搜索织图</h2><button className="btn" onClick={onClose}>关闭</button></div>
    <input ref={input} className="search-input" value={query} onChange={(event) => setQuery(event.target.value)}
      placeholder="搜知识点、笔记、对话或资料" aria-label="搜索内容" />
    <div className="search-results" ref={results} aria-busy={loading}>
      {query.trim() ? loading ? <p className="sidebar-note" role="status">正在搜索…</p> : error ? <p className="sidebar-note" role="alert">{error}</p> : hits.length ? hits.map((hit, index) =>
        <button className={index === activeIndex ? 'selected' : ''} key={`${hit.kind}-${hit.id}`} onClick={() => onOpen(hit)}>
          <small>{labels[hit.kind]}</small><strong>{hit.title}</strong><span>{hit.excerpt}</span>
        </button>) : <p className="sidebar-note">没有找到相关内容。换个词试试。</p>
        : <><p className="sidebar-label">快速操作</p>
          <button className={activeIndex === 0 ? 'selected' : ''} onClick={() => onCommand('new')}><strong>新的一场</strong></button>
          <button className={activeIndex === 1 ? 'selected' : ''} onClick={() => onCommand('settings')}><strong>打开设置</strong></button>
          <button className={activeIndex === 2 ? 'selected' : ''} onClick={() => onCommand('export')}><strong>导出</strong></button></>}
    </div>
    <div className="search-help">↑ ↓ 选择 · Enter 打开 · Esc 关闭</div>
  </div></div>
}
