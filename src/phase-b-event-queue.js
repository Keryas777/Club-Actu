import { EVENT_EXTRACTOR_VERSION } from './phase-b-events-targeted.js';
import {
  loadPhaseBClubContext,
  persistPhaseBEventCandidatesForArticle
} from './phase-b-event-persistence.js';

export const EVENT_AUTO_BATCH_VERSION = 'phase-b-event-auto-batch-v1';
export const DEFAULT_EVENT_BATCH_LIMIT = 4;
export const DEFAULT_EVENT_LOOKBACK_HOURS = 72;
export const DEFAULT_EVENT_BATCH_MAX_DURATION_MS = 12000;

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export async function loadPendingEventArticleIds(db, options = {}) {
  const limit = clampInteger(options.limit, DEFAULT_EVENT_BATCH_LIMIT, 1, 12);
  const lookbackHours = clampInteger(
    options.lookbackHours,
    DEFAULT_EVENT_LOOKBACK_HOURS,
    1,
    24 * 14
  );
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  const { results } = await db.prepare(`
    SELECT ce.article_id
    FROM article_content_enrichments ce INDEXED BY idx_content_enrichments_event_queue
    JOIN raw_articles r
      ON r.id = ce.article_id
     AND r.content_hash = ce.source_content_hash
    WHERE ce.status = 'completed'
      AND ce.updated_at >= ?
      AND ce.content_hash IS NOT NULL
      AND ce.content_text IS NOT NULL
      AND LENGTH(TRIM(ce.content_text)) > 0
      AND EXISTS (
        SELECT 1
        FROM article_club_assessments a INDEXED BY idx_article_assessments_enrichment_queue
        WHERE a.article_id = ce.article_id
          AND a.source_content_hash = ce.source_content_hash
          AND a.rule_version = 'phase-a-relevance-v3'
          AND a.decision = 'relevant'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM article_event_candidate_runs q INDEXED BY idx_article_event_runs_content_gate
        WHERE q.article_id = ce.article_id
          AND q.source_content_hash = ce.source_content_hash
          AND q.extractor_version = ?
          AND q.input_source = 'article_content_enrichments'
          AND q.input_content_hash = ce.content_hash
          AND (
            q.status = 'completed'
            OR q.status = 'failed'
            OR (
              q.status = 'processing'
              AND q.lease_expires_at IS NOT NULL
              AND q.lease_expires_at > CURRENT_TIMESTAMP
            )
            OR (
              q.status = 'retry'
              AND q.next_retry_at IS NOT NULL
              AND q.next_retry_at > CURRENT_TIMESTAMP
            )
          )
      )
    ORDER BY ce.updated_at ASC, ce.article_id ASC
    LIMIT ?
  `).bind(cutoff, EVENT_EXTRACTOR_VERSION, limit).all();

  return (results || []).map((row) => row.article_id).filter(Boolean);
}

export async function processPhaseBEventPersistenceBatch(db, options = {}) {
  if (!db) throw new Error('D1 binding is required');

  const limit = clampInteger(options.limit, DEFAULT_EVENT_BATCH_LIMIT, 1, 12);
  const maxDurationMs = clampInteger(
    options.maxDurationMs,
    DEFAULT_EVENT_BATCH_MAX_DURATION_MS,
    1000,
    25000
  );
  const startedAtMs = Date.now();
  const articleIds = await loadPendingEventArticleIds(db, {
    limit,
    lookbackHours: options.lookbackHours
  });

  if (!articleIds.length) {
    return {
      batch_version: EVENT_AUTO_BATCH_VERSION,
      extractor_version: EVENT_EXTRACTOR_VERSION,
      candidates: 0,
      processed: 0,
      persisted: 0,
      deferred: 0,
      errors: 0,
      event_candidates: 0,
      writes_executed: 0,
      stop_reason: 'empty',
      examples: []
    };
  }

  const clubs = options.clubs || await loadPhaseBClubContext(db);
  const persistArticle = options.persistArticle || persistPhaseBEventCandidatesForArticle;
  const totals = {
    candidates: articleIds.length,
    processed: 0,
    persisted: 0,
    deferred: 0,
    errors: 0,
    event_candidates: 0,
    writes_executed: 0
  };
  const examples = [];
  let stopReason = 'drained';

  for (const articleId of articleIds) {
    if (Date.now() - startedAtMs >= maxDurationMs) {
      stopReason = 'time_guard';
      break;
    }

    try {
      const result = await persistArticle(db, articleId, {
        clubs,
        leaseMs: 120000
      });

      totals.processed++;
      totals.writes_executed += Number(result.writes_executed || 0);

      if (result.status === 'persisted') {
        totals.persisted++;
        totals.event_candidates += Number(result.event_count || 0);
      } else if (result.status === 'deferred') {
        totals.deferred++;
      }

      if (examples.length < 6) {
        examples.push({
          article_id: articleId,
          status: result.status,
          event_count: Number(result.event_count || 0),
          writes_executed: Number(result.writes_executed || 0),
          already_completed: Boolean(result.already_completed)
        });
      }
    } catch (error) {
      totals.processed++;
      totals.errors++;
      if (examples.length < 6) {
        examples.push({
          article_id: articleId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return {
    batch_version: EVENT_AUTO_BATCH_VERSION,
    extractor_version: EVENT_EXTRACTOR_VERSION,
    ...totals,
    stop_reason: stopReason,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date().toISOString(),
    examples
  };
}
