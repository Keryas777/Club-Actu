-- 0013_optimize_event_persistence_queue.sql
-- D1: exact content revision gate + covering indexes for automatic EVENT persistence.
--
-- Automatic EVENT extraction only consumes completed full-content enrichments.
-- input_content_hash records the exact enriched body revision used for a run, so:
-- - a later enrichment revision becomes eligible again;
-- - an unchanged article is excluded directly by indexed SQL;
-- - club/alias changes remain diagnostic only and do not reopen history.

PRAGMA foreign_keys = ON;

ALTER TABLE article_event_candidate_runs
  ADD COLUMN input_content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_article_event_runs_content_gate
  ON article_event_candidate_runs(
    article_id,
    source_content_hash,
    extractor_version,
    input_source,
    input_content_hash,
    status,
    next_retry_at,
    lease_expires_at
  );

CREATE INDEX IF NOT EXISTS idx_content_enrichments_event_queue
  ON article_content_enrichments(
    status,
    updated_at,
    article_id,
    source_content_hash,
    content_hash
  );
