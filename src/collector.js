import { listEnabledAdapters } from "./sources.js";

const USER_AGENT = "ClubActuBot/0.1 (+https://github.com/Keryas777/Club-Actu)";

const CP1252_REVERSE = new Map([
  ["€", 0x80], ["‚", 0x82], ["ƒ", 0x83], ["„", 0x84], ["…", 0x85],
  ["†", 0x86], ["‡", 0x87], ["ˆ", 0x88], ["‰", 0x89], ["Š", 0x8A],
  ["‹", 0x8B], ["Œ", 0x8C], ["Ž", 0x8E], ["‘", 0x91], ["’", 0x92],
  ["“", 0x93], ["”", 0x94], ["•", 0x95], ["–", 0x96], ["—", 0x97],
  ["˜", 0x98], ["™", 0x99], ["š", 0x9A], ["›", 0x9B], ["œ", 0x9C],
  ["ž", 0x9E], ["Ÿ", 0x9F]
]);

function repairMojibakeOnce(text = "") {
  const s = String(text);
  if (!/[ÃÂâ]/.test(s)) return s;

  const bytes = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code <= 0xFF) {
      bytes.push(code);
      continue;
    }
    const cp1252 = CP1252_REVERSE.get(ch);
    if (cp1252 == null) return s;
    bytes.push(cp1252);
  }

  try {
    const repaired = new TextDecoder("utf-8", { fatal: true })
      .decode(new Uint8Array(bytes));
    return /\uFFFD/.test(repaired) ? s : repaired;
  } catch {
    return s;
  }
}

export function repairMojibake(text = "") {
  let current = String(text);
  for (let i = 0; i < 3; i++) {
    const repaired = repairMojibakeOnce(current);
    if (repaired === current) break;
    current = repaired;
  }
  return current;
}

const NAMED_HTML_ENTITIES = new Map([
  ["nbsp", " "],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
  ["lt", "<"],
  ["gt", ">"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["hellip", "…"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["euro", "€"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"]
]);

function decodeEntityPass(text = "") {
  return String(text)
    .replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (match, hex, dec) => {
      const codePoint = Number.parseInt(hex || dec, hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) {
        return match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    })
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => {
      return NAMED_HTML_ENTITIES.get(String(name).toLowerCase()) ?? match;
    });
}

export function decodeEntities(text = "") {
  let current = String(text || "");
  for (let i = 0; i < 3; i++) {
    const decoded = decodeEntityPass(current);
    if (decoded === current) break;
    current = decoded;
  }

  return repairMojibake(current)
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html = "") {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "));
}

export function normalizeSourceTitle(sourceId, title = "") {
  let normalized = decodeEntities(title || "");

  if (sourceId === "sports_orange") {
    // Orange prepends presentation metadata that changes as an item ages:
    // "19:09 Football …" later becomes "02/09 Football …".
    // It is not editorial content and must not affect the article hash.
    normalized = normalized.replace(
      /^(?:(?:[01]?\d|2[0-3]):[0-5]\d|\d{2}\/\d{2})\s+Football\s+/i,
      ""
    );
  }

  if (sourceId === "madeingones") {
    // MadeInGones appends a relative presentation timestamp to cards:
    // "OL • 15h45" later becomes "OL • 02/09".
    normalized = normalized.replace(
      /\s*•\s*(?:(?:[01]?\d|2[0-3])h[0-5]\d|\d{2}\/\d{2})\s*$/i,
      ""
    );

    // Some cards repeat the section label in their metadata.
    normalized = normalized.replace(
      /\b(Mercato|Ligue 1|Ligue 2|Ligue Europa|Ligue des Champions|Anciens|OL)\s*•\s*\1\b/gi,
      "$1"
    );
  }

  return normalized.replace(/\s+/g, " ").trim();
}

function absoluteUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function canonicalize(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: init.redirect || "follow"
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 12000) {
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
    }
  }, timeoutMs);
  const text = await res.text();
  return { ok: res.ok, status: res.status, text, finalUrl: res.url };
}

