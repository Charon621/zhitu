import type Database from 'better-sqlite3'

/** app_config 表：一个简单的键值存储 */
export class ConfigStore {
  constructor(private db: Database.Database) {}

  getRaw(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM app_config WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  setRaw(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString())
  }

  getJSON<T>(key: string, fallback: T): T {
    const raw = this.getRaw(key)
    if (raw === null) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  setJSON(key: string, value: unknown): void {
    this.setRaw(key, JSON.stringify(value))
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM app_config WHERE key = ?').run(key)
  }
}
