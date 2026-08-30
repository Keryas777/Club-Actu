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
      const res = await fetch(target, { redirect: "follow" });
      const html = await res.text();
      const origin = new URL(res.url).origin;

      const rawSrcs = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1]);
      const rootScripts = [...new Set(rawSrcs.map((raw) => new URL("/" + raw.replace(/^\/+/, ""), origin).toString()))];

      const files = [];
      const allCandidates = new Set();
      const seen = new Set();
      const queue = [...rootScripts];

      while (queue.length && seen.size < 20) {
        const scriptUrl = queue.shift();
        if (!scriptUrl || seen.has(scriptUrl)) continue;
        seen.add(scriptUrl);

        try {
          const r = await fetch(scriptUrl, { redirect: "follow" });
          const body = await r.text();
          const contentType = r.headers.get("content-type") || "";
          const looksJs = /javascript|ecmascript/i.test(contentType) || !/^\s*<!doctype html/i.test(body);

          const candidateStrings = [];
          const quoted = body.match(/["'`](.{1,240}?)["'`]/g) || [];
          for (const token of quoted) {
            const value = token.slice(1, -1);
            if (/api|graphql|actualit|article|news|content|cms|backend/i.test(value)) {
              candidateStrings.push(value);
              allCandidates.add(value);
            }
          }

          const imports = [];
          const importRe = /(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g;
          let im;
          while ((im = importRe.exec(body))) {
            const chunkUrl = new URL("/" + im[1].replace(/^\/+/, ""), origin).toString();
            imports.push(chunkUrl);
            if (!seen.has(chunkUrl)) queue.push(chunkUrl);
          }

          files.push({
            url: scriptUrl,
            status: r.status,
            content_type: contentType,
            length: body.length,
            looks_js: looksJs,
            imports: [...new Set(imports)].slice(0, 20),
            candidate_strings: [...new Set(candidateStrings)].slice(0, 80)
          });
        } catch (error) {
          files.push({ url: scriptUrl, error: String(error?.message || error) });
        }
      }

      // Extract the runtime API base URL from Angular's bundled configuration.
      // OL's article service builds routes such as `${config.apiUrl}/articles`.
      const apiUrlCandidates = new Set();
      for (const file of files) {
        if (!file.url || !file.looks_js) continue;
        try {
          const rr = await fetch(file.url, { redirect: "follow" });
          const bb = await rr.text();
          const urlMatches = bb.match(/https?:\\?\/\\?\/[^"'\`\\s,}]{4,240}/g) || [];
          for (let value of urlMatches) {
            value = value.replace(/\\\//g, "/");
            if (/api|ol\.fr|olvallee|lyonnais/i.test(value)) apiUrlCandidates.add(value);
          }
          const configSnippets = bb.match(/.{0,180}apiUrl.{0,260}/g) || [];
          for (const snippet of configSnippets) allCandidates.add(snippet);
        } catch {}
      }

      return json({
        ok: true,
        target,
        status: res.status,
        root_scripts: rootScripts,
        scanned_file_count: files.length,
        api_url_candidates: [...apiUrlCandidates].slice(0, 100),
        api_probe_results: await Promise.all(
          [...apiUrlCandidates]
            .filter((base) => /^https:\/\//i.test(base) && !/media\.|auth\./i.test(base))
            .slice(0, 20)
            .map(async (base) => {
              const normalized = base.replace(/\/+$/, "");
              const endpoints = [normalized + "/articles", normalized + "/articles/count"];
              const results = [];
              for (const endpoint of endpoints) {
                try {
                  const rr = await fetch(endpoint, {
                    redirect: "follow",
                    headers: { accept: "application/json,text/plain,*/*" }
                  });
                  const bb = await rr.text();
                  results.push({
                    endpoint,
                    status: rr.status,
                    content_type: rr.headers.get("content-type") || "",
                    length: bb.length,
                    prefix: bb.slice(0, 500)
                  });
                } catch (error) {
                  results.push({ endpoint, error: String(error?.message || error) });
                }
              }
              return { base: normalized, results };
            })
        ),
        config_probe_results: await Promise.all(
          [
            "/assets/config/config.json",
            "/assets/config/config.prod.json",
            "/assets/config/config.production.json",
            "/assets/config/app-config.json",
            "/assets/config.json",
            "/config.json",
            "/app-config.json",
            "/assets/environment.json",
            "/environment.json"
          ].map(async (path) => {
            const endpoint = "https://www.ol.fr" + path;
            try {
              const rr = await fetch(endpoint, { redirect: "follow", headers: { accept: "application/json,text/plain,*/*" } });
              const bb = await rr.text();
              return {
                endpoint,
                status: rr.status,
                content_type: rr.headers.get("content-type") || "",
                length: bb.length,
                is_spa_html: /<!doctype html/i.test(bb),
                prefix: bb.slice(0, 1200)
              };
            } catch (error) {
              return { endpoint, error: String(error?.message || error) };
            }
          })
        ),
        files,
        candidate_strings: [...allCandidates].slice(0, 200)
      });
    } catch (error) {
      return json({ ok: false, target, error: String(error?.message || error) }, { status: 500 });
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
