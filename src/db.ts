import Database from "better-sqlite3";

export function openDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id     TEXT PRIMARY KEY,
      project_path   TEXT NOT NULL,
      file_path      TEXT NOT NULL,
      started_at     TEXT,
      ended_at       TEXT,
      first_prompt   TEXT,
      ai_title       TEXT,
      git_branch     TEXT,
      models         TEXT NOT NULL DEFAULT '[]',
      message_count  INTEGER NOT NULL DEFAULT 0,
      file_mtime_ms  INTEGER NOT NULL DEFAULT 0,
      file_size      INTEGER NOT NULL DEFAULT 0,
      digest_status  TEXT NOT NULL DEFAULT 'pending',
      digest_title   TEXT,
      digest_summary TEXT,
      decisions      TEXT NOT NULL DEFAULT '[]',
      outcome        TEXT,
      source_missing INTEGER NOT NULL DEFAULT 0,
      indexed_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS session_files (
      session_id TEXT NOT NULL,
      file_path  TEXT NOT NULL,
      PRIMARY KEY (session_id, file_path)
    );
    CREATE TABLE IF NOT EXISTS session_topics (
      session_id TEXT NOT NULL,
      topic      TEXT NOT NULL,
      PRIMARY KEY (session_id, topic)
    );
    CREATE TABLE IF NOT EXISTS session_continues (
      from_id TEXT NOT NULL,
      to_id   TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      session_id UNINDEXED, title, summary, decisions, first_prompt, topics
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
    CREATE INDEX IF NOT EXISTS idx_session_files_path ON session_files(file_path);
    CREATE INDEX IF NOT EXISTS idx_session_topics_topic ON session_topics(topic);
  `);
  return db;
}
