import {
  STORY_MATCHER_VERSION, STORY_SHORTLIST_CONTEXT_VERSION, STORY_LOW_THRESHOLD, STORY_HIGH_THRESHOLD,
  STORY_EMBEDDING_DIMENSION, STORY_EMBEDDING_ENCODING, STORY_EMBEDDING_MODEL, STORY_EMBEDDING_VERSION,
  DEFAULT_STORY_MATCH_LIMIT, MAX_STORY_CANDIDATES, MAX_SHORTLIST_MEMBERS_PER_STORY,
  clampInteger, cleanError, lexicalTokens, buildShortlistContextSnapshot, shortlistContextVersion,
  buildStoryCandidateLookupKeys, buildPairwiseLookupKeys, pairwiseShortlist, familyCompatible,
  decodeFloat32Blob, cosineSimilarity, lexicalJaccard, temporalGaussianScore, hybridStoryScore,
  buildEventIndexKeys
} from './story-matching-core.js';

const MATCH_LEASE_MS = 2 * 60 * 1000;

function metaRowsRead(result) {
  return Number(result?.meta?.rows_read || 0);
}

function metaRowsWritten(result) {
  return Number(result?.meta?.rows_written ?? result?.meta?.changes ?? 0);
}

export async function queryAll(db, sql, bindings, metrics) {
  const result = await db.prepare(sql).bind(...bindings).all();
  metrics.queries++;
  metrics.rows_read += metaRowsRead(result);
  return result.results || [];
}

export async function runStatement(db, sql, bindings, metrics) {
  const result = await db.prepare(sql).bind(...bindings).run();
  metrics.queries++;
  metrics.write_statements++;
  metrics.rows_read += metaRowsRead(result);
  metrics.rows_written += metaRowsWritten(result);
  return result;
}

export async function runBatch(db, statements, metrics) {
  const results = await db.batch(statements);
  metrics.queries++;
  metrics.write_statements += statements.length;
  for (const result of results || []) {
    metrics.rows_read += metaRowsRead(result);
    metrics.rows_written += metaRowsWritten(result);
  }
  return results || [];
}

function inPlaceholders(count) {
  return new Array(count).fill('?').join(', ');
}

export async function loadReadyStoryMatchEvents(db, options = {}, metrics = { queries: 0, rows_read: 0 }) {
  const limit = clampInteger(options.limit, DEFAULT_STORY_MATCH_LIMIT, 1, 8);
  const eventId = String(options.eventId || '').trim();
  const eligibility = `(
    e.match_status = 'ready_match'
    OR (e.match_status = 'matching_retry' AND (e.next_retry_at IS NULL OR e.next_retry_at <= CURRENT_TIMESTAMP))
    OR (e.match_status = 'matching' AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= CURRENT_TIMESTAMP))
  )`;
  const whereEvent = eventId ? `AND e.id = ?` : '';
  const orderLimit = eventId ? 'LIMIT 1' : 'ORDER BY e.created_at ASC, e.id ASC LIMIT ?';
  const bindings = eventId
    ? [STORY_EMBEDDING_MODEL, STORY_EMBEDDING_VERSION, STORY_EMBEDDING_DIMENSION, STORY_EMBEDDING_ENCODING, eventId]
    : [STORY_EMBEDDING_MODEL, STORY_EMBEDDING_VERSION, STORY_EMBEDDING_DIMENSION, STORY_EMBEDDING_ENCODING, limit];
  return queryAll(db, `
    SELECT
      e.id AS event_id,
      e.article_id,
      e.published_at,
      e.language,
      e.family,
      e.stage,
      e.primary_people_json,
      e.primary_clubs_json,
      e.relation_from,
      e.relation_to,
      e.competition,
      e.opponents_json,
      e.lexical_tokens_json,
      e.match_status,
      e.match_attempts,
      emb.id AS embedding_id,
      emb.representation_hash,
      emb.dimension AS embedding_dimension,
      emb.encoding AS embedding_encoding,
      emb.vector AS embedding_vector
    FROM event_candidates AS e INDEXED BY idx_event_candidates_match_queue
    JOIN event_embeddings AS emb INDEXED BY idx_event_embeddings_event_ready
      ON emb.event_id = e.id
     AND emb.status = 'ready'
     AND emb.embedding_model = ?
     AND emb.embedding_version = ?
     AND emb.dimension = ?
     AND emb.encoding = ?
     AND emb.vector IS NOT NULL
    WHERE e.lifecycle_status = 'active'
      AND ${eligibility}
      ${whereEvent}
      AND emb.id = (
        SELECT MAX(emb2.id)
        FROM event_embeddings emb2
        WHERE emb2.event_id = e.id
          AND emb2.status = 'ready'
          AND emb2.embedding_model = emb.embedding_model
          AND emb2.embedding_version = emb.embedding_version
          AND emb2.dimension = emb.dimension
          AND emb2.encoding = emb.encoding
          AND emb2.vector IS NOT NULL
      )
    ${orderLimit}
  `, bindings, metrics);
}

