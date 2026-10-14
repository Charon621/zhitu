import { useState } from 'react'
import type { NoteBlock, NoteCard as NoteCardData } from '../api'
import { deleteNoteBlock, updateNoteBlock } from '../api'
import { Markdown } from './Markdown'

interface Props {
  card: NoteCardData
  full?: boolean
  onChanged: () => void
  onSource: (turnId: string) => void
  onDocument: (attachmentId: string, page: number | null) => void
  onAsk: (question: string) => void
}

const kindLabels: Record<string, string> = {
  question: '问题', concept: '概念', fact: '结论', example: '例子', resource: '资料'
}
const statusLabels: Record<string, string> = {
  open: '未收线', gathered: '已收线', mastered: '已掌握'
}
const blockLabels: Record<string, string> = {
  claim: '核心', mece: '结构', example: '例子', contrast: '对比', pitfall: '易错',
  question: '留着的问题', formula: '公式', source_quote: '原文', user_note: '我记下的'
}

function ageLabel(iso: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  return `${days} 天前`
}

function priority(block: NoteBlock): number {
  if (block.pinned) return -1
  if (block.block_type === 'claim') return 0
  if (block.block_type === 'pitfall') return 1
  return 2
}

export function NoteCard({ card, full = false, onChanged, onSource, onDocument, onAsk }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const ordered = [...card.blocks].sort((a, b) => priority(a) - priority(b) || a.ordinal - b.ordinal)
  const visible = full || expanded ? ordered : ordered.slice(0, 3)

  const save = async (id: string): Promise<void> => {
    if (!draft.trim() || pending) return
    setPending(true)
    setError('')
    try {
      await updateNoteBlock(id, { content: draft })
      setEditingId(null)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm('删掉这条笔记？原始对话仍会保留。')) return
    setPending(true)
    setError('')
    try {
      await deleteNoteBlock(id)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const pin = async (block: NoteBlock): Promise<void> => {
    if (pending) return
    setPending(true)
    setError('')
    try { await updateNoteBlock(block.id, { pinned: !block.pinned }); onChanged() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setPending(false) }
  }

  return (
    <article className={`note-card ${full || expanded ? 'expanded' : ''}`} data-note-id={card.id}>
      <div className="note-card-head">
        <h3 title={card.title}>{card.title}</h3>
        <span className="note-mastery" aria-label={`掌握度 ${card.mastery} / 5`}>
          {'●'.repeat(card.mastery)}{'○'.repeat(5 - card.mastery)}
        </span>
      </div>
      <div className="note-meta">
        {kindLabels[card.kind] ?? card.kind} · {statusLabels[card.status] ?? card.status} · {ageLabel(card.updated_at)}
      </div>

      <div className="note-blocks">
        {visible.map((block) => (
          <section key={block.id} className={`note-block note-${block.block_type}`}>
            <div className="note-block-head">
              <span>{blockLabels[block.block_type] ?? block.block_type}</span>
              <span className="note-block-actions">
                <button onClick={() => void pin(block)} disabled={pending} aria-pressed={!!block.pinned}>
                  {block.pinned ? '取消置顶' : '置顶'}</button>
                <button onClick={() => { setEditingId(block.id); setDraft(block.content_md); setError('') }} disabled={pending}>改</button>
                <button onClick={() => void remove(block.id)} disabled={pending}>删</button>
              </span>
            </div>
            {editingId === block.id ? (
              <div className="note-edit">
                <textarea aria-label="编辑笔记" value={draft} onChange={(event) => setDraft(event.target.value)} rows={4} />
                <div>
                  <button onClick={() => void save(block.id)} disabled={pending || !draft.trim()}>保存</button>
                  <button onClick={() => setEditingId(null)} disabled={pending}>取消</button>
                </div>
              </div>
            ) : <Markdown text={block.content_md} />}
            {block.source_name && block.source_attachment_id && (
              <button className="note-source" onClick={() => onDocument(block.source_attachment_id!, block.source_page)}>
                来自《{block.source_name}》{block.source_page === null ? '' : `第 ${block.source_page} 页`}
                {block.source_partial ? '（提取不完整，请核对原件）' : ''} →
              </button>
            )}
          </section>
        ))}
      </div>

      {!full && ordered.length > 3 && (
        <button className="note-expand" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : `还有 ${ordered.length - 3} 条`}
        </button>
      )}
      {error && <div className="note-error">{error}</div>}
      <div className="note-card-foot">
        {card.origin_turn_id && <button onClick={() => onSource(card.origin_turn_id!)}>看原文</button>}
        <button onClick={() => onAsk(`请换一个角度重讲：${card.title}`)}>让 AI 重讲</button>
        <button onClick={() => onAsk(`请针对“${card.title}”出一道检验理解的应用题，不要只问定义。`)}>让 AI 出个题</button>
      </div>
    </article>
  )
}
