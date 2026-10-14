import { useCallback, useEffect, useRef, useState } from 'react'
import { cancelDocumentAnalysis, deleteAttachment, getAnalysisPlan, getAttachmentFile, getDocumentAnalysis, getLibrary,
  saveDocumentSources, saveOrganizedNote, startDocumentAnalysis, uploadAttachment, type LibraryItem } from '../api'
import type { AnalysisMode, AnalysisPlan, BookCharacter, BookEvent, BookRelation, DocumentAnalysis, DocumentSource, Evidence, OrganizedNote } from '../../shared/library'
import type { SettingsView } from '../types'
import { BookGraph } from '../components/BookGraph'
import { Markdown } from '../components/Markdown'
import { lastLibrarySelection, readLibraryDraft, writeLibraryDraft, type LibraryDraft } from '../library-drafts'

const statusLabels: Record<string, string> = { idle: '待整理', running: '整理中', done: '已整理', failed: '待重试', cancelled: '已停止', pending: '解析中', ok: '可整理', partial: '部分提取' }
const message = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试'
const accepted = '.png,.jpg,.jpeg,.webp,.pdf,.epub,.txt,.md,.docx'
const exportName = (value: string, ext: string) => `织图-${value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 75)}.${ext}`
interface Props { settings: SettingsView; selection?: { attachmentId: string; itemId: string } | null; onSettings: () => void; onDiscuss: (id: string, title: string, attachmentId: string) => void }
export function LibraryPage({ settings, selection, onSettings, onDiscuss }: Props): React.JSX.Element {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [selected, setSelected] = useState<string | null>(() => selection?.attachmentId ?? lastLibrarySelection())
  const selectedRef = useRef(selected); selectedRef.current = selected
  const [analysis, setAnalysis] = useState<DocumentAnalysis | null>(null)
  const [mode, setMode] = useState<AnalysisMode>('handwriting')
  const [startPage, setStartPage] = useState(1); const [endPage, setEndPage] = useState(1)
  const [plan, setPlan] = useState<AnalysisPlan | null>(null)
  const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState(''); const [listQuery, setListQuery] = useState('')
  const [category, setCategory] = useState('全部'); const [through, setThrough] = useState(1)
  const [proof, setProof] = useState<Evidence | null>(null)
  const [tab, setTab] = useState<'result' | 'source'>('result')
  const [draftSources, rawSetSources] = useState<DocumentSource[] | null>(null)
  const [editing, rawSetEditing] = useState<OrganizedNote | null>(null)
  const draftRef = useRef<LibraryDraft>({ sources: null, note: null })
  const [draftError, setDraftError] = useState('')
  const persist = (draft: LibraryDraft) => {
    draftRef.current = draft
    if (!selected) return
    try { writeLibraryDraft(selected, draft); setDraftError('') }
    catch { setDraftError('本机草稿保存失败，关闭前请保存修改或导出草稿。') }
  }
  const setDraftSources = (sources: DocumentSource[] | null) => { rawSetSources(sources); persist({ ...draftRef.current, sources }) }
  const setEditing = (note: OrganizedNote | null) => { rawSetEditing(note); persist({ ...draftRef.current, note }) }
  const [originalURL, setOriginalURL] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  // 新导入的文件要不要按类型自动选整理方式：拖入和页头「导入资料」为 true，
  // 走「手写笔记 / 书籍阅读」入口进来的为 false（那里用户已经明确选过）。
  const inferMode = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (selection) setSelected(selection.attachmentId) }, [selection])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (draftError) { e.preventDefault(); e.returnValue = '' } }
    window.dispatchEvent(new CustomEvent('zhitu:library-draft-error', { detail: !!draftError }))
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [draftError])
  useEffect(() => () => { window.dispatchEvent(new CustomEvent('zhitu:library-draft-error', { detail: false })) }, [])
  const active = items.find((i) => i.attachment.id === selected)
  const running = analysis?.status === 'running'
  const result = analysis?.status !== 'done' && analysis?.previousResult ? analysis.previousResult : analysis?.result
  const resultSources = analysis?.status !== 'done' && analysis?.previousSources ? analysis.previousSources : analysis?.sources

  const refresh = useCallback(async () => {
    const data = await getLibrary()
    if (!mounted.current) return
    setItems(data.items); setLoading(false)
  }, [])
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try { await refresh() } catch (e) { if (alive) { setError(message(e)); setLoading(false) } }
      if (alive) timer = setTimeout(() => void tick(), 2000)
    }
    void tick(); return () => { alive = false; clearTimeout(timer) }
  }, [refresh])

  useEffect(() => {
    setAnalysis(null); setPlan(null); setError(''); setProof(null); rawSetSources(null); rawSetEditing(null); setDraftError('')
    setQuery(''); setCategory('全部'); setTab('result')
    if (!selected) return
    try {
      localStorage.setItem('zhitu.library.selected', selected)
      const draft = readLibraryDraft(selected); draftRef.current = draft
      rawSetSources(draft.sources); rawSetEditing(draft.note)
      if (draft.sources || draft.note) { setNotice('已恢复本机草稿，保存后才会更新正式内容。'); if (draft.sources) setTab('source') }
    } catch (e) { setDraftError(message(e)) }
    let alive = true; let timer: ReturnType<typeof setTimeout>; let initialized = false
    const tick = async () => {
      try {
        const data = await getDocumentAnalysis(selected)
        if (!alive) return
        setAnalysis((old) => old?.updatedAt === data.analysis?.updatedAt ? old : data.analysis)
        if (!initialized && data.analysis) {
          setMode(data.analysis.mode); setStartPage(data.analysis.startPage); setEndPage(data.analysis.endPage)
          setThrough(Math.max(1, data.analysis.total)); initialized = true
        }
      } catch (e) { if (alive) setError(message(e)) }
      if (alive) timer = setTimeout(() => void tick(), 1500)
    }
    void tick(); return () => { alive = false; clearTimeout(timer) }
  }, [selected])

  useEffect(() => {
    if (!selection || selection.attachmentId !== selected || !result) return
    const item = [...result.notes, ...result.characters, ...result.events, ...result.relations].find((i) => i.id === selection.itemId)
    if (!item) return
    setTab('result'); setQuery(''); setCategory('全部'); setThrough(Number.MAX_SAFE_INTEGER); setProof(item)
    const timer = window.setTimeout(() => document.getElementById(`library-item-${selection.itemId}`)?.scrollIntoView({ block: 'center' }), 100)
    return () => window.clearTimeout(timer)
  }, [selection, selected, result])

  useEffect(() => {
    if (!active || active.attachment.extract_status === 'pending' || active.attachment.extract_status === 'failed' || running) { setPlan(null); return }
    let alive = true; setPlan(null)
    void getAnalysisPlan(active.attachment.id, mode, startPage, endPage).then((data) => {
      if (alive) { setPlan(data.plan); setError('') }
    }, (e) => { if (alive) setError(message(e)) })
    return () => { alive = false }
  }, [selected, active?.attachment.extract_status, mode, startPage, endPage, running, settings.visionEnabled, settings.visionModel])

  useEffect(() => { return () => { if (originalURL) URL.revokeObjectURL(originalURL) } }, [originalURL])
  useEffect(() => { setOriginalURL(null) }, [selected])
  const choose = (item: LibraryItem) => {
    if (busy) return
    if (draftError && !window.confirm('草稿尚未保存在本机。仍要切换资料吗？')) return
    setSelected(item.attachment.id); setMode(item.analysis?.mode ?? (item.attachment.kind === 'image' ? 'handwriting' : 'book'))
    setStartPage(1); setEndPage(item.attachment.page_count ?? 1); setNotice('')
  }
  const importFiles = async (files: File[], inferFromKind = inferMode.current) => {
    if (!files.length || busy) return
    setBusy(true); setError(''); const failures: string[] = []; let last: LibraryItem | null = null
    for (const file of files) {
      try {
        const data = await uploadAttachment(file, undefined, true)
        last = { attachment: data.attachment, analysis: null }
      } catch (e) { failures.push(`${file.name}：${message(e)}`) }
    }
    if (!mounted.current) return
    try { await refresh() } catch (e) { failures.push(message(e)) }
    if (last) {
      setSelected(last.attachment.id)
      // 没有明确选过整理方式时按文件类型推断：图片是手写笔记，文档是书籍图谱。
      if (inferFromKind) setMode(last.attachment.kind === 'image' ? 'handwriting' : 'book')
      setStartPage(1); setEndPage(last.attachment.page_count ?? 1)
      setNotice(`已导入 ${files.length - failures.length} 份资料。确认页码与用量后开始整理。`)
    }
    setError(failures.join('\n')); setBusy(false)
  }
  // A newly parsed PDF/EPUB reveals its page count after upload.
  useEffect(() => {
    if (active?.attachment.page_count && !analysis) setEndPage(active.attachment.page_count)
  }, [active?.attachment.page_count, analysis?.attachmentId])
  const start = async (restart = false) => {
    if (!selected) return
    if (restart && result?.notes.some((n) => n.edited) && !window.confirm('重新整理成功后会替换当前手动修改的分类笔记。可先导出保留，继续吗？')) return
    const id = selected; setBusy(true); setError(''); setProof(null)
    try {
      const data = await startDocumentAnalysis(id, mode, { startPage, endPage, restart })
      if (selectedRef.current === id) { setAnalysis(data.analysis); setThrough(Number.MAX_SAFE_INTEGER); setNotice('整理已开始，可以离开本页；进度会保存在本机。') }
      await refresh()
    } catch (e) { if (selectedRef.current === id) setError(message(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { if (mounted.current) setError(message(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const exportResult = async () => {
    if (!analysis || !active || !result) return
    const lines = [`# ${active.attachment.original_name}`, '', `整理状态：${statusLabels[analysis.status]}；处理 ${analysis.completed}/${analysis.total} 段。AI 整理，请核对原文。`, '']
    if (analysis.warnings.length) lines.push(...analysis.warnings.map((w) => `提示：${w}`), '')
    const source = (e: Evidence) => `来源：${resultSources?.[e.source]?.label ?? '原文'}；摘录：${e.quote}`
    for (const n of result.notes) lines.push(`## ${n.category} / ${n.title}`, '', n.content, '', source(n), '')
    for (const c of result.characters.filter((c) => c.segment <= through)) lines.push(`## 人物：${c.name}`, '', c.description, '', source(c), '')
    for (const e of result.events.filter((e) => e.segment <= through)) lines.push(`## 剧情：${e.title}`, '', e.summary, '', source(e), '')
    for (const r of result.relations.filter((r) => r.segment <= through)) lines.push(`${result.characters.find((c) => c.id === r.from)?.name} → ${result.characters.find((c) => c.id === r.to)?.name}：${r.label}`, source(r), '')
    const saved = await window.zhitu.saveExport(exportName(`${active.attachment.original_name.replace(/\.[^.]+$/, '')}-整理`, 'md'), new TextEncoder().encode(lines.join('\n')))
    if (saved) setNotice('整理结果已导出。')
  }
  const showOriginal = async () => {
    if (!selected) return
    const id = selected; const blob = await getAttachmentFile(id)
    if (selectedRef.current !== id) return
    if (['image', 'pdf'].includes(active?.attachment.kind ?? '')) { setOriginalURL(URL.createObjectURL(blob)); setTab('source') }
    else {
      const name = active!.attachment.original_name
      const saved = await window.zhitu.saveExport(exportName(name.replace(/\.[^.]+$/, ''), name.split('.').pop()!.toLowerCase()), new Uint8Array(await blob.arrayBuffer()))
      if (saved) setNotice('原件已另存。')
    }
  }
  const showBookItem = (item: BookCharacter | BookEvent | BookRelation) => { setProof(item) }
  const categories = ['全部', ...new Set(result?.notes.map((n) => n.category) ?? [])]
  const noteMatches = result?.notes.filter((n) => (category === '全部' || n.category === category) && `${n.title} ${n.content} ${n.category}`.includes(query)) ?? []
  const bookEvents = result?.events.filter((e) => e.segment <= through && `${e.title} ${e.summary}`.includes(query)) ?? []
  const availableSegments = Math.max(1, analysis?.total ?? 1)
  const resumable = analysis && ['failed', 'cancelled'].includes(analysis.status) && analysis.mode === mode &&
    analysis.startPage === startPage && analysis.endPage === endPage

  return <section className="library-page" onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDragging(true) }}
    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); void importFiles(Array.from(e.dataTransfer.files), true) }}>
    <header className="library-head"><div><h1>资料库</h1><p>把手写页整理成笔记，把一本书展开成关系。</p></div>
      <button className="btn primary" disabled={busy} onClick={() => { inferMode.current = true; input.current?.click() }}>导入资料</button></header>
    <input type="file" ref={input} accept={accepted} multiple hidden onChange={(e) => { void importFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
    {dragging && <div className="drop-overlay">松手导入笔记或书籍</div>}
    <div className="library-layout"><aside className="library-list" aria-label="导入的资料">
      <input className="input" aria-label="搜索资料库" placeholder="查找文件…" value={listQuery} onChange={(e) => setListQuery(e.target.value)} />
      {loading ? <p role="status">加载资料…</p> : !items.length ? <p className="muted">这里会保留原件、整理结果和上次进度。</p> : null}
      {items.filter((i) => i.attachment.original_name.includes(listQuery)).map((item) => <button key={item.attachment.id} disabled={busy} className={`library-file ${selected === item.attachment.id ? 'active' : ''}`} onClick={() => choose(item)}>
        <strong>{item.attachment.original_name}</strong><span>{item.attachment.kind.toUpperCase()} · {statusLabels[item.analysis?.status ?? item.attachment.extract_status] ?? '待整理'}</span>
        {item.analysis?.status === 'running' && <small>{item.analysis.stage}</small>}</button>)}
      {!!listQuery && !items.some((i) => i.attachment.original_name.includes(listQuery)) && <p className="muted">没有找到这份资料。</p>}
    </aside><div className="library-content">
      {notice && <div className="inline-notice" role="status">{notice}<button aria-label="关闭资料库提示" onClick={() => setNotice('')}>×</button></div>}
      {error && <div className="banner error" role="alert">{error}<button className="btn small" onClick={onSettings}>设置</button></div>}
      {draftError && <div className="banner error" role="alert">{draftError}<button className="btn small" onClick={() => void window.zhitu.saveExport('织图-未保存草稿.json', new TextEncoder().encode(JSON.stringify(draftRef.current, null, 2)))}>导出草稿</button></div>}
      {(editing || draftSources) && !draftError && <p className="library-draft-status" role="status">草稿已保存在本机 · 切换资料、离开页面或重启后可继续编辑。</p>}
      {editing && result && !result.notes.some((n) => n.id === editing.id) && <div className="library-note"><h3>上次编辑的笔记草稿</h3><p>重新整理后，原来的笔记条目已变化。草稿仍保留在本机，可以先导出，再编辑新的条目。</p><strong>{editing.title}</strong><textarea className="input" aria-label="原笔记草稿内容" value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} /><div className="library-toolbar"><button className="btn small" onClick={() => void act(async () => { await window.zhitu.saveExport('织图-笔记草稿.md', new TextEncoder().encode(`# ${editing.title}\n\n${editing.content}\n`)) })}>导出这份草稿</button><button className="btn small" onClick={() => setEditing(null)}>丢弃这份草稿</button></div></div>}
      {!active ? <div className="library-welcome">
        <span className="library-eyebrow">从你手里的资料开始</span><h2>纸上的想法，书里的线索。</h2>
        <div className="library-entry-grid"><button className="library-entry" onClick={() => { inferMode.current = false; setMode('handwriting'); input.current?.click() }}>
          <span>01 / 手写笔记</span><h3>识别 → 校对 → 分类</h3><p>导入照片或扫描 PDF，保留原文，自动按主题整理。公式和难辨字可以再校对。</p><strong>导入手写笔记 →</strong></button>
          <button className="library-entry" onClick={() => { inferMode.current = false; setMode('book'); input.current?.click() }}>
            <span>02 / 书籍阅读</span><h3>人物 → 关系 → 剧情</h3><p>导入 EPUB、TXT、PDF 或 Word。沿着人物关系和剧情线索阅读，每条连线都能查原文。</p><strong>导入一本书 →</strong></button></div>
        <p className="muted">也可以把文件拖到这里。单文件最多 50 MB；AI 整理使用设置中的服务商，用量会在开始前显示。</p>
      </div> : <>
        <div className="library-document-head"><div><h2>{active.attachment.original_name}</h2><p>{(active.attachment.bytes / 1024 / 1024).toFixed(2)} MB{active.attachment.page_count ? ` · ${active.attachment.page_count} ${active.attachment.kind === 'epub' ? '节' : '页'}` : ''}</p></div>
          <div className="library-toolbar"><button className="btn small" disabled={busy} onClick={() => void act(showOriginal)}>查看原件</button>
            <button className="btn small" onClick={() => onDiscuss(active.attachment.session_id, active.attachment.original_name, active.attachment.id)}>带着资料聊</button>
            <button className="btn small" disabled={busy || running} onClick={() => {
              if (window.confirm(`删除《${active.attachment.original_name}》及它的整理结果？已被对话引用的原件会保留。`)) void act(async () => { await deleteAttachment(active.attachment.id); setSelected(null); await refresh() })
            }}>删除</button></div></div>
        {active.attachment.extract_error && <p className="library-warning">文件提取提示：{active.attachment.extract_error}</p>}
        <details className="library-setup" key={`${selected}-${analysis?.status === 'done' ? 'done' : 'active'}`} open={analysis?.status !== 'done'}>
          <summary>{running ? '正在整理 · 查看进度' : analysis?.status === 'done' ? '整理已完成 · 调整范围或重新整理' : '整理方式与预计用量'}</summary>
          <div className="library-toolbar" role="group" aria-label="资料整理方式"><button className={`btn small ${mode === 'handwriting' ? 'primary' : ''}`} disabled={running} aria-pressed={mode === 'handwriting'} onClick={() => setMode('handwriting')}>手写笔记</button>
            <button className={`btn small ${mode === 'book' ? 'primary' : ''}`} disabled={running} aria-pressed={mode === 'book'} onClick={() => setMode('book')}>书籍图谱</button>
            {!!active.attachment.page_count && <><label>从<input className="input library-number" aria-label="开始页或章节" type="number" min={1} max={active.attachment.page_count} value={startPage} disabled={running} onChange={(e) => setStartPage(Number(e.target.value))} /></label>
              <label>到<input className="input library-number" aria-label="结束页或章节" type="number" min={startPage} max={active.attachment.page_count} value={endPage} disabled={running} onChange={(e) => setEndPage(Number(e.target.value))} /></label></>}
          </div>
          {running ? <div className="library-progress" role="status"><strong>{analysis.stage}</strong><progress value={analysis.completed + analysis.ocrCompleted} max={Math.max(1, analysis.total + analysis.ocrTotal)} />
            <span>离开页面也会继续；重启后可续接。</span><button className="btn small" disabled={busy} onClick={() => void act(async () => { await cancelDocumentAnalysis(selected!); setNotice('正在停止当前请求…') })}>停止整理</button></div> : <>
            <p className="library-cost">{plan ? `${plan.ocrPages ? `视觉识别 ${plan.ocrPages} 页，` : ''}${plan.characters.toLocaleString()} 字可提取文字，预计约 ${plan.estimatedCalls} 次 AI 请求${plan.ocrPages ? '（识别后按实际字数分段）' : ''}。` : active.attachment.extract_status === 'pending' ? '正在提取文件文字…' : '等待整理方案…'}<br />
              使用 {settings.visionEnabled && plan?.ocrPages ? `${settings.visionModel} + ` : ''}{settings.utilityModel || settings.model}。开始后会把所选内容发送给设置中的服务商，费用由你的账户承担。</p>
            <div className="library-toolbar"><button className="btn primary" disabled={busy || !plan || !settings.hasApiKey} onClick={() => void start(!!analysis && !resumable)}>
              {resumable ? '从上次进度继续' : analysis ? '重新整理' : mode === 'handwriting' ? '开始识别并分类' : '生成人物与剧情图'}</button>
              {analysis && ['failed', 'cancelled'].includes(analysis.status) && <button className="btn small" disabled={!plan || busy} onClick={() => void start(true)}>从头整理</button>}
              {(!settings.hasApiKey || mode === 'handwriting' && !settings.visionEnabled) && <button className="btn small" onClick={onSettings}>配置 AI / 视觉识别</button>}
            </div></>}
          {analysis?.error && <p className="library-warning" role="status">{analysis.error}</p>}
        </details>
        {!!analysis?.sources.length && <div className="library-toolbar library-tabs"><button className={`btn small ${tab === 'result' ? 'primary' : ''}`} aria-pressed={tab === 'result'} onClick={() => setTab('result')}>整理结果</button>
          <button className={`btn small ${tab === 'source' ? 'primary' : ''}`} aria-pressed={tab === 'source'} onClick={() => setTab('source')}>原文与校对</button>
          {!!result && <button className="btn small" onClick={() => void act(exportResult)}>导出 Markdown</button>}</div>}
        {!!analysis?.warnings.length && <details className="library-warnings"><summary>提取与整理提示（{analysis.warnings.length}）</summary>{analysis.warnings.map((w) => <p key={w}>{w}</p>)}</details>}
        {tab === 'source' ? <div className="library-sources">
          {originalURL && (active.attachment.kind === 'image' ? <img src={originalURL} alt="导入的手写原件" /> : <iframe title="导入的 PDF 原件" src={originalURL} />)}
          {!!analysis?.sources.length && <><div className="library-toolbar"><p>识别结果保留在本机。保存校对后，再点重新整理更新分类与连线。</p>
            {!draftSources ? <button className="btn small" disabled={running || busy} onClick={() => setDraftSources(structuredClone(analysis.sources))}>校对原文</button> : <>
              <button className="btn primary small" disabled={busy} onClick={() => void act(async () => { const data = await saveDocumentSources(selected!, draftSources); setAnalysis(data.analysis); setDraftSources(null); setNotice('校对已保存，请重新整理以更新结果。') })}>保存校对</button>
              <button className="btn small" onClick={() => setDraftSources(null)}>取消</button></> }</div>
            {(draftSources ?? analysis.sources).map((s, i) => <details key={i} open={!!draftSources}><summary>{s.label} · {s.text.length} 字</summary>{draftSources ? <textarea className="input" aria-label={`校对 ${s.label}`} value={s.text} onChange={(e) => setDraftSources(draftSources.map((old, n) => n === i ? { ...old, text: e.target.value } : old))} /> : <pre>{s.text}</pre>}</details>)}</>}
        </div> : result && (result.notes.length || result.characters.length || result.events.length) ? <>
          <div className="library-toolbar"><input className="input library-search" aria-label="查找整理内容" placeholder={mode === 'book' ? '查找人物或剧情…' : '查找分类笔记…'} value={query} onChange={(e) => setQuery(e.target.value)} />
            <span className="muted">AI 整理 · 点击原文依据核对</span></div>
          {analysis?.previousResult && <p className="library-warning">当前展示上次保存的结果；新整理成功后才替换。</p>}
          {analysis?.mode === 'handwriting' ? <>
            <div className="library-toolbar library-categories" aria-label="笔记分类">{categories.map((c) => <button className={`btn small ${category === c ? 'primary' : ''}`} key={c} onClick={() => setCategory(c)}>{c}{c !== '全部' && ` (${result.notes.filter((n) => n.category === c).length})`}</button>)}</div>
            <div className="library-notes">{noteMatches.map((note) => <article key={note.id} id={`library-item-${note.id}`} className={`library-note ${selection?.itemId === note.id ? 'search-located' : ''}`}>
              {editing?.id === note.id ? <><label>分类<input className="input" aria-label="笔记分类" maxLength={60} value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} /></label>
                <label>标题<input className="input" aria-label="笔记标题" maxLength={100} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
                <label>内容<textarea className="input" aria-label="笔记内容" maxLength={4000} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} /></label>
                <div className="library-toolbar"><button className="btn primary small" disabled={busy} onClick={() => void act(async () => { const data = await saveOrganizedNote(selected!, note.id, editing); setAnalysis(data.analysis); setEditing(null); setCategory('全部'); setNotice('笔记修改已保存。') })}>保存笔记</button><button className="btn small" onClick={() => setEditing(null)}>取消</button></div></> : <>
                <small>{note.category}{note.edited ? ' · 已手改' : ''}</small><h3>{note.title}</h3><Markdown text={note.content} />
                <div className="library-toolbar"><button className="btn small" onClick={() => setProof(note)}>原文依据</button><button className="btn small" disabled={analysis?.status !== 'done' || !!editing} title={editing ? '先保存或取消当前笔记草稿' : undefined} onClick={() => setEditing({ ...note })}>修改分类 / 内容</button></div></>}
            </article>)}</div>{!noteMatches.length && <p className="library-empty">没有符合条件的笔记，试着清空搜索或切换分类。</p>}</> : <>
            <label className="library-spoiler">阅读范围：看到第 {Math.min(through, availableSegments)} / {availableSegments} 个片段
              <input aria-label="显示到第几个剧情片段" type="range" min={1} max={availableSegments} value={Math.min(through, availableSegments)} onChange={(e) => { setThrough(Number(e.target.value)); setProof(null) }} />
              <small>拖动可隐藏后续剧情与关系；按原文顺序排列。</small></label>
            <BookGraph result={result} through={through} query={query} onSelect={showBookItem} />
            <details className="library-book-list" open><summary>剧情时间线（{bookEvents.length}）</summary>{bookEvents.map((event, i) => <button key={event.id} id={`library-item-${event.id}`} className="library-event" onClick={() => setProof(event)}><span>{i + 1}</span><div><strong>{event.title}</strong><p>{event.summary}</p><small>{resultSources?.[event.source]?.label} · 点击查看原文</small></div></button>)}</details>
            <details className="library-book-list" open={!!selection}><summary>人物与关系列表（支持键盘选择）</summary>{result.characters.filter((c) => c.segment <= through && `${c.name} ${c.description}`.includes(query)).map((c) => <button className="library-event" id={`library-item-${c.id}`} key={c.id} onClick={() => setProof(c)}><div><strong>{c.name}</strong><p>{c.description}</p></div></button>)}
              {result.relations.filter((r) => r.segment <= through && `${r.label} ${result.characters.find((c) => c.id === r.from)?.name} ${result.characters.find((c) => c.id === r.to)?.name}`.includes(query)).map((r) => <button className="library-event" id={`library-item-${r.id}`} key={r.id} onClick={() => setProof(r)}><div><strong>{result.characters.find((c) => c.id === r.from)?.name} → {result.characters.find((c) => c.id === r.to)?.name}</strong><p>{r.label}</p></div></button>)}</details>
          </>}
          {proof && <aside className="library-proof" role="region" aria-label="原文依据"><div className="library-toolbar"><strong>{resultSources?.[proof.source]?.label ?? '原文'}</strong><button className="btn small" aria-label="关闭原文依据" onClick={() => setProof(null)}>×</button></div><blockquote>{proof.quote}</blockquote><button className="btn small" onClick={() => { setTab('source'); setProof(null) }}>查看完整识别原文</button></aside>}
        </> : !running && <p className="library-empty">确认整理方式后开始。识别文字、分类笔记和书籍连线都会保存在这里。</p>}
      </>}
    </div></div>
  </section>
}
