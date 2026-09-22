import {
  STORY_EMBEDDING_DIMENSION,
  STORY_EMBEDDING_ENCODING,
  STORY_EMBEDDING_MODEL,
  STORY_EMBEDDING_VERSION,
  buildStructuredEventEmbeddingInput
} from './story-event-representation.js';

export const EVENT_EMBEDDING_BATCH_VERSION = 'event-embedding-batch-v1';
export const DEFAULT_EVENT_EMBEDDING_LIMIT = 4;
export const DEFAULT_EVENT_EMBEDDING_MAX_DURATION_MS = 12000;
const RETRY_DELAY_MS = 30 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const PHASE_A_EXTRACTOR_VERSION = 'phase-a-extractor-v1';

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return String(message || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

export async function loadPendingEmbeddingEvents(db, options = {}) {
  const limit = clampInteger(options.limit, DEFAULT_EVENT_EMBEDDING_LIMIT, 1, 12);

  const { results } = await db.prepare(`
    SELECT
      e.id AS event_id,
      e.article_id,
      e.family,
      e.stage,
      e.primary_people_json,
      e.primary_clubs_json,
      e.relation_from,
      e.relation_to,
      e.evidence_json,
      e.lexical_tokens_json,
      e.match_status,
      e.match_attempts,
      COALESCE(x.normalized_title, r.title, '') AS article_title
    FROM event_candidates e INDEXED BY idx_event_candidates_match_queue
    JOIN raw_articles r
      ON r.id = e.article_id
    LEFT JOIN article_extractions x
      ON x.article_id = e.article_id
     AND x.source_content_hash = e.source_content_hash
     AND x.extractor_version = ?
     AND x.status = 'completed'
    WHERE e.lifecycle_status = 'active'
      AND e.match_status IN ('pending_embedding', 'embedding_retry', 'embedding_processing')
      AND (
        e.match_status = 'pending_embedding'
        OR (
          e.match_status = 'embedding_retry'
          AND (e.next_retry_at IS NULL OR e.next_retry_at <= CURRENT_TIMESTAMP)
        )
        OR (
          e.match_status = 'embedding_processing'
          AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= CURRENT_TIMESTAMP)
        )
      )
    ORDER BY e.created_at ASC, e.id ASC
    LIMIT ?
  `).bind(PHASE_A_EXTRACTOR_VERSION, limit).all();

  return results || [];
}

async function findReadyEmbedding(db, eventId, representationHash) {
  return db.prepare(`
    SELECT id, dimension, encoding
    FROM event_embeddings
    WHERE event_id = ?
      AND embedding_model = ?
      AND embedding_version = ?
      AND representation_hash = ?
      AND status = 'ready'
      AND vector IS NOT NULL
    LIMIT 1
  `).bind(
    eventId,
    STORY_EMBEDDING_MODEL,
    STORY_EMBEDDING_VERSION,
    representationHash
  ).first();
}

async function markEventReadyFromExisting(db, eventId) {
  const result = await db.prepare(`
    UPDATE event_candidates
    SET match_status = 'ready_match',
        next_retry_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = NULL,
        last_error_detail = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND lifecycle_status = 'active'
      AND match_status <> 'ready_match'
  `).bind(eventId).run();

  return Number(result?.meta?.changes || 0);
}

async function claimEventForEmbedding(db, row) {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();

  const result = await db.prepare(`
    UPDATE event_candidates
    SET match_status = 'embedding_processing',
        match_attempts = match_attempts + 1,
        next_retry_at = NULL,
        lease_token = ?,
        lease_expires_at = ?,
        last_error_code = NULL,
        last_error_detail = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND lifecycle_status = 'active'
      AND (
        match_status = 'pending_embedding'
        OR (
          match_status = 'embedding_retry'
          AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
        )
        OR (
          match_status = 'embedding_processing'
          AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
        )
      )
  `).bind(leaseToken, leaseExpiresAt, row.event_id).run();

  if (Number(result?.meta?.changes || 0) === 0) {
    return { claimed: false };
  }

  const attempt = Number(row.match_attempts || 0) + 1;
  return { claimed: true, leaseToken, leaseExpiresAt, attempt };
}

async function upsertProcessingEmbedding(db, job) {
  await db.prepare(`
    INSERT INTO event_embeddings (
      event_id,
      embedding_model,
      embedding_version,
      representation_hash,
      dimension,
      encoding,
      vector,
      status,
      attempts,
      next_retry_at,
      lease_token,
      lease_expires_at,
      error_code,
      error_detail,
      created_at,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, NULL,
      'processing', 1, NULL, ?, ?, NULL, NULL,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(event_id, embedding_model, embedding_version, representation_hash)
    DO UPDATE SET
      dimension = excluded.dimension,
      encoding = excluded.encoding,
      status = 'processing',
      attempts = event_embeddings.attempts + 1,
      next_retry_at = NULL,
      lease_token = excluded.lease_token,
      lease_expires_at = excluded.lease_expires_at,
      error_code = NULL,
      error_detail = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    job.event_id,
    STORY_EMBEDDING_MODEL,
    STORY_EMBEDDING_VERSION,
    job.representation_hash,
    STORY_EMBEDDING_DIMENSION,
    STORY_EMBEDDING_ENCODING,
    job.leaseToken,
    job.leaseExpiresAt
  ).run();
}

export function extractEmbeddingVectors(payload, expectedCount) {
  const candidates = [
    payload?.data,
    payload?.result?.data,
    payload?.response,
    payload?.result?.response
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;

    if (
      expectedCount === 1
      && candidate.length === STORY_EMBEDDING_DIMENSION
      && candidate.every((value) => typeof value === 'number')
    ) {
      return [candidate];
    }

    if (
      candidate.length === expectedCount
      && candidate.every((row) => Array.isArray(row))
    ) {
      return candidate;
    }
  }

  throw new Error(
    `Unexpected BGE-M3 response shape: ${JSON.stringify(payload).slice(0, 800)}`
  );
}

export function validateEmbeddingVector(vector) {
  if (!Array.isArray(vector) || vector.length !== STORY_EMBEDDING_DIMENSION) {
    throw new Error(
      `BGE-M3 dimension mismatch: expected ${STORY_EMBEDDING_DIMENSION}, got ${Array.isArray(vector) ? vector.length : 'non-array'}`
    );
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new Error('BGE-M3 vector contains non-finite values');
  }
  return Float32Array.from(vector);
}

export async function runBgeM3Embeddings(ai, texts) {
  if (!ai?.run) throw new Error('Workers AI binding missing');
  if (!texts.length) return [];

  const payload = await ai.run(STORY_EMBEDDING_MODEL, { text: texts });
  const vectors = extractEmbeddingVectors(payload, texts.length);
  return vectors.map(validateEmbeddingVector);
}

function readyStatements(db, job, vector) {
  return [
    db.prepare(`
      UPDATE event_embeddings
      SET vector = ?,
          status = 'ready',
          next_retry_at = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          error_code = NULL,
          error_detail = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE event_id = ?
        AND embedding_model = ?
        AND embedding_version = ?
        AND representation_hash = ?
        AND status = 'processing'
        AND lease_token = ?
    `).bind(
      vector,
      job.event_id,
      STORY_EMBEDDING_MODEL,
      STORY_EMBEDDING_VERSION,
      job.representation_hash,
      job.leaseToken
    ),
    db.prepare(`
      UPDATE event_candidates
      SET match_status = 'ready_match',
          next_retry_at = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          last_error_detail = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND lifecycle_status = 'active'
        AND match_status = 'embedding_processing'
        AND lease_token = ?
    `).bind(job.event_id, job.leaseToken)
  ];
}

async function markEmbeddingFailure(db, job, error) {
  const terminal = job.attempt >= MAX_ATTEMPTS;
  const status = terminal ? 'failed' : 'retry';
  const eventStatus = terminal ? 'embedding_failed' : 'embedding_retry';
  const nextRetryAt = terminal
    ? null
    : new Date(Date.now() + RETRY_DELAY_MS).toISOString();
  const detail = cleanError(error);

  await db.batch([
    db.prepare(`
      UPDATE event_embeddings
      SET status = ?,
          next_retry_at = ?,
          lease_token = NULL,
          lease_expires_at = NULL,
          error_code = 'workers_ai_embedding_error',
          error_detail = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE event_id = ?
        AND embedding_model = ?
        AND embedding_version = ?
        AND representation_hash = ?
        AND status = 'processing'
        AND lease_token = ?
    `).bind(
      status,
      nextRetryAt,
      detail,
      job.event_id,
      STORY_EMBEDDING_MODEL,
      STORY_EMBEDDING_VERSION,
      job.representation_hash,
      job.leaseToken
    ),
    db.prepare(`
      UPDATE event_candidates
      SET match_status = ?,
          next_retry_at = ?,
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error_code = 'workers_ai_embedding_error',
          last_error_detail = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND lifecycle_status = 'active'
        AND match_status = 'embedding_processing'
        AND lease_token = ?
    `).bind(
      eventStatus,
      nextRetryAt,
      detail,
      job.event_id,
      job.leaseToken
    )
  ]);

  return { terminal, status: eventStatus };
}

export async function processEventEmbeddingBatch(db, ai, options = {}) {
  if (!db) throw new Error('D1 binding is required');

  const limit = clampInteger(options.limit, DEFAULT_EVENT_EMBEDDING_LIMIT, 1, 12);
  const maxDurationMs = clampInteger(
    options.maxDurationMs,
    DEFAULT_EVENT_EMBEDDING_MAX_DURATION_MS,
    1000,
    25000
  );
  const startedAtMs = Date.now();
  const rows = options.rows || await loadPendingEmbeddingEvents(db, { limit });
  const embed = options.embed || ((texts) => runBgeM3Embeddings(ai, texts));

  const totals = {
    candidates: rows.length,
    claimed: 0,
    reused: 0,
    embedded: 0,
    deferred: 0,
    retry: 0,
    failed: 0,
    ai_calls: 0,
    writes_executed: 0
  };
  const examples = [];
  const jobs = [];
  let stopReason = rows.length ? 'drained' : 'empty';

  for (const row of rows) {
    if (Date.now() - startedAtMs >= maxDurationMs) {
      stopReason = 'time_guard';
      break;
    }

    const input = await buildStructuredEventEmbeddingInput(row);
    const ready = await findReadyEmbedding(db, row.event_id, input.representation_hash);
    if (ready) {
      const writes = await markEventReadyFromExisting(db, row.event_id);
      totals.reused++;
      totals.writes_executed += writes;
      if (examples.length < 6) {
        examples.push({
          event_id: row.event_id,
          status: 'reused',
          dimension: Number(ready.dimension || 0),
          writes_executed: writes
        });
      }
      continue;
    }

    const claim = await claimEventForEmbedding(db, row);
    if (!claim.claimed) {
      totals.deferred++;
      continue;
    }

    const job = {
      ...row,
      ...input,
      ...claim
    };
    await upsertProcessingEmbedding(db, job);
    totals.claimed++;
    totals.writes_executed += 2;
    jobs.push(job);
  }

  if (!jobs.length) {
    return {
      batch_version: EVENT_EMBEDDING_BATCH_VERSION,
      model: STORY_EMBEDDING_MODEL,
      embedding_version: STORY_EMBEDDING_VERSION,
      dimension: STORY_EMBEDDING_DIMENSION,
      ...totals,
      stop_reason: stopReason,
      started_at: new Date(startedAtMs).toISOString(),
      finished_at: new Date().toISOString(),
      examples
    };
  }

  try {
    totals.ai_calls++;
    const vectors = await embed(jobs.map((job) => job.text));
    if (!Array.isArray(vectors) || vectors.length !== jobs.length) {
      throw new Error(
        `Embedding result count mismatch: expected ${jobs.length}, got ${Array.isArray(vectors) ? vectors.length : 'non-array'}`
      );
    }

    const statements = [];
    for (let i = 0; i < jobs.length; i++) {
      const vector = vectors[i] instanceof Float32Array
        ? vectors[i]
        : validateEmbeddingVector(vectors[i]);
      statements.push(...readyStatements(db, jobs[i], vector));
    }
    await db.batch(statements);

    totals.embedded += jobs.length;
    totals.writes_executed += statements.length;
    for (const job of jobs) {
      if (examples.length >= 6) break;
      examples.push({
        event_id: job.event_id,
        status: 'embedded',
        representation_hash: job.representation_hash,
        dimension: STORY_EMBEDDING_DIMENSION
      });
    }
  } catch (error) {
    for (const job of jobs) {
      const failure = await markEmbeddingFailure(db, job, error);
      totals.writes_executed += 2;
      if (failure.terminal) totals.failed++;
      else totals.retry++;
      if (examples.length < 6) {
        examples.push({
          event_id: job.event_id,
          status: failure.status,
          error: cleanError(error)
        });
      }
    }
  }

  return {
    batch_version: EVENT_EMBEDDING_BATCH_VERSION,
    model: STORY_EMBEDDING_MODEL,
    embedding_version: STORY_EMBEDDING_VERSION,
    dimension: STORY_EMBEDDING_DIMENSION,
    ...totals,
    stop_reason: stopReason,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date().toISOString(),
    examples
  };
}