function looksLikeArticleUrl(url, adapter) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "") || "/";

  // Source-specific rules stay authoritative where the site's article URL
  // structure is known.
  if (adapter.articlePath) return adapter.articlePath.test(path);

  // Generic guardrails for navigation/account/index pages.
  if (path === "/") return false;
  if (/\/(?:login|connexion|connecter|compte|account|abonnement|newsletter|contact|mentions-legales|politique-de-confidentialite|privacy|cookies?|classement|calendrier|resultats?|equipe|effectif|billetterie|boutique)(?:\/|$)/i.test(path)) {
    return false;
  }

  const segments = path.split("/").filter(Boolean);
  const slug = segments[segments.length - 1] || "";
  const hasArticleId = /(?:^|[-_])\d{4,}(?:\.[a-z]+)?$/i.test(slug) || /\d{5,}/.test(slug);
  const longSlug = slug.length >= 24 && (slug.match(/-/g) || []).length >= 3;
  return hasArticleId || longSlug;
}

function looksLikeArticleTitle(title = "") {
  const t = title.trim();
  if (t.length < 18) return false;
  if (/^(?:se connecter|connexion|accueil|calendrier|classement|résultats?|effectif|équipe|billetterie|boutique|newsletter|contact)(?:\b|\s|\/|-)/i.test(t)) return false;
  return true;
}

async function discoverOlApi(adapter) {
  const configRes = await fetchWithTimeout(adapter.configUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/plain,*/*" }
  });
  if (!configRes.ok) throw new Error(`OL config HTTP ${configRes.status}`);
  const config = await configRes.json();
  const apiUrl = String((config && config.apiUrl) || "").replace(/\/+$/, "");
  if (!apiUrl) throw new Error("OL config missing apiUrl");
  const headers = Object.assign({}, (config && config.headers) || {}, {
    "User-Agent": USER_AGENT,
    Accept: "application/json,text/plain,*/*"
  });
  const pageSize = Math.max(1, Math.min(100, Number(adapter.pageSize || 25)));
  const locale = encodeURIComponent(adapter.locale || "fr");
  const endpoint = `${apiUrl}/articles?sort=publish_date:desc&pagination[pageSize]=${pageSize}&locale=${locale}`;
  const res = await fetchWithTimeout(endpoint, { headers });
  if (!res.ok) throw new Error(`OL articles HTTP ${res.status}`);
  const payload = await res.json();
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  return rows.filter((row) => row && row.slug && row.title).map((row) => ({
    url: canonicalize(new URL(String(row.slug), adapter.articleBaseUrl).toString()),
    title: decodeEntities(row.title || ""),
    excerpt: decodeEntities(row.description || ""),
    publishedAt: row.publish_date || row.publishedAt || null,
    discoveryMethod: "api"
  }));
}
function extractXmlTag(block, tag) {
  const re = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
  const m = re.exec(block);
  if (!m) return "";
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").replace(/<[^>]+>/g, " "));
}

function discoverRss(xml, adapter) {
  const found = new Map();
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const rawUrl = extractXmlTag(block, "link") || extractXmlTag(block, "guid");
    const title = extractXmlTag(block, "title");
    if (!rawUrl || !looksLikeArticleTitle(title)) continue;
    const url = absoluteUrl(rawUrl, adapter.discoveryUrl);
    if (!url) continue;
    const u = new URL(url);
    if (adapter.articleHosts && !adapter.articleHosts.includes(u.hostname)) continue;
    const canonical = canonicalize(url);
    if (!found.has(canonical)) found.set(canonical, { url: canonical, title, excerpt: extractXmlTag(block, "description"), publishedAt: extractXmlTag(block, "pubDate") || null, discoveryMethod: "rss" });
    if (found.size >= 50) break;
  }
  return [...found.values()];
}

