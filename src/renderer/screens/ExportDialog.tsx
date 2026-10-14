import { useEffect, useState } from 'react'
import { downloadExport, previewBackup, restoreBackup, type BackupPreview } from '../api'

interface Props { sessionId: string | null; onClose: () => void }

export function ExportDialog({ sessionId, onClose }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [backup, setBackup] = useState<unknown>(null)
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [filename, setFilename] = useState('')
  const [restored, setRestored] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (busy || restored)) { event.preventDefault(); event.stopImmediatePropagation(); if (restored) window.location.reload() }
    }
    const warn = (event: BeforeUnloadEvent) => { if (busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('keydown', escape, true); window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('beforeunload', warn) }
  }, [busy, restored])
  const inspect = async (file: File): Promise<void> => {
    setBusy(true); setError(''); setMessage(''); setPreview(null); setBackup(null); setRestored(false)
    try {
      if (file.size > 420 * 1024 * 1024) throw new Error('备份文件超过 420 MB，请选择较小的备份。')
      const data: unknown = JSON.parse(await file.text())
      const result = await previewBackup(data)
      setBackup(data); setPreview(result.preview); setFilename(file.name)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '备份校验失败') }
    finally { setBusy(false) }
  }
  const restore = async (): Promise<void> => {
    if (!backup || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await restoreBackup(backup)
      setRestored(true); setBackup(null)
      setMessage(`恢复完成。恢复前快照已保存：${result.snapshotPath}${result.snapshotWarning ? `；${result.snapshotWarning}` : ''}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败') }
    finally { setBusy(false) }
  }
  const save = async (path: string, name: string): Promise<void> => {
    setBusy(true); setMessage('')
    try {
      const saved = await downloadExport(path, name)
      setMessage(saved ? '文件已保存到你选的位置。' : '已取消保存。')
    } catch (error) { setMessage(error instanceof Error ? error.message : '导出失败') }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) restored ? window.location.reload() : onClose()
  }}><div className="modal export-modal" role="dialog" aria-label="导出与恢复">
    <div className="modal-head"><h2>导出与恢复</h2><button className="btn" disabled={busy} onClick={() => restored ? window.location.reload() : onClose()}>关闭</button></div>
    <div className="export-options">
      <button disabled={busy} onClick={() => void save('/exports/notes', '织图-全部笔记.zip')}>
        <strong>全部笔记</strong><span>每个知识点一份 Markdown，保留 Obsidian 双链。</span>
      </button>
      <button disabled={busy || !sessionId} onClick={() => sessionId && void save(
        `/exports/sessions/${encodeURIComponent(sessionId)}`, '织图-本场对话.md')}>
        <strong>本场对话</strong><span>{sessionId ? '按原顺序保存完整对话与小结。' : '先开始一场学习后可导出。'}</span>
      </button>
      <button disabled={busy} onClick={() => void save('/exports/all', '织图-全部数据.json')}>
        <strong>全部数据备份</strong><span>包含对话、笔记、关系与资料原件，不包含 API 密钥。</span>
      </button>
    </div>
    <section className="backup-restore"><h3>从备份恢复</h3><p>选择织图导出的全部数据 JSON。先核对内容，再加入当前工作台。单次恢复最多 300 MB 原件。</p>
      <label className={`btn backup-picker ${busy ? 'disabled' : ''}`}>选择备份文件<input type="file" accept=".json" disabled={busy} aria-label="选择备份文件" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) void inspect(file)
      }} /></label>
      {busy && <p role="status">正在校验或恢复，请稍候…</p>}
      {preview && <div className="backup-preview"><strong>{filename}</strong><p>备份时间：{preview.exportedAt ? new Date(preview.exportedAt).toLocaleString('zh-CN') : '未记录'}</p>
        <div className="backup-counts"><span><b>{preview.sessions}</b> 场学习</span><span><b>{preview.notes}</b> 条笔记</span><span><b>{preview.attachments}</b> 份原件</span></div>
        <p>{preview.archived} 场已归档，{preview.trash} 场在回收站；原件 {(preview.fileBytes / 1024 / 1024).toFixed(1)} MB。</p>
        <p>以新副本加入，保留当前数据、AI 设置与密钥；重复导入同一备份会产生额外副本。回收站重新保留 30 天；未结束学习以已收线恢复，继续聊可重新打开。</p>
        {!restored && <button className="btn primary" disabled={busy} onClick={() => void restore()}>保存快照并恢复这份备份</button>}
      </div>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {message && <p className="backup-message" role="status">{message}</p>}
      {restored && <button className="btn primary" onClick={() => window.location.reload()}>完成并重新加载</button>}
    </section>
  </div></div>
}