export async function claimStoryMatchEvent(db, row, metrics) {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + MATCH_LEASE_MS).toISOString();
  const result = await runStatement(db, `
    UPDATE event_candidates
    SET match_status = 'matching',
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
        match_status = 'ready_match'
        OR (match_status = 'matching_retry' AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP))
        OR (match_status = 'matching' AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP))
      )
  `, [leaseToken, leaseExpiresAt, row.event_id], metrics);
  const claimed = Number(result?.meta?.changes || 0) > 0;
  return { claimed, leaseToken, leaseExpiresAt, attempt: Number(row.match_attempts || 0) + 1 };
}

export async function loadShortlistContext(db, event, metrics) {
  const language = String(event.language || 'und').trim().toLowerCase() || 'und';
  const tokens = lexicalTokens(event).slice(0, 64);
  const contextRows = await queryAll(db, `
    SELECT language, context_version, event_count, max_df, common_tokens_json, source_snapshot_hash
    FROM story_shortlist_contexts
    WHERE language = ?
    LIMIT 1
  `, [language], metrics);
  const current = contextRows[0] || { event_count: 0, max_df: 3 };
  const counts = new Map();
  if (tokens.length) {
    const rows = await queryAll(db, `
      SELECT token, document_count
      FROM story_shortlist_token_df
      WHERE language = ?
        AND token IN (${inPlaceholders(tokens.length)})
    `, [language, ...tokens], metrics);
    for (const row of rows) counts.set(row.token, Number(row.document_count || 0));
  }
  const ctx = buildShortlistContextSnapshot({ language, eventCount: current.event_count, tokens, counts });
  ctx.version = await shortlistContextVersion(ctx);
  ctx.previous_event_count = Number(current.event_count || 0);
  return ctx;
}

export async function loadStoryCandidates(db, event, ctx, metrics) {
  const keys = buildStoryCandidateLookupKeys(event, ctx.discriminantTokens);
  if (!keys.length) return { candidates: [], lookup_keys: [] };
  const values = keys.map(() => '(?, ?)').join(', ');
  const bindings = keys.flatMap((row) => [row.key_type, row.key_value]);
  const rows = await queryAll(db, `
    WITH event_keys(key_type, key_value) AS (
      VALUES ${values}
    )
    SELECT
      s.id,
      s.founder_event_id,
      s.family,
      s.status,
      s.boundary_event_id,
      s.first_event_at,
      s.last_event_at,
      s.member_count,
      s.centroid_blob,
      s.centroid_model,
      s.centroid_embedding_version,
      s.centroid_dimension,
      s.centroid_encoding,
      s.centroid_member_count,
      s.centroid_revision,
      COUNT(*) AS matched_key_count
    FROM event_keys q
    JOIN story_index_keys AS k INDEXED BY idx_story_index_keys_lookup
      ON k.key_type = q.key_type
     AND k.key_value = q.key_value
    JOIN stories s ON s.id = k.story_id
    WHERE s.status = 'active'
      AND s.merged_into_story_id IS NULL
    GROUP BY s.id
    ORDER BY matched_key_count DESC, COALESCE(s.last_event_at, s.created_at) DESC, s.id ASC
    LIMIT ?
  `, [...bindings, MAX_STORY_CANDIDATES], metrics);
  return { candidates: rows, lookup_keys: keys };
}

