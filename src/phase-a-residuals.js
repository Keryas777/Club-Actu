import {
  classifyRoleWithProvider,
  rolePreviewDecision,
  ROLE_CLASSIFIER_VERSION
} from "./relevance-role.js";

const EXTRACTOR_VERSION = "phase-a-extractor-v1";
const RULE_VERSION = "phase-a-relevance-v3";

const RESIDUAL_ROLE_REASONS = [
  "strong_alias_body_only",
  "strong_alias_body_repeated",
  "weak_alias_title",
  "weak_alias_excerpt",
  "weak_alias_lead"
];

const ALL_ROLE_QUEUE_REASONS = [
  "strong_alias_excerpt_role_review",
  "strong_alias_lead_role_review",
  ...RESIDUAL_ROLE_REASONS
];

function compactSpace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseDetail(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

export function isObviousNonFootballReview({ title = "", url = "" } = {}) {
  const normalizedTitle = compactSpace(title);
  const normalizedUrl = String(url || "").toLowerCase();

  if (/\/(?:rugby|cyclisme|basket(?:ball)?|handball|tennis|athletisme|ski)(?:\/|$)/i.test(normalizedUrl)) {
    return true;
  }

  if (
    /^(?:rugby|top 14|pro d2|ultra-trail|trail|cyclisme|basket-ball|basketball|handball|tennis|athlétisme)\b/i.test(normalizedTitle) ||
    /^lyon urban trail\b/i.test(normalizedTitle)
  ) {
    return true;
  }

  return false;
}

export function statusFromAssessmentCounts({ relevant = 0, needs_review = 0, rejected = 0 } = {}) {
  if (Number(relevant || 0) > 0) return "phase_a_ready";
  if (Number(needs_review || 0) > 0) return "phase_a_review";
  if (Number(rejected || 0) > 0) return "phase_a_rejected";
  return "phase_a_processed";
}

async function refreshArticleStatus(db, articleId, sourceContentHash) {
  const counts = await db.prepare(
    `SELECT
       SUM(CASE WHEN decision = 'relevant' THEN 1 ELSE 0 END) AS relevant,
       SUM(CASE WHEN decision = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
       SUM(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END) AS rejected
     FROM article_club_assessments
     WHERE article_id = ?
       AND source_content_hash = ?
       AND rule_version = ?`
  ).bind(articleId, sourceContentHash, RULE_VERSION).first();

  const status = statusFromAssessmentCounts(counts || {});
  await db.prepare(
    `UPDATE raw_articles
     SET processing_status = ?
     WHERE id = ? AND processing_status <> ?`
  ).bind(status, articleId, status).run();
  return status;
}

async function saveRoleClassification(db, row, classification) {
  const now = new Date().toISOString();
  const status = classification?.error ? "error" : "completed";

  await db.prepare(
    `INSERT INTO article_club_role_classifications
      (article_id, club_id, source_content_hash, classifier_version,
       status, role, confidence, rationale, provider_model, attempts,
       error_code, error_detail, classified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id, club_id, source_content_hash, classifier_version) DO UPDATE SET
       status = excluded.status,
       role = excluded.role,
       confidence = excluded.confidence,
       rationale = excluded.rationale,
       provider_model = excluded.provider_model,
       attempts = excluded.attempts,
       error_code = excluded.error_code,
       error_detail = excluded.error_detail,
       classified_at = excluded.classified_at,
       updated_at = excluded.updated_at`
  ).bind(
    row.article_id,
    row.club_id,
    row.source_content_hash,
    ROLE_CLASSIFIER_VERSION,
    status,
    classification?.role || null,
    Number.isFinite(classification?.confidence) ? classification.confidence : null,
    classification?.rationale || null,
    classification?.model || null,
    Number.isFinite(classification?.attempts) ? classification.attempts : null,
    classification?.error || null,
    classification?.detail || null,
    status === "completed" ? now : null,
    now,
    now
  ).run();
}

function roleAssessmentDetail(row, classification) {
  const detail = parseDetail(row.reason_detail);
  return JSON.stringify({
    ...detail,
    role_classifier: {
      version: ROLE_CLASSIFIER_VERSION,
      model: classification.model || null,
      role: classification.role,
      confidence: classification.confidence,
      rationale: classification.rationale,
      attempts: classification.attempts || 1
    }
  });
}

async function terminalizeGoneExtractions(db, limit = 50) {
  const { results } = await db.prepare(
    `SELECT r.id AS article_id, r.source_id, r.content_hash AS source_content_hash,
            r.title, r.canonical_url AS url, e.id AS extraction_id,
            e.error_detail
     FROM article_extractions e
     JOIN raw_articles r
       ON r.id = e.article_id
      AND r.content_hash = e.source_content_hash
     WHERE e.extractor_version = ?
       AND e.status = 'retry'
       AND e.error_detail IN ('HTTP 404', 'HTTP 410')
     ORDER BY e.updated_at ASC
     LIMIT ?`
  ).bind(EXTRACTOR_VERSION, limit).all();

  let terminalized = 0;
  const examples = [];
  for (const row of results || []) {
    const now = new Date().toISOString();
    await db.prepare(
      `UPDATE article_extractions
       SET status = 'completed',
           error_code = 'source_unavailable',
           retry_after = NULL,
           extracted_at = COALESCE(extracted_at, ?),
           updated_at = ?
       WHERE id = ?`
    ).bind(now, now, row.extraction_id).run();

    const { results: clubs } = await db.prepare(
      `SELECT cs.club_id
       FROM club_sources cs
       JOIN clubs c ON c.id = cs.club_id AND c.active = 1
       WHERE cs.source_id = ?`
    ).bind(row.source_id).all();

    for (const club of clubs || []) {
      await db.prepare(
        `INSERT INTO article_club_assessments
          (article_id, club_id, source_content_hash, rule_version,
           decision, reason_code, reason_detail, decided_at)
         VALUES (?, ?, ?, ?, 'rejected', 'source_unavailable', ?, ?)
         ON CONFLICT(article_id, club_id, source_content_hash, rule_version) DO UPDATE SET
           decision = 'rejected',
           reason_code = 'source_unavailable',
           reason_detail = excluded.reason_detail,
           decided_at = excluded.decided_at`
      ).bind(
        row.article_id,
        club.club_id,
        row.source_content_hash,
        RULE_VERSION,
        JSON.stringify({ http_error: row.error_detail }),
        now
      ).run();
    }

    await refreshArticleStatus(db, row.article_id, row.source_content_hash);
    terminalized++;
    if (examples.length < 8) {
      examples.push({
        article_id: row.article_id,
        source_id: row.source_id,
        title: row.title,
        url: row.url,
        error: row.error_detail
      });
    }
  }

  return { terminalized, examples };
}

async function promoteDirectShortContent(db, limit = 50) {
  const { results } = await db.prepare(
    `SELECT a.article_id, a.club_id, a.source_content_hash, r.source_id, r.title
     FROM article_club_assessments a
     JOIN raw_articles r
       ON r.id = a.article_id
      AND r.content_hash = a.source_content_hash
     JOIN club_sources cs
       ON cs.source_id = r.source_id
      AND cs.club_id = a.club_id
      AND cs.relation_type = 'direct'
     WHERE a.rule_version = ?
       AND a.decision = 'needs_review'
       AND a.reason_code = 'insufficient_content'
     ORDER BY a.decided_at ASC
     LIMIT ?`
  ).bind(RULE_VERSION, limit).all();

  let promoted = 0;
  const examples = [];
  for (const row of results || []) {
    const now = new Date().toISOString();
    await db.prepare(
      `UPDATE article_club_assessments
       SET decision = 'relevant',
           reason_code = 'direct_club_source',
           reason_detail = ?,
           decided_at = ?
       WHERE article_id = ?
         AND club_id = ?
         AND source_content_hash = ?
         AND rule_version = ?`
    ).bind(
      JSON.stringify({ repaired_from: "insufficient_content", relation_type: "direct" }),
      now,
      row.article_id,
      row.club_id,
      row.source_content_hash,
      RULE_VERSION
    ).run();
    await refreshArticleStatus(db, row.article_id, row.source_content_hash);
    promoted++;
    if (examples.length < 8) {
      examples.push({ article_id: row.article_id, club_id: row.club_id, source_id: row.source_id, title: row.title });
    }
  }

  return { promoted, examples };
}

async function rejectObviousNonFootballReviews(db, limit = 100) {
  const placeholders = ALL_ROLE_QUEUE_REASONS.map(() => "?").join(", ");
  const { results } = await db.prepare(
    `SELECT a.article_id, a.club_id, a.source_content_hash, a.reason_code,
            r.source_id, r.title, r.canonical_url AS url
     FROM article_club_assessments a
     JOIN raw_articles r
       ON r.id = a.article_id
      AND r.content_hash = a.source_content_hash
     WHERE a.rule_version = ?
       AND a.decision = 'needs_review'
       AND a.reason_code IN (${placeholders})
     ORDER BY a.decided_at ASC
     LIMIT ?`
  ).bind(RULE_VERSION, ...ALL_ROLE_QUEUE_REASONS, limit).all();

  let rejected = 0;
  const examples = [];
  for (const row of results || []) {
    if (!isObviousNonFootballReview(row)) continue;
    const now = new Date().toISOString();
    await db.prepare(
      `UPDATE article_club_assessments
       SET decision = 'rejected',
           reason_code = 'non_football_context',
           reason_detail = ?,
           decided_at = ?
       WHERE article_id = ?
         AND club_id = ?
         AND source_content_hash = ?
         AND rule_version = ?`
    ).bind(
      JSON.stringify({ repaired_from: row.reason_code }),
      now,
      row.article_id,
      row.club_id,
      row.source_content_hash,
      RULE_VERSION
    ).run();
    await refreshArticleStatus(db, row.article_id, row.source_content_hash);
    rejected++;
    if (examples.length < 8) {
      examples.push({ article_id: row.article_id, club_id: row.club_id, source_id: row.source_id, title: row.title, url: row.url });
    }
  }

  return { rejected, examples };
}

async function reconcileStaleStatuses(db, limit = 100) {
  const { results } = await db.prepare(
    `SELECT r.id AS article_id, r.content_hash AS source_content_hash,
            SUM(CASE WHEN a.decision = 'relevant' THEN 1 ELSE 0 END) AS relevant,
            SUM(CASE WHEN a.decision = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
            SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS rejected,
            COUNT(DISTINCT cs.club_id) AS expected_clubs,
            COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN cs.club_id END) AS assessed_clubs
     FROM raw_articles r
     JOIN article_extractions e
       ON e.article_id = r.id
      AND e.source_content_hash = r.content_hash
      AND e.extractor_version = ?
      AND e.status = 'completed'
     JOIN club_sources cs ON cs.source_id = r.source_id
     JOIN clubs c ON c.id = cs.club_id AND c.active = 1
     LEFT JOIN article_club_assessments a
       ON a.article_id = r.id
      AND a.club_id = cs.club_id
      AND a.source_content_hash = r.content_hash
      AND a.rule_version = ?
     WHERE r.processing_status IN ('raw', 'phase_a_retry')
     GROUP BY r.id, r.content_hash
     HAVING expected_clubs = assessed_clubs
     ORDER BY r.last_seen_at ASC
     LIMIT ?`
  ).bind(EXTRACTOR_VERSION, RULE_VERSION, limit).all();

  let reconciled = 0;
  for (const row of results || []) {
    const status = statusFromAssessmentCounts(row);
    const change = await db.prepare(
      `UPDATE raw_articles
       SET processing_status = ?
       WHERE id = ? AND processing_status <> ?`
    ).bind(status, row.article_id, status).run();
    if (Number(change?.meta?.changes || 0) > 0) reconciled++;
  }

  return { reconciled, scanned: (results || []).length };
}

async function loadResidualRoleCandidates(db, limit) {
  const placeholders = RESIDUAL_ROLE_REASONS.map(() => "?").join(", ");
  const { results } = await db.prepare(
    `SELECT a.article_id, a.club_id, a.source_content_hash,
            a.reason_code, a.reason_detail,
            r.source_id, r.title, r.canonical_url AS url,
            c.name AS club_name,
            e.normalized_title, e.normalized_excerpt, e.normalized_content
     FROM article_club_assessments a
     JOIN raw_articles r
       ON r.id = a.article_id
      AND r.content_hash = a.source_content_hash
     JOIN clubs c ON c.id = a.club_id AND c.active = 1
     JOIN article_extractions e
       ON e.article_id = r.id
      AND e.source_content_hash = r.content_hash
      AND e.extractor_version = ?
      AND e.status = 'completed'
     WHERE a.rule_version = ?
       AND a.decision = 'needs_review'
       AND a.reason_code IN (${placeholders})
     ORDER BY a.decided_at ASC
     LIMIT ?`
  ).bind(EXTRACTOR_VERSION, RULE_VERSION, ...RESIDUAL_ROLE_REASONS, limit).all();
  return results || [];
}

async function getAliases(db, clubId) {
  const { results } = await db.prepare(
    `SELECT alias
     FROM club_aliases
     WHERE club_id = ?
     ORDER BY CASE strength WHEN 'strong' THEN 0 ELSE 1 END, length(alias) DESC`
  ).bind(clubId).all();
  return (results || []).map((row) => row.alias);
}

async function drainResidualRoleClassifier(db, env, options = {}) {
  const maxItems = Math.max(1, Math.min(12, Number(options.maxItems || 8)));
  const maxDurationMs = Math.max(5000, Number(options.maxDurationMs || 40000));
  const interRequestDelayMs = Math.max(0, Number(options.interRequestDelayMs ?? 4000));
  const startedAtMs = Date.now();
  const rows = await loadResidualRoleCandidates(db, maxItems);
  const totals = { candidates: rows.length, processed: 0, relevant: 0, rejected: 0, needs_review: 0, errors: 0 };
  const examples = [];
  let lastRequestAt = 0;
  let stopReason = rows.length ? "drained" : "empty";

  for (const row of rows) {
    if (Date.now() - startedAtMs >= maxDurationMs) {
      stopReason = "time_guard";
      break;
    }

    const elapsed = Date.now() - lastRequestAt;
    if (lastRequestAt && elapsed < interRequestDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, interRequestDelayMs - elapsed));
    }

    const detail = parseDetail(row.reason_detail);
    const aliases = await getAliases(db, row.club_id);
    const input = {
      club_id: row.club_id,
      club_name: row.club_name,
      aliases,
      title: row.normalized_title || row.title || "",
      excerpt: row.normalized_excerpt || "",
      lead: compactSpace(row.normalized_content || "").slice(0, 900),
      matched_alias: detail.matched_alias || null,
      matched_field: detail.matched_field || null,
      match_context: detail.match_context || null
    };

    const classification = await classifyRoleWithProvider(env, input);
    lastRequestAt = Date.now();
    await saveRoleClassification(db, row, classification);

    if (classification.error) {
      totals.errors++;
      totals.needs_review++;
      if (examples.length < 8) {
        examples.push({
          article_id: row.article_id,
          club_id: row.club_id,
          title: row.title,
          reason_code: row.reason_code,
          status: "needs_review",
          error: classification.error
        });
      }
      continue;
    }

    const resolved = rolePreviewDecision(classification);
    const now = new Date().toISOString();
    await db.prepare(
      `UPDATE article_club_assessments
       SET decision = ?, reason_code = ?, reason_detail = ?, decided_at = ?
       WHERE article_id = ?
         AND club_id = ?
         AND source_content_hash = ?
         AND rule_version = ?`
    ).bind(
      resolved.decision,
      resolved.reason_code,
      roleAssessmentDetail(row, classification),
      now,
      row.article_id,
      row.club_id,
      row.source_content_hash,
      RULE_VERSION
    ).run();

    await refreshArticleStatus(db, row.article_id, row.source_content_hash);
    totals.processed++;
    if (resolved.decision === "relevant") totals.relevant++;
    else if (resolved.decision === "rejected") totals.rejected++;
    else totals.needs_review++;

    if (examples.length < 8) {
      examples.push({
        article_id: row.article_id,
        club_id: row.club_id,
        title: row.title,
        previous_reason_code: row.reason_code,
        role: classification.role,
        confidence: classification.confidence,
        decision: resolved.decision
      });
    }
  }

  return {
    classifier_version: ROLE_CLASSIFIER_VERSION,
    stop_reason: stopReason,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date().toISOString(),
    ...totals,
    examples
  };
}

