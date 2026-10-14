export type AnalysisMode = 'handwriting' | 'book'
export type AnalysisStatus = 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
export interface DocumentSource { text: string; page: number | null; label: string }
export interface Evidence { source: number; quote: string }
export interface OrganizedNote extends Evidence { id: string; category: string; title: string; content: string; edited?: boolean }
export interface BookCharacter extends Evidence { id: string; name: string; description: string; segment: number }
export interface BookEvent extends Evidence { id: string; title: string; summary: string; characters: string[]; segment: number }
export interface BookRelation extends Evidence { id: string; from: string; to: string; label: string; segment: number }
export interface AnalysisResult {
  notes: OrganizedNote[]; characters: BookCharacter[]; events: BookEvent[]; relations: BookRelation[]
}
export interface DocumentAnalysis {
  attachmentId: string; mode: AnalysisMode; status: AnalysisStatus; stage: string
  completed: number; total: number; ocrCompleted: number; ocrTotal: number
  sources: DocumentSource[]; result: AnalysisResult; warnings: string[]; error: string | null
  updatedAt: string; startPage: number; endPage: number; revision: number
  previousResult?: AnalysisResult
  previousSources?: DocumentSource[]
  sourceEdited?: boolean
}
export interface AnalysisPlan {
  mode: AnalysisMode; characters: number; segments: number; ocrPages: number
  estimatedCalls: number; warnings: string[]; startPage: number; endPage: number
}