export async function loadQualifiedMembers(db, event, ctx, candidateIds, metrics) {
  if (!candidateIds.length) return [];
  const qKeys = buildPairwiseLookupKeys(event, ctx.discriminantTokens);
  if (!qKeys.length) return [];
  const qValues = qKeys.map(() => '(?, ?, ?)').join(', ');
  const qBindings = qKeys.flatMap((row) => [row.rule_type, row.key_type, row.key_value]);
  const storyPlaceholders = inPlaceholders(candidateIds.length);
  const family = event.family || 'unknown';
  return queryAll(db, `
    WITH q(rule_type, key_type, key_value) AS (
      VALUES ${qValues}
    ),
    hits AS (
      SELECT
        ik.story_id,
        ik.event_id,
        m.article_id,
        m.published_at,
        m.language,
        m.family,
        m.stage,
        m.primary_people_json,
        m.primary_clubs_json,
        m.relation_from,
        m.relation_to,
        m.competition,
        m.opponents_json,
        m.lexical_tokens_json,
        MAX(CASE WHEN q.rule_type = 'person' THEN 1 ELSE 0 END) AS person_hit,
        COUNT(DISTINCT CASE WHEN q.rule_type = 'club' THEN q.key_value END) AS club_hits,
        MAX(CASE WHEN q.rule_type = 'relation' THEN 1 ELSE 0 END) AS relation_hit,
        COUNT(DISTINCT CASE WHEN q.rule_type = 'salient' THEN q.key_value END) AS salient_hits
      FROM q
      JOIN story_event_index_keys AS ik INDEXED BY idx_story_event_index_keys_lookup
        ON ik.key_type = q.key_type
       AND ik.key_value = q.key_value
      JOIN story_events se
        ON se.story_id = ik.story_id
       AND se.event_id = ik.event_id
       AND se.membership_status = 'active'
      JOIN event_candidates m ON m.id = ik.event_id
      WHERE ik.story_id IN (${storyPlaceholders})
        AND m.lifecycle_status = 'active'
        AND m.article_id <> ?
      GROUP BY ik.story_id, ik.event_id
    ),
    qualified AS (
      SELECT *
      FROM hits
      WHERE person_hit > 0
         OR relation_hit > 0
         OR club_hits >= 2
         OR salient_hits >= 4
         OR (
           family = ?
           AND ? <> 'unknown'
           AND (salient_hits >= 3 OR (club_hits >= 1 AND salient_hits >= 2))
         )
    ),
    ranked AS (
      SELECT
        qualified.*,
        COUNT(*) OVER (PARTITION BY story_id) AS qualified_count,
        ROW_NUMBER() OVER (
          PARTITION BY story_id
          ORDER BY
            person_hit DESC,
            relation_hit DESC,
            club_hits DESC,
            salient_hits DESC,
            COALESCE(published_at, '') DESC,
            event_id ASC
        ) AS rn
      FROM qualified
    )
    SELECT *
    FROM ranked
    WHERE rn <= ?
    ORDER BY story_id ASC, rn ASC
  `, [
    ...qBindings,
    ...candidateIds,
    event.article_id,
    family,
    family,
    MAX_SHORTLIST_MEMBERS_PER_STORY
  ], metrics);
}

