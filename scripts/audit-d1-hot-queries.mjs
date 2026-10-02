import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const DB = 'DB';
const OUT_DIR = 'd1-hot-query-audit';
fs.mkdirSync(OUT_DIR, { recursive: true });

const EXTRACTOR_VERSION = 'phase-a-extractor-v1';
const RULE_VERSION = 'phase-a-relevance-v3';
const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const EMBEDDING_VERSION = 'story-event-embedding-v1';

// Each entry is a read-only SELECT that runs automatically in production.
// runsPerDay is the nominal minimum frequency. Some drain loops can execute
// their selector more than once when a queue is non-empty.
const queries = [
  {
    name: 'content_enrichment_candidates',
    path: 'github-action :15/:45',
    runsPerDay: 48,
    sql: `SELECT DISTINCT r.id, r.source_id, r.canonical_url AS url,
                 r.content_hash AS source_content_hash
          FROM article_club_assessments a
          JOIN raw_articles r
            ON r.id = a.article_id
           AND r.content_hash = a.source_content_hash
          LEFT JOIN article_content_enrichments ce ON ce.article_id = r.id
          WHERE a.rule_version = '${RULE_VERSION}'
            AND a.decision = 'relevant'
            AND (
              ce.article_id IS NULL
              OR ce.source_content_hash <> r.content_hash
              OR (
                ce.status = 'retry'
                AND (ce.retry_after IS NULL OR ce.retry_after <= CURRENT_TIMESTAMP)
              )
            )
          ORDER BY COALESCE(r.published_at, r.last_seen_at) DESC
          LIMIT 20`
  },
  {
    name: 'phase_a_candidates',
    path: 'worker cron / drainPhaseA',
    runsPerDay: 48,
    note: 'minimum; drainPhaseA may call this more than once per cron',
    sql: `SELECT r.*
          FROM raw_articles r
          WHERE r.content_hash IS NOT NULL
            AND r.processing_status IN ('raw', 'phase_a_retry')
            AND (
              NOT EXISTS (
                SELECT 1 FROM article_extractions e
                WHERE e.article_id = r.id
                  AND e.source_content_hash = r.content_hash
                  AND e.extractor_version = '${EXTRACTOR_VERSION}'
              )
              OR EXISTS (
                SELECT 1 FROM article_extractions e
                WHERE e.article_id = r.id
                  AND e.source_content_hash = r.content_hash
                  AND e.extractor_version = '${EXTRACTOR_VERSION}'
                  AND e.status = 'retry'
                  AND (e.retry_after IS NULL OR e.retry_after <= CURRENT_TIMESTAMP)
              )
              OR (
                EXISTS (
                  SELECT 1 FROM article_extractions e
                  WHERE e.article_id = r.id
                    AND e.source_content_hash = r.content_hash
                    AND e.extractor_version = '${EXTRACTOR_VERSION}'
                    AND e.status = 'completed'
                )
                AND EXISTS (
                  SELECT 1 FROM club_sources cs
                  WHERE cs.source_id = r.source_id
                    AND NOT EXISTS (
                      SELECT 1 FROM article_club_assessments a
                      WHERE a.article_id = r.id
                        AND a.club_id = cs.club_id
                        AND a.source_content_hash = r.content_hash
                        AND a.rule_version = '${RULE_VERSION}'
                    )
                )
              )
            )
          ORDER BY r.last_seen_at ASC
          LIMIT 25`
  },
  {
    name: 'phase_a_text_cleanup_candidates',
    path: 'worker cron / cleanStoredPhaseAText',
    runsPerDay: 48,
    sql: `SELECT e.id, r.source_id,
                 e.normalized_title, e.normalized_author,
                 e.normalized_excerpt, e.normalized_content
          FROM article_extractions e
          JOIN raw_articles r ON r.id = e.article_id
          WHERE e.status = 'completed'
            AND (
              e.normalized_title LIKE '%&#%' OR e.normalized_excerpt LIKE '%&#%' OR e.normalized_content LIKE '%&#%'
              OR e.normalized_title LIKE '%&amp;%' OR e.normalized_excerpt LIKE '%&amp;%' OR e.normalized_content LIKE '%&amp;%'
              OR e.normalized_title LIKE '%&rsquo;%' OR e.normalized_excerpt LIKE '%&rsquo;%' OR e.normalized_content LIKE '%&rsquo;%'
              OR e.normalized_title LIKE '%The post%' OR e.normalized_excerpt LIKE '%The post%' OR e.normalized_content LIKE '%The post%'
              OR e.normalized_title LIKE '%pour lire la suite%' OR e.normalized_excerpt LIKE '%pour lire la suite%' OR e.normalized_content LIKE '%pour lire la suite%'
              OR e.normalized_title LIKE '%Ce contenu est bloqué%' OR e.normalized_excerpt LIKE '%Ce contenu est bloqué%' OR e.normalized_content LIKE '%Ce contenu est bloqué%'
            )
            AND e.updated_at >= datetime('now', '-2 hours')
          ORDER BY e.updated_at ASC
          LIMIT 25`
  },
  {
    name: 'phase_a_text_cleanup_remaining',
    path: 'worker cron / cleanStoredPhaseAText',
    runsPerDay: 48,
    sql: `SELECT COUNT(*) AS n
          FROM article_extractions e
          WHERE e.status = 'completed'
            AND (
              e.normalized_title LIKE '%&#%' OR e.normalized_excerpt LIKE '%&#%' OR e.normalized_content LIKE '%&#%'
              OR e.normalized_title LIKE '%&amp;%' OR e.normalized_excerpt LIKE '%&amp;%' OR e.normalized_content LIKE '%&amp;%'
              OR e.normalized_title LIKE '%&rsquo;%' OR e.normalized_excerpt LIKE '%&rsquo;%' OR e.normalized_content LIKE '%&rsquo;%'
              OR e.normalized_title LIKE '%The post%' OR e.normalized_excerpt LIKE '%The post%' OR e.normalized_content LIKE '%The post%'
              OR e.normalized_title LIKE '%pour lire la suite%' OR e.normalized_excerpt LIKE '%pour lire la suite%' OR e.normalized_content LIKE '%pour lire la suite%'
              OR e.normalized_title LIKE '%Ce contenu est bloqué%' OR e.normalized_excerpt LIKE '%Ce contenu est bloqué%' OR e.normalized_content LIKE '%Ce contenu est bloqué%'
            )
            AND e.updated_at >= datetime('now', '-2 hours')`
  },
  {
    name: 'terminalize_gone_extractions',
    path: 'worker cron / repairPhaseAResiduals',
    runsPerDay: 48,
    sql: `SELECT r.id AS article_id, r.source_id, r.content_hash AS source_content_hash,
                 r.title, r.canonical_url AS url, e.id AS extraction_id, e.error_detail
          FROM article_extractions e
          JOIN raw_articles r
            ON r.id = e.article_id
           AND r.content_hash = e.source_content_hash
          WHERE e.extractor_version = '${EXTRACTOR_VERSION}'
            AND e.status = 'retry'
            AND e.error_detail IN ('HTTP 404', 'HTTP 410')
          ORDER BY e.updated_at ASC
          LIMIT 50`
  },
  {
    name: 'promote_direct_short_content',
    path: 'worker cron / repairPhaseAResiduals',
    runsPerDay: 48,
    sql: `SELECT a.article_id, a.club_id, a.source_content_hash, r.source_id, r.title
          FROM article_club_assessments a
          JOIN raw_articles r
            ON r.id = a.article_id
           AND r.content_hash = a.source_content_hash
          JOIN club_sources cs
            ON cs.source_id = r.source_id
           AND cs.club_id = a.club_id
           AND cs.relation_type = 'direct'
          WHERE a.rule_version = '${RULE_VERSION}'
            AND a.decision = 'needs_review'
            AND a.reason_code = 'insufficient_content'
          ORDER BY a.decided_at ASC
          LIMIT 50`
  },
  {
    name: 'nonfootball_review_candidates',
    path: 'worker cron / repairPhaseAResiduals',
    runsPerDay: 48,
    sql: `SELECT a.article_id, a.club_id, a.source_content_hash, a.reason_code,
                 r.source_id, r.title, r.canonical_url AS url
          FROM article_club_assessments a
          JOIN raw_articles r
            ON r.id = a.article_id
           AND r.content_hash = a.source_content_hash
          WHERE a.rule_version = '${RULE_VERSION}'
            AND a.decision = 'needs_review'
            AND a.reason_code IN (
              'strong_alias_excerpt_role_review', 'strong_alias_lead_role_review',
              'strong_alias_body_only', 'strong_alias_body_repeated',
              'weak_alias_title', 'weak_alias_excerpt', 'weak_alias_lead'
            )
          ORDER BY a.decided_at ASC
          LIMIT 100`
  },
  {
    name: 'reconcile_stale_statuses',
    path: 'worker cron / repairPhaseAResiduals (twice)',
    runsPerDay: 96,
    sql: `WITH candidates AS MATERIALIZED (
            SELECT id, content_hash, source_id, last_seen_at
            FROM raw_articles INDEXED BY idx_raw_articles_phase_a_queue
            WHERE processing_status IN ('raw', 'phase_a_retry')
          )
          SELECT r.id AS article_id, r.content_hash AS source_content_hash,
                 SUM(CASE WHEN a.decision = 'relevant' THEN 1 ELSE 0 END) AS relevant,
                 SUM(CASE WHEN a.decision = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
                 SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                 COUNT(DISTINCT cs.club_id) AS expected_clubs,
                 COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN cs.club_id END) AS assessed_clubs
          FROM candidates r
          JOIN club_sources cs ON cs.source_id = r.source_id
          JOIN clubs c ON c.id = cs.club_id AND c.active = 1
          LEFT JOIN article_club_assessments a
            ON a.article_id = r.id
           AND a.club_id = cs.club_id
           AND a.source_content_hash = r.content_hash
           AND a.rule_version = '${RULE_VERSION}'
          WHERE EXISTS (
            SELECT 1 FROM article_extractions e
            WHERE e.article_id = r.id
              AND e.source_content_hash = r.content_hash
              AND e.extractor_version = '${EXTRACTOR_VERSION}'
              AND e.status = 'completed'
          )
          GROUP BY r.id, r.content_hash, r.last_seen_at
          HAVING expected_clubs = assessed_clubs
          ORDER BY r.last_seen_at ASC
          LIMIT 100`
  },
  {
    name: 'primary_role_classifier_queue',
    path: 'worker cron / drainRoleClassifier',
    runsPerDay: 48,
    sql: `SELECT a.article_id, a.club_id, a.source_content_hash, a.reason_code,
                 r.source_id, r.title
          FROM article_club_assessments a
          JOIN raw_articles r
            ON r.id = a.article_id AND r.content_hash = a.source_content_hash
          JOIN clubs c ON c.id = a.club_id AND c.active = 1
          JOIN article_extractions e
            ON e.article_id = r.id
           AND e.source_content_hash = r.content_hash
           AND e.extractor_version = '${EXTRACTOR_VERSION}'
           AND e.status = 'completed'
          WHERE a.rule_version = '${RULE_VERSION}'
            AND a.decision = 'needs_review'
            AND a.reason_code IN ('strong_alias_excerpt_role_review','strong_alias_lead_role_review')
          ORDER BY a.decided_at ASC
          LIMIT 10`
  },
  {
    name: 'residual_role_classifier_queue',
    path: 'worker cron / repairPhaseAResiduals',
    runsPerDay: 48,
    sql: `SELECT a.article_id, a.club_id, a.source_content_hash, a.reason_code,
                 r.source_id, r.title
          FROM article_club_assessments a
          JOIN raw_articles r
            ON r.id = a.article_id AND r.content_hash = a.source_content_hash
          JOIN clubs c ON c.id = a.club_id AND c.active = 1
          JOIN article_extractions e
            ON e.article_id = r.id
           AND e.source_content_hash = r.content_hash
           AND e.extractor_version = '${EXTRACTOR_VERSION}'
           AND e.status = 'completed'
          WHERE a.rule_version = '${RULE_VERSION}'
            AND a.decision = 'needs_review'
            AND a.reason_code IN (
              'strong_alias_body_only','strong_alias_body_repeated',
              'weak_alias_title','weak_alias_excerpt','weak_alias_lead'
            )
          ORDER BY a.decided_at ASC
          LIMIT 8`
  },
  {
    name: 'remaining_residual_role_queue_count',
    path: 'worker cron / repairPhaseAResiduals',
    runsPerDay: 48,
    sql: `SELECT COUNT(*) AS n
          FROM article_club_assessments a
          JOIN raw_articles r
            ON r.id = a.article_id AND r.content_hash = a.source_content_hash
          WHERE a.rule_version = '${RULE_VERSION}'
            AND a.decision = 'needs_review'
            AND a.reason_code IN (
              'strong_alias_body_only','strong_alias_body_repeated',
              'weak_alias_title','weak_alias_excerpt','weak_alias_lead'
            )`
  },
  {
    name: 'event_persistence_queue',
    path: 'worker cron / EVENT',
    runsPerDay: 48,
    sql: `SELECT ce.article_id
          FROM article_content_enrichments ce INDEXED BY idx_content_enrichments_event_queue
          JOIN raw_articles r
            ON r.id = ce.article_id AND r.content_hash = ce.source_content_hash
          WHERE ce.status = 'completed'
            AND ce.updated_at >= datetime('now', '-72 hours')
            AND ce.content_hash IS NOT NULL
            AND ce.content_text IS NOT NULL
            AND LENGTH(TRIM(ce.content_text)) > 0
            AND EXISTS (
              SELECT 1 FROM article_club_assessments a INDEXED BY idx_article_assessments_enrichment_queue
              WHERE a.article_id = ce.article_id
                AND a.source_content_hash = ce.source_content_hash
                AND a.rule_version = '${RULE_VERSION}'
                AND a.decision = 'relevant'
            )
            AND NOT EXISTS (
              SELECT 1 FROM article_event_candidate_runs q INDEXED BY idx_article_event_runs_content_gate
              WHERE q.article_id = ce.article_id
                AND q.source_content_hash = ce.source_content_hash
                AND q.extractor_version = 'phase-b-event-extractor-v0.5'
                AND q.input_source = 'article_content_enrichments'
                AND q.input_content_hash = ce.content_hash
                AND (
                  q.status IN ('completed','failed')
                  OR (q.status='processing' AND q.lease_expires_at IS NOT NULL AND q.lease_expires_at>CURRENT_TIMESTAMP)
                  OR (q.status='retry' AND q.next_retry_at IS NOT NULL AND q.next_retry_at>CURRENT_TIMESTAMP)
                )
            )
          ORDER BY ce.updated_at ASC, ce.article_id ASC
          LIMIT 4`
  },
  {
    name: 'embedding_queue',
    path: 'worker cron / embeddings',
    runsPerDay: 48,
    sql: `SELECT e.id AS event_id, e.article_id
          FROM event_candidates e INDEXED BY idx_event_candidates_match_queue
          JOIN raw_articles r ON r.id = e.article_id
          LEFT JOIN article_extractions x
            ON x.article_id = e.article_id
           AND x.source_content_hash = e.source_content_hash
           AND x.extractor_version = '${EXTRACTOR_VERSION}'
           AND x.status = 'completed'
          WHERE e.lifecycle_status = 'active'
            AND e.match_status IN ('pending_embedding','embedding_retry','embedding_processing')
            AND (
              e.match_status='pending_embedding'
              OR (e.match_status='embedding_retry' AND (e.next_retry_at IS NULL OR e.next_retry_at<=CURRENT_TIMESTAMP))
              OR (e.match_status='embedding_processing' AND (e.lease_expires_at IS NULL OR e.lease_expires_at<=CURRENT_TIMESTAMP))
            )
          ORDER BY e.created_at ASC, e.id ASC
          LIMIT 4`
  },
  {
    name: 'story_match_queue',
    path: 'worker cron / STORY',
    runsPerDay: 48,
    sql: `SELECT e.id AS event_id, emb.id AS embedding_id
          FROM event_candidates e INDEXED BY idx_event_candidates_match_queue
          JOIN event_embeddings emb INDEXED BY idx_event_embeddings_event_ready
            ON emb.event_id=e.id
           AND emb.status='ready'
           AND emb.embedding_model='${EMBEDDING_MODEL}'
           AND emb.embedding_version='${EMBEDDING_VERSION}'
           AND emb.dimension=1024
           AND emb.encoding='float32le'
           AND emb.vector IS NOT NULL
           AND typeof(emb.vector)='blob'
          WHERE e.lifecycle_status='active'
            AND (
              e.match_status='ready_match'
              OR (e.match_status='matching_retry' AND (e.next_retry_at IS NULL OR e.next_retry_at<=CURRENT_TIMESTAMP))
              OR (e.match_status='matching' AND (e.lease_expires_at IS NULL OR e.lease_expires_at<=CURRENT_TIMESTAMP))
            )
            AND emb.id=(
              SELECT MAX(emb2.id)
              FROM event_embeddings emb2
              WHERE emb2.event_id=e.id
                AND emb2.status='ready'
                AND emb2.embedding_model=emb.embedding_model
                AND emb2.embedding_version=emb.embedding_version
                AND emb2.dimension=emb.dimension
                AND emb2.encoding=emb.encoding
                AND emb2.vector IS NOT NULL
            )
          ORDER BY e.created_at ASC, e.id ASC
          LIMIT 4`
  }
];

