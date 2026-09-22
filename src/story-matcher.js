import {
  STORY_MATCHER_VERSION, STORY_LOW_THRESHOLD, STORY_HIGH_THRESHOLD, STORY_TEMPORAL_SIGMA_DAYS,
  STORY_EMBEDDING_DIMENSION, STORY_EMBEDDING_ENCODING, STORY_EMBEDDING_MODEL, STORY_EMBEDDING_VERSION,
  DEFAULT_STORY_MATCH_LIMIT, DEFAULT_STORY_MATCH_MAX_DURATION_MS,
  clampInteger, cleanError, decodeFloat32Blob, updateCentroid, buildStoryId,
  buildEventIndexKeys, buildCandidateSetHash
} from './story-matching-core.js';
import { encodeFloat32LE } from './story-event-representation.js';
import {
  queryAll, runStatement, runBatch, loadReadyStoryMatchEvents, claimStoryMatchEvent,
  loadShortlistContext, loadStoryCandidates, loadQualifiedMembers, scoreCandidates,
  chooseStoryDecision, candidateAuditJson, attemptInsertStatement, contextWriteStatements,
  loadEventTrackedClubs, storyKeyStatements, storyEventKeyStatements, storyClubStatements, eventFinalStatement
} from './story-match-store.js';

const STORY_CENTROID_LEASE_MS = 2 * 60 * 1000;
const MATCH_RETRY_DELAY_MS = 10 * 60 * 1000;
const STORY_BUSY_RETRY_MS = 60 * 1000;
const MAX_MATCH_ATTEMPTS = 8;

function inPlaceholders(count) {
  return new Array(count).fill('?').join(', ');
}

async function persistNewStory(db, event, vector, decision, scored, candidateSetHash, ctx, metrics) {
  const storyId = await buildStoryId(event.event_id);
  const trackedClubs = await loadEventTrackedClubs(db, event.event_id, metrics);
  const statements = [
    db.prepare(`
      INSERT INTO stories (
        id, founder_event_id, family, status, merged_into_story_id, boundary_event_id,
        first_event_at, last_event_at, member_count,
        centroid_blob, centroid_model, centroid_embedding_version, centroid_dimension,
        centroid_encoding, centroid_member_count, centroid_revision, centroid_updated_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, 'active', NULL, NULL, ?, ?, 1,
        ?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).bind(
      storyId,
      event.event_id,
      event.family || 'unknown',
      event.published_at || null,
      event.published_at || null,
      encodeFloat32LE(vector),
      STORY_EMBEDDING_MODEL,
      STORY_EMBEDDING_VERSION,
      STORY_EMBEDDING_DIMENSION,
      STORY_EMBEDDING_ENCODING
    ),
    attemptInsertStatement(db, event, decision, scored, candidateSetHash, ctx.version, storyId),
    db.prepare(`
      INSERT INTO story_events (
        story_id, event_id, assignment_kind, membership_status,
        match_attempt_id, centroid_applied, centroid_applied_at, assigned_at
      ) VALUES (
        ?, ?, 'AUTO_NEW_STORY', 'active',
        (SELECT id FROM story_match_attempts
         WHERE event_id = ? AND matcher_version = ? AND embedding_id = ? AND candidate_set_hash = ?
         LIMIT 1),
        1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).bind(storyId, event.event_id, event.event_id, STORY_MATCHER_VERSION, event.embedding_id, candidateSetHash),
    ...storyClubStatements(db, storyId, trackedClubs),
    ...storyKeyStatements(db, storyId, event.family, event),
    ...storyEventKeyStatements(db, storyId, event),
    ...contextWriteStatements(db, event, ctx),
    eventFinalStatement(db, event, 'auto_new_story')
  ];
  await runBatch(db, statements, metrics);
  return {
    story_id: storyId,
    member_count_before: 0,
    member_count_after: 1,
    centroid_revision_before: 0,
    centroid_revision_after: 1,
    clubs_added: trackedClubs.map((row) => row.club_id),
    index_keys_added: buildEventIndexKeys(event).length
  };
}

export async function acquireStoryCentroidLease(db, storyId, metrics = { queries: 0, rows_read: 0, write_statements: 0, rows_written: 0 }) {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + STORY_CENTROID_LEASE_MS).toISOString();
  const result = await runStatement(db, `
    UPDATE stories
    SET centroid_lease_token = ?,
        centroid_lease_expires_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'active'
      AND merged_into_story_id IS NULL
      AND (
        centroid_lease_token IS NULL
        OR centroid_lease_expires_at IS NULL
        OR centroid_lease_expires_at <= CURRENT_TIMESTAMP
      )
  `, [leaseToken, leaseExpiresAt, storyId], metrics);
  return {
    acquired: Number(result?.meta?.changes || 0) > 0,
    leaseToken,
    leaseExpiresAt
  };
}

