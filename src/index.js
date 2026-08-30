import { collectAll, repairMojibake } from "./collector.js";
import { getProcessingDiagnostics, processPhaseA } from "./processor.js";

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

  if (url.pathname === "/api/sources" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT s.*, cs.relation_type, cs.priority
       FROM sources s
       LEFT JOIN club_sources cs ON cs.source_id = s.id AND cs.club_id = 'ol'
       ORDER BY cs.priority ASC, s.name ASC`
    ).all();
    return json({ ok: true, count: results.length, sources: results });
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
      await processPhaseA(env.DB, { limit: 25 });
    })());
  }
};
