import type Database from 'better-sqlite3'
import { completeChat, type ProviderConfig } from './provider'
import { PROFILE_SIGNAL_PROMPT } from './prompts'

const weights = {
  basic_question: -0.1,
  correct_terminology: 0.2,
  example_request: -0.1,
  boundary_question: 0.3,
  corrects_ai: 0.4,
  stuck_same_level: -0.2
} as const
type Signal = keyof typeof weights

export class ProfileService {
  constructor(private db: Database.Database, private utilityConfig: () => ProviderConfig) {}

  promptHint(): string {
    const row = this.db.prepare("SELECT level_estimate, confidence FROM learner_profile WHERE id = 'singleton'")
      .get() as { level_estimate: number; confidence: number } | undefined
    if (!row || row.confidence <= 0.5) return ''
    const label = row.level_estimate < 1.5 ? '刚接触' : row.level_estimate < 3 ? '有一些基础' :
      row.level_estimate < 4 ? '能独立追问' : '理解较深'
    return `\n\n根据你之前的提问方式判断，这个人的基础大约在「${label}」这一档。解释时可以按这个深度来，但不要说出来，也不要假设他不知道某个具体的词。`
  }

  schedule(sessionId: string, userTurnId: string): void {
    void this.observe(sessionId, userTurnId).catch(() => undefined)
  }

  async observe(sessionId: string, userTurnId: string): Promise<void> {
    if (this.db.prepare('SELECT 1 FROM profile_observations WHERE user_turn_id = ?').get(userTurnId)) return
    const recent = this.db.prepare(`SELECT id, content FROM turns WHERE session_id = ? AND role = 'user'
      ORDER BY rowid DESC LIMIT 3`).all(sessionId) as Array<{ id: string; content: string }>
    if (!recent.some((turn) => turn.id === userTurnId)) return
    const raw = await completeChat(this.utilityConfig(), [
      { role: 'system', content: PROFILE_SIGNAL_PROMPT },
      { role: 'user', content: recent.reverse().map((turn, index) =>
        `第 ${index + 1} 轮：${turn.content}`).join('\n') }
    ], AbortSignal.timeout(45_000))
    let parsed: { signals?: unknown }
    try {
      parsed = JSON.parse(raw) as { signals?: unknown }
    } catch {
      // 模型这次没给合法 JSON。画像信号只是锦上添花，不能让它掀掉主进程。
      throw new Error('学习信号不是合法 JSON')
    }
    if (!Array.isArray(parsed.signals) || parsed.signals.length > 3 ||
      parsed.signals.some((signal) => typeof signal !== 'string' || !(signal in weights))) {
      throw new Error('学习信号格式不合规')
    }
    const signals = [...new Set(parsed.signals as Signal[])]
    this.db.transaction(() => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO profile_observations VALUES (?, ?, ?)')
        .run(userTurnId, JSON.stringify(signals), new Date().toISOString())
      if (!inserted.changes) return
      const row = this.db.prepare("SELECT level_estimate FROM learner_profile WHERE id = 'singleton'")
        .get() as { level_estimate: number } | undefined
      const level = Math.min(5, Math.max(0, (row?.level_estimate ?? 1) +
        signals.reduce((sum, signal) => sum + weights[signal], 0)))
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM profile_observations').get() as { n: number }).n
      const confidence = 1 - Math.exp(-n / 20)
      this.db.prepare(`INSERT INTO learner_profile (id, level_estimate, confidence, signals_json, updated_at)
        VALUES ('singleton', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET level_estimate = excluded.level_estimate,
        confidence = excluded.confidence, signals_json = excluded.signals_json, updated_at = excluded.updated_at`)
        .run(level, confidence, JSON.stringify({ observations: n, lastSignals: signals }), new Date().toISOString())
    })()
  }
}