function parseWranglerJson(stdout) {
  const parsed = JSON.parse(stdout);
  const chunks = Array.isArray(parsed) ? parsed : [parsed];
  let rowsRead = 0;
  let rowsWritten = 0;
  let returned = 0;
  let duration = 0;
  for (const chunk of chunks) {
    const meta = chunk?.meta || {};
    rowsRead += Number(meta.rows_read || 0);
    rowsWritten += Number(meta.rows_written || 0);
    duration += Number(meta.duration || 0);
    returned += Array.isArray(chunk?.results) ? chunk.results.length : 0;
  }
  return { rowsRead, rowsWritten, returned, duration, raw: parsed };
}

function execute(sql) {
  const child = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  if (child.status !== 0) {
    throw new Error((child.stderr || child.stdout || `wrangler exit ${child.status}`).trim());
  }
  return parseWranglerJson(child.stdout);
}

const report = [];
for (const q of queries) {
  const item = { name: q.name, path: q.path, runs_per_day: q.runsPerDay, note: q.note || null };
  try {
    const result = execute(q.sql);
    item.rows_read = result.rowsRead;
    item.rows_written = result.rowsWritten;
    item.rows_returned = result.returned;
    item.duration = result.duration;
    item.projected_rows_read_per_day = result.rowsRead * q.runsPerDay;
    item.success = true;

    // EXPLAIN is intentionally run only after the measured SELECT, and its
    // rows_read is not included in the projection.
    try {
      const plan = execute(`EXPLAIN QUERY PLAN ${q.sql}`);
      item.query_plan = (Array.isArray(plan.raw) ? plan.raw : [plan.raw])
        .flatMap((chunk) => chunk?.results || []);
    } catch (error) {
      item.query_plan_error = String(error?.message || error);
    }
  } catch (error) {
    item.success = false;
    item.error = String(error?.message || error);
  }
  report.push(item);
}

