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

function decodeEntities(text = "") {
  return repairMojibake(
    text
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function stripTags(html = "") {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "));
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

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
      }
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

function discoverLinks(html, adapter) {
  const found = new Map();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = absoluteUrl(m[1], adapter.discoveryUrl);
    if (!url) continue;
    const u = new URL(url);
    if (!adapter.articleHosts.includes(u.hostname)) continue;
    if (adapter.includePath && !adapter.includePath.test(u.pathname)) continue;
    const title = stripTags(m[2]);
    if (!title || title.length < 12) continue;
    const canonical = canonicalize(url);
    if (!found.has(canonical)) found.set(canonical, { url: canonical, title });
    if (found.size >= 50) break;
  }
  return [...found.values()];
}

async function upsertArticle(db, sourceId, item, now) {
  const id = await sha256Hex(sourceId + "|" + item.url);
  const contentHash = await sha256Hex(item.title || item.url);

  const existing = await db.prepare(
    "SELECT id, content_hash FROM raw_articles WHERE source_id = ? AND canonical_url = ?"
  ).bind(sourceId, item.url).first();

  if (!existing) {
    await db.prepare(
      `INSERT INTO raw_articles
      (id, source_id, url, canonical_url, title, content_level, discovery_method,
       first_seen_at, last_seen_at, content_hash, processing_status)
       VALUES (?, ?, ?, ?, ?, 'metadata', 'html_links', ?, ?, ?, 'raw')`
    ).bind(id, sourceId, item.url, item.url, item.title, now, now, contentHash).run();

    await db.prepare(
      `INSERT OR IGNORE INTO article_versions
       (article_id, content_hash, title, captured_at)
       VALUES (?, ?, ?, ?)`
    ).bind(id, contentHash, item.title, now).run();

    return "inserted";
  }

  await db.prepare(
    "UPDATE raw_articles SET last_seen_at = ?, title = ?, content_hash = ? WHERE id = ?"
  ).bind(now, item.title, contentHash, existing.id).run();

  if (existing.content_hash !== contentHash) {
    await db.prepare(
      `INSERT OR IGNORE INTO article_versions
       (article_id, content_hash, title, captured_at)
       VALUES (?, ?, ?, ?)`
    ).bind(existing.id, contentHash, item.title, now).run();
  }

  return "updated";
}

export async function collectAll(db) {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const adapters = listEnabledAdapters();
  let success = 0, discovered = 0, inserted = 0, updated = 0, errors = 0;
  const details = [];

  await db.prepare(
    `INSERT INTO collection_runs
     (id, started_at, status, sources_attempted)
     VALUES (?, ?, 'running', ?)`
  ).bind(runId, startedAt, adapters.length).run();

  for (const adapter of adapters) {
    try {
      const page = await fetchText(adapter.discoveryUrl);
      if (!page.ok) throw new Error(`HTTP ${page.status}`);
      const links = discoverLinks(page.text, adapter);
      discovered += links.length;
      let sourceInserted = 0, sourceUpdated = 0;
      for (const item of links) {
        const action = await upsertArticle(db, adapter.id, item, startedAt);
        if (action === "inserted") { inserted++; sourceInserted++; }
        else { updated++; sourceUpdated++; }
      }
      success++;
      details.push({
        source: adapter.id,
        ok: true,
        discovered: links.length,
        inserted: sourceInserted,
        updated: sourceUpdated
      });
    } catch (error) {
      errors++;
      details.push({
        source: adapter.id,
        ok: false,
        error: String(error?.message || error)
      });
    }
  }

  const finishedAt = new Date().toISOString();
  await db.prepare(
    `UPDATE collection_runs SET
      finished_at = ?, status = ?, sources_succeeded = ?,
      articles_discovered = ?, articles_inserted = ?,
      articles_updated = ?, error_count = ?, notes = ?
     WHERE id = ?`
  ).bind(
    finishedAt,
    errors === adapters.length ? "failed" : (errors ? "partial" : "success"),
    success,
    discovered,
    inserted,
    updated,
    errors,
    JSON.stringify(details),
    runId
  ).run();

  return {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    sources_attempted: adapters.length,
    sources_succeeded: success,
    articles_discovered: discovered,
    articles_inserted: inserted,
    articles_updated: updated,
    errors,
    details
  };
}
