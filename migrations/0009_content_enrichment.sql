-- 0009_content_enrichment.sql
-- Phase A.4: full-content enrichment for articles already relevant to >= 1 club.
-- This table is deliberately independent from raw_articles.content_hash so
-- fetching article bodies never invalidates Phase A relevance decisions.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS article_content_enrichments (
  article_id TEXT PRIMARY KEY,
  source_content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  extraction_method TEXT,
  content_text TEXT,
  content_hash TEXT,
  http_status INTEGER,
  fetched_at TEXT,
  error_code TEXT,
  error_detail TEXT,
  retry_after TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (article_id) REFERENCES raw_articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_enrichments_queue
  ON article_content_enrichments(status, retry_after, updated_at);

CREATE INDEX IF NOT EXISTS idx_content_enrichments_source_hash
  ON article_content_enrichments(source_content_hash, status);
