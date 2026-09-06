-- 0010_optimize_d1_hot_queues.sql
-- Reduce D1 row reads for the automatic content-enrichment and Phase A cleanup queues.

PRAGMA foreign_keys = ON;

-- Content enrichment starts from current Phase A relevant assessments.
-- Keep rule_version + decision first so D1 can narrow the queue before joining raw_articles.
CREATE INDEX IF NOT EXISTS idx_article_assessments_enrichment_queue
  ON article_club_assessments(
    rule_version,
    decision,
    article_id,
    source_content_hash
  );

-- Automatic Phase A text cleanup always filters completed extractions and a recent updated_at window.
-- The existing (status, retry_after, updated_at) index cannot efficiently serve that access pattern
-- because retry_after is not constrained by the cleanup query.
CREATE INDEX IF NOT EXISTS idx_article_extractions_cleanup_queue
  ON article_extractions(status, updated_at, article_id);
