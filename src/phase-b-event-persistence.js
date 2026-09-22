import { normalizeTopicText } from './grouper.js';
import {
  EVENT_EXTRACTOR_VERSION,
  extractEventCandidates
} from './phase-b-events-targeted.js';

export const EVENT_PERSISTENCE_VERSION = 'phase-b-event-persistence-v2';
const PHASE_A_EXTRACTOR_VERSION = 'phase-a-extractor-v1';
const PHASE_A_RULE_VERSION = 'phase-a-relevance-v3';

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function jsonText(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function normalizedSorted(values = []) {
  return [...new Set(
    (values || [])
      .map((value) => normalizeTopicText(value))
      .filter(Boolean)
  )].sort();
}

function normalizedClubContext(clubs = []) {
  return clubs
    .map((club) => ({
      id: club.id,
      name: club.name,
      aliases: normalizedSorted(club.aliases || [])
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function articleProcessingInput(article) {
  return {
    extractor_version: EVENT_EXTRACTOR_VERSION,
    article: {
      id: article.id,
      title: article.title || '',
      published_at: article.published_at || null,
      excerpt: article.excerpt || '',
      content: article.content || '',
      content_source: article.content_source || 'none'
    }
  };
}

function canonicalEventForIdentity(article, event) {
  const hints = event?.relation_hints || {};
  const discriminator = event?.family_discriminator || null;
  const evidence = event?.evidence || {};
  const lexical = event?.lexical_fingerprint || {};

  return {
    article_title: cleanText(article?.title || ''),
    published_at: article?.published_at || null,
    family: event?.family || 'unknown',
    stage: event?.stage || 'unknown',
    primary_people: normalizedSorted(event?.primary_people || []),
    primary_clubs: normalizedSorted(event?.primary_clubs || []),
    relation_from: normalizeTopicText(hints.club_from || ''),
    relation_to: normalizeTopicText(hints.club_to || ''),
    family_discriminator: discriminator,
    evidence: {
      kind: evidence.kind || null,
      text: cleanText(evidence.text || ''),
      fragments: (evidence.fragments || []).map(cleanText).filter(Boolean)
    },
    lexical_tokens: normalizedSorted(lexical.tokens || [])
  };
}

export async function buildEventCandidateRecord(article, event, metadata = {}) {
  const candidateHash = await sha256Hex(
    stableStringify(canonicalEventForIdentity(article, event))
  );
  const id = await sha256Hex(
    `club-actu:event-candidate:v1\u0000${article.id}\u0000${candidateHash}`
  );
  const discriminator = event?.family_discriminator || null;
  const competition = event?.competition || discriminator?.competition || null;
  const opponents = event?.opponents || discriminator?.opponents || [];
  const hints = event?.relation_hints || {};

  return {
    id,
    article_id: article.id,
    source_content_hash: metadata.sourceContentHash || '',
    phase_b_input_source: metadata.inputSource || 'none',
    phase_b_input_hash: metadata.inputHash || '',
    extractor_version: metadata.extractorVersion || EVENT_EXTRACTOR_VERSION,
    candidate_hash: candidateHash,
    published_at: article.published_at || null,
    language: metadata.language || 'und',
    family: event?.family || 'unknown',
    stage: event?.stage || 'unknown',
    primary_people_json: jsonText(event?.primary_people || [], []),
    primary_clubs_json: jsonText(event?.primary_clubs || [], []),
    relation_from: hints.club_from || null,
    relation_to: hints.club_to || null,
    relation_hints_json: jsonText(hints, {}),
    competition,
    opponents_json: jsonText(opponents, []),
    family_discriminator_json: discriminator == null ? null : JSON.stringify(discriminator),
    evidence_json: jsonText(event?.evidence || {}, {}),
    lexical_tokens_json: jsonText(event?.lexical_fingerprint?.tokens || [], [])
  };
}

export function buildClubContext(rows = []) {
  const clubs = new Map();
  for (const row of rows || []) {
    if (!clubs.has(row.id)) {
      clubs.set(row.id, {
        id: row.id,
        name: row.name || row.id,
        aliases: []
      });
    }
    if (row.alias) clubs.get(row.id).aliases.push(row.alias);
  }
  return [...clubs.values()];
}

function aliasIndex(clubs = []) {
  const index = new Map();
  for (const club of clubs) {
    for (const alias of [club.id, club.name, ...(club.aliases || [])]) {
      const normalized = normalizeTopicText(alias);
      if (!normalized) continue;
      if (!index.has(normalized)) index.set(normalized, new Set());
      index.get(normalized).add(club.id);
    }
  }
  return index;
}

export function resolveTrackedClubIds(event, clubs = []) {
  const index = aliasIndex(clubs);
  const hints = event?.relation_hints || {};
  const anchors = [
    ...(event?.primary_clubs || []),
    hints.club_from,
    hints.club_to
  ].filter(Boolean);

  const clubIds = new Set();
  const ambiguousAnchors = [];
  const unmatchedAnchors = [];
  const seenAnchors = new Set();

  for (const anchor of anchors) {
    const normalized = normalizeTopicText(anchor);
    if (!normalized || seenAnchors.has(normalized)) continue;
    seenAnchors.add(normalized);
    const matches = [...(index.get(normalized) || [])];
    if (matches.length === 1) clubIds.add(matches[0]);
    else if (matches.length > 1) ambiguousAnchors.push(anchor);
    else unmatchedAnchors.push(anchor);
  }

  return {
    clubIds: [...clubIds].sort(),
    ambiguousAnchors,
    unmatchedAnchors
  };
}

export async function buildArticleEventProcessingHash(article) {
  return sha256Hex(stableStringify(articleProcessingInput(article)));
}

export async function buildPhaseBClubContextHash(clubs = []) {
  return sha256Hex(stableStringify(normalizedClubContext(clubs)));
}

export async function buildPhaseBInputHash(article, clubs = []) {
  return sha256Hex(stableStringify({
    ...articleProcessingInput(article),
    clubs: normalizedClubContext(clubs)
  }));
}

export async function loadPhaseBClubContext(db) {
  const { results } = await db.prepare(`
    SELECT c.id, c.name, a.alias, a.strength
    FROM clubs c
    LEFT JOIN club_aliases a ON a.club_id = c.id
    WHERE c.active = 1
    ORDER BY c.id, a.alias
  `).all();
  return buildClubContext(results || []);
}

async function loadArticleForPersistence(db, articleId) {
  const { results } = await db.prepare(`
    SELECT
      r.id,
      r.source_id,
      r.content_hash AS source_content_hash,
      COALESCE(s.language, 'und') AS language,
      COALESCE(e.normalized_title, r.title) AS title,
      COALESCE(e.normalized_published_at, r.published_at, r.last_seen_at) AS published_at,
      COALESCE(e.normalized_excerpt, r.excerpt, '') AS excerpt,
      COALESCE(NULLIF(ce.content_text, ''), e.normalized_content, r.raw_content, '') AS content,
      CASE
        WHEN ce.content_text IS NOT NULL AND LENGTH(TRIM(ce.content_text)) > 0
          THEN 'article_content_enrichments'
        WHEN e.normalized_content IS NOT NULL AND LENGTH(TRIM(e.normalized_content)) > 0
          THEN 'article_extractions'
        WHEN r.raw_content IS NOT NULL AND LENGTH(TRIM(r.raw_content)) > 0
          THEN 'raw_articles'
        ELSE 'none'
      END AS content_source
    FROM raw_articles r
    JOIN sources s
      ON s.id = r.source_id
    JOIN article_extractions e
      ON e.article_id = r.id
     AND e.source_content_hash = r.content_hash
     AND e.extractor_version = ?
     AND e.status = 'completed'
    LEFT JOIN article_content_enrichments ce
      ON ce.article_id = r.id
     AND ce.source_content_hash = r.content_hash
     AND ce.status = 'completed'
    WHERE r.id = ?
      AND EXISTS (
        SELECT 1
        FROM article_club_assessments a
        WHERE a.article_id = r.id
          AND a.source_content_hash = r.content_hash
          AND a.rule_version = ?
          AND a.decision = 'relevant'
      )
    LIMIT 1
  `).bind(PHASE_A_EXTRACTOR_VERSION, articleId, PHASE_A_RULE_VERSION).all();

  return results?.[0] || null;
}

async function loadCompletedArticleEventRun(db, articleId, processingInputHash) {
  const { results } = await db.prepare(`
    SELECT
      id,
      phase_b_input_hash,
      club_context_hash,
      input_source,
      event_count,
      completed_at
    FROM article_event_candidate_runs
    WHERE article_id = ?
      AND processing_input_hash = ?
      AND extractor_version = ?
      AND status = 'completed'
    LIMIT 1
  `).bind(articleId, processingInputHash, EVENT_EXTRACTOR_VERSION).all();

  return results?.[0] || null;
}

async function loadExistingArticleEvents(db, articleId) {
  const { results } = await db.prepare(`
    SELECT id, lifecycle_status, source_content_hash, phase_b_input_source,
           phase_b_input_hash, extractor_version, candidate_hash, language
    FROM event_candidates
    WHERE article_id = ?
  `).bind(articleId).all();
  return results || [];
}

async function loadExistingClubLinks(db, articleId) {
  const { results } = await db.prepare(`
    SELECT ec.event_id, ec.club_id
    FROM event_candidate_clubs ec
    JOIN event_candidates e ON e.id = ec.event_id
    WHERE e.article_id = ?
  `).bind(articleId).all();

  const links = new Map();
  for (const row of results || []) {
    if (!links.has(row.event_id)) links.set(row.event_id, new Set());
    links.get(row.event_id).add(row.club_id);
  }
  return links;
}

function insertArticleEventRunStatement(db, {
  article,
  processingInputHash,
  phaseBInputHash,
  clubContextHash,
  eventCount
}) {
  return db.prepare(`
    INSERT INTO article_event_candidate_runs (
      article_id,
      source_content_hash,
      processing_input_hash,
      phase_b_input_hash,
      club_context_hash,
      input_source,
      extractor_version,
      status,
      event_count,
      attempts,
      started_at,
      completed_at,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      'completed', ?, 1,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).bind(
    article.id,
    article.source_content_hash || '',
    processingInputHash,
    phaseBInputHash,
    clubContextHash,
    article.content_source || 'none',
    EVENT_EXTRACTOR_VERSION,
    eventCount
  );
}

function insertEventStatement(db, record) {
  return db.prepare(`
    INSERT INTO event_candidates (
      id, article_id, source_content_hash, phase_b_input_source, phase_b_input_hash,
      extractor_version, candidate_hash, published_at, language, family, stage,
      primary_people_json, primary_clubs_json, relation_from, relation_to,
      relation_hints_json, competition, opponents_json, family_discriminator_json,
      evidence_json, lexical_tokens_json, lifecycle_status, match_status
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'active', 'pending_embedding'
    )
  `).bind(
    record.id,
    record.article_id,
    record.source_content_hash,
    record.phase_b_input_source,
    record.phase_b_input_hash,
    record.extractor_version,
    record.candidate_hash,
    record.published_at,
    record.language,
    record.family,
    record.stage,
    record.primary_people_json,
    record.primary_clubs_json,
    record.relation_from,
    record.relation_to,
    record.relation_hints_json,
    record.competition,
    record.opponents_json,
    record.family_discriminator_json,
    record.evidence_json,
    record.lexical_tokens_json
  );
}

function refreshEventStatement(db, record) {
  return db.prepare(`
    UPDATE event_candidates
    SET source_content_hash = ?,
        phase_b_input_source = ?,
        phase_b_input_hash = ?,
        extractor_version = ?,
        candidate_hash = ?,
        published_at = ?,
        language = ?,
        family = ?,
        stage = ?,
        primary_people_json = ?,
        primary_clubs_json = ?,
        relation_from = ?,
        relation_to = ?,
        relation_hints_json = ?,
        competition = ?,
        opponents_json = ?,
        family_discriminator_json = ?,
        evidence_json = ?,
        lexical_tokens_json = ?,
        lifecycle_status = 'active',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    record.source_content_hash,
    record.phase_b_input_source,
    record.phase_b_input_hash,
    record.extractor_version,
    record.candidate_hash,
    record.published_at,
    record.language,
    record.family,
    record.stage,
    record.primary_people_json,
    record.primary_clubs_json,
    record.relation_from,
    record.relation_to,
    record.relation_hints_json,
    record.competition,
    record.opponents_json,
    record.family_discriminator_json,
    record.evidence_json,
    record.lexical_tokens_json,
    record.id
  );
}

function needsRefresh(existing, record) {
  return existing.lifecycle_status !== 'active'
    || existing.source_content_hash !== record.source_content_hash
    || existing.phase_b_input_source !== record.phase_b_input_source
    || existing.phase_b_input_hash !== record.phase_b_input_hash
    || existing.extractor_version !== record.extractor_version
    || existing.candidate_hash !== record.candidate_hash
    || existing.language !== record.language;
}

export async function persistPhaseBEventCandidatesForArticle(db, articleId, options = {}) {
  if (!db) throw new Error('D1 binding is required');
  if (!articleId) throw new Error('articleId is required');

  const [article, clubs] = await Promise.all([
    loadArticleForPersistence(db, articleId),
    options.clubs ? Promise.resolve(options.clubs) : loadPhaseBClubContext(db)
  ]);

  if (!article) {
    return {
      article_id: articleId,
      status: 'not_ready_or_not_relevant',
      extractor_version: EVENT_EXTRACTOR_VERSION,
      event_count: 0
    };
  }

  const [processingInputHash, clubContextHash, inputHash] = await Promise.all([
    buildArticleEventProcessingHash(article),
    buildPhaseBClubContextHash(clubs),
    buildPhaseBInputHash(article, clubs)
  ]);

  const completedRun = options.ignoreCompletedRun
    ? null
    : await loadCompletedArticleEventRun(db, article.id, processingInputHash);

  if (completedRun) {
    const storedEventCount = Number(completedRun.event_count || 0);
    return {
      article_id: article.id,
      status: 'persisted',
      persistence_version: EVENT_PERSISTENCE_VERSION,
      extractor_version: EVENT_EXTRACTOR_VERSION,
      content_source: completedRun.input_source || article.content_source || 'none',
      processing_input_hash: processingInputHash,
      phase_b_input_hash: completedRun.phase_b_input_hash,
      club_context_hash: completedRun.club_context_hash,
      current_club_context_hash: clubContextHash,
      club_context_changed: completedRun.club_context_hash !== clubContextHash,
      already_completed: true,
      event_count: storedEventCount,
      tracked_club_links: 0,
      ambiguous_club_anchor_count: 0,
      unmatched_club_anchor_count: 0,
      events_without_tracked_club: 0,
      writes_executed: 0,
      inserted: 0,
      refreshed: 0,
      reactivated: 0,
      unchanged: storedEventCount,
      superseded: 0,
      club_links_added: 0,
      club_links_removed: 0
    };
  }

  const extractor = options.extractor || extractEventCandidates;
  const events = extractor(article, { clubs }) || [];
  const records = await Promise.all(events.map((event) =>
    buildEventCandidateRecord(article, event, {
      sourceContentHash: article.source_content_hash || '',
      inputSource: article.content_source || 'none',
      inputHash,
      language: article.language || 'und',
      extractorVersion: EVENT_EXTRACTOR_VERSION
    })
  ));

  const [existingRows, existingClubLinks] = await Promise.all([
    loadExistingArticleEvents(db, article.id),
    loadExistingClubLinks(db, article.id)
  ]);
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const currentIds = new Set(records.map((record) => record.id));
  const statements = [];
  const stats = {
    inserted: 0,
    refreshed: 0,
    reactivated: 0,
    unchanged: 0,
    superseded: 0,
    club_links_added: 0,
    club_links_removed: 0
  };
  let ambiguousClubAnchors = 0;
  let unmatchedClubAnchors = 0;
  let trackedClubLinks = 0;
  let eventsWithoutTrackedClub = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const event = events[i];
    const existing = existingById.get(record.id);

    if (!existing) {
      statements.push(insertEventStatement(db, record));
      stats.inserted++;
    } else if (needsRefresh(existing, record)) {
      statements.push(refreshEventStatement(db, record));
      if (existing.lifecycle_status === 'active') stats.refreshed++;
      else stats.reactivated++;
    } else {
      stats.unchanged++;
    }

    const resolved = resolveTrackedClubIds(event, clubs);
    ambiguousClubAnchors += resolved.ambiguousAnchors.length;
    unmatchedClubAnchors += resolved.unmatchedAnchors.length;
    trackedClubLinks += resolved.clubIds.length;
    if (!resolved.clubIds.length) eventsWithoutTrackedClub++;
    const desired = new Set(resolved.clubIds);
    const current = existingClubLinks.get(record.id) || new Set();

    for (const clubId of desired) {
      if (current.has(clubId)) continue;
      statements.push(
        db.prepare(`
          INSERT OR IGNORE INTO event_candidate_clubs (event_id, club_id)
          VALUES (?, ?)
        `).bind(record.id, clubId)
      );
      stats.club_links_added++;
    }

    for (const clubId of current) {
      if (desired.has(clubId)) continue;
      statements.push(
        db.prepare(`
          DELETE FROM event_candidate_clubs
          WHERE event_id = ? AND club_id = ?
        `).bind(record.id, clubId)
      );
      stats.club_links_removed++;
    }
  }

  for (const existing of existingRows) {
    if (existing.lifecycle_status !== 'active' || currentIds.has(existing.id)) continue;
    statements.push(
      db.prepare(`
        UPDATE event_candidates
        SET lifecycle_status = 'superseded',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lifecycle_status = 'active'
      `).bind(existing.id)
    );
    stats.superseded++;
  }

  statements.push(
    insertArticleEventRunStatement(db, {
      article,
      processingInputHash,
      phaseBInputHash: inputHash,
      clubContextHash,
      eventCount: records.length
    })
  );

  if (statements.length) await db.batch(statements);

  return {
    article_id: article.id,
    status: 'persisted',
    persistence_version: EVENT_PERSISTENCE_VERSION,
    extractor_version: EVENT_EXTRACTOR_VERSION,
    content_source: article.content_source || 'none',
    processing_input_hash: processingInputHash,
    phase_b_input_hash: inputHash,
    club_context_hash: clubContextHash,
    current_club_context_hash: clubContextHash,
    club_context_changed: false,
    already_completed: false,
    event_count: records.length,
    tracked_club_links: trackedClubLinks,
    ambiguous_club_anchor_count: ambiguousClubAnchors,
    unmatched_club_anchor_count: unmatchedClubAnchors,
    events_without_tracked_club: eventsWithoutTrackedClub,
    writes_executed: statements.length,
    ...stats
  };
}
