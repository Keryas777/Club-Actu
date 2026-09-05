import {
  EVENT_EXTRACTOR_VERSION,
  extractEventCandidates
} from './phase-b-events.js';

/**
 * Phase B preview read-path after Phase A.4.
 *
 * Prefer the globally enriched full article body when it is completed for the
 * current raw_articles.content_hash. Keep the historical normalized/raw body
 * fields only as safe fallbacks while the enrichment backfill is progressing.
 *
 * This module is deliberately read-only: no Phase A state, hashes or decisions
 * are mutated here.
 */
export async function getPhaseBEventPreview(db, clubId = 'ol', articleLimit = 60, articleId = null) {
  const { results: aliases } = await db.prepare(
    'SELECT club_id, alias, strength FROM club_aliases'
  ).all();

  const clubMap = new Map();
  for (const row of aliases || []) {
    if (!clubMap.has(row.club_id)) {
      clubMap.set(row.club_id, {
        id: row.club_id,
        name: row.club_id.toUpperCase(),
        aliases: []
      });
    }
    clubMap.get(row.club_id).aliases.push(row.alias);
  }

  const articleFilter = articleId ? 'AND r.id = ?' : '';
  const bindings = articleId
    ? [clubId, articleId, 1]
    : [clubId, articleLimit];

  const sql = `
    SELECT
      r.id,
      r.source_id,
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
    FROM article_club_assessments a
    JOIN raw_articles r
      ON r.id = a.article_id
    JOIN article_extractions e
      ON e.article_id = r.id
     AND e.source_content_hash = r.content_hash
     AND e.extractor_version = 'phase-a-extractor-v1'
     AND e.status = 'completed'
    LEFT JOIN article_content_enrichments ce
      ON ce.article_id = r.id
     AND ce.source_content_hash = r.content_hash
     AND ce.status = 'completed'
    WHERE a.club_id = ?
      AND a.decision = 'relevant'
      AND a.source_content_hash = r.content_hash
      AND a.rule_version = 'phase-a-relevance-v3'
      ${articleFilter}
    ORDER BY COALESCE(e.normalized_published_at, r.published_at, r.last_seen_at) DESC
    LIMIT ?
  `;

  const { results: articles } = await db.prepare(sql).bind(...bindings).all();
  const context = { clubs: [...clubMap.values()] };

  const rows = (articles || []).map((article) => ({
    article: {
      id: article.id,
      source_id: article.source_id,
      title: article.title,
      published_at: article.published_at,
      content_source: article.content_source
    },
    events: extractEventCandidates(article, context)
  }));

  const familyCounts = new Map();
  const evidenceKinds = new Map();
  const contentSources = new Map();
  const eventCountDistribution = {};
  let zero = 0;
  let one = 0;
  let multi = 0;
  let total = 0;
  let unknown = 0;
  let missingPeople = 0;
  let missingClubs = 0;
  let leadEvents = 0;
  let bodyEvents = 0;

  for (const row of rows) {
    const source = row.article.content_source || 'none';
    contentSources.set(source, (contentSources.get(source) || 0) + 1);

    const n = row.events.length;
    eventCountDistribution[n] = (eventCountDistribution[n] || 0) + 1;
    if (n === 0) zero++;
    else if (n === 1) one++;
    else multi++;
    total += n;

    for (const event of row.events) {
      familyCounts.set(event.family, (familyCounts.get(event.family) || 0) + 1);
      evidenceKinds.set(event.evidence.kind, (evidenceKinds.get(event.evidence.kind) || 0) + 1);
      if (event.evidence.kind === 'lead') leadEvents++;
      else bodyEvents++;
      if (event.family === 'unknown') unknown++;
      if (!event.primary_people.length) missingPeople++;
      if (!event.primary_clubs.length) missingClubs++;
    }
  }

  return {
    version: EVENT_EXTRACTOR_VERSION,
    content_read_path: 'phase-a-4-full-content-v1',
    club_id: clubId,
    article_id: articleId || null,
    article_count: rows.length,
    event_count: total,
    articles_with_0_events: zero,
    articles_with_1_event: one,
    articles_with_multiple_events: multi,
    multi_event_rate: rows.length ? multi / rows.length : 0,
    unknown_family_rate: total ? unknown / total : 0,
    events_without_primary_people: missingPeople,
    events_without_primary_clubs: missingClubs,
    lead_event_count: leadEvents,
    body_event_count: bodyEvents,
    body_event_rate: total ? bodyEvents / total : 0,
    content_source_distribution: Object.fromEntries(
      [...contentSources.entries()].sort((a, b) => b[1] - a[1])
    ),
    family_distribution: Object.fromEntries(
      [...familyCounts.entries()].sort((a, b) => b[1] - a[1])
    ),
    evidence_kind_distribution: Object.fromEntries(
      [...evidenceKinds.entries()].sort((a, b) => b[1] - a[1])
    ),
    events_per_article_distribution: eventCountDistribution,
    articles: rows
  };
}