async function releaseStoryCentroidLease(db, storyId, leaseToken, metrics) {
  await runStatement(db, `
    UPDATE stories
    SET centroid_lease_token = NULL,
        centroid_lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND centroid_lease_token = ?
  `, [storyId, leaseToken], metrics);
}

async function reloadLeasedStory(db, storyId, leaseToken, metrics) {
  const rows = await queryAll(db, `
    SELECT *
    FROM stories
    WHERE id = ? AND centroid_lease_token = ?
    LIMIT 1
  `, [storyId, leaseToken], metrics);
  return rows[0] || null;
}

async function deferEvent(db, event, reason, delayMs, metrics) {
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  await runStatement(db, `
    UPDATE event_candidates
    SET match_status = 'matching_retry',
        next_retry_at = ?,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = ?,
        last_error_detail = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND match_status = 'matching'
      AND lease_token = ?
  `, [nextRetryAt, reason, reason, event.event_id, event.match_lease_token], metrics);
}

async function loadExistingStoryClubsAndKeys(db, storyId, event, metrics) {
  const trackedClubs = await loadEventTrackedClubs(db, event.event_id, metrics);
  const existingClubRows = trackedClubs.length ? await queryAll(db, `
    SELECT club_id
    FROM story_clubs
    WHERE story_id = ?
      AND club_id IN (${inPlaceholders(trackedClubs.length)})
  `, [storyId, ...trackedClubs.map((row) => row.club_id)], metrics) : [];
  const existingClubs = new Set(existingClubRows.map((row) => row.club_id));
  const clubsAdded = trackedClubs.filter((row) => !existingClubs.has(row.club_id));

  const eventKeys = buildEventIndexKeys(event);
  const existingKeyRows = eventKeys.length ? await queryAll(db, `
    WITH q(key_type, key_value) AS (
      VALUES ${eventKeys.map(() => '(?, ?)').join(', ')}
    )
    SELECT k.key_type, k.key_value
    FROM q
    JOIN story_index_keys k INDEXED BY idx_story_index_keys_lookup
      ON k.key_type = q.key_type
     AND k.key_value = q.key_value
    WHERE k.story_id = ?
  `, [...eventKeys.flatMap((row) => [row.key_type, row.key_value]), storyId], metrics) : [];
  const existingKeys = new Set(existingKeyRows.map((row) => `${row.key_type}\u0000${row.key_value}`));
  const keysAdded = eventKeys.filter((row) => !existingKeys.has(`${row.key_type}\u0000${row.key_value}`));
  return { trackedClubs, clubsAdded, eventKeys, keysAdded };
}