export function scoreCandidates(event, vector, candidates, members, ctx) {
  const membersByStory = new Map();
  for (const member of members) {
    if (!membersByStory.has(member.story_id)) membersByStory.set(member.story_id, []);
    const exact = pairwiseShortlist(event, member, ctx);
    if (exact.keep) membersByStory.get(member.story_id).push({ ...member, shortlist_reasons: exact.reasons });
  }
  const out = [];
  for (const story of candidates) {
    const shortlistMembers = membersByStory.get(story.id) || [];
    const qualifiedCount = shortlistMembers.length ? Number(shortlistMembers[0].qualified_count || shortlistMembers.length) : 0;
    const truncated = qualifiedCount > shortlistMembers.length;
    let centroid = null;
    let embedding = null;
    let centroidError = null;
    if (shortlistMembers.length) {
      try {
        if (story.centroid_model !== STORY_EMBEDDING_MODEL
          || story.centroid_embedding_version !== STORY_EMBEDDING_VERSION
          || Number(story.centroid_dimension || 0) !== STORY_EMBEDDING_DIMENSION
          || story.centroid_encoding !== STORY_EMBEDDING_ENCODING) {
          throw new Error('Story centroid metadata mismatch');
        }
        centroid = decodeFloat32Blob(story.centroid_blob, STORY_EMBEDDING_DIMENSION);
        embedding = cosineSimilarity(vector, centroid);
      } catch (error) {
        centroidError = cleanError(error);
      }
    }
    let lexical = 0;
    for (const member of shortlistMembers) lexical = Math.max(lexical, lexicalJaccard(event, member));
    const temporal = temporalGaussianScore(event.published_at, story.last_event_at);
    const hybrid = embedding == null ? null : hybridStoryScore(embedding, lexical, temporal);
    out.push({
      ...story,
      shortlist_members: shortlistMembers,
      shortlist_pass: shortlistMembers.length > 0,
      members_truncated: truncated,
      family_compatible: familyCompatible(event.family, story.family),
      embedding_score: embedding,
      lexical_score: lexical,
      temporal_score: temporal,
      hybrid_score: hybrid,
      centroid_error: centroidError
    });
  }
  return out;
}

export function chooseStoryDecision(scored) {
  const shortlisted = scored.filter((row) => row.shortlist_pass && row.hybrid_score != null);
  const invalidCentroid = scored.some((row) => row.shortlist_pass && row.hybrid_score == null);
  if (!shortlisted.length) {
    if (invalidCentroid) return { decision: 'AMBIGUOUS_AI', best: null, reason: 'candidate_centroid_invalid' };
    return { decision: 'AUTO_NEW_STORY', best: null, reason: 'no_pairwise_candidate' };
  }
  shortlisted.sort((a, b) => b.hybrid_score - a.hybrid_score || a.id.localeCompare(b.id));
  const bestRaw = shortlisted[0];
  const eligible = shortlisted.filter((row) => row.family_compatible);
  eligible.sort((a, b) => b.hybrid_score - a.hybrid_score || a.id.localeCompare(b.id));
  const best = eligible[0] || bestRaw;
  const anyTruncated = shortlisted.some((row) => row.members_truncated);
  if (!best.family_compatible) {
    if (best.hybrid_score >= STORY_LOW_THRESHOLD) {
      return { decision: 'AMBIGUOUS_AI', best, reason: 'family_gate' };
    }
    return { decision: 'AUTO_NEW_STORY', best, reason: 'family_gate_below_low' };
  }
  if (anyTruncated) {
    return { decision: 'AMBIGUOUS_AI', best, reason: 'bounded_membership_lower_bound' };
  }
  if (best.hybrid_score >= STORY_HIGH_THRESHOLD) {
    return { decision: 'AUTO_ATTACH', best, reason: 'high_score' };
  }
  if (best.hybrid_score >= STORY_LOW_THRESHOLD) {
    return { decision: 'AMBIGUOUS_AI', best, reason: 'score_ambiguous' };
  }
  return { decision: 'AUTO_NEW_STORY', best, reason: 'below_low' };
}

export function candidateAuditJson(scored) {
  return scored.map((row) => ({
    story_id: row.id,
    centroid_revision: Number(row.centroid_revision || 0),
    member_count: Number(row.member_count || 0),
    matched_key_count: Number(row.matched_key_count || 0),
    shortlist_pass: Boolean(row.shortlist_pass),
    shortlist_member_count: row.shortlist_members.length,
    shortlist_member_total: row.shortlist_members.length ? Number(row.shortlist_members[0].qualified_count || row.shortlist_members.length) : 0,
    members_truncated: Boolean(row.members_truncated),
    shortlist_members: row.shortlist_members.map((member) => ({
      event_id: member.event_id,
      reasons: member.shortlist_reasons
    })),
    embedding: row.embedding_score,
    lexical: row.lexical_score,
    temporal: row.temporal_score,
    hybrid: row.hybrid_score,
    family_compatible: Boolean(row.family_compatible),
    centroid_error: row.centroid_error || null
  }));
}

