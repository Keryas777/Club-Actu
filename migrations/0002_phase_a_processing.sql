-- 0002_phase_a_processing.sql
-- Phase A: deterministic raw -> filtered/extracted processing.
-- Keeps raw collection intact and separates extraction, club relevance and run observability.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS club_aliases (
  club_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  strength TEXT NOT NULL DEFAULT 'strong',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (club_id, alias),
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_club_aliases_club_strength
  ON club_aliases(club_id, strength);

INSERT OR IGNORE INTO club_aliases (club_id, alias, strength) VALUES
  ('ol', 'Olympique Lyonnais', 'strong'),
  ('ol', 'OL', 'strong'),
  ('ol', 'Lyon', 'weak'),
  ('ol', 'Lyonnais', 'weak'),
  ('ol', 'Gones', 'weak');

CREATE TABLE IF NOT EXISTS article_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  status TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  normalized_title TEXT,
  normalized_author TEXT,
  normalized_published_at TEXT,
  normalized_excerpt TEXT,
  normalized_content TEXT,
  normalized_image_url TEXT,
  extracted_at TEXT,
  error_code TEXT,
  error_detail TEXT,
  retry_after TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(article_id, source_content_hash, extractor_version),
  FOREIGN KEY (article_id) REFERENCES raw_articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_article_extractions_lookup
  ON article_extractions(article_id, source_content_hash, extractor_version);

CREATE INDEX IF NOT EXISTS idx_article_extractions_status
  ON article_extractions(status, retry_after, updated_at);

CREATE TABLE IF NOT EXISTS article_club_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_code TEXT,
  reason_detail TEXT,
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(article_id, club_id, source_content_hash, rule_version),
  FOREIGN KEY (article_id) REFERENCES raw_articles(id) ON DELETE CASCADE,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_article_club_assessments_current
  ON article_club_assessments(club_id, decision, source_content_hash, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_article_club_assessments_article
  ON article_club_assessments(article_id, club_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS processing_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  candidates INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  relevant INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  extracted INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  retry INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_processing_runs_started
  ON processing_runs(started_at DESC);

-- Candidate lookup: rows whose current hash has no successful/retry-aware extraction yet.
CREATE INDEX IF NOT EXISTS idx_raw_articles_phase_a_candidates
  ON raw_articles(content_hash, last_seen_at DESC);
