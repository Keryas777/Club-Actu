import { collectAll, repairMojibake, normalizeStoredEntities } from "./collector.js";
import { drainPhaseA, drainRoleClassifier, getProcessingDiagnostics, getRelevanceAudit, getRelevanceV3Preview, runRoleClassifierPreview } from "./processor.js";
import { getPhaseBPreview } from "./grouper.js";
import { cleanEditorialText } from "./text-cleanup.js";

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

function parseLimit(url, fallback = 25, max = 100) {
  const n = Number(url.searchParams.get("limit") || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function knownNoiseSql(alias = "e") {
  const fields = ["normalized_title", "normalized_excerpt", "normalized_content"];
  const patterns = [
    "%&#%",
    "%&amp;%",
    "%&rsquo;%",
    "%&lsquo;%",
    "%&rdquo;%",
    "%&ldquo;%",
    "%&hellip;%",
    "%&ndash;%",
    "%&mdash;%",
    "%&eacute;%",
    "%&egrave;%",
    "%&agrave;%",
    "%&ccedil;%",
    "%The post%first appeared on But! Football Club%",
    "%pour lire la suite, rejoignez notre communauté d'abonnés%",
    "%Ce contenu est bloqué car vous n'avez pas accepté les cookies%",
    "%{'skus':%"
  ];

  const clauses = [];
  const bindings = [];
  for (const field of fields) {
    for (const pattern of patterns) {
      clauses.push(`${alias}.${field} LIKE ?`);
      bindings.push(pattern);
    }
  }
  return { sql: `(${clauses.join(" OR ")})`, bindings };
}

async function cleanStoredPhaseAText(db, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit || 25)));
  const historical = Boolean(options.historical);
  const noise = knownNoiseSql("e");
  const recentClause = historical ? "" : " AND e.updated_at >= ?";
  const recentBinding = historical
    ? []
    : [new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()];

  const { results } = await db.prepare(
    `SELECT e.id, r.source_id,
            e.normalized_title, e.normalized_author,
            e.normalized_excerpt, e.normalized_content
     FROM article_extractions e
     JOIN raw_articles r ON r.id = e.article_id
     WHERE e.status = 'completed'
       AND ${noise.sql}
       ${recentClause}
     ORDER BY e.updated_at ASC
     LIMIT ?`
  ).bind(...noise.bindings, ...recentBinding, limit).all();

  let updated = 0;
  const examples = [];
  for (const row of results || []) {
    const title = cleanEditorialText(row.normalized_title, row.source_id) || null;
    const author = cleanEditorialText(row.normalized_author, row.source_id) || null;
    const excerpt = cleanEditorialText(row.normalized_excerpt, row.source_id) || null;
    const content = cleanEditorialText(row.normalized_content, row.source_id) || null;

    if (
      title === row.normalized_title &&
      author === row.normalized_author &&
      excerpt === row.normalized_excerpt &&
      content === row.normalized_content
    ) {
      continue;
    }

    await db.prepare(
      `UPDATE article_extractions
       SET normalized_title = ?, normalized_author = ?,
           normalized_excerpt = ?, normalized_content = ?, updated_at = ?
       WHERE id = ?`
    ).bind(title, author, excerpt, content, new Date().toISOString(), row.id).run();
    updated++;

    if (examples.length < 8) {
      examples.push({ id: row.id, source_id: row.source_id, title });
    }
  }

  const remainingRow = await db.prepare(
    `SELECT COUNT(*) AS n
     FROM article_extractions e
     WHERE e.status = 'completed'
       AND ${noise.sql}
       ${recentClause}`
  ).bind(...noise.bindings, ...recentBinding).first();

  return {
    historical,
    scanned: (results || []).length,
    updated,
    remaining: Number(remainingRow?.n || 0),
    examples
  };
}

