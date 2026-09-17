-- 0011_story_engine_schema.sql
-- D1: persistent EVENT_CANDIDATE -> STORY foundation.
-- Schema only: no cron, no production matcher, no AI invocation.
--
-- Design goals:
-- - ARTICLE / EVENT_CANDIDATE / STORY stay global, never duplicated per club.
-- - Idempotent persistence through deterministic IDs + UNIQUE constraints.
-- - Hot queues are index-driven; no historical scans or all-pairs matching.
-- - BGE-M3 vectors/centroids are persisted as compact Float32 BLOBs.
-- - STORY ids and founder events are immutable; future merges redirect instead of rewriting history.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS event_candidates (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  phase_b_input_source TEXT NOT NULL,
  phase_b_input_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  published_at TEXT,
  language TEXT NOT NULL DEFAULT 'und',
  family TEXT NOT NULL DEFAULT 'unknown',
  stage TEXT NOT NULL DEFAULT 'unknown',
  primary_people_json TEXT NOT NULL DEFAULT '[]',
  primary_clubs_json TEXT NOT NULL DEFAULT '[]',
  relation_from TEXT,
  relation_to TEXT,
  relation_hints_json TEXT NOT NULL DEFAULT '{}',
  competition TEXT,
  opponents_json TEXT NOT NULL DEFAULT '[]',
  family_discriminator_json TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  lexical_tokens_json TEXT NOT NULL DEFAULT '[]',
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  supersedes_event_id TEXT,
  match_status TEXT NOT NULL DEFAULT 'pending_embedding',
  match_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  last_error_detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(article_id, phase_b_input_hash, extractor_version, candidate_hash),
  FOREIGN KEY (article_id) REFERENCES raw_articles(id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_event_id) REFERENCES event_candidates(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_event_candidates_article
  ON event_candidates(article_id, source_content_hash, extractor_version, id);

CREATE INDEX IF NOT EXISTS idx_event_candidates_supersession
  ON event_candidates(article_id, lifecycle_status, supersedes_event_id, id);

CREATE INDEX IF NOT EXISTS idx_event_candidates_match_queue
  ON event_candidates(
    lifecycle_status,
    match_status,
    next_retry_at,
    lease_expires_at,
    created_at,
    id
  );

CREATE TABLE IF NOT EXISTS event_candidate_clubs (
  event_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, club_id),
  FOREIGN KEY (event_id) REFERENCES event_candidates(id) ON DELETE CASCADE,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_candidate_clubs_club
  ON event_candidate_clubs(club_id, event_id);

CREATE TABLE IF NOT EXISTS event_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_version TEXT NOT NULL,
  representation_hash TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'float32le',
  vector BLOB,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, embedding_model, embedding_version, representation_hash),
  FOREIGN KEY (event_id) REFERENCES event_candidates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_embeddings_queue
  ON event_embeddings(
    status,
    next_retry_at,
    lease_expires_at,
    created_at,
    id,
    event_id,
    embedding_model,
    embedding_version,
    representation_hash
  );

CREATE INDEX IF NOT EXISTS idx_event_embeddings_event_ready
  ON event_embeddings(event_id, status, embedding_model, embedding_version, id);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  founder_event_id TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'active',
  merged_into_story_id TEXT,
  boundary_event_id TEXT,
  first_event_at TEXT,
  last_event_at TEXT,
  member_count INTEGER NOT NULL DEFAULT 0,
  centroid_blob BLOB,
  centroid_model TEXT,
  centroid_embedding_version TEXT,
  centroid_dimension INTEGER,
  centroid_encoding TEXT NOT NULL DEFAULT 'float32le',
  centroid_member_count INTEGER NOT NULL DEFAULT 0,
  centroid_revision INTEGER NOT NULL DEFAULT 0,
  centroid_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (founder_event_id) REFERENCES event_candidates(id) ON DELETE RESTRICT,
  FOREIGN KEY (merged_into_story_id) REFERENCES stories(id) ON DELETE RESTRICT,
  FOREIGN KEY (boundary_event_id) REFERENCES event_candidates(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_stories_active_family_recent
  ON stories(status, family, last_event_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_stories_merged_into
  ON stories(merged_into_story_id, id);

CREATE TABLE IF NOT EXISTS story_shortlist_contexts (
  language TEXT PRIMARY KEY,
  context_version TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  max_df INTEGER NOT NULL DEFAULT 3,
  common_tokens_json TEXT NOT NULL DEFAULT '[]',
  source_snapshot_hash TEXT,
  computed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- candidate_set_hash must include the exact candidate STORY snapshot used for
-- the decision (at minimum story ids + centroid revisions/member counts), so a
-- later STORY update produces a new auditable matching attempt.
CREATE TABLE IF NOT EXISTS story_match_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  matcher_version TEXT NOT NULL,
  embedding_id INTEGER NOT NULL,
  shortlist_context_version TEXT,
  candidate_set_hash TEXT NOT NULL,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  best_story_id TEXT,
  best_embedding_score REAL,
  best_lexical_score REAL,
  best_temporal_score REAL,
  best_hybrid_score REAL,
  family_compatible INTEGER,
  boundary_status TEXT,
  decision TEXT NOT NULL,
  selected_story_id TEXT,
  ai_status TEXT NOT NULL DEFAULT 'not_required',
  ai_provider TEXT,
  ai_model TEXT,
  ai_prompt_version TEXT,
  ai_request_hash TEXT,
  ai_response_json TEXT,
  ai_attempts INTEGER NOT NULL DEFAULT 0,
  ai_next_retry_at TEXT,
  ai_lease_token TEXT,
  ai_lease_expires_at TEXT,
  ai_error_code TEXT,
  ai_error_detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, matcher_version, embedding_id, candidate_set_hash),
  FOREIGN KEY (event_id) REFERENCES event_candidates(id) ON DELETE RESTRICT,
  FOREIGN KEY (embedding_id) REFERENCES event_embeddings(id) ON DELETE RESTRICT,
  FOREIGN KEY (best_story_id) REFERENCES stories(id) ON DELETE SET NULL,
  FOREIGN KEY (selected_story_id) REFERENCES stories(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_story_match_attempts_event
  ON story_match_attempts(event_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_story_match_attempts_ai_queue
  ON story_match_attempts(
    ai_status,
    ai_next_retry_at,
    ai_lease_expires_at,
    updated_at,
    id,
    event_id
  );

CREATE TABLE IF NOT EXISTS story_events (
  story_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  assignment_kind TEXT NOT NULL,
  membership_status TEXT NOT NULL DEFAULT 'active',
  match_attempt_id INTEGER,
  centroid_applied INTEGER NOT NULL DEFAULT 0,
  centroid_applied_at TEXT,
  retired_at TEXT,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (story_id, event_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES event_candidates(id) ON DELETE RESTRICT,
  FOREIGN KEY (match_attempt_id) REFERENCES story_match_attempts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_story_events_story_assigned
  ON story_events(story_id, membership_status, assigned_at, event_id);

CREATE TABLE IF NOT EXISTS story_clubs (
  story_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (story_id, club_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_story_clubs_club
  ON story_clubs(club_id, story_id);

CREATE TABLE IF NOT EXISTS story_index_keys (
  story_id TEXT NOT NULL,
  key_type TEXT NOT NULL,
  key_value TEXT NOT NULL,
  story_family TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (key_type, key_value, story_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_story_index_keys_lookup
  ON story_index_keys(key_type, key_value, story_family, story_id);

CREATE INDEX IF NOT EXISTS idx_story_index_keys_story
  ON story_index_keys(story_id, key_type, key_value);