export async function getResidualQueueStatus(db) {
  const placeholders = RESIDUAL_ROLE_REASONS.map(() => "?").join(", ");
  const row = await db.prepare(
    `SELECT COUNT(*) AS n
     FROM article_club_assessments a
     JOIN raw_articles r
       ON r.id = a.article_id
      AND r.content_hash = a.source_content_hash
     WHERE a.rule_version = ?
       AND a.decision = 'needs_review'
       AND a.reason_code IN (${placeholders})`
  ).bind(RULE_VERSION, ...RESIDUAL_ROLE_REASONS).first();
  return Number(row?.n || 0);
}

export async function repairPhaseAResiduals(db, env, options = {}) {
  const terminal = await terminalizeGoneExtractions(db, options.terminalLimit || 50);
  const direct = await promoteDirectShortContent(db, options.directLimit || 50);
  const nonFootball = await rejectObviousNonFootballReviews(db, options.reviewScanLimit || 100);
  const staleBefore = await reconcileStaleStatuses(db, options.staleLimit || 100);
  const roles = await drainResidualRoleClassifier(db, env, {
    maxItems: options.maxRoleItems || 8,
    maxDurationMs: options.maxDurationMs || 40000,
    interRequestDelayMs: options.interRequestDelayMs ?? 4000
  });
  const staleAfter = await reconcileStaleStatuses(db, options.staleLimit || 100);
  const remainingRoleQueue = await getResidualQueueStatus(db);

  return {
    rule_version: RULE_VERSION,
    extractor_version: EXTRACTOR_VERSION,
    terminal,
    direct,
    non_football: nonFootball,
    stale_before: staleBefore,
    roles,
    stale_after: staleAfter,
    remaining_role_queue: remainingRoleQueue
  };
}

