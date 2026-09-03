-- 0008_reduce_d1_row_reads.sql
-- Add covering indexes for the two hot automatic queues.
-- These queries run every 30 minutes, so avoiding full-table scans is critical
-- on the D1 free tier.

PRAGMA foreign_keys = ON;

-- Phase A starts from raw/retry rows only and orders oldest first.
CREATE INDEX IF NOT EXISTS idx_raw_articles_phase_a_queue
  ON raw_articles(processing_status, last_seen_at ASC, id, source_id, content_hash);

-- Automatic role classifier queue:
-- WHERE rule_version = ? AND decision = 'needs_review'
--   AND reason_code IN (...) ORDER BY decided_at ASC
CREATE INDEX IF NOT EXISTS idx_article_assessments_role_queue
  ON article_club_assessments(
    rule_version,
    decision,
    reason_code,
    decided_at ASC,
    article_id,
    club_id,
    source_content_hash
  );

-- Source -> clubs lookup is executed per Phase A candidate.
CREATE INDEX IF NOT EXISTS idx_club_sources_source
  ON club_sources(source_id, priority, club_id);

-- Stale-run recovery executes automatically every cycle.
CREATE INDEX IF NOT EXISTS idx_processing_runs_status_started
  ON processing_runs(status, started_at);

CREATE INDEX IF NOT EXISTS idx_collection_runs_status_started
  ON collection_runs(status, started_at);
