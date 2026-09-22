-- 0014_story_match_runtime.sql
-- D1.1 STORY V1 hot-path support: scoped centroid leases, incremental token DF,
-- and per-member lookup keys for bounded exact pairwise shortlist retrieval.

PRAGMA foreign_keys = ON;

ALTER TABLE stories ADD COLUMN centroid_lease_token TEXT;
ALTER TABLE stories ADD COLUMN centroid_lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_stories_centroid_lease
  ON stories(status, centroid_lease_expires_at, id);

CREATE TABLE IF NOT EXISTS story_shortlist_token_df (
  language TEXT NOT NULL,
  token TEXT NOT NULL,
  document_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (language, token)
);

CREATE INDEX IF NOT EXISTS idx_story_shortlist_token_df_count
  ON story_shortlist_token_df(language, document_count DESC, token);

CREATE TABLE IF NOT EXISTS story_event_index_keys (
  story_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  key_type TEXT NOT NULL,
  key_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (key_type, key_value, story_id, event_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES event_candidates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_story_event_index_keys_lookup
  ON story_event_index_keys(key_type, key_value, story_id, event_id);

CREATE INDEX IF NOT EXISTS idx_story_event_index_keys_story_event
  ON story_event_index_keys(story_id, event_id, key_type, key_value);

CREATE INDEX IF NOT EXISTS idx_story_event_index_keys_event
  ON story_event_index_keys(event_id, story_id, key_type, key_value);