async function persistAttach(db, event, vector, decision, scored, candidateSetHash, ctx, metrics) {
  const target = decision.best;
  const lease = await acquireStoryCentroidLease(db, target.id, metrics);
  if (!lease.acquired) {
    await deferEvent(db, event, 'story_centroid_busy', STORY_BUSY_RETRY_MS, metrics);
    return { deferred: true, reason: 'story_centroid_busy', story_id: target.id };
  }
  let keepLease = true;
  try {
    const current = await reloadLeasedStory(db, target.id, lease.leaseToken, metrics);
    if (!current) throw new Error('Leased story disappeared');
    if (Number(current.centroid_revision || 0) !== Number(target.centroid_revision || 0)
      || Number(current.member_count || 0) !== Number(target.member_count || 0)) {
      await releaseStoryCentroidLease(db, target.id, lease.leaseToken, metrics);
      keepLease = false;
      await deferEvent(db, event, 'story_snapshot_changed', STORY_BUSY_RETRY_MS, metrics);
      return { deferred: true, reason: 'story_snapshot_changed', story_id: target.id };
    }
    const oldCentroid = decodeFloat32Blob(current.centroid_blob, STORY_EMBEDDING_DIMENSION);
    const oldCentroidCount = Number(current.centroid_member_count || 0);
    const nextCentroid = updateCentroid(oldCentroid, vector, oldCentroidCount);
    const additions = await loadExistingStoryClubsAndKeys(db, target.id, event, metrics);
    const statements = [
      attemptInsertStatement(db, event, decision, scored, candidateSetHash, ctx.version, target.id),
      db.prepare(`
        INSERT INTO story_events (
          story_id, event_id, assignment_kind, membership_status,
          match_attempt_id, centroid_applied, centroid_applied_at, assigned_at
        ) VALUES (
          ?, ?, 'AUTO_ATTACH', 'active',
          (SELECT id FROM story_match_attempts
           WHERE event_id = ? AND matcher_version = ? AND embedding_id = ? AND candidate_set_hash = ?
           LIMIT 1),
          1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).bind(target.id, event.event_id, event.event_id, STORY_MATCHER_VERSION, event.embedding_id, candidateSetHash),
      ...storyClubStatements(db, target.id, additions.clubsAdded),
      ...storyKeyStatements(db, target.id, current.family, event, additions.keysAdded),
      ...storyEventKeyStatements(db, target.id, event),
      db.prepare(`
        UPDATE stories
        SET first_event_at = CASE
              WHEN first_event_at IS NULL THEN ?
              WHEN ? IS NULL THEN first_event_at
              WHEN ? < first_event_at THEN ?
              ELSE first_event_at
            END,
            last_event_at = CASE
              WHEN last_event_at IS NULL THEN ?
              WHEN ? IS NULL THEN last_event_at
              WHEN ? > last_event_at THEN ?
              ELSE last_event_at
            END,
            member_count = member_count + 1,
            centroid_blob = ?,
            centroid_member_count = centroid_member_count + 1,
            centroid_revision = centroid_revision + 1,
            centroid_updated_at = CURRENT_TIMESTAMP,
            centroid_lease_token = NULL,
            centroid_lease_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND centroid_lease_token = ?
      `).bind(
        event.published_at || null,
        event.published_at || null,
        event.published_at || null,
        event.published_at || null,
        event.published_at || null,
        event.published_at || null,
        event.published_at || null,
        event.published_at || null,
        encodeFloat32LE(nextCentroid),
        target.id,
        lease.leaseToken
      ),
      ...contextWriteStatements(db, event, ctx),
      eventFinalStatement(db, event, 'auto_attach')
    ];
    await runBatch(db, statements, metrics);
    keepLease = false;
    return {
      deferred: false,
      story_id: target.id,
      member_count_before: Number(current.member_count || 0),
      member_count_after: Number(current.member_count || 0) + 1,
      centroid_revision_before: Number(current.centroid_revision || 0),
      centroid_revision_after: Number(current.centroid_revision || 0) + 1,
      clubs_added: additions.clubsAdded.map((row) => row.club_id),
      index_keys_added: additions.keysAdded.length
    };
  } finally {
    if (keepLease) {
      try { await releaseStoryCentroidLease(db, target.id, lease.leaseToken, metrics); } catch { /* lease expires */ }
    }
  }
}

async function persistAmbiguous(db, event, decision, scored, candidateSetHash, ctx, metrics) {
  const statements = [
    attemptInsertStatement(db, event, decision, scored, candidateSetHash, ctx.version, null),
    ...contextWriteStatements(db, event, ctx),
    eventFinalStatement(db, event, 'ambiguous_ai')
  ];
  await runBatch(db, statements, metrics);
  return {
    story_id: null,
    member_count_before: decision.best ? Number(decision.best.member_count || 0) : null,
    member_count_after: decision.best ? Number(decision.best.member_count || 0) : null,
    centroid_revision_before: decision.best ? Number(decision.best.centroid_revision || 0) : null,
    centroid_revision_after: decision.best ? Number(decision.best.centroid_revision || 0) : null,
    clubs_added: [],
    index_keys_added: 0
  };
}

async function markMatchFailure(db, event, error, metrics) {
  const terminal = Number(event.match_attempts || 0) >= MAX_MATCH_ATTEMPTS;
  const status = terminal ? 'matching_failed' : 'matching_retry';
  const nextRetryAt = terminal ? null : new Date(Date.now() + MATCH_RETRY_DELAY_MS).toISOString();
  await runStatement(db, `
    UPDATE event_candidates
    SET match_status = ?,
        next_retry_at = ?,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = 'story_match_error',
        last_error_detail = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND match_status = 'matching'
      AND lease_token = ?
  `, [status, nextRetryAt, cleanError(error), event.event_id, event.match_lease_token], metrics);
  return status;
}

async function existingEventOutcome(db, eventId, metrics) {
  const rows = await queryAll(db, `
    SELECT
      e.id AS event_id,
      e.match_status,
      se.story_id,
      se.assignment_kind,
      s.member_count,
      s.centroid_revision,
      a.id AS match_attempt_id,
      a.decision,
      a.best_story_id,
      a.best_hybrid_score,
      a.shortlist_context_version,
      a.candidate_set_hash
    FROM event_candidates e
    LEFT JOIN story_events se ON se.event_id = e.id AND se.membership_status = 'active'
    LEFT JOIN stories s ON s.id = se.story_id
    LEFT JOIN story_match_attempts a ON a.id = (
      SELECT MAX(a2.id) FROM story_match_attempts a2 WHERE a2.event_id = e.id
    )
    WHERE e.id = ?
    LIMIT 1
  `, [eventId], metrics);
  return rows[0] || null;
}

async function processClaimedEvent(db, row, claim, metrics) {
  const event = { ...row, match_lease_token: claim.leaseToken, match_attempts: claim.attempt };
  const vector = decodeFloat32Blob(event.embedding_vector, STORY_EMBEDDING_DIMENSION);
  const ctx = await loadShortlistContext(db, event, metrics);
  const lookup = await loadStoryCandidates(db, event, ctx, metrics);
  const candidateIds = lookup.candidates.map((candidate) => candidate.id);
  const members = await loadQualifiedMembers(db, event, ctx, candidateIds, metrics);
  const scored = scoreCandidates(event, vector, lookup.candidates, members, ctx);
  const decision = chooseStoryDecision(scored);
  const candidateSetHash = await buildCandidateSetHash(scored, ctx.version);
  let persistence;
  if (decision.decision === 'AUTO_NEW_STORY') {
    persistence = await persistNewStory(db, event, vector, decision, scored, candidateSetHash, ctx, metrics);
  } else if (decision.decision === 'AUTO_ATTACH') {
    persistence = await persistAttach(db, event, vector, decision, scored, candidateSetHash, ctx, metrics);
    if (persistence.deferred) {
      return {
        event_id: event.event_id,
        status: 'deferred',
        reason: persistence.reason,
        story_id: persistence.story_id,
        embedding_id: event.embedding_id,
        shortlist_context_version: ctx.version,
        candidate_set_hash: candidateSetHash,
        lookup_keys: lookup.lookup_keys,
        candidates: candidateAuditJson(scored)
      };
    }
  } else {
    persistence = await persistAmbiguous(db, event, decision, scored, candidateSetHash, ctx, metrics);
  }
  return {
    event_id: event.event_id,
    status: 'decided',
    decision: decision.decision,
    decision_reason: decision.reason,
    embedding_id: event.embedding_id,
    embedding_model: STORY_EMBEDDING_MODEL,
    embedding_version: STORY_EMBEDDING_VERSION,
    representation_hash: event.representation_hash,
    shortlist_context_version: ctx.version,
    event_count_context: ctx.eventCount,
    max_df: ctx.maxDf,
    common_tokens: ctx.commonTokens,
    candidate_set_hash: candidateSetHash,
    lookup_keys: lookup.lookup_keys,
    candidates: candidateAuditJson(scored),
    selected_story_id: persistence.story_id,
    member_count_before: persistence.member_count_before,
    member_count_after: persistence.member_count_after,
    centroid_revision_before: persistence.centroid_revision_before,
    centroid_revision_after: persistence.centroid_revision_after,
    clubs_added: persistence.clubs_added,
    index_keys_added: persistence.index_keys_added
  };
}

export async function processStoryMatchBatch(db, options = {}) {
  if (!db) throw new Error('D1 binding is required');
  const limit = clampInteger(options.limit, DEFAULT_STORY_MATCH_LIMIT, 1, 8);
  const maxDurationMs = clampInteger(options.maxDurationMs, DEFAULT_STORY_MATCH_MAX_DURATION_MS, 1000, 25000);
  const eventId = String(options.eventId || '').trim() || null;
  const metrics = { queries: 0, rows_read: 0, write_statements: 0, rows_written: 0 };
  const startedAtMs = Date.now();
  const rows = await loadReadyStoryMatchEvents(db, { limit, eventId }, metrics);
  if (!rows.length && eventId) {
    const existing = await existingEventOutcome(db, eventId, metrics);
    return {
      matcher_version: STORY_MATCHER_VERSION,
      candidates: 0,
      claimed: 0,
      decided: 0,
      auto_new_story: 0,
      auto_attach: 0,
      ambiguous_ai: 0,
      reused: existing ? 1 : 0,
      deferred: 0,
      retry: 0,
      failed: 0,
      stop_reason: existing ? 'already_final' : 'event_not_eligible',
      d1_queries: metrics.queries,
      d1_rows_read: metrics.rows_read,
      d1_write_statements: metrics.write_statements,
      d1_rows_written: metrics.rows_written,
      examples: existing ? [{ status: 'already_final', ...existing }] : []
    };
  }
  const totals = {
    candidates: rows.length,
    claimed: 0,
    decided: 0,
    auto_new_story: 0,
    auto_attach: 0,
    ambiguous_ai: 0,
    reused: 0,
    deferred: 0,
    retry: 0,
    failed: 0
  };
  const examples = [];
  let stopReason = rows.length ? 'drained' : 'empty';
  for (const row of rows) {
    if (Date.now() - startedAtMs >= maxDurationMs) {
      stopReason = 'time_guard';
      break;
    }
    const claim = await claimStoryMatchEvent(db, row, metrics);
    if (!claim.claimed) {
      totals.deferred++;
      continue;
    }
    totals.claimed++;
    try {
      const result = await processClaimedEvent(db, row, claim, metrics);
      if (result.status === 'deferred') {
        totals.deferred++;
      } else {
        totals.decided++;
        if (result.decision === 'AUTO_NEW_STORY') totals.auto_new_story++;
        if (result.decision === 'AUTO_ATTACH') totals.auto_attach++;
        if (result.decision === 'AMBIGUOUS_AI') totals.ambiguous_ai++;
      }
      if (examples.length < 6) examples.push(result);
    } catch (error) {
      const status = await markMatchFailure(db, { ...row, match_lease_token: claim.leaseToken, match_attempts: claim.attempt }, error, metrics);
      if (status === 'matching_failed') totals.failed++;
      else totals.retry++;
      if (examples.length < 6) examples.push({ event_id: row.event_id, status, error: cleanError(error) });
    }
  }
  return {
    matcher_version: STORY_MATCHER_VERSION,
    thresholds: { low: STORY_LOW_THRESHOLD, high: STORY_HIGH_THRESHOLD },
    score_weights: { embedding: 0.60, lexical: 0.25, temporal: 0.15 },
    temporal_sigma_days: STORY_TEMPORAL_SIGMA_DAYS,
    embedding_model: STORY_EMBEDDING_MODEL,
    embedding_version: STORY_EMBEDDING_VERSION,
    embedding_dimension: STORY_EMBEDDING_DIMENSION,
    ...totals,
    stop_reason: stopReason,
    d1_queries: metrics.queries,
    d1_rows_read: metrics.rows_read,
    d1_write_statements: metrics.write_statements,
    d1_rows_written: metrics.rows_written,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date().toISOString(),
    examples
  };
}
