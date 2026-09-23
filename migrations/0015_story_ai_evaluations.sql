-- 0015_story_ai_evaluations.sql
-- Append-only audit/calibration history for STORY ambiguity AI.
-- This table never drives STORY membership directly.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS story_ai_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('queue', 'replay')),
  prompt_version TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('review', 'error')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('attach', 'new_story', 'unsure')),
  story_id TEXT,
  confidence REAL,
  match_basis TEXT,
  shared_facts_json TEXT,
  rationale TEXT,
  evidence_event_ids_json TEXT,
  response_json TEXT,
  error_code TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attempt_id) REFERENCES story_match_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES event_candidates(id) ON DELETE CASCADE,
  FOREIGN KEY (story_id) REFERENCES stories(id),
  UNIQUE(attempt_id, mode, request_hash)
);

CREATE INDEX IF NOT EXISTS idx_story_ai_evaluations_attempt
  ON story_ai_evaluations(attempt_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_story_ai_evaluations_prompt_status
  ON story_ai_evaluations(prompt_version, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_story_ai_evaluations_event
  ON story_ai_evaluations(event_id, id DESC);
