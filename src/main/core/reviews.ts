import type Database from 'better-sqlite3'
import { z } from 'zod'
import { newId } from './ids'
import { completeChat, type ProviderConfig } from './provider'
import { REVIEW_GRADE_PROMPT, REVIEW_QUESTION_PROMPT } from './prompts'

const questionSchema = z.object({ question: z.string().min(8).max(160) })
const gradeSchema = z.object({
  correct: z.boolean(),
  quality: z.number().int().min(0).max(5),
  masteryDelta: z.number().int().min(-2).max(2),
  feedback: z.string().min(3).max(160)
})
const recallQuestion = /(?:是什么|什么是|请定义|定义一下|请复述|请背诵)/
const bulletLine = /^\s*[•*-]\s/m

interface ReviewNode {
  id: string
  title: string
  mastery: number
  due_at: string
  interval_days: number
  ease: number
  lapses: number
  last_reviewed_at: string | null
}

export class ReviewService {
  constructor(private db: Database.Database, private utilityConfig: () => ProviderConfig) {}

  dueCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM reviews r JOIN nodes n ON n.id = r.node_id
      WHERE r.due_at <= ? AND n.kind != 'resource' AND n.trashed_at IS NULL
      AND EXISTS (SELECT 1 FROM note_blocks b WHERE b.node_id = n.id AND b.deleted_by_user = 0)`)
      .get(new Date().toISOString()) as { n: number }).n
  }

  private dueNode(): ReviewNode | null {
    return this.db.prepare(`SELECT n.id, n.title, n.mastery, r.due_at, r.interval_days, r.ease, r.lapses,
      r.last_reviewed_at FROM reviews r JOIN nodes n ON n.id = r.node_id
      WHERE r.due_at <= ? AND n.kind != 'resource' AND n.trashed_at IS NULL
      AND EXISTS (SELECT 1 FROM note_blocks b WHERE b.node_id = n.id AND b.deleted_by_user = 0)
      ORDER BY r.due_at, n.last_seen_at DESC LIMIT 1`)
      .get(new Date().toISOString()) as ReviewNode | undefined ?? null
  }

  private noteText(nodeId: string): string {
    return (this.db.prepare(`SELECT content_md FROM note_blocks WHERE node_id = ?
      AND deleted_by_user = 0 ORDER BY pinned DESC, ordinal LIMIT 8`)
      .all(nodeId) as Array<{ content_md: string }>).map((row) => row.content_md).join('\n')
  }

  async question(): Promise<{ attemptId: string; nodeId: string; title: string; question: string } | null> {
    const node = this.dueNode()
    if (!node) return null
    const notes = this.noteText(node.id)
    let lastError = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await completeChat(this.utilityConfig(), [
          { role: 'system', content: REVIEW_QUESTION_PROMPT },
          { role: 'user', content: `【知识点】${node.title}\n【笔记】${notes}${lastError ? `\n上次题目不合格：${lastError}。请重出。` : ''}` }
        ], AbortSignal.timeout(45_000))
        const parsed = questionSchema.parse(JSON.parse(raw))
        const question = parsed.question.trim()
        if (recallQuestion.test(question) || bulletLine.test(question)) throw new Error('题目是背诵题或用了符号列表')
        const id = newId('rev')
        this.db.prepare('INSERT INTO review_attempts (id, node_id, question, created_at) VALUES (?, ?, ?, ?)')
          .run(id, node.id, question, new Date().toISOString())
        return { attemptId: id, nodeId: node.id, title: node.title, question }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    throw new Error(`没能生成合适的复习题：${lastError}`)
  }

  async grade(attemptId: string, answer: string): Promise<{
    correct: boolean; quality: number; masteryDelta: number; feedback: string;
    mastery: number; nextDueAt: string
  }> {
    const attempt = this.db.prepare(`SELECT a.node_id, a.question, a.graded_at, a.feedback, a.quality,
      a.mastery_delta, n.title, n.mastery, r.interval_days, r.ease, r.lapses, r.last_reviewed_at, r.due_at
      FROM review_attempts a JOIN nodes n ON n.id = a.node_id JOIN reviews r ON r.node_id = n.id WHERE a.id = ?`)
      .get(attemptId) as (ReviewNode & { node_id: string; question: string; graded_at: string | null;
        feedback: string | null; quality: number | null; mastery_delta: number | null }) | undefined
    if (!attempt) throw new Error('找不到这道复习题')
    if (attempt.graded_at) return {
      correct: (attempt.quality ?? 0) >= 3, quality: attempt.quality ?? 0,
      masteryDelta: attempt.mastery_delta ?? 0, feedback: attempt.feedback ?? '',
      mastery: attempt.mastery, nextDueAt: attempt.due_at
    }
    const cleanAnswer = answer.trim()
    if (!cleanAnswer || cleanAnswer.length > 4000) throw new Error('请先写下你的回答，最多 4000 字')
    const raw = await completeChat(this.utilityConfig(), [
      { role: 'system', content: REVIEW_GRADE_PROMPT },
      { role: 'user', content: `【知识点】${attempt.title}\n【笔记】${this.noteText(attempt.node_id)}\n【题目】${attempt.question}\n【学习者回答】${cleanAnswer}` }
    ], AbortSignal.timeout(45_000))
    const grade = gradeSchema.parse(JSON.parse(raw))
    if (grade.correct !== (grade.quality >= 3) || bulletLine.test(grade.feedback)) {
      throw new Error('复习判定结果不一致或排版不合规')
    }
    const mastery = Math.min(5, Math.max(0, attempt.mastery + grade.masteryDelta))
    const ease = Math.max(1.3, grade.quality < 3 ? attempt.ease - 0.2 :
      attempt.ease + (0.1 - (5 - grade.quality) * (0.08 + (5 - grade.quality) * 0.02)))
    const interval = grade.quality < 3 ? 1 : !attempt.last_reviewed_at ? 1
      : attempt.interval_days <= 1 ? 6 : Math.max(1, Math.round(attempt.interval_days * ease))
    const now = new Date().toISOString()
    const nextDueAt = new Date(Date.now() + interval * 86_400_000).toISOString()
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE review_attempts SET answer = ?, feedback = ?, quality = ?,
        mastery_delta = ?, graded_at = ? WHERE id = ? AND graded_at IS NULL`)
        .run(cleanAnswer, grade.feedback.trim(), grade.quality, grade.masteryDelta, now, attemptId)
      if (result.changes !== 1) throw new Error('这道题已经批改过了')
      this.db.prepare(`UPDATE reviews SET due_at = ?, interval_days = ?, ease = ?, lapses = lapses + ?,
        last_reviewed_at = ? WHERE node_id = ?`)
        .run(nextDueAt, interval, ease, grade.quality < 3 ? 1 : 0, now, attempt.node_id)
      this.db.prepare(`UPDATE nodes SET mastery = ?, status = CASE
        WHEN ? = 5 THEN 'mastered' WHEN status = 'mastered' THEN 'gathered' ELSE status END,
        updated_at = ? WHERE id = ?`).run(mastery, mastery, now, attempt.node_id)
    })()
    return { correct: grade.correct, quality: grade.quality, masteryDelta: grade.masteryDelta,
      feedback: grade.feedback.trim(), mastery, nextDueAt }
  }
}
