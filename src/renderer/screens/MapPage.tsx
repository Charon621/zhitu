import { useEffect, useMemo, useRef, useState } from 'react'
import cytoscape, { type Core } from 'cytoscape'
import { getMap, type MapData, type MapNode } from '../api'

interface Props {
  onOpenNote: (nodeId: string) => void
  onContinue: (question: string, sessionId: string | null) => void
}

const masteryColors = ['#d9dfe2', '#becad0', '#9bacb5', '#7b919d', '#567280', '#344c58']
const statusLabels: Record<string, string> = { open: '未收线', gathered: '已收线', mastered: '已掌握' }
function mapLabel(title: string): string {
  const short = title.length > 28 ? `${title.slice(0, 28)}…` : title
  const lines: string[] = []; let line = ''; let width = 0
  for (const token of short.match(/[A-Za-z0-9]+|./gu) ?? []) {
    const size = /^[A-Za-z0-9]+$/.test(token) ? token.length * .55 : 1
    if (width + size > 10 && line) { lines.push(line); line = ''; width = 0 }
    line += token; width += size
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

export function MapPage({ onOpenNote, onContinue }: Props): React.JSX.Element {
  const [data, setData] = useState<MapData | null>(null)
  const [topicId, setTopicId] = useState<string | null>(null)
  const [mode, setMode] = useState<'near' | 'mainline' | 'full'>('near')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [questionsOnly, setQuestionsOnly] = useState(false)
  const [unmasteredOnly, setUnmasteredOnly] = useState(false)
  const [recentOnly, setRecentOnly] = useState(false)
  const [openOnly, setOpenOnly] = useState(false)
  const [renderMs, setRenderMs] = useState<number | null>(null)
  const [renderedNodes, setRenderedNodes] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<{ title: string; x: number; y: number } | null>(null)
  const canvas = useRef<HTMLDivElement | null>(null)
  const graph = useRef<Core | null>(null)
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const change = (): void => setDark(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    void getMap(topicId ?? undefined).then((result) => {
      if (!active) return
      setData(result)
      setSelectedId(null)
      setExpanded(new Set())
      setMode('near')
      setError('')
      setLoading(false)
    }).catch((err: unknown) => { if (active) { setError(err instanceof Error ? err.message : String(err)); setLoading(false) } })
    return () => { active = false }
  }, [topicId])

  const eligible = useMemo(() => (data?.nodes ?? []).filter((node) => {
    if (questionsOnly && node.kind !== 'question') return false
    if (unmasteredOnly && node.status === 'mastered') return false
    if (recentOnly && Date.now() - Date.parse(node.updated_at) > 7 * 86_400_000) return false
    if (openOnly && node.status !== 'open') return false
    return true
  }), [data, questionsOnly, unmasteredOnly, recentOnly, openOnly])

  const visibleIds = useMemo(() => {
    const ids = new Set(eligible.map((node) => node.id))
    if (mode === 'full') return ids
    const parentEdges = (data?.edges ?? []).filter((edge) => edge.type === 'parent' &&
      ids.has(edge.src_id) && ids.has(edge.dst_id))
    const childIds = new Set(parentEdges.map((edge) => edge.dst_id))
    const roots = eligible.filter((node) => !childIds.has(node.id))
    if (!roots.length && eligible.length) roots.push(eligible[0])
    const children = new Map<string, string[]>()
    for (const edge of parentEdges) children.set(edge.src_id, [...(children.get(edge.src_id) ?? []), edge.dst_id])
    const visible = new Set(roots.map((node) => node.id))
    if (mode === 'mainline') {
      const byId = new Map(eligible.map((node) => [node.id, node]))
      for (const root of roots) {
        let current = root.id
        const visited = new Set<string>()
        while (!visited.has(current)) {
          visited.add(current)
          const next = (children.get(current) ?? []).map((id) => byId.get(id))
            .filter((node): node is MapNode => !!node)
            .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0]
          if (!next) break
          visible.add(next.id)
          current = next.id
        }
      }
      return visible
    }
    for (const root of roots) for (const child of children.get(root.id) ?? []) visible.add(child)
    for (const id of expanded) if (visible.has(id)) for (const child of children.get(id) ?? []) visible.add(child)
    return visible
  }, [eligible, data, mode, expanded])

  useEffect(() => {
    if (!canvas.current || !data || !visibleIds.size) { setRenderMs(null); setRenderedNodes(0); return }
    setRenderMs(null)
    setRenderedNodes(0)
    const started = performance.now()
    const nodes = data.nodes.filter((node) => visibleIds.has(node.id))
    const edges = data.edges.filter((edge) => visibleIds.has(edge.src_id) && visibleIds.has(edge.dst_id))
    // Group a branch together, then use a compact reading order. Fit chooses rows/columns
    // from the actual viewport instead of shrinking a force layout with huge empty gaps.
    const children = new Map<string, string[]>()
    const childIds = new Set<string>()
    for (const edge of edges.filter((e) => e.type === 'parent')) { children.set(edge.src_id, [...(children.get(edge.src_id) ?? []), edge.dst_id]); childIds.add(edge.dst_id) }
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const ordered: MapNode[] = []; const visited = new Set<string>()
    const visit = (id: string) => { if (visited.has(id) || !byId.has(id)) return; visited.add(id); ordered.push(byId.get(id)!); for (const child of children.get(id) ?? []) visit(child) }
    for (const node of nodes.filter((n) => !childIds.has(n.id))) visit(node.id)
    for (const node of nodes) visit(node.id)
    let columns = 1; let best = 0
    for (let c = 1; c <= nodes.length; c++) {
      const scale = Math.min((canvas.current.clientWidth - 56) / (c * 188), (canvas.current.clientHeight - 88) / (Math.ceil(nodes.length / c) * 94))
      if (scale > best) { best = scale; columns = c }
    }
    const cy = cytoscape({
      container: canvas.current,
      elements: [
        ...ordered.map((node, i) => ({ data: { id: node.id, label: mapLabel(node.title),
          color: masteryColors[Math.min(5, Math.max(0, node.mastery))] }, position: { x: (i % columns) * 188, y: Math.floor(i / columns) * 94 } })),
        ...edges.map((edge) => ({ data: { id: edge.id, source: edge.src_id, target: edge.dst_id }, classes: edge.type }))
      ],
      style: [
        { selector: 'node', style: { 'background-color': dark ? '#303333' : '#eef3f3', label: 'data(label)', color: dark ? '#f2eee8' : '#252c30',
          'font-family': 'Microsoft YaHei, sans-serif', 'font-size': 14, 'text-wrap': 'wrap',
          'text-max-width': '144px', 'text-valign': 'center', 'text-halign': 'center',
          'shape': 'round-rectangle', 'background-opacity': 1,
          'border-width': 1.5, 'border-color': 'data(color)', width: 166, height: 66 } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#2f6f5e' } },
        { selector: 'node.overview', style: { label: '', 'background-color': 'data(color)' } },
        { selector: '.muted', style: { opacity: .2 } },
        { selector: 'edge', style: { width: 1.2, 'line-color': '#aaa49a', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#aaa49a', 'arrow-scale': .8 } },
        { selector: 'edge.prereq', style: { 'line-style': 'dashed', 'line-color': '#7d8c80' } },
        { selector: 'edge.related', style: { width: 0.7, 'line-style': 'dotted', 'line-color': '#b9b4aa' } },
        { selector: 'edge.answers', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': '#2f6f5e',
          'line-color': '#2f6f5e' } }
      ],
      layout: { name: 'preset', fit: true, padding: 32 },
      maxZoom: 2,
      minZoom: 0.1,
      wheelSensitivity: 0.2
    })
    graph.current = cy
    const labels = () => { cy.nodes().toggleClass('overview', cy.zoom() < .7) }
    cy.on('zoom', labels); labels()
    const resize = new ResizeObserver(() => { cy.resize() })
    resize.observe(canvas.current)
    let lastTap = { id: '', at: 0 }
    cy.on('tap', 'node', (event) => {
      const id = event.target.id() as string
      setSelectedId(id)
      const at = performance.now()
      if (lastTap.id === id && at - lastTap.at < 400) setExpanded((old) => new Set(old).add(id))
      lastTap = { id, at }
    })
    cy.on('mouseover', 'node', (event) => { const p = event.target.renderedPosition(); setHover({ title: byId.get(event.target.id())?.title ?? '', x: p.x, y: p.y }) })
    cy.on('mouseout', 'node', () => setHover(null))
    const frame = requestAnimationFrame(() => {
      setRenderedNodes(cy.nodes().length)
      setRenderMs(Math.round(performance.now() - started))
    })
    return () => { resize.disconnect(); cancelAnimationFrame(frame); graph.current = null; cy.destroy(); setHover(null) }
  }, [data, visibleIds, dark])

  useEffect(() => {
    const cy = graph.current
    if (!cy) return
    cy.elements().removeClass('muted'); cy.nodes().unselect()
    if (!selectedId) return
    const node = cy.getElementById(selectedId)
    if (!node.length) return
    node.select(); cy.elements().not(node.closedNeighborhood()).addClass('muted')
    cy.zoom(Math.max(.9, cy.zoom())); cy.center(node)
  }, [selectedId, visibleIds])

  const selectedNode = data?.nodes.find((node) => node.id === selectedId) ?? null
  const showFull = (): void => {
    if (loading) return
    setSelectedId(null)
    setMode('full')
  }

  return <section className="map-page" aria-busy={loading} data-topic-id={data?.selectedTopicId ?? ''}>
    <header className="map-head">
      <div><h1>地图</h1><p>点选查看连接，双击展开；缩小概览会收起标签，可用右侧目录查找并定位。</p></div>
      <select value={topicId ?? data?.selectedTopicId ?? ''} onChange={(event) => setTopicId(event.target.value)} aria-label="选择地图主题">
        {(data?.topics ?? []).map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}
      </select>
    </header>
    <div className="map-toolbar">
      <button disabled={loading} className={mode === 'near' ? 'active' : ''} onClick={() => setMode('near')}>附近两层</button>
      <button disabled={loading} className={mode === 'mainline' ? 'active' : ''} onClick={() => setMode('mainline')}>只看主线</button>
      <button disabled={loading} className={mode === 'full' ? 'active' : ''} onClick={showFull}>全览</button>
      <button className={showFilters ? 'active' : ''} onClick={() => setShowFilters(!showFilters)}>筛选</button>
      <button onClick={() => graph.current?.fit(undefined, 50)} disabled={!visibleIds.size}>适应窗口</button>
      <button aria-label="放大地图" onClick={() => graph.current?.zoom(Math.min(2, graph.current.zoom() * 1.2))}>＋</button>
      <button aria-label="缩小地图" onClick={() => graph.current?.zoom(Math.max(.1, graph.current.zoom() / 1.2))}>−</button>
      <span>{visibleIds.size} / {eligible.length} 个点</span>
    </div>
    {showFilters && <div className="map-filters">
      <label><input type="checkbox" checked={questionsOnly} onChange={(event) => setQuestionsOnly(event.target.checked)} />只看问题</label>
      <label><input type="checkbox" checked={unmasteredOnly} onChange={(event) => setUnmasteredOnly(event.target.checked)} />尚未掌握</label>
      <label><input type="checkbox" checked={recentOnly} onChange={(event) => setRecentOnly(event.target.checked)} />最近一周</label>
      <label><input type="checkbox" checked={openOnly} onChange={(event) => setOpenOnly(event.target.checked)} />只看未收线</label>
    </div>}
    {error && <div className="banner error">{error}</div>}
    <div className="map-stage">
      <div className="map-canvas" ref={canvas} data-render-ms={renderMs ?? ''} data-render-nodes={renderedNodes} />
      <aside className="map-outline" aria-label="知识点目录"><input className="input" placeholder="查找知识点…" aria-label="查找地图知识点" value={query} onChange={(e) => setQuery(e.target.value)} /><p>{eligible.length} 个知识点 · 点击定位</p><div>{eligible.filter((n) => n.title.toLowerCase().includes(query.trim().toLowerCase())).map((n) => <button key={n.id} title={n.title} className={n.id === selectedId ? 'active' : ''} onClick={() => { if (!visibleIds.has(n.id)) setMode('full'); setSelectedId(n.id) }}><i style={{ background: masteryColors[Math.min(5, Math.max(0, n.mastery))] }} /><span>{n.title}</span></button>)}{!eligible.some((n) => n.title.toLowerCase().includes(query.trim().toLowerCase())) && <p>没有匹配的知识点。</p>}</div></aside>
      {hover && <div className="map-tooltip" role="tooltip" style={{ left: hover.x, top: hover.y + (canvas.current?.offsetTop ?? 0) }}>{hover.title}</div>}
      <div className="map-legend" aria-label="地图图例">
        <div>掌握度 <span className="legend-colors">{masteryColors.map((color, index) => <i key={index} style={{ background: color }} />)}</span></div>
        <div><span className="legend-line solid" />从哪来 <span className="legend-line dashed" />前置 <span className="legend-line dotted" />相关 <span className="legend-line arrow" />回答</div>
      </div>
      {!data?.nodes.length && <div className="map-empty">还没有能画出来的知识点。先回到对话聊清一个问题，它会成为地图上的第一个点。</div>}
      {!!data?.nodes.length && !visibleIds.size && <div className="map-empty">没有符合筛选条件的知识点。<button className="btn small" onClick={() => {
        setQuestionsOnly(false); setUnmasteredOnly(false); setRecentOnly(false); setOpenOnly(false)
      }}>清除筛选</button></div>}
      {selectedNode && <div className="map-info">
        <button className="map-info-close" onClick={() => setSelectedId(null)} aria-label="关闭详情">×</button>
        <strong>{selectedNode.title}</strong>
        <small>{statusLabels[selectedNode.status] ?? selectedNode.status} · 掌握度 {selectedNode.mastery} / 5</small>
        <p>{selectedNode.summary || '这个点还没有完整笔记，可从这里继续提问。'}</p>
        <div><button onClick={() => onOpenNote(selectedNode.id)}>看笔记</button>
          <button onClick={() => onContinue(selectedNode.title, selectedNode.origin_session_id)}>继续聊</button></div>
      </div>}
    </div>
  </section>
}
