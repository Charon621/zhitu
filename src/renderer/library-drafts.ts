import type { DocumentSource, OrganizedNote } from '../shared/library'
export interface LibraryDraft { sources: DocumentSource[] | null; note: OrganizedNote | null }
const key = (id: string) => `zhitu.library.draft.v1.${id}`
export function readLibraryDraft(id: string): LibraryDraft {
  const raw = localStorage.getItem(key(id))
  if (!raw) return { sources: null, note: null }
  const value = JSON.parse(raw) as LibraryDraft
  if (!value || (value.sources !== null && (!Array.isArray(value.sources) || value.sources.some((s) => typeof s.text !== 'string' || typeof s.label !== 'string'))) ||
    (value.note !== null && (!value.note || typeof value.note.id !== 'string' || typeof value.note.content !== 'string'))) throw new Error('本机草稿格式异常，请先导出草稿后处理。')
  return value
}
export function writeLibraryDraft(id: string, draft: LibraryDraft): void {
  if (!draft.note && !draft.sources) localStorage.removeItem(key(id))
  else localStorage.setItem(key(id), JSON.stringify(draft))
}
export function lastLibrarySelection(): string | null { try { return localStorage.getItem('zhitu.library.selected') } catch { return null } }
