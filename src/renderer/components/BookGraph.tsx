import { useEffect, useMemo, useRef, useState } from 'react'
import cytoscape, { type Core } from 'cytoscape'
import type { AnalysisResult, BookCharacter, BookEvent, BookRelation } from '../../shared/library'

interface Props {
  result: AnalysisResult; through: number; query: string
  onSelect: (item: BookCharacter | BookEvent | BookRelation) => void
}

export function BookGraph({ result, through, query, onSelect }: Props): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const graph = useRef<Core | null>(null)
  const select = useRef(onSelect); select.current = onSelect
  const [view, setView] = useState<'characters' | 'story'>('characters')
  const [exportError, setExportError] = useState('')
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const events = useMemo(() => result.events.filter((e) => e.segment <= through), [result, through])
  const relations = useMemo(() => result.relations.filter((r) => r.segment <= through), [result, through])
  const characters = useMemo(() => result.characters.filter((c) => c.segment <= through), [result, through])

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const change = () => setDark(media.matches); media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])

  useEffect(() => {
    if (!container.current) return
    const textColor = dark ? '#f2eee8' : '#252c30'
    const elements: cytoscape.ElementDefinition[] = [
      ...characters.map((c) => ({ data: { id: c.id, label: c.name }, classes: 'character' })),
      ...(view === 'characters' ? relations.map((r) => ({ data: { id: r.id, source: r.from, target: r.to, label: r.label }, classes: 'relation' })) : [
        ...events.map((e, i) => ({ data: { id: e.id, label: `${i + 1}. ${e.title}` }, classes: 'event' })),
        ...events.slice(1).map((e, i) => ({ data: { id: `seq-${e.id}`, source: events[i].id, target: e.id, label: '剧情顺序' }, classes: 'sequence' })),
        ...events.flatMap((e) => e.characters.filter((id) => characters.some((c) => c.id === id)).map((id) => ({
          data: { id: `part-${e.id}-${id}`, source: id, target: e.id, label: '参与' }, classes: 'participates' })))
      ])
    ]
    const cy = cytoscape({ container: container.current, elements, minZoom: .15, maxZoom: 2.5, wheelSensitivity: .15,
      style: [
        { selector: 'node', style: { label: 'data(label)', color: textColor, 'text-wrap': 'wrap', 'text-max-width': '150px',
          'font-family': 'Microsoft YaHei, sans-serif', 'font-size': 13, 'text-valign': 'center', 'text-halign': 'center',
          width: 160, height: 58, 'background-color': dark ? '#343e3a' : '#e5ede7', shape: 'round-rectangle',
          'border-color': dark ? '#718779' : '#98aa9e', 'border-width': 1, padding: '8px' } },
        { selector: 'node.event', style: { 'background-color': dark ? '#3e3b36' : '#eeeae1', 'border-color': '#a89b86', shape: 'rectangle' } },
        { selector: 'edge', style: { label: 'data(label)', 'font-size': 11, color: textColor, 'curve-style': 'bezier',
          'line-color': '#8b978e', 'target-arrow-color': '#8b978e', 'target-arrow-shape': 'triangle', width: 1.5,
          'text-background-color': dark ? '#202523' : '#fbfaf8', 'text-background-opacity': .95, 'text-background-padding': '4px', 'text-rotation': 'autorotate' } },
        { selector: 'edge.participates', style: { 'line-style': 'dotted', 'target-arrow-shape': 'none', width: 1 } },
        { selector: '.dim', style: { opacity: .15 } },
        { selector: ':selected', style: { 'border-width': 3, 'border-color': '#2f6f5e', 'line-color': '#2f6f5e' } }
      ], layout: elements.filter((e) => !e.data.source).length <= 12
        ? { name: 'circle', animate: false, padding: 40, radius: 170, avoidOverlap: true }
        : { name: 'cose', animate: false, padding: 35, randomize: false,
          nodeRepulsion: () => 160000, idealEdgeLength: () => 180 },
    })
    graph.current = cy
    cy.on('tap', 'node, edge', (event) => {
      const id = event.target.id() as string
      const item = [...result.characters, ...result.events, ...result.relations].find((i) => i.id === id)
      if (item) select.current(item)
    })
    const observer = new ResizeObserver(() => cy.resize()); observer.observe(container.current)
    return () => { observer.disconnect(); graph.current = null; cy.destroy() }
  }, [result, view, dark, events, relations, characters])

  useEffect(() => {
    const cy = graph.current; if (!cy) return
    cy.elements().removeClass('dim')
    if (!query.trim()) return
    const hits = cy.nodes().filter((n) => String(n.data('label')).includes(query.trim()))
    const visible = hits.union(hits.connectedEdges()).union(hits.neighborhood())
    cy.elements().difference(visible).addClass('dim')
    if (hits.length) cy.fit(visible, 65)
  }, [query, result, view, through, dark])

  const exportImage = async () => {
    try {
      setExportError('')
      const cy = graph.current; if (!cy) return
      const data = cy.png({ full: true, scale: 1.5, maxWidth: 4000, maxHeight: 4000, bg: dark ? '#202523' : '#fbfaf8' })
      const bytes = Uint8Array.from(atob(data.split(',')[1]), (c) => c.charCodeAt(0))
      await window.zhitu.saveExport('织图-书籍关系图.png', bytes)
    } catch (e) { setExportError(e instanceof Error ? e.message : '图片导出失败') }
  }
  return <div className="book-graph">
    <div className="library-toolbar">
      <button className={`btn small ${view === 'characters' ? 'primary' : ''}`} aria-pressed={view === 'characters'} onClick={() => setView('characters')}>人物关系</button>
      <button className={`btn small ${view === 'story' ? 'primary' : ''}`} aria-pressed={view === 'story'} onClick={() => setView('story')}>剧情连线</button>
      <button className="btn small" onClick={() => graph.current?.fit(undefined, 35)}>适应窗口</button>
      <button className="btn small" aria-label="放大书籍图" onClick={() => graph.current?.zoom(Math.min(2.5, graph.current.zoom() * 1.2))}>＋</button>
      <button className="btn small" aria-label="缩小书籍图" onClick={() => graph.current?.zoom(Math.max(.15, graph.current.zoom() / 1.2))}>−</button>
      <button className="btn small" onClick={() => void exportImage()}>导出图片</button>
      <span>{characters.length} 人物 · {view === 'characters' ? relations.length : events.length} {view === 'characters' ? '关系' : '事件'}</span>
    </div>
    <div className="book-graph-canvas" ref={container} role="img" aria-label={`${view === 'characters' ? '人物关系' : '剧情连线'}图，可点击节点和连线查看原文；下方列表提供键盘操作`} />
    {exportError && <p role="alert">{exportError}</p>}
    {!characters.length && !events.length && <p className="library-empty">这段阅读范围还没有有依据的人物或事件。</p>}
  </div>
}