report.sort((a, b) => Number(b.projected_rows_read_per_day || 0) - Number(a.projected_rows_read_per_day || 0));
fs.writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));

const successful = report.filter((r) => r.success);
const projected = successful.reduce((sum, r) => sum + Number(r.projected_rows_read_per_day || 0), 0);
const measured = successful.reduce((sum, r) => sum + Number(r.rows_read || 0), 0);

let md = '# Club Actu — D1 automatic hot-query benchmark\n\n';
md += `Measured read-only SELECTs: **${successful.length}/${report.length}**  \n`;
md += `Rows read by this one-shot benchmark: **${measured.toLocaleString('en-US')}**  \n`;
md += `Nominal projected automatic rows/day represented: **${projected.toLocaleString('en-US')}**\n\n`;
md += '> Projection = current measured rows_read × nominal executions/day. It is a diagnostic estimate, not Cloudflare billing telemetry. Drain loops can execute some selectors more often when queues are active.\n\n';
md += '| # | selector | path | rows/read | returned | nominal runs/day | projected rows/day |\n';
md += '|---:|---|---|---:|---:|---:|---:|\n';
successful.forEach((r, i) => {
  md += `| ${i + 1} | \`${r.name}\` | ${r.path} | ${Number(r.rows_read).toLocaleString('en-US')} | ${Number(r.rows_returned).toLocaleString('en-US')} | ${r.runs_per_day} | **${Number(r.projected_rows_read_per_day).toLocaleString('en-US')}** |\n`;
});

const failed = report.filter((r) => !r.success);
if (failed.length) {
  md += '\n## Failed measurements\n\n';
  for (const r of failed) md += `- **${r.name}**: ${r.error}\n`;
}

md += '\n## Query plans for the highest projected consumers\n\n';
for (const r of successful.slice(0, 8)) {
  md += `### ${r.name}\n\n`;
  if (r.note) md += `${r.note}\n\n`;
  if (r.query_plan?.length) {
    md += '```text\n';
    for (const row of r.query_plan) md += `${row.detail || JSON.stringify(row)}\n`;
    md += '```\n\n';
  } else {
    md += `_No query plan captured${r.query_plan_error ? `: ${r.query_plan_error}` : '.'}_\n\n`;
  }
}

fs.writeFileSync(`${OUT_DIR}/summary.md`, md);
process.stdout.write(md);