export function attemptInsertStatement(db, event, decision, scored, candidateSetHash, contextVersion, selectedStoryId = null) {
  const best = decision.best;
  return db.prepare(`
    INSERT INTO story_match_attempts (
      event_id, matcher_version, embedding_id, shortlist_context_version,
      candidate_set_hash, candidates_json, best_story_id,
      best_embedding_score, best_lexical_score, best_temporal_score, best_hybrid_score,
      family_compatible, boundary_status, decision, selected_story_id,
      ai_status, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inactive_v1', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(event_id, matcher_version, embedding_id, candidate_set_hash) DO NOTHING
  `).bind(
    event.event_id,
    STORY_MATCHER_VERSION,
    event.embedding_id,
    contextVersion,
    candidateSetHash,
    JSON.stringify(candidateAuditJson(scored)),
    best?.id || null,
    best?.embedding_score ?? null,
    best?.lexical_score ?? null,
    best?.temporal_score ?? null,
    best?.hybrid_score ?? null,
    best ? (best.family_compatible ? 1 : 0) : null,
    decision.decision,
    selectedStoryId,
    decision.decision === 'AMBIGUOUS_AI' ? 'pending' : 'not_required'
  );
}

export function contextWriteStatements(db, event, ctx) {
  const statements = [];
  const tokens = lexicalTokens(event).slice(0, 64);
  for (const token of tokens) {
    statements.push(db.prepare(`
      INSERT INTO story_shortlist_token_df (language, token, document_count, updated_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(language, token) DO UPDATE SET
        document_count = story_shortlist_token_df.document_count + 1,
        updated_at = CURRENT_TIMESTAMP
    `).bind(ctx.language, token));
  }
  statements.push(db.prepare(`
    INSERT INTO story_shortlist_contexts (
      language, context_version, event_count, max_df, common_tokens_json,
      source_snapshot_hash, computed_at, updated_at
    ) VALUES (?, ?, 1, 3, '[]', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(language) DO UPDATE SET
      context_version = ? || ':' || CAST(story_shortlist_contexts.event_count + 1 AS TEXT),
      event_count = story_shortlist_contexts.event_count + 1,
      max_df = CASE
        WHEN ((3 * (story_shortlist_contexts.event_count + 1) + 99) / 100) > 3
          THEN ((3 * (story_shortlist_contexts.event_count + 1) + 99) / 100)
        ELSE 3
      END,
      source_snapshot_hash = excluded.source_snapshot_hash,
      computed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    ctx.language,
    `${STORY_SHORTLIST_CONTEXT_VERSION}:1`,
    ctx.version,
    STORY_SHORTLIST_CONTEXT_VERSION
  ));
  return statements;
}

export async function loadEventTrackedClubs(db, eventId, metrics) {
  return queryAll(db, `
    SELECT club_id
    FROM event_candidate_clubs
    WHERE event_id = ?
    ORDER BY club_id ASC
  `, [eventId], metrics);
}

export function storyKeyStatements(db, storyId, storyFamily, event, explicitKeys = null) {
  const keys = explicitKeys || buildEventIndexKeys(event);
  return keys.map((key) => db.prepare(`
    INSERT OR IGNORE INTO story_index_keys (
      story_id, key_type, key_value, story_family, created_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(storyId, key.key_type, key.key_value, storyFamily || 'unknown'));
}

export function storyEventKeyStatements(db, storyId, event) {
  const keys = buildEventIndexKeys(event);
  return keys.map((key) => db.prepare(`
    INSERT OR IGNORE INTO story_event_index_keys (
      story_id, event_id, key_type, key_value, created_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(storyId, event.event_id, key.key_type, key.key_value));
}

export function storyClubStatements(db, storyId, trackedClubs) {
  return trackedClubs.map((row) => db.prepare(`
    INSERT OR IGNORE INTO story_clubs (story_id, club_id, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).bind(storyId, row.club_id));
}

export function eventFinalStatement(db, event, status) {
  return db.prepare(`
    UPDATE event_candidates
    SET match_status = ?,
        next_retry_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = NULL,
        last_error_detail = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND lifecycle_status = 'active'
      AND match_status = 'matching'
      AND lease_token = ?
  `).bind(status, event.event_id, event.match_lease_token);
}
