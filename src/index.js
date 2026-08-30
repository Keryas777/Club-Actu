import { collectAll, repairMojibake } from "./collector.js";

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


  if (url.pathname === "/api/debug/ol-source" && request.method === "GET") {
    const target = "https://www.ol.fr/fr/actualites";
    try {
      const res = await fetch(target, {
        redirect: "follow",
        headers: {
          "User-Agent": "ClubActuBot/0.1 (+https://github.com/Keryas777/Club-Actu)",
          "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
        }
      });
      const html = await res.text();

      const routeMatches = html.match(/\\?\/fr\\?\/actualites\\?\/[a-z0-9][a-z0-9-]{5,}/gi) || [];
      const uniqueRoutes = [...new Set(routeMatches.map((m) => m.replace(/\\/g, "")))];

      const scriptSrcs = [];
      const scriptRe = /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
      let sm;
      while ((sm = scriptRe.exec(html))) {
        try {
          scriptSrcs.push(new URL(sm[1], res.url).toString());
        } catch {}
      }

      const scannedScripts = [];
      const candidates = [];
      const urlLikeRe = /https?:\\?\/\\?\/[^"'\s)]+|\\?\/(?:api|graphql|content|news|actualites|articles)[^"'\s)]*/gi;

      for (const src of [...new Set(scriptSrcs)].slice(0, 12)) {
        try {
          const jsRes = await fetch(src, {
            headers: {
              "User-Agent": "ClubActuBot/0.1 (+https://github.com/Keryas777/Club-Actu)"
            }
          });
          const js = await jsRes.text();
          const hits = js.match(urlLikeRe) || [];
          const relevant = [...new Set(
            hits
              .map((x) => x.replace(/\\/g, ""))
              .filter((x) => /api|graphql|actualit|article|news|content/i.test(x))
          )].slice(0, 50);

          if (/actualit|article|graphql|api/i.test(js)) {
            scannedScripts.push({
              src,
              status: jsRes.status,
              length: js.length,
              relevant_hits: relevant
            });
            candidates.push(...relevant);
          }
        } catch (error) {
          scannedScripts.push({
            src,
            error: String(error?.message || error)
          });
        }
      }

      return json({
        ok: true,
        target,
        final_url: res.url,
        status: res.status,
        content_type: res.headers.get("content-type"),
        body_length: html.length,
        route_match_count: routeMatches.length,
        unique_route_count: uniqueRoutes.length,
        sample_routes: uniqueRoutes.slice(0, 20),
        script_count: scriptSrcs.length,
        scripts: [...new Set(scriptSrcs)],
        scanned_scripts: scannedScripts,
        candidate_endpoints: [...new Set(candidates)].slice(0, 100)
      });
    } catch (error) {
      return json({
        ok: false,
        target,
        error: String(error?.message || error)
      }, { status: 500 });
    }
  }

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
    const { results } = await env.DB.prepare(
      `SELECT id, source_id, canonical_url AS url, title, published_at,
              content_level, first_seen_at, last_seen_at, processing_status
       FROM raw_articles
       ORDER BY last_seen_at DESC
       LIMIT ?`
    ).bind(limit).all();
    return json({ ok: true, count: results.length, articles: results });
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
    ctx.waitUntil(collectAll(env.DB));
  }
};
