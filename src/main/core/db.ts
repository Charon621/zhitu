import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 数据库的建表语句。
 *
 * 设计原则（见方案书第三章）：
 * 1. turns 是"原件"，只写不改。所有的笔记、地图都是派生出来的。
 * 2. nodes / edges 是地图上的点和线，其中边分两种：parent（从哪来）和 prereq（要先会）。
 * 3. 现在还用不到的表也一起建好，免得以后改结构。
 */

export const SCHEMA_VERSION = 10

const SCHEMA_SQL = `
-- 应用配置（键值对，密钥单独加密处理）
CREATE TABLE IF NOT EXISTS app_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 主题：一张大地图，比如"AI 入门"
CREATE TABLE IF NOT EXISTS topics (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  goal_kind   TEXT NOT NULL DEFAULT 'principle',  -- principle 偏原理 / hands_on 偏动手 / casual 随便看看
  created_at  TEXT NOT NULL,
  archived_at TEXT
);

-- 一场学习：从一个话题开始到你说"今天到这儿"
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT REFERENCES topics(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  summary_md  TEXT,                               -- 本场小结，第 1 步才用得上
  archived_at TEXT                                -- 归档时间：从列表收起，数据全留（见 SCHEMA_V7_SQL）
);

-- 对话流水（原件，只追加不修改）
CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);

-- 概念字典：防止"梯度下降"和"GD"被当成两个东西
CREATE TABLE IF NOT EXISTS concepts (
  id             TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  aliases_json   TEXT NOT NULL DEFAULT '[]',
  note           TEXT,
  created_at     TEXT NOT NULL
);

-- 知识节点：地图上的一个点
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  topic_id      TEXT REFERENCES topics(id) ON DELETE CASCADE,
  concept_id    TEXT REFERENCES concepts(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  body_md       TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'question',  -- question / concept / fact / example / resource
  status        TEXT NOT NULL DEFAULT 'gathered',  -- open 未收线 / gathered 已收线 / mastered 已掌握
  mastery       INTEGER NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 5),
  origin_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_topic ON nodes(topic_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);

-- 连线：连接两个节点
CREATE TABLE IF NOT EXISTS edges (
  id         TEXT PRIMARY KEY,
  src_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('parent', 'prereq', 'related', 'answers')),
  weight     REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  UNIQUE (src_id, dst_id, type)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id, type);

-- 后台整理的记录（第 1 步才用得上，先建好）
CREATE TABLE IF NOT EXISTS extractions (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  node_id         TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending / ok / skipped / failed
  payload_json    TEXT,
  error           TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extractions_turn ON extractions(turn_id);
`

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  extracted_md TEXT,
  extract_status TEXT NOT NULL DEFAULT 'pending',
  extract_error TEXT,
  page_count INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_hash ON attachments(sha256, session_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  page INTEGER,
  token_estimate INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_attachment ON chunks(attachment_id, ordinal);

CREATE TABLE IF NOT EXISTS turn_meta (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  cited_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'guide'
);

CREATE TABLE IF NOT EXISTS note_blocks (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  block_type TEXT NOT NULL,
  content_md TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  origin_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
  origin_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  edited_by_user INTEGER NOT NULL DEFAULT 0,
  deleted_by_user INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_blocks_node ON note_blocks(node_id, ordinal);

CREATE TABLE IF NOT EXISTS learner_profile (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  level_estimate INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0,
  signals_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  interval_days REAL NOT NULL DEFAULT 1,
  ease REAL NOT NULL DEFAULT 2.5,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_due ON reviews(due_at);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  ref_kind, ref_id, text, tokenize = 'trigram'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_extractions_unique_turn ON extractions(turn_id);

CREATE TRIGGER IF NOT EXISTS search_turn_insert AFTER INSERT ON turns BEGIN
  INSERT INTO search_fts(ref_kind, ref_id, text) VALUES ('turn', NEW.id, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS search_node_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO search_fts(ref_kind, ref_id, text) VALUES ('node', NEW.id, NEW.title || ' ' || NEW.body_md);
END;
CREATE TRIGGER IF NOT EXISTS search_node_update AFTER UPDATE OF title, body_md ON nodes BEGIN
  DELETE FROM search_fts WHERE ref_kind = 'node' AND ref_id = OLD.id;
  INSERT INTO search_fts(ref_kind, ref_id, text) VALUES ('node', NEW.id, NEW.title || ' ' || NEW.body_md);
END;
CREATE TRIGGER IF NOT EXISTS search_note_insert AFTER INSERT ON note_blocks BEGIN
  INSERT INTO search_fts(ref_kind, ref_id, text) VALUES ('note_block', NEW.id, NEW.content_md);
END;
CREATE TRIGGER IF NOT EXISTS search_note_update AFTER UPDATE OF content_md ON note_blocks BEGIN
  DELETE FROM search_fts WHERE ref_kind = 'note_block' AND ref_id = OLD.id;
  INSERT INTO search_fts(ref_kind, ref_id, text) VALUES ('note_block', NEW.id, NEW.content_md);
END;
CREATE TRIGGER IF NOT EXISTS search_note_delete AFTER DELETE ON note_blocks BEGIN
  DELETE FROM search_fts WHERE ref_kind = 'note_block' AND ref_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_note_hide AFTER UPDATE OF deleted_by_user ON note_blocks
WHEN NEW.deleted_by_user = 1 BEGIN
  DELETE FROM search_fts WHERE ref_kind = 'note_block' AND ref_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS search_chunk_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO search_fts(ref_kind, ref_id, text) VALUES ('chunk', NEW.id, NEW.text);
END;
CREATE TRIGGER IF NOT EXISTS search_chunk_delete AFTER DELETE ON chunks BEGIN
  DELETE FROM search_fts WHERE ref_kind = 'chunk' AND ref_id = OLD.id;
END;
`

const SCHEMA_V3_SQL = `
ALTER TABLE attachments ADD COLUMN resource_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_resource_node ON attachments(resource_node_id);
`

const SCHEMA_V4_SQL = `
CREATE TABLE IF NOT EXISTS homeward_state (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  stopped_at TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_preferences (
  topic_id TEXT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
  recommendation_weight REAL NOT NULL DEFAULT 1.0
);
CREATE TABLE IF NOT EXISTS session_homeward (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

const SCHEMA_V5_SQL = `
CREATE TABLE IF NOT EXISTS review_attempts (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT,
  feedback TEXT,
  quality INTEGER CHECK (quality BETWEEN 0 AND 5),
  mastery_delta INTEGER,
  created_at TEXT NOT NULL,
  graded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_attempts_node ON review_attempts(node_id, created_at DESC);
INSERT OR IGNORE INTO reviews (node_id, due_at)
  SELECT DISTINCT n.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM nodes n
  JOIN note_blocks b ON b.node_id = n.id AND b.deleted_by_user = 0;
`

const SCHEMA_V6_SQL = `
CREATE TABLE IF NOT EXISTS profile_observations (
  user_turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  signals_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

/**
 * 历史记录管理：把一场学习归档（从列表里收起来，数据全留）。
 * 归档是"不想再看见"，不是"删除"；真删走 deleteSession 那条路。
 *
 * 注意这里不能直接 `ALTER TABLE ... ADD COLUMN`：全新数据库会按
 * `SCHEMA_SQL` 一次建好 sessions（那个版本里已经带 archived_at），
 * 再执行本段就会撞上 duplicate column。所以先看列在不在。
 */
const SCHEMA_V7_SQL = `
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived_at, started_at DESC);
`

/**
 * 历史记录的删除：两级删除 + 回收站。
 *
 * 软删除只打标记，什么都不搬走：
 *   - `sessions.deleted_at` 非空 = 这场在回收站里
 *   - `nodes.trashed_at` 非空 = 这个知识点是被删场次独占的，跟着一起藏起来
 *     （恢复时清掉；只有硬删才算真正消失）
 *
 * 主题刻意不在这里删：回收站期间主题要留着，否则恢复时 `topic_id` 已被外键置空，
 * 主题名就永久丢了。清理空主题只发生在彻底删除时（见 store.ts）。
 *
 * 三段分开写，是因为升级路径上可能出现"只有一部分表"的库（自动化里的最小样例就是这样）。
 * 缺哪张表就跳过哪一段，别让一个缺表的库在启动时直接崩掉。
 * 顺带把全文索引补上删除触发器：以前只有 INSERT 触发器，
 * 删掉的对话会在索引里留下永久孤儿行（索引只增不减）。
 */
const SCHEMA_V9_SESSIONS_SQL = `
ALTER TABLE sessions ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_alive ON sessions(deleted_at, started_at DESC);
`

const SCHEMA_V9_NODES_SQL = `
ALTER TABLE nodes ADD COLUMN trashed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_nodes_trashed ON nodes(trashed_at);
`

const SCHEMA_V9_FTS_SQL = `
CREATE TRIGGER IF NOT EXISTS search_turn_delete AFTER DELETE ON turns BEGIN
  DELETE FROM search_fts WHERE ref_kind = 'turn' AND ref_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS search_node_delete AFTER DELETE ON nodes BEGIN
  DELETE FROM search_fts WHERE ref_kind = 'node' AND ref_id = OLD.id;
END;
DELETE FROM search_fts WHERE ref_kind = 'turn' AND ref_id NOT IN (SELECT id FROM turns);
DELETE FROM search_fts WHERE ref_kind = 'node' AND ref_id NOT IN (SELECT id FROM nodes);
`

export interface DbHandle {
  db: Database.Database
  close: () => void
}

export function openDatabase(file: string): DbHandle {
  mkdirSync(dirname(file), { recursive: true })

  const db = new Database(file)

  // WAL 模式：读写不互相阻塞，桌面应用的标准做法
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  const current = db.pragma('user_version', { simple: true }) as number

  if (current > SCHEMA_VERSION) {
    db.close()
    throw new Error(`数据库版本 ${current} 高于当前程序支持的 ${SCHEMA_VERSION}，请升级织图。`)
  }

  if (current < SCHEMA_VERSION) {
    db.exec('BEGIN')
    try {
      if (current < 1) db.exec(SCHEMA_SQL)
      if (current < 2) {
        db.exec(SCHEMA_V2_SQL)
        db.exec(`INSERT INTO search_fts(ref_kind, ref_id, text)
          SELECT 'turn', id, content FROM turns`)
        db.exec(`INSERT INTO search_fts(ref_kind, ref_id, text)
          SELECT 'node', id, title || ' ' || body_md FROM nodes`)
      }
      if (current < 3) db.exec(SCHEMA_V3_SQL)
      if (current < 4) db.exec(SCHEMA_V4_SQL)
      if (current < 5) db.exec(SCHEMA_V5_SQL)
      if (current < 6) db.exec(SCHEMA_V6_SQL)
      if (current < 7) {
        // 老库需要补列；按 SCHEMA_SQL 新建的库已经有了，所以先查一下。
        const columns = db.pragma('table_info(sessions)') as Array<{ name: string }>
        if (!columns.some((column) => column.name === 'archived_at')) {
          db.exec('ALTER TABLE sessions ADD COLUMN archived_at TEXT')
        }
        db.exec(SCHEMA_V7_SQL)
      }
      if (current < 8) db.exec(`CREATE TABLE document_analyses (
        attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`)
      if (current < 9) {
        const hasTable = (name: string): boolean => !!db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
        if (hasTable('sessions')) db.exec(SCHEMA_V9_SESSIONS_SQL)
        if (hasTable('nodes')) db.exec(SCHEMA_V9_NODES_SQL)
        if (hasTable('turns') && hasTable('nodes') && hasTable('search_fts')) db.exec(SCHEMA_V9_FTS_SQL)
      }
      if (current < 10) {
        const hasTable = (name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
        if (hasTable('attachments')) db.exec('ALTER TABLE attachments ADD COLUMN active_source_version INTEGER NOT NULL DEFAULT 0')
        if (hasTable('chunks')) db.exec('ALTER TABLE chunks ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0')
        if (hasTable('attachments') && hasTable('search_fts')) db.exec(`
          CREATE TABLE library_search_entries (
            id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
            item_id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL
          );
          CREATE TRIGGER library_search_insert AFTER INSERT ON library_search_entries BEGIN
            INSERT INTO search_fts(ref_kind, ref_id, text) VALUES ('library', NEW.id, NEW.text);
          END;
          CREATE TRIGGER library_search_delete AFTER DELETE ON library_search_entries BEGIN
            DELETE FROM search_fts WHERE ref_kind = 'library' AND ref_id = OLD.id;
          END;
        `)
      }
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  return {
    db,
    close: () => db.close()
  }
}