export async function getPhaseAClosureStatusFixed(db) {
  const clubs = ["ol", "psg", "om"];
  const byClub = {};
  const allQueuePlaceholders = ALL_ROLE_QUEUE_REASONS.map(() => "?").join(", ");
  const now = new Date().toISOString();

  for (const clubId of clubs) {
    const counts = await db.prepare(
      `SELECT
         SUM(CASE WHEN a.decision = 'relevant' THEN 1 ELSE 0 END) AS relevant,
         SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN a.decision = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
         SUM(CASE WHEN a.decision = 'needs_review' AND a.reason_code IN (${allQueuePlaceholders}) THEN 1 ELSE 0 END) AS role_queue_pending
       FROM article_club_assessments a
       JOIN raw_articles r ON r.id = a.article_id AND r.content_hash = a.source_content_hash
       WHERE a.club_id = ?
         AND a.rule_version = ?`
    ).bind(...ALL_ROLE_QUEUE_REASONS, clubId, RULE_VERSION).first();

    const extraction = await db.prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN e.status = 'retry' THEN r.id END) AS retry,
         COUNT(DISTINCT CASE WHEN e.status = 'failed' THEN r.id END) AS failed
       FROM raw_articles r
       JOIN club_sources cs ON cs.source_id = r.source_id AND cs.club_id = ?
       JOIN article_extractions e
         ON e.article_id = r.id
        AND e.source_content_hash = r.content_hash
        AND e.extractor_version = ?
       WHERE r.content_hash IS NOT NULL`
    ).bind(clubId, EXTRACTOR_VERSION).first();

    const waiting = await db.prepare(
      `SELECT COUNT(DISTINCT r.id) AS n
       FROM raw_articles r
       JOIN club_sources cs
         ON cs.source_id = r.source_id
        AND cs.club_id = ?
       WHERE r.content_hash IS NOT NULL
         AND (
           NOT EXISTS (
             SELECT 1 FROM article_extractions e
             WHERE e.article_id = r.id
               AND e.source_content_hash = r.content_hash
               AND e.extractor_version = ?
           )
           OR EXISTS (
             SELECT 1 FROM article_extractions e
             WHERE e.article_id = r.id
               AND e.source_content_hash = r.content_hash
               AND e.extractor_version = ?
               AND e.status = 'retry'
               AND (e.retry_after IS NULL OR e.retry_after <= ?)
           )
           OR (
             EXISTS (
               SELECT 1 FROM article_extractions e
               WHERE e.article_id = r.id
                 AND e.source_content_hash = r.content_hash
                 AND e.extractor_version = ?
                 AND e.status = 'completed'
             )
             AND NOT EXISTS (
               SELECT 1 FROM article_club_assessments a
               WHERE a.article_id = r.id
                 AND a.club_id = ?
                 AND a.source_content_hash = r.content_hash
                 AND a.rule_version = ?
             )
           )
         )`
    ).bind(clubId, EXTRACTOR_VERSION, EXTRACTOR_VERSION, now, EXTRACTOR_VERSION, clubId, RULE_VERSION).first();

    const roleErrors = await db.prepare(
      `SELECT COUNT(*) AS n
       FROM article_club_assessments a
       JOIN raw_articles r ON r.id = a.article_id AND r.content_hash = a.source_content_hash
       WHERE a.club_id = ?
         AND a.rule_version = ?
         AND a.decision = 'needs_review'
         AND a.reason_code IN (${allQueuePlaceholders})
         AND EXISTS (
           SELECT 1 FROM article_club_role_classifications rc
           WHERE rc.article_id = a.article_id
             AND rc.club_id = a.club_id
             AND rc.source_content_hash = a.source_content_hash
             AND rc.classifier_version = ?
             AND rc.status = 'error'
         )`
    ).bind(clubId, RULE_VERSION, ...ALL_ROLE_QUEUE_REASONS, ROLE_CLASSIFIER_VERSION).first();

    const { results: reviewReasons } = await db.prepare(
      `SELECT COALESCE(a.reason_code, 'unspecified') AS reason_code, COUNT(*) AS count
       FROM article_club_assessments a
       JOIN raw_articles r ON r.id = a.article_id AND r.content_hash = a.source_content_hash
       WHERE a.club_id = ?
         AND a.rule_version = ?
         AND a.decision = 'needs_review'
       GROUP BY COALESCE(a.reason_code, 'unspecified')
       ORDER BY count DESC, reason_code ASC`
    ).bind(clubId, RULE_VERSION).all();

    const retry = Number(extraction?.retry || 0);
    const failed = Number(extraction?.failed || 0);
    const waitingCount = Number(waiting?.n || 0);
    const roleQueuePending = Number(counts?.role_queue_pending || 0);
    const roleClassifierErrors = Number(roleErrors?.n || 0);

    byClub[clubId] = {
      status: retry || failed || waitingCount || roleQueuePending || roleClassifierErrors ? "attention" : "ok",
      relevant: Number(counts?.relevant || 0),
      rejected: Number(counts?.rejected || 0),
      needs_review: Number(counts?.needs_review || 0),
      retry,
      failed,
      waiting: waitingCount,
      role_queue_pending: roleQueuePending,
      role_classifier_errors: roleClassifierErrors,
      review_reasons: reviewReasons || []
    };
  }

  return {
    clubs: byClub,
    semantics: {
      waiting: "actionable current extraction/assessment backlog only",
      residual_review: "low-confidence or unclear reviews may remain without blocking closure once role_queue_pending is zero"
    }
  };
}
