-- 0007_phase_a_v3_role_classifier.sql
-- Phase A v3: persist role classifications and seed v3 assessments from v2.
-- Ambiguous strong excerpt/lead matches are moved to needs_review for automatic AI resolution.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS article_club_role_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  status TEXT NOT NULL,
  role TEXT,
  confidence REAL,
  rationale TEXT,
  provider_model TEXT,
  attempts INTEGER,
  error_code TEXT,
  error_detail TEXT,
  classified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(article_id, club_id, source_content_hash, classifier_version),
  FOREIGN KEY (article_id) REFERENCES raw_articles(id) ON DELETE CASCADE,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_role_classifications_lookup
  ON article_club_role_classifications(article_id, club_id, source_content_hash, classifier_version);

CREATE INDEX IF NOT EXISTS idx_role_classifications_status
  ON article_club_role_classifications(status, updated_at);

INSERT OR IGNORE INTO article_club_assessments
  (article_id, club_id, source_content_hash, rule_version,
   decision, reason_code, reason_detail, decided_at, created_at)
SELECT
  article_id,
  club_id,
  source_content_hash,
  'phase-a-relevance-v3',
  CASE
    WHEN decision = 'relevant'
      AND reason_code IN ('strong_alias_excerpt', 'strong_alias_lead')
      THEN 'needs_review'
    ELSE decision
  END,
  CASE
    WHEN decision = 'relevant' AND reason_code = 'strong_alias_excerpt'
      THEN 'strong_alias_excerpt_role_review'
    WHEN decision = 'relevant' AND reason_code = 'strong_alias_lead'
      THEN 'strong_alias_lead_role_review'
    ELSE reason_code
  END,
  reason_detail,
  decided_at,
  created_at
FROM article_club_assessments
WHERE rule_version = 'phase-a-relevance-v2';
