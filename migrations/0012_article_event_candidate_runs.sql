-- 0012_article_event_candidate_runs.sql
-- D1: article-level EVENT extraction outcome / queue gate.
--
-- A completed row is the durable proof that a specific ARTICLE input was already
-- processed by the EVENT extractor, including the valid "0 EVENT" outcome.
-- The automatic-processing identity intentionally excludes the mutable club/alias
-- context so adding a club or alias does not invalidate historical ARTICLEs.
-- phase_b_input_hash + club_context_hash remain stored for audit/diagnostics.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS article_event_candidate_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  processing_input_hash TEXT NOT NULL,
  phase_b_input_hash TEXT NOT NULL,
  club_context_hash TEXT NOT NULL,
  input_source TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  event_count INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_detail TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(article_id, processing_input_hash, extractor_version),
  FOREIGN KEY (article_id) REFERENCES raw_articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_article_event_candidate_runs_queue
  ON article_event_candidate_runs(
    status,
    next_retry_at,
    lease_expires_at,
    created_at,
    id,
    article_id,
    source_content_hash,
    extractor_version
  );

CREATE INDEX IF NOT EXISTS idx_article_event_candidate_runs_article
  ON article_event_candidate_runs(
    article_id,
    source_content_hash,
    extractor_version,
    processing_input_hash,
    status,
    id
  );