function discoverLinks(html, adapter) {
  const found = new Map();

  // 1) Normal HTML anchors.
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = absoluteUrl(m[1], adapter.discoveryUrl);
    if (!url) continue;
    const u = new URL(url);
    if (!adapter.articleHosts.includes(u.hostname)) continue;
    if (adapter.includePath && !adapter.includePath.test(u.pathname)) continue;
    if (adapter.excludePath && adapter.excludePath.test(u.pathname)) continue;
    if (!looksLikeArticleUrl(url, adapter)) continue;
    const title = stripTags(m[2]);
    if (!looksLikeArticleTitle(title)) continue;
    const canonical = canonicalize(url);
    if (!found.has(canonical)) found.set(canonical, { url: canonical, title });
    if (found.size >= 50) break;
  }

  // 2) Client-rendered sites often embed routes in JSON/script payloads even
  // when no useful <a> tags exist in the server-rendered shell.
  if (adapter.discoveryMode === "embedded_routes" && found.size < 50) {
    const routeRe = /(?:https?:\\?\/\\?\/www\.ol\.fr)?\\?\/fr\\?\/actualites\\?\/([a-z0-9][a-z0-9-]{5,})/gi;
    let rm;
    while ((rm = routeRe.exec(html))) {
      const slug = rm[1];
      const url = `https://www.ol.fr/fr/actualites/${slug}`;
      if (!looksLikeArticleUrl(url, adapter)) continue;

      // We may not have the card title in the embedded payload. Use a readable
      // slug-derived placeholder; full extraction will replace it later.
      const title = slug
        .split("-")
        .filter(Boolean)
        .map((part) => part.length <= 3 ? part.toUpperCase() : part)
        .join(" ");

      const canonical = canonicalize(url);
      if (!found.has(canonical)) found.set(canonical, { url: canonical, title });
      if (found.size >= 50) break;
    }
  }

  return [...found.values()];
}