async function getPhaseAClosureStatus(db) {
  const clubs = ["ol", "psg", "om"];
  const byClub = {};

  for (const clubId of clubs) {
    const counts = await db.prepare(
      `SELECT
         SUM(CASE WHEN a.decision = 'relevant' THEN 1 ELSE 0 END) AS relevant,
         SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN a.decision = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
         SUM(CASE WHEN a.decision = 'needs_review' AND a.reason_code IN (
           'strong_alias_excerpt_role_review', 'strong_alias_lead_role_review'
         ) THEN 1 ELSE 0 END) AS role_queue_pending
       FROM article_club_assessments a
       JOIN raw_articles r ON r.id = a.article_id AND r.content_hash = a.source_content_hash
       WHERE a.club_id = ?
         AND a.rule_version = 'phase-a-relevance-v3'`
    ).bind(clubId).first();

    const extraction = await db.prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN e.status = 'retry' THEN r.id END) AS retry,
         COUNT(DISTINCT CASE WHEN e.status = 'failed' THEN r.id END) AS failed
       FROM raw_articles r
       JOIN club_sources cs ON cs.source_id = r.source_id AND cs.club_id = ?
       JOIN article_extractions e
         ON e.article_id = r.id
        AND e.source_content_hash = r.content_hash
       WHERE r.content_hash IS NOT NULL`
    ).bind(clubId).first();

    const waiting = await db.prepare(
      `SELECT COUNT(DISTINCT r.id) AS n
       FROM raw_articles r
       JOIN club_sources cs ON cs.source_id = r.source_id AND cs.club_id = ?
       WHERE r.processing_status IN ('raw', 'phase_a_retry')`
    ).bind(clubId).first();

    const roleErrors = await db.prepare(
      `SELECT COUNT(*) AS n
       FROM article_club_assessments a
       JOIN raw_articles r ON r.id = a.article_id AND r.content_hash = a.source_content_hash
       WHERE a.club_id = ?
         AND a.rule_version = 'phase-a-relevance-v3'
         AND a.decision = 'needs_review'
         AND a.reason_code IN ('strong_alias_excerpt_role_review', 'strong_alias_lead_role_review')
         AND EXISTS (
           SELECT 1
           FROM article_club_role_classifications rc
           WHERE rc.article_id = a.article_id
             AND rc.club_id = a.club_id
             AND rc.source_content_hash = a.source_content_hash
             AND rc.status = 'error'
         )`
    ).bind(clubId).first();

    const { results: reviewReasons } = await db.prepare(
      `SELECT COALESCE(a.reason_code, 'unspecified') AS reason_code, COUNT(*) AS count
       FROM article_club_assessments a
       JOIN raw_articles r ON r.id = a.article_id AND r.content_hash = a.source_content_hash
       WHERE a.club_id = ?
         AND a.rule_version = 'phase-a-relevance-v3'
         AND a.decision = 'needs_review'
       GROUP BY COALESCE(a.reason_code, 'unspecified')
       ORDER BY count DESC, reason_code ASC`
    ).bind(clubId).all();

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

  const noise = knownNoiseSql("e");
  const noisyTotal = await db.prepare(
    `SELECT COUNT(*) AS n
     FROM article_extractions e
     WHERE e.status = 'completed' AND ${noise.sql}`
  ).bind(...noise.bindings).first();

  const { results: noisyBySource } = await db.prepare(
    `SELECT r.source_id, COUNT(*) AS count
     FROM article_extractions e
     JOIN raw_articles r ON r.id = e.article_id
     WHERE e.status = 'completed' AND ${noise.sql}
     GROUP BY r.source_id
     ORDER BY count DESC, r.source_id ASC`
  ).bind(...noise.bindings).all();

  return {
    clubs: byClub,
    text_cleanup: {
      known_noise_remaining: Number(noisyTotal?.n || 0),
      by_source: noisyBySource || []
    }
  };
}

async function handleApi(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });

  if (url.pathname === "/api/debug/encoding" && request.method === "GET") {
    const samples = [
      "entraÃ®neur",
      "lâ€™Ã¨re",
      "rÃ©cente",
      "dâ€™innover"
    ];

    return json({
      ok: true,
      samples: samples.map((input) => {
        const output = repairMojibake(input);
        return {
          input,
          output,
          input_codepoints: [...input].map((c) => c.codePointAt(0).toString(16)),
          output_codepoints: [...output].map((c) => c.codePointAt(0).toString(16))
        };
      })
    });
  }

  if (url.pathname === "/api/collection-audit" && request.method === "GET") {
    const limit = parseLimit(url, 20, 100);

    const latestRun = await env.DB.prepare(
      `SELECT id, started_at, finished_at, status, notes
       FROM collection_runs
       ORDER BY started_at DESC
       LIMIT 1`
    ).first();

    let details = [];
    try {
      details = latestRun?.notes ? JSON.parse(latestRun.notes) : [];
    } catch {
      details = [];
    }

    const { results: recent } = await env.DB.prepare(
      `SELECT source_id, canonical_url AS url, title, first_seen_at, last_seen_at
       FROM raw_articles
       ORDER BY last_seen_at DESC
       LIMIT ?`
    ).bind(limit).all();

    const { results: suspicious } = await env.DB.prepare(
      `SELECT source_id, canonical_url AS url, title, last_seen_at
       FROM raw_articles
       WHERE
         lower(title) IN ('se connecter','connexion','accueil','calendrier','classement')
         OR lower(title) LIKE 'calendrier%'
         OR lower(title) LIKE 'classement%'
         OR lower(canonical_url) LIKE '%/login%'
         OR lower(canonical_url) LIKE '%/connexion%'
         OR lower(canonical_url) LIKE '%/calendrier%'
         OR lower(canonical_url) LIKE '%/classement%'
       ORDER BY last_seen_at DESC
       LIMIT 100`
    ).all();

    return json({
      ok: true,
      latest_run: latestRun ? {
        id: latestRun.id,
        started_at: latestRun.started_at,
        finished_at: latestRun.finished_at,
        status: latestRun.status,
        source_details: details
      } : null,
      recent_articles: recent,
      suspicious_legacy_rows: suspicious
    });
  }

  if (url.pathname === "/api/normalize-stored-text" && request.method === "POST") {
    if (!env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
    }

    const token = bearerToken(request);
    if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const result = await normalizeStoredEntities(env.DB, 100);
    return json({ ok: true, trigger: "normalize_stored_text", ...result });
  }

  if (url.pathname === "/api/clean-phase-a-text" && request.method === "POST") {
    if (!env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
    }

    const token = bearerToken(request);
    if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const historical = ["1", "true", "yes"].includes(
      (url.searchParams.get("historical") || "").trim().toLowerCase()
    );
    const limit = parseLimit(url, 100, 100);
    const result = await cleanStoredPhaseAText(env.DB, { limit, historical });
    return json({ ok: true, trigger: "clean_phase_a_text", ...result });
  }

  if (url.pathname === "/api/phase-a-closure-status" && request.method === "GET") {
    const result = await getPhaseAClosureStatus(env.DB);
    return json({ ok: true, ...result });
  }

  if (url.pathname === "/api/collect-now" && request.method === "POST") {
    if (!env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
    }

    const token = bearerToken(request);
    if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const result = await collectAll(env.DB);
    return json({ ok: true, trigger: "manual_collection", ...result });
  }

  if (url.pathname === "/api/process-phase-a" && request.method === "POST") {
    if (!env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
    }

    const token = bearerToken(request);
    if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const deterministic = await drainPhaseA(env.DB, { chunkSize: 25, maxDurationMs: 45000 });
    const cleanup = await cleanStoredPhaseAText(env.DB, { limit: 25, historical: false });
    const roles = await drainRoleClassifier(env.DB, env, {
      maxItems: 10,
      maxDurationMs: 45000,
      interRequestDelayMs: 4000
    });
    return json({ ok: true, trigger: "manual", deterministic, cleanup, roles });
  }

  if (url.pathname === "/api/relevance-role-preview" && request.method === "POST") {
    if (!env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
    }

    const token = bearerToken(request);
    if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const club = (url.searchParams.get("club") || "ol").trim() || "ol";
    const limit = parseLimit(url, 20, 50);
    const preview = await runRoleClassifierPreview(env.DB, env, club, limit);
    return json({ ok: true, ...preview });
  }

  if (url.pathname === "/api/relevance-v3-preview" && request.method === "GET") {
    const club = (url.searchParams.get("club") || "ol").trim() || "ol";
    const limit = parseLimit(url, 100, 200);
    const preview = await getRelevanceV3Preview(env.DB, club, limit);
    return json({ ok: true, ...preview });
  }

  if (url.pathname === "/api/relevance-audit" && request.method === "GET") {
    const club = (url.searchParams.get("club") || "ol").trim() || "ol";
    const limit = parseLimit(url, 50, 100);
    const compact = ["1", "true", "yes"].includes(
      (url.searchParams.get("compact") || "").trim().toLowerCase()
    );
    const audit = await getRelevanceAudit(env.DB, club, limit, { compact });
    return json({ ok: true, compact, ...audit });
  }

  if (url.pathname === "/api/processing-status" && request.method === "GET") {
    const club = (url.searchParams.get("club") || "ol").trim() || "ol";
    const limit = parseLimit(url, 8, 20);

    const decisionRaw = (url.searchParams.get("decision") || "").trim();
    const extractionStatusRaw = (url.searchParams.get("extraction_status") || "").trim();

    const allowedDecisions = new Set(["relevant", "rejected", "needs_review"]);
    const allowedExtractionStatuses = new Set(["completed", "retry", "failed"]);

    const decision = allowedDecisions.has(decisionRaw) ? decisionRaw : null;
    const extractionStatus = allowedExtractionStatuses.has(extractionStatusRaw) ? extractionStatusRaw : null;

    const diagnostics = await getProcessingDiagnostics(env.DB, club, limit, {
      decision,
      extractionStatus
    });
    return json({ ok: true, ...diagnostics });
  }

  if (url.pathname === "/api/phase-b-preview" && request.method === "GET") {
    const club = (url.searchParams.get("club") || "ol").trim() || "ol";
    const articleLimit = parseLimit(url, 60, 120);
    const pairLimitRaw = Number(url.searchParams.get("pairs") || 30);
    const pairLimit = Number.isFinite(pairLimitRaw)
      ? Math.max(1, Math.min(100, Math.trunc(pairLimitRaw)))
      : 30;

    const preview = await getPhaseBPreview(env.DB, club, articleLimit, pairLimit);
    return json({ ok: true, ...preview });
  }

  if (url.pathname === "/api/sources" && request.method === "GET") {
    const club = (url.searchParams.get("club") || "ol").trim() || "ol";
    const { results } = await env.DB.prepare(
      `SELECT s.*, cs.relation_type, cs.priority
       FROM sources s
       LEFT JOIN club_sources cs ON cs.source_id = s.id AND cs.club_id = ?
       ORDER BY CASE WHEN cs.priority IS NULL THEN 1 ELSE 0 END,
                cs.priority ASC, s.name ASC`
    ).bind(club).all();
    return json({ ok: true, club_id: club, count: results.length, sources: results });
  }

  if (url.pathname === "/api/articles" && request.method === "GET") {
    const limit = parseLimit(url);
    const source = (url.searchParams.get("source") || "").trim();

    let statement;
    let bindings;

    if (source) {
      statement = env.DB.prepare(
        `SELECT id, source_id, canonical_url AS url, title, published_at,
                excerpt, content_level, discovery_method,
                first_seen_at, last_seen_at, processing_status
         FROM raw_articles
         WHERE source_id = ?
         ORDER BY COALESCE(published_at, last_seen_at) DESC, last_seen_at DESC
         LIMIT ?`
      );
      bindings = [source, limit];
    } else {
      statement = env.DB.prepare(
        `SELECT id, source_id, canonical_url AS url, title, published_at,
                excerpt, content_level, discovery_method,
                first_seen_at, last_seen_at, processing_status
         FROM raw_articles
         ORDER BY last_seen_at DESC
         LIMIT ?`
      );
      bindings = [limit];
    }

    const { results } = await statement.bind(...bindings).all();
    return json({ ok: true, source: source || null, count: results.length, articles: results });
  }

  if (url.pathname === "/api/hash-instability-audit" && request.method === "GET") {
    const source = (url.searchParams.get("source") || "").trim();
    const limit = parseLimit(url, 50, 100);
    const where = source ? "WHERE r.source_id = ?" : "";
    const bindings = source ? [source, limit] : [limit];

    const { results } = await env.DB.prepare(
      `SELECT
         r.id,
         r.source_id,
         r.canonical_url AS url,
         r.title,
         r.excerpt,
         r.published_at,
         r.content_hash,
         r.last_seen_at,
         COUNT(v.id) AS version_count,
         MIN(v.captured_at) AS first_version_at,
         MAX(v.captured_at) AS last_version_at
       FROM raw_articles r
       LEFT JOIN article_versions v ON v.article_id = r.id
       ${where}
       GROUP BY r.id
       HAVING COUNT(v.id) > 1
       ORDER BY MAX(v.captured_at) DESC
       LIMIT ?`
    ).bind(...bindings).all();

    const items = [];
    for (const row of results || []) {
      const { results: versions } = await env.DB.prepare(
        `SELECT content_hash, title, excerpt, captured_at
         FROM article_versions
         WHERE article_id = ?
         ORDER BY captured_at DESC
         LIMIT 5`
      ).bind(row.id).all();

      items.push({
        ...row,
        versions: versions || []
      });
    }

    return json({
      ok: true,
      source: source || null,
      count: items.length,
      items
    });
  }

  if (url.pathname === "/api/collection-runs" && request.method === "GET") {
    const limit = parseLimit(url, 10, 50);
    const { results } = await env.DB.prepare(
      `SELECT id, started_at, finished_at, status, sources_attempted,
              sources_succeeded, articles_discovered, articles_inserted,
              articles_updated, error_count
       FROM collection_runs
       ORDER BY started_at DESC
       LIMIT ?`
    ).bind(limit).all();
    return json({ ok: true, count: results.length, runs: results });
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      let database = "unbound";
      if (env.DB) {
        try {
          await env.DB.prepare("SELECT 1 AS ok").first();
          database = "ok";
        } catch {
          database = "error";
        }
      }
      return json({
        ok: true,
        service: "club-actu",
        database,
        timestamp: new Date().toISOString()
      });
    }

    const api = await handleApi(request, env, url);
    if (api) return api;

    return json({ ok: false, error: "Not Found" }, { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await collectAll(env.DB);
      await drainPhaseA(env.DB, { chunkSize: 25, maxDurationMs: 45000 });
      await cleanStoredPhaseAText(env.DB, { limit: 25, historical: false });
      await drainRoleClassifier(env.DB, env, {
        maxItems: 10,
        maxDurationMs: 45000,
        interRequestDelayMs: 4000
      });
    })());
  }
};