async function upsertArticles(db, sourceId, items, now) {
  if (!items.length) return { inserted: 0, updated: 0, unchanged: 0 };

  const prepared = await Promise.all(items.map(async (item) => {
    const normalizedTitle = normalizeSourceTitle(sourceId, item.title || "");
    const normalizedExcerpt = decodeEntities(item.excerpt || "");
    const publishedAt = item.publishedAt || null;
    const discoveryMethod = item.discoveryMethod || "html_links";
    const id = await sha256Hex(sourceId + "|" + item.url);
    const contentHash = await sha256Hex(
      [normalizedTitle, normalizedExcerpt, publishedAt || ""].join("|") || item.url
    );
    return {
      ...item,
      id,
      normalizedTitle,
      normalizedExcerpt,
      publishedAt,
      discoveryMethod,
      contentHash
    };
  }));

  const placeholders = prepared.map(() => "?").join(",");
  const { results: existingRows } = await db.prepare(
    `SELECT id, canonical_url, content_hash
     FROM raw_articles
     WHERE source_id = ? AND canonical_url IN (${placeholders})`
  ).bind(sourceId, ...prepared.map((item) => item.url)).all();

  const existingByUrl = new Map(
    (existingRows || []).map((row) => [row.canonical_url, row])
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const articleStatements = [];
  const versionStatements = [];

  for (const item of prepared) {
    const existing = existingByUrl.get(item.url);

    if (!existing) {
      inserted++;
      articleStatements.push(
        db.prepare(
          `INSERT INTO raw_articles
          (id, source_id, url, canonical_url, title, published_at, excerpt,
           content_level, discovery_method, first_seen_at, last_seen_at,
           content_hash, processing_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'metadata', ?, ?, ?, ?, 'raw')`
        ).bind(
          item.id, sourceId, item.url, item.url, item.normalizedTitle,
          item.publishedAt, item.normalizedExcerpt || null, item.discoveryMethod,
          now, now, item.contentHash
        )
      );
      versionStatements.push(
        db.prepare(
          `INSERT OR IGNORE INTO article_versions
           (article_id, content_hash, title, excerpt, captured_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          item.id, item.contentHash, item.normalizedTitle,
          item.normalizedExcerpt || null, now
        )
      );
      continue;
    }

    // Do not rewrite an unchanged article on every 30-minute collection.
    // raw_articles.last_seen_at participates in several indexes, so even a
    // heartbeat-only UPDATE creates substantial D1 write amplification.
    if (existing.content_hash === item.contentHash) {
      unchanged++;
      continue;
    }

    updated++;
    articleStatements.push(
      db.prepare(
        `UPDATE raw_articles SET
           last_seen_at = ?, title = ?, published_at = COALESCE(?, published_at),
           excerpt = COALESCE(?, excerpt), discovery_method = ?, content_hash = ?,
           processing_status = 'raw'
         WHERE id = ?`
      ).bind(
        now, item.normalizedTitle, item.publishedAt,
        item.normalizedExcerpt || null, item.discoveryMethod,
        item.contentHash, existing.id
      )
    );

    versionStatements.push(
      db.prepare(
        `INSERT OR IGNORE INTO article_versions
         (article_id, content_hash, title, excerpt, captured_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        existing.id, item.contentHash, item.normalizedTitle,
        item.normalizedExcerpt || null, now
      )
    );
  }

  // Parent rows must exist before article_versions because D1 enforces the
  // foreign key immediately. Keep each batch modest to avoid oversized calls.
  for (let i = 0; i < articleStatements.length; i += 50) {
    await db.batch(articleStatements.slice(i, i + 50));
  }
  for (let i = 0; i < versionStatements.length; i += 50) {
    await db.batch(versionStatements.slice(i, i + 50));
  }

  return { inserted, updated, unchanged };
}

export async function normalizeStoredEntities(db, limit = 100) {
  const cappedLimit = Math.max(1, Math.min(200, Number(limit || 100)));
  const entityPredicates = [
    "title LIKE '%&#%'",
    "excerpt LIKE '%&#%'",
    "lower(title) LIKE '%&rsquo;%'",
    "lower(excerpt) LIKE '%&rsquo;%'",
    "lower(title) LIKE '%&lsquo;%'",
    "lower(excerpt) LIKE '%&lsquo;%'",
    "lower(title) LIKE '%&rdquo;%'",
    "lower(excerpt) LIKE '%&rdquo;%'",
    "lower(title) LIKE '%&ldquo;%'",
    "lower(excerpt) LIKE '%&ldquo;%'",
    "lower(title) LIKE '%&ndash;%'",
    "lower(excerpt) LIKE '%&ndash;%'",
    "lower(title) LIKE '%&mdash;%'",
    "lower(excerpt) LIKE '%&mdash;%'",
    "lower(title) LIKE '%&hellip;%'",
    "lower(excerpt) LIKE '%&hellip;%'",
    "lower(title) LIKE '%&laquo;%'",
    "lower(excerpt) LIKE '%&laquo;%'",
    "lower(title) LIKE '%&raquo;%'",
    "lower(excerpt) LIKE '%&raquo;%'",
    "lower(title) LIKE '%&amp;#%'",
    "lower(excerpt) LIKE '%&amp;#%'"
  ];

  const { results } = await db.prepare(
    `SELECT id, source_id, canonical_url, title, excerpt, published_at, content_hash
     FROM raw_articles
     WHERE ${entityPredicates.join(" OR ")}
     ORDER BY last_seen_at ASC
     LIMIT ?`
  ).bind(cappedLimit).all();

  const rows = results || [];
  let changed = 0;
  const articleStatements = [];
  const versionStatements = [];
  const examples = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    const normalizedTitle = decodeEntities(row.title || "");
    const normalizedExcerpt = decodeEntities(row.excerpt || "");
    if (normalizedTitle === (row.title || "") && normalizedExcerpt === (row.excerpt || "")) {
      continue;
    }

    const nextHash = await sha256Hex(
      [normalizedTitle, normalizedExcerpt, row.published_at || ""].join("|") || row.canonical_url
    );

    articleStatements.push(
      db.prepare(
        `UPDATE raw_articles
         SET title = ?, excerpt = ?, content_hash = ?
         WHERE id = ?`
      ).bind(normalizedTitle, normalizedExcerpt || null, nextHash, row.id)
    );

    versionStatements.push(
      db.prepare(
        `INSERT OR IGNORE INTO article_versions
         (article_id, content_hash, title, excerpt, captured_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(row.id, nextHash, normalizedTitle, normalizedExcerpt || null, now)
    );

    changed++;
    if (examples.length < 10) {
      examples.push({
        id: row.id,
        source: row.source_id,
        before: row.title,
        after: normalizedTitle
      });
    }
  }

  for (let i = 0; i < articleStatements.length; i += 50) {
    await db.batch(articleStatements.slice(i, i + 50));
  }
  for (let i = 0; i < versionStatements.length; i += 50) {
    await db.batch(versionStatements.slice(i, i + 50));
  }

  return {
    scanned: rows.length,
    changed,
    remaining_possible: rows.length === cappedLimit,
    examples
  };
}

async function checkpointRun(db, runId, counters, details, finishedAt = null) {
  const status = finishedAt
    ? (counters.errors === counters.attempted
      ? "failed"
      : (counters.errors ? "partial" : "success"))
    : "running";

  await db.prepare(
    `UPDATE collection_runs SET
      finished_at = ?, status = ?, sources_succeeded = ?,
      articles_discovered = ?, articles_inserted = ?,
      articles_updated = ?, error_count = ?, notes = ?
     WHERE id = ?`
  ).bind(
    finishedAt,
    status,
    counters.success,
    counters.discovered,
    counters.inserted,
    counters.updated,
    counters.errors,
    JSON.stringify(details),
    runId
  ).run();
}

export async function collectAll(db) {
  const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recoveredAt = new Date().toISOString();

  await db.prepare(
    `UPDATE collection_runs
     SET status = 'abandoned',
         finished_at = COALESCE(finished_at, ?),
         notes = CASE
           WHEN notes IS NULL OR notes = '' THEN ?
           ELSE notes
         END
     WHERE status = 'running'
       AND started_at < ?`
  ).bind(
    recoveredAt,
    JSON.stringify({ reason: "stale_run_recovered", recovered_at: recoveredAt }),
    staleBefore
  ).run();

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const adapters = listEnabledAdapters();
  const counters = {
    attempted: adapters.length,
    success: 0,
    discovered: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    errors: 0
  };
  const details = [];

  await db.prepare(
    `INSERT INTO collection_runs
     (id, started_at, status, sources_attempted)
     VALUES (?, ?, 'running', ?)`
  ).bind(runId, startedAt, adapters.length).run();

  for (const adapter of adapters) {
    const sourceStartedAt = Date.now();

    try {
      let links;
      if (adapter.discoveryMode === "ol_api") {
        links = await discoverOlApi(adapter);
      } else {
        const page = await fetchText(adapter.discoveryUrl);
        if (!page.ok) throw new Error(`HTTP ${page.status}`);
        links = adapter.discoveryMode === "rss"
          ? discoverRss(page.text, adapter)
          : discoverLinks(page.text, adapter);
      }

      const sourceResult = await upsertArticles(db, adapter.id, links, startedAt);
      counters.discovered += links.length;
      counters.inserted += sourceResult.inserted;
      counters.updated += sourceResult.updated;
      counters.unchanged += sourceResult.unchanged;
      counters.success++;

      details.push({
        source: adapter.id,
        ok: true,
        discovered: links.length,
        inserted: sourceResult.inserted,
        updated: sourceResult.updated,
        unchanged: sourceResult.unchanged,
        duration_ms: Date.now() - sourceStartedAt
      });
    } catch (error) {
      counters.errors++;
      details.push({
        source: adapter.id,
        ok: false,
        error: String(error?.name === "AbortError"
          ? "fetch timeout"
          : (error?.message || error)),
        duration_ms: Date.now() - sourceStartedAt
      });
    }

    // Persist progress after every source. If Cloudflare interrupts the Worker,
    // the audit still shows exactly how far the run got instead of 0/13.
    await checkpointRun(db, runId, counters, details);
  }

  const finishedAt = new Date().toISOString();
  await checkpointRun(db, runId, counters, details, finishedAt);

  return {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    sources_attempted: counters.attempted,
    sources_succeeded: counters.success,
    articles_discovered: counters.discovered,
    articles_inserted: counters.inserted,
    articles_updated: counters.updated,
    articles_unchanged: counters.unchanged,
    errors: counters.errors,
    details
  };
}

