import { classifyRoleWithProvider, rolePreviewDecision, ROLE_CLASSIFIER_VERSION } from "./relevance-role.js";

const USER_AGENT = "ClubActuBot/0.2 (+https://github.com/Keryas777/Club-Actu)";
const EXTRACTOR_VERSION = "phase-a-extractor-v1";
const RULE_VERSION = "phase-a-relevance-v2";

function compactSpace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeEntities(text = "") {
  return compactSpace(
    String(text || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
  );
}

function stripTags(html = "") {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function metaContent(html, matcher) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    if (!matcher.test(name)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([\s\S]*?)["']/i)?.[1];
    if (content) return decodeEntities(content);
  }
  return null;
}

function firstTagText(html, names) {
  for (const name of names) {
    const re = new RegExp("<" + name + "\\b[^>]*>([\\s\\S]*?)<\\/" + name + ">", "i");
    const match = String(html || "").match(re);
    if (match?.[1]) {
      const value = stripTags(match[1]);
      if (value) return value;
    }
  }
  return null;
}

function extractMainText(html) {
  const body =
    String(html || "").match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    String(html || "").match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    "";
  const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((p) => p.length >= 20);
  return compactSpace(paragraphs.join("\n\n"));
}

export function classifyTechnicalArticle(article, extraction) {
  const title = compactSpace(extraction.normalized_title || article.title || "");
  const excerpt = compactSpace(extraction.normalized_excerpt || article.excerpt || "");
  const content = compactSpace(extraction.normalized_content || article.raw_content || "");
  const url = String(article.canonical_url || article.url || "").toLowerCase();

  if (
    /\/(?:login|connexion|compte|account|abonnement|newsletter|contact|mentions-legales|privacy|cookies?|classement|calendrier|resultats?|effectif|billetterie|boutique)(?:\/|$)/i.test(url) ||
    /%7burl_(?:tunnel|logout)%7d/i.test(url) ||
    /^(?:se connecter|se déconnecter|connexion|accueil|calendrier|classement|résultats?|effectif|billetterie|boutique|newsletter|contact|refuser\s*&\s*s'abonner)(?:\b|\s|\/|-)/i.test(title)
  ) {
    return { status: "rejected", reason_code: "navigation_page" };
  }

  if (title.length < 12) {
    return { status: "rejected", reason_code: "insufficient_title" };
  }

  if (!excerpt && content.length < 120) {
    return { status: "needs_content", reason_code: "insufficient_content" };
  }

  return { status: "usable", reason_code: null };
}

function aliasRegex(alias, global = false) {
  const escaped = String(alias).replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    "(^|[^\\p{L}\\p{N}])" + escaped + "([^\\p{L}\\p{N}]|$)",
    global ? "giu" : "iu"
  );
}

function aliasMatches(text, alias) {
  const value = compactSpace(text);
  if (!value) return 0;
  return [...value.matchAll(aliasRegex(alias, true))].length;
}

function aliasContext(text, alias, radius = 120) {
  const value = compactSpace(text);
  if (!value) return null;
  const haystack = value.toLocaleLowerCase("fr");
  const needle = String(alias || "").toLocaleLowerCase("fr");
  const index = haystack.indexOf(needle);
  if (index < 0) return null;

  const start = Math.max(0, index - radius);
  const end = Math.min(value.length, index + needle.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return prefix + value.slice(start, end).trim() + suffix;
}

function buildAliasEvidence(aliases, title, excerpt, content) {
  const cleanTitle = compactSpace(title);
  const cleanExcerpt = compactSpace(excerpt);
  const cleanContent = compactSpace(content);
  const lead = cleanContent.slice(0, 900);
  const bodyAfterLead = cleanContent.slice(900);

  return aliases.map((entry) => {
    const evidence = {
      alias: entry.alias,
      strength: entry.strength,
      title: aliasMatches(cleanTitle, entry.alias),
      excerpt: aliasMatches(cleanExcerpt, entry.alias),
      lead: aliasMatches(lead, entry.alias),
      body: aliasMatches(cleanContent, entry.alias),
      body_after_lead: aliasMatches(bodyAfterLead, entry.alias),
      contexts: {
        title: aliasContext(cleanTitle, entry.alias),
        excerpt: aliasContext(cleanExcerpt, entry.alias),
        lead: aliasContext(lead, entry.alias),
        body: aliasContext(bodyAfterLead, entry.alias)
      }
    };
    evidence.total = evidence.title + evidence.excerpt + evidence.body;
    return evidence;
  });
}

function detailFor(evidence, matchedField) {
  return JSON.stringify({
    matched_alias: evidence.alias,
    strength: evidence.strength,
    matched_field: matchedField,
    match_context: evidence.contexts?.[matchedField] || null,
    occurrences: {
      title: evidence.title,
      excerpt: evidence.excerpt,
      lead: evidence.lead,
      body: evidence.body
    }
  });
}

function enrichDiagnosticExample(example) {
  if (!example) return example;

  let detail = null;
  try {
    detail = example.reason_detail ? JSON.parse(example.reason_detail) : null;
  } catch {
    detail = null;
  }

  const alias = detail?.matched_alias;
  const field = detail?.matched_field;
  if (!alias || !field) return example;

  let sourceText = "";
  if (field === "title") {
    sourceText = example.normalized_title || example.title || "";
  } else if (field === "excerpt") {
    sourceText = example.normalized_excerpt || "";
  } else if (field === "lead") {
    sourceText = compactSpace(example.normalized_content || "").slice(0, 900);
  } else if (field === "body") {
    sourceText = compactSpace(example.normalized_content || "").slice(900);
  }

  const matchContext = detail.match_context || aliasContext(sourceText, alias);
  const enrichedDetail = { ...detail, match_context: matchContext || null };

  const {
    normalized_title,
    normalized_excerpt,
    normalized_content,
    ...publicExample
  } = example;

  return {
    ...publicExample,
    match_context: matchContext || null,
    reason_detail: JSON.stringify(enrichedDetail)
  };
}

export function assessClubRelevance({ relationType, aliases, title, excerpt, content }) {
  if (relationType === "direct") {
    return { decision: "relevant", reason_code: "direct_club_source" };
  }

  const evidence = buildAliasEvidence(aliases, title, excerpt, content);
  const strong = evidence.filter((item) => item.strength === "strong");
  const weak = evidence.filter((item) => item.strength !== "strong");

  const titleStrong = strong.find((item) => item.title > 0);
  if (titleStrong) {
    return {
      decision: "relevant",
      reason_code: "strong_alias_title",
      reason_detail: detailFor(titleStrong, "title")
    };
  }

  const excerptStrong = strong.find((item) => item.excerpt > 0);
  if (excerptStrong) {
    return {
      decision: "relevant",
      reason_code: "strong_alias_excerpt",
      reason_detail: detailFor(excerptStrong, "excerpt")
    };
  }

  const leadStrong = strong.find((item) => item.lead > 0);
  if (leadStrong) {
    return {
      decision: "relevant",
      reason_code: "strong_alias_lead",
      reason_detail: detailFor(leadStrong, "lead")
    };
  }

  const bodyStrong = strong.find((item) => item.body_after_lead > 0);
  if (bodyStrong) {
    return {
      decision: "needs_review",
      reason_code: bodyStrong.body > 1 ? "strong_alias_body_repeated" : "strong_alias_body_only",
      reason_detail: detailFor(bodyStrong, "body")
    };
  }

  const titleWeak = weak.find((item) => item.title > 0);
  if (titleWeak) {
    return {
      decision: "needs_review",
      reason_code: "weak_alias_title",
      reason_detail: detailFor(titleWeak, "title")
    };
  }

  const excerptWeak = weak.find((item) => item.excerpt > 0);
  if (excerptWeak) {
    return {
      decision: "needs_review",
      reason_code: "weak_alias_excerpt",
      reason_detail: detailFor(excerptWeak, "excerpt")
    };
  }

  const leadWeak = weak.find((item) => item.lead > 0 && item.body_after_lead === 0);
  if (leadWeak) {
    return {
      decision: "needs_review",
      reason_code: "weak_alias_lead",
      reason_detail: detailFor(leadWeak, "lead")
    };
  }

  return { decision: "rejected", reason_code: "club_not_relevant" };
}

async function fetchArticlePage(url, timeoutMs = 12000) {
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
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function structuredExtraction(article) {
  return {
    extraction_method: "collected_metadata",
    normalized_title: compactSpace(article.title),
    normalized_author: compactSpace(article.author) || null,
    normalized_published_at: article.published_at || null,
    normalized_excerpt: compactSpace(article.excerpt) || null,
    normalized_content: compactSpace(article.raw_content) || null,
    normalized_image_url: article.image_url || null
  };
}

function htmlExtraction(article, html) {
  const title =
    metaContent(html, /^(?:og:title|twitter:title)$/i) ||
    firstTagText(html, ["h1", "title"]) ||
    article.title ||
    null;

  const excerpt =
    metaContent(html, /^(?:description|og:description|twitter:description)$/i) ||
    article.excerpt ||
    null;

  const author =
    metaContent(html, /^(?:author|article:author)$/i) ||
    article.author ||
    null;

  const publishedAt =
    metaContent(html, /^(?:article:published_time|date|datepublished)$/i) ||
    article.published_at ||
    null;

  const image =
    metaContent(html, /^(?:og:image|twitter:image)$/i) ||
    article.image_url ||
    null;

  return {
    extraction_method: "html_page",
    normalized_title: compactSpace(title) || null,
    normalized_author: compactSpace(author) || null,
    normalized_published_at: publishedAt || null,
    normalized_excerpt: compactSpace(excerpt) || null,
    normalized_content: extractMainText(html) || null,
    normalized_image_url: image || null
  };
}

async function getClubCandidates(db, sourceId) {
  const { results } = await db.prepare(
    `SELECT c.id AS club_id, cs.relation_type
     FROM club_sources cs
     JOIN clubs c ON c.id = cs.club_id
     WHERE cs.source_id = ? AND c.active = 1
     ORDER BY cs.priority ASC, c.id ASC`
  ).bind(sourceId).all();
  return results || [];
}

async function getAliases(db, clubId) {
  const { results } = await db.prepare(
    `SELECT alias, strength
     FROM club_aliases
     WHERE club_id = ?
     ORDER BY CASE strength WHEN 'strong' THEN 0 ELSE 1 END, length(alias) DESC`
  ).bind(clubId).all();
  return results || [];
}

async function findCurrentExtraction(db, article) {
  return db.prepare(
    `SELECT *
     FROM article_extractions
     WHERE article_id = ? AND source_content_hash = ? AND extractor_version = ?
     ORDER BY id DESC
     LIMIT 1`
  ).bind(article.id, article.content_hash || "", EXTRACTOR_VERSION).first();
}

async function saveExtraction(db, article, extraction, status, error = null) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO article_extractions
      (article_id, source_content_hash, extractor_version, status, extraction_method,
       normalized_title, normalized_author, normalized_published_at,
       normalized_excerpt, normalized_content, normalized_image_url,
       extracted_at, error_code, error_detail, retry_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id, source_content_hash, extractor_version) DO UPDATE SET
       status = excluded.status,
       extraction_method = excluded.extraction_method,
       normalized_title = excluded.normalized_title,
       normalized_author = excluded.normalized_author,
       normalized_published_at = excluded.normalized_published_at,
       normalized_excerpt = excluded.normalized_excerpt,
       normalized_content = excluded.normalized_content,
       normalized_image_url = excluded.normalized_image_url,
       extracted_at = excluded.extracted_at,
       error_code = excluded.error_code,
       error_detail = excluded.error_detail,
       retry_after = excluded.retry_after,
       updated_at = excluded.updated_at`
  ).bind(
    article.id,
    article.content_hash || "",
    EXTRACTOR_VERSION,
    status,
    extraction.extraction_method,
    extraction.normalized_title,
    extraction.normalized_author,
    extraction.normalized_published_at,
    extraction.normalized_excerpt,
    extraction.normalized_content,
    extraction.normalized_image_url,
    status === "completed" ? now : null,
    error?.code || null,
    error?.detail || null,
    error?.retry_after || null,
    now,
    now
  ).run();

  return findCurrentExtraction(db, article);
}

async function extractArticle(db, article) {
  const existing = await findCurrentExtraction(db, article);
  if (existing?.status === "completed") return { extraction: existing, reused: true };
  if (existing?.status === "retry" && existing.retry_after && existing.retry_after > new Date().toISOString()) {
    return { extraction: existing, reused: true };
  }

  let extraction = structuredExtraction(article);
  let technical = classifyTechnicalArticle(article, extraction);
  if (technical.status === "usable" || technical.status === "rejected") {
    const saved = await saveExtraction(db, article, extraction, "completed");
    return { extraction: saved, reused: false, technical };
  }

  try {
    const page = await fetchArticlePage(article.canonical_url || article.url);
    if (!page.ok) {
      const retryAfter = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const saved = await saveExtraction(db, article, extraction, "retry", {
        code: "http_error",
        detail: "HTTP " + page.status,
        retry_after: retryAfter
      });
      return { extraction: saved, reused: false, technical: { status: "retry", reason_code: "http_error" } };
    }

    extraction = htmlExtraction(article, page.text);
    technical = classifyTechnicalArticle(article, extraction);
    const saved = await saveExtraction(db, article, extraction, "completed");
    return { extraction: saved, reused: false, technical };
  } catch (error) {
    const retryAfter = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const saved = await saveExtraction(db, article, extraction, "retry", {
      code: "fetch_failed",
      detail: String(error?.message || error),
      retry_after: retryAfter
    });
    return { extraction: saved, reused: false, technical: { status: "retry", reason_code: "fetch_failed" } };
  }
}

async function saveAssessment(db, article, clubId, result) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO article_club_assessments
      (article_id, club_id, source_content_hash, rule_version,
       decision, reason_code, reason_detail, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id, club_id, source_content_hash, rule_version) DO UPDATE SET
       decision = excluded.decision,
       reason_code = excluded.reason_code,
       reason_detail = excluded.reason_detail,
       decided_at = excluded.decided_at`
  ).bind(
    article.id,
    clubId,
    article.content_hash || "",
    RULE_VERSION,
    result.decision,
    result.reason_code || null,
    result.reason_detail || null,
    now
  ).run();
}

async function hasCurrentAssessment(db, article, clubId) {
  return db.prepare(
    `SELECT id, decision, reason_code
     FROM article_club_assessments
     WHERE article_id = ? AND club_id = ? AND source_content_hash = ? AND rule_version = ?
     LIMIT 1`
  ).bind(article.id, clubId, article.content_hash || "", RULE_VERSION).first();
}

async function loadCandidates(db, limit) {
  const { results } = await db.prepare(
    `SELECT r.*
     FROM raw_articles r
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
           AND EXISTS (
             SELECT 1 FROM club_sources cs
             WHERE cs.source_id = r.source_id
               AND NOT EXISTS (
                 SELECT 1 FROM article_club_assessments a
                 WHERE a.article_id = r.id
                   AND a.club_id = cs.club_id
                   AND a.source_content_hash = r.content_hash
                   AND a.rule_version = ?
               )
           )
         )
       )
     ORDER BY r.last_seen_at ASC
     LIMIT ?`
  ).bind(EXTRACTOR_VERSION, EXTRACTOR_VERSION, new Date().toISOString(), EXTRACTOR_VERSION, RULE_VERSION, limit).all();
  return results || [];
}

function coarseStatus(summary) {
  if (summary.retry > 0 || summary.failed > 0) return "phase_a_retry";
  if (summary.ready > 0) return "phase_a_ready";
  if (summary.needs_review > 0) return "phase_a_review";
  if (summary.rejected > 0) return "phase_a_rejected";
  return "phase_a_processed";
}

export async function processPhaseA(db, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || 25)));

  // A Worker can be interrupted before it reaches the final UPDATE. Keep
  // observability honest: a run still marked running after one hour is stale.
  const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recoveredAt = new Date().toISOString();
  await db.prepare(
    `UPDATE processing_runs
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
  const candidates = await loadCandidates(db, limit);

  const totals = {
    candidates: candidates.length,
    processed: 0,
    relevant: 0,
    rejected: 0,
    needs_review: 0,
    extracted: 0,
    ready: 0,
    retry: 0,
    failed: 0
  };
  const examples = [];

  await db.prepare(
    `INSERT INTO processing_runs (id, started_at, status, candidates)
     VALUES (?, ?, 'running', ?)`
  ).bind(runId, startedAt, candidates.length).run();

  for (const article of candidates) {
    const perArticle = { relevant: 0, rejected: 0, needs_review: 0, ready: 0, retry: 0, failed: 0 };
    try {
      const extractionResult = await extractArticle(db, article);
      const extraction = extractionResult.extraction;
      const technical = extractionResult.technical || classifyTechnicalArticle(article, extraction);

      if (extraction?.status === "completed") totals.extracted++;
      if (extraction?.status === "retry" || technical.status === "retry") {
        totals.retry++;
        perArticle.retry++;
        await db.prepare("UPDATE raw_articles SET processing_status = 'phase_a_retry' WHERE id = ?")
          .bind(article.id).run();
        totals.processed++;
        continue;
      }

      const clubs = await getClubCandidates(db, article.source_id);
      if (!clubs.length) {
        totals.rejected++;
        perArticle.rejected++;
        await db.prepare("UPDATE raw_articles SET processing_status = 'phase_a_rejected' WHERE id = ?")
          .bind(article.id).run();
        totals.processed++;
        continue;
      }

      for (const club of clubs) {
        const existing = await hasCurrentAssessment(db, article, club.club_id);
        if (existing) {
          if (existing.decision === "relevant") {
            totals.relevant++;
            totals.ready++;
            perArticle.relevant++;
            perArticle.ready++;
          } else if (existing.decision === "needs_review") {
            totals.needs_review++;
            perArticle.needs_review++;
          } else {
            totals.rejected++;
            perArticle.rejected++;
          }
          continue;
        }

        let result;
        if (technical.status === "rejected") {
          result = { decision: "rejected", reason_code: technical.reason_code };
        } else if (technical.status === "needs_content") {
          result = { decision: "needs_review", reason_code: technical.reason_code };
        } else {
          const aliases = await getAliases(db, club.club_id);
          result = assessClubRelevance({
            relationType: club.relation_type,
            aliases,
            title: extraction.normalized_title,
            excerpt: extraction.normalized_excerpt,
            content: extraction.normalized_content
          });
        }

        await saveAssessment(db, article, club.club_id, result);

        if (result.decision === "relevant") {
          totals.relevant++;
          totals.ready++;
          perArticle.relevant++;
          perArticle.ready++;
        } else if (result.decision === "needs_review") {
          totals.needs_review++;
          perArticle.needs_review++;
        } else {
          totals.rejected++;
          perArticle.rejected++;
        }
      }

      await db.prepare("UPDATE raw_articles SET processing_status = ? WHERE id = ?")
        .bind(coarseStatus(perArticle), article.id).run();
      totals.processed++;

      if (examples.length < 8) {
        examples.push({
          article_id: article.id,
          source_id: article.source_id,
          title: extraction.normalized_title,
          status: coarseStatus(perArticle)
        });
      }
    } catch (error) {
      totals.failed++;
      perArticle.failed++;
      totals.processed++;
      await db.prepare("UPDATE raw_articles SET processing_status = 'phase_a_retry' WHERE id = ?")
        .bind(article.id).run();
      if (examples.length < 8) {
        examples.push({
          article_id: article.id,
          source_id: article.source_id,
          title: article.title,
          status: "phase_a_retry",
          error: String(error?.message || error)
        });
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const status = totals.failed === candidates.length && candidates.length ? "failed" : (totals.failed || totals.retry ? "partial" : "success");

  await db.prepare(
    `UPDATE processing_runs SET
       finished_at = ?, status = ?, processed = ?, relevant = ?, rejected = ?,
       needs_review = ?, extracted = ?, ready = ?, retry = ?, failed = ?, notes = ?
     WHERE id = ?`
  ).bind(
    finishedAt,
    status,
    totals.processed,
    totals.relevant,
    totals.rejected,
    totals.needs_review,
    totals.extracted,
    totals.ready,
    totals.retry,
    totals.failed,
    JSON.stringify({ examples }),
    runId
  ).run();

  return {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    ...totals,
    examples
  };
}


export async function drainPhaseA(db, options = {}) {
  const chunkSize = Math.max(1, Math.min(50, Number(options.chunkSize || 25)));
  const maxDurationMs = Math.max(1000, Number(options.maxDurationMs || 45000));
  const startedAtMs = Date.now();

  const totals = {
    chunks: 0,
    candidates: 0,
    processed: 0,
    relevant: 0,
    rejected: 0,
    needs_review: 0,
    extracted: 0,
    ready: 0,
    retry: 0,
    failed: 0
  };
  const runs = [];
  let stopReason = "empty";

  while (true) {
    if (Date.now() - startedAtMs >= maxDurationMs) {
      stopReason = "time_guard";
      break;
    }

    const run = await processPhaseA(db, { limit: chunkSize });
    runs.push(run);
    totals.chunks++;
    totals.candidates += Number(run.candidates || 0);
    totals.processed += Number(run.processed || 0);
    totals.relevant += Number(run.relevant || 0);
    totals.rejected += Number(run.rejected || 0);
    totals.needs_review += Number(run.needs_review || 0);
    totals.extracted += Number(run.extracted || 0);
    totals.ready += Number(run.ready || 0);
    totals.retry += Number(run.retry || 0);
    totals.failed += Number(run.failed || 0);

    if (!run.candidates) {
      stopReason = "empty";
      break;
    }

    if (run.candidates < chunkSize) {
      stopReason = "drained";
      break;
    }
  }

  return {
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date().toISOString(),
    chunk_size: chunkSize,
    max_duration_ms: maxDurationMs,
    stop_reason: stopReason,
    ...totals,
    runs
  };
}


function compactAuditExample(example, clubId) {
  const enriched = enrichDiagnosticExample(example);
  let detail = null;
  try {
    detail = enriched?.reason_detail ? JSON.parse(enriched.reason_detail) : null;
  } catch {
    detail = null;
  }

  return {
    club_id: clubId,
    source_id: enriched?.source_id || null,
    title: enriched?.title || null,
    reason_code: enriched?.reason_code || null,
    matched_alias: detail?.matched_alias || null,
    matched_field: detail?.matched_field || null,
    match_context: enriched?.match_context || detail?.match_context || null,
    url: enriched?.url || null
  };
}

export async function getRelevanceAudit(db, clubId = "ol", exampleLimit = 50, options = {}) {
  const { results: reasonCounts } = await db.prepare(
    `SELECT a.reason_code, COUNT(*) AS count
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     WHERE a.club_id = ?
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = ?
       AND a.decision = 'relevant'
       AND a.reason_code IN ('strong_alias_lead', 'strong_alias_excerpt')
     GROUP BY a.reason_code
     ORDER BY count DESC, a.reason_code ASC`
  ).bind(clubId, RULE_VERSION).all();

  const { results: sourceCounts } = await db.prepare(
    `SELECT r.source_id, a.reason_code, COUNT(*) AS count
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     WHERE a.club_id = ?
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = ?
       AND a.decision = 'relevant'
       AND a.reason_code IN ('strong_alias_lead', 'strong_alias_excerpt')
     GROUP BY r.source_id, a.reason_code
     ORDER BY count DESC, r.source_id ASC, a.reason_code ASC`
  ).bind(clubId, RULE_VERSION).all();

  const { results: examples } = await db.prepare(
    `SELECT r.id, r.source_id, r.title, r.canonical_url AS url,
            a.decision, a.reason_code, a.reason_detail, a.decided_at,
            e.normalized_title, e.normalized_excerpt, e.normalized_content
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     LEFT JOIN article_extractions e
       ON e.article_id = r.id
      AND e.source_content_hash = r.content_hash
      AND e.extractor_version = ?
      AND e.status = 'completed'
     WHERE a.club_id = ?
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = ?
       AND a.decision = 'relevant'
       AND a.reason_code IN ('strong_alias_lead', 'strong_alias_excerpt')
     ORDER BY a.decided_at DESC
     LIMIT ?`
  ).bind(EXTRACTOR_VERSION, clubId, RULE_VERSION, exampleLimit).all();

  return {
    club_id: clubId,
    relevance_rules: RULE_VERSION,
    audited_reasons: ["strong_alias_lead", "strong_alias_excerpt"],
    reason_counts: reasonCounts || [],
    source_counts: sourceCounts || [],
    examples: options.compact
      ? (examples || []).map((example) => compactAuditExample(example, clubId))
      : (examples || []).map(enrichDiagnosticExample)
  };
}

export function previewV3Decision(decision, reasonCode) {
  if (
    decision === "relevant" &&
    (reasonCode === "strong_alias_excerpt" || reasonCode === "strong_alias_lead")
  ) {
    return {
      decision: "needs_review",
      reason_code: reasonCode === "strong_alias_excerpt"
        ? "strong_alias_excerpt_role_review"
        : "strong_alias_lead_role_review"
    };
  }

  return {
    decision,
    reason_code: reasonCode
  };
}

export async function getRelevanceV3Preview(db, clubId = "ol", exampleLimit = 100) {
  const counts = await db.prepare(
    `SELECT
       SUM(CASE WHEN a.decision = 'relevant' THEN 1 ELSE 0 END) AS current_relevant,
       SUM(CASE WHEN a.decision = 'needs_review' THEN 1 ELSE 0 END) AS current_needs_review,
       SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS current_rejected,
       SUM(CASE WHEN a.decision = 'relevant' AND a.reason_code = 'strong_alias_excerpt' THEN 1 ELSE 0 END) AS excerpt_to_review,
       SUM(CASE WHEN a.decision = 'relevant' AND a.reason_code = 'strong_alias_lead' THEN 1 ELSE 0 END) AS lead_to_review
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     WHERE a.club_id = ?
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = ?`
  ).bind(clubId, RULE_VERSION).first();

  const currentRelevant = Number(counts?.current_relevant || 0);
  const currentReview = Number(counts?.current_needs_review || 0);
  const currentRejected = Number(counts?.current_rejected || 0);
  const excerptToReview = Number(counts?.excerpt_to_review || 0);
  const leadToReview = Number(counts?.lead_to_review || 0);
  const movedToReview = excerptToReview + leadToReview;

  const { results: examples } = await db.prepare(
    `SELECT r.id, r.source_id, r.title, r.canonical_url AS url,
            a.decision, a.reason_code, a.reason_detail, a.decided_at,
            e.normalized_title, e.normalized_excerpt, e.normalized_content
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     LEFT JOIN article_extractions e
       ON e.article_id = r.id
      AND e.source_content_hash = r.content_hash
      AND e.extractor_version = ?
      AND e.status = 'completed'
     WHERE a.club_id = ?
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = ?
       AND a.decision = 'relevant'
       AND a.reason_code IN ('strong_alias_excerpt', 'strong_alias_lead')
     ORDER BY a.decided_at DESC
     LIMIT ?`
  ).bind(EXTRACTOR_VERSION, clubId, RULE_VERSION, exampleLimit).all();

  return {
    club_id: clubId,
    current_rule_version: RULE_VERSION,
    preview_rule_version: "phase-a-relevance-v3-preview",
    policy: {
      direct_club_source: "relevant",
      strong_alias_title: "relevant",
      strong_alias_excerpt: "needs_review",
      strong_alias_lead: "needs_review",
      body_and_weak_alias_rules: "unchanged"
    },
    current_counts: {
      relevant: currentRelevant,
      needs_review: currentReview,
      rejected: currentRejected
    },
    preview_counts: {
      relevant: Math.max(0, currentRelevant - movedToReview),
      needs_review: currentReview + movedToReview,
      rejected: currentRejected
    },
    moved_to_review: {
      total: movedToReview,
      strong_alias_excerpt: excerptToReview,
      strong_alias_lead: leadToReview
    },
    changed_examples: (examples || []).map((example) => {
      const enriched = enrichDiagnosticExample(example);
      let detail = null;
      try {
        detail = enriched?.reason_detail ? JSON.parse(enriched.reason_detail) : null;
      } catch {
        detail = null;
      }
      const preview = previewV3Decision(enriched.decision, enriched.reason_code);
      return {
        id: enriched.id,
        club_id: clubId,
        source_id: enriched.source_id,
        title: enriched.title,
        url: enriched.url,
        current_decision: enriched.decision,
        current_reason_code: enriched.reason_code,
        preview_decision: preview.decision,
        preview_reason_code: preview.reason_code,
        matched_alias: detail?.matched_alias || null,
        matched_field: detail?.matched_field || null,
        match_context: enriched.match_context || detail?.match_context || null
      };
    })
  };
}

export async function runRoleClassifierPreview(db, env, clubId = "ol", exampleLimit = 20) {
  const club = await db.prepare(
    `SELECT id, name FROM clubs WHERE id = ? AND active = 1 LIMIT 1`
  ).bind(clubId).first();

  if (!club) {
    return {
      club_id: clubId,
      classifier_version: ROLE_CLASSIFIER_VERSION,
      error: "unknown_club",
      count: 0,
      results: []
    };
  }

  const aliases = await getAliases(db, clubId);

  const { results: rows } = await db.prepare(
    `SELECT r.id, r.source_id, r.title, r.canonical_url AS url,
            a.reason_code, a.reason_detail,
            e.normalized_title, e.normalized_excerpt, e.normalized_content
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     LEFT JOIN article_extractions e
       ON e.article_id = r.id
      AND e.source_content_hash = r.content_hash
      AND e.extractor_version = ?
      AND e.status = 'completed'
     WHERE a.club_id = ?
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = ?
       AND a.decision = 'relevant'
       AND a.reason_code IN ('strong_alias_excerpt', 'strong_alias_lead')
     ORDER BY a.decided_at DESC
     LIMIT ?`
  ).bind(EXTRACTOR_VERSION, clubId, RULE_VERSION, exampleLimit).all();

  const inputs = (rows || []).map((row) => {
    let detail = null;
    try {
      detail = row.reason_detail ? JSON.parse(row.reason_detail) : null;
    } catch {
      detail = null;
    }

    return {
      row,
      input: {
        club_id: clubId,
        club_name: club.name,
        aliases: aliases.map((entry) => entry.alias),
        title: row.normalized_title || row.title || "",
        excerpt: row.normalized_excerpt || "",
        lead: compactSpace(row.normalized_content || "").slice(0, 900),
        matched_alias: detail?.matched_alias || null,
        matched_field: detail?.matched_field || null,
        match_context: detail?.match_context || null
      }
    };
  });

  const classified = [];
  for (const { row, input } of inputs) {
    const classification = await classifyRoleWithProvider(env, input);
    const preview = classification.error
      ? { decision: "needs_review", reason_code: "role_classifier_error" }
      : rolePreviewDecision(classification);

    classified.push({
      id: row.id,
      club_id: clubId,
      source_id: row.source_id,
      title: row.title,
      url: row.url,
      current_reason_code: row.reason_code,
      matched_alias: input.matched_alias,
      matched_field: input.matched_field,
      match_context: input.match_context,
      classification,
      preview_decision: preview.decision,
      preview_reason_code: preview.reason_code
    });
  }

  const summary = {
    relevant: classified.filter((item) => item.preview_decision === "relevant").length,
    rejected: classified.filter((item) => item.preview_decision === "rejected").length,
    needs_review: classified.filter((item) => item.preview_decision === "needs_review").length,
    errors: classified.filter((item) => item.classification?.error).length
  };

  return {
    club_id: clubId,
    club_name: club.name,
    classifier_version: ROLE_CLASSIFIER_VERSION,
    configured: Boolean(
      env.ROLE_CLASSIFIER_BASE_URL &&
      env.ROLE_CLASSIFIER_MODEL &&
      env.ROLE_CLASSIFIER_API_KEY
    ),
    bindings: {
      base_url: Boolean(env.ROLE_CLASSIFIER_BASE_URL),
      model: Boolean(env.ROLE_CLASSIFIER_MODEL),
      api_key: Boolean(env.ROLE_CLASSIFIER_API_KEY)
    },
    count: classified.length,
    summary,
    results: classified
  };
}

export async function getProcessingDiagnostics(db, clubId = "ol", exampleLimit = 8, filters = {}) {
  const decisionFilter = filters.decision || null;
  const extractionStatusFilter = filters.extractionStatus || null;
  const waiting = await db.prepare(
    `SELECT COUNT(*) AS n
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
  ).bind(
    clubId,
    EXTRACTOR_VERSION,
    EXTRACTOR_VERSION,
    new Date().toISOString(),
    EXTRACTOR_VERSION,
    clubId,
    RULE_VERSION
  ).first();

  const counts = await db.prepare(
    `SELECT
       SUM(CASE WHEN a.decision = 'relevant' THEN 1 ELSE 0 END) AS relevant,
       SUM(CASE WHEN a.decision = 'rejected' THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN a.decision = 'needs_review' THEN 1 ELSE 0 END) AS needs_review
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     WHERE a.club_id = ?
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = ?`
  ).bind(clubId, RULE_VERSION).first();

  const ready = await db.prepare(
    `SELECT COUNT(*) AS n
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     JOIN article_extractions e
       ON e.article_id = r.id
      AND e.source_content_hash = r.content_hash
      AND e.extractor_version = ?
      AND e.status = 'completed'
     WHERE a.club_id = ?
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = ?
       AND a.decision = 'relevant'`
  ).bind(EXTRACTOR_VERSION, clubId, RULE_VERSION).first();

  const { results: reasons } = await db.prepare(
    `SELECT a.decision, COALESCE(a.reason_code, 'unspecified') AS reason_code, COUNT(*) AS count
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     WHERE a.club_id = ?
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = ?
     GROUP BY a.decision, COALESCE(a.reason_code, 'unspecified')
     ORDER BY count DESC, reason_code ASC
     LIMIT 20`
  ).bind(clubId, RULE_VERSION).all();

  let examples;
  if (extractionStatusFilter) {
    let sql = `SELECT r.id, r.source_id, r.title, r.canonical_url AS url,
                      a.decision, a.reason_code, a.reason_detail,
                      e.normalized_title, e.normalized_excerpt, e.normalized_content,
                      e.status AS extraction_status,
                      e.error_code, e.error_detail, e.retry_after, e.updated_at
               FROM raw_articles r
               JOIN article_extractions e
                 ON e.article_id = r.id
                AND e.source_content_hash = r.content_hash
                AND e.extractor_version = ?
               LEFT JOIN article_club_assessments a
                 ON a.article_id = r.id
                AND a.club_id = ?
                AND a.source_content_hash = r.content_hash
                AND a.rule_version = ?
               WHERE e.status = ?`;
    const bindings = [EXTRACTOR_VERSION, clubId, RULE_VERSION, extractionStatusFilter];

    if (decisionFilter) {
      sql += " AND a.decision = ?";
      bindings.push(decisionFilter);
    }

    sql += " ORDER BY e.updated_at DESC LIMIT ?";
    bindings.push(exampleLimit);
    ({ results: examples } = await db.prepare(sql).bind(...bindings).all());
  } else {
    let sql = `SELECT r.id, r.source_id, r.title, r.canonical_url AS url,
                      a.decision, a.reason_code, a.reason_detail, a.decided_at,
                      e.normalized_title, e.normalized_excerpt, e.normalized_content
               FROM article_club_assessments a
               JOIN raw_articles r ON r.id = a.article_id
               LEFT JOIN article_extractions e
                 ON e.article_id = r.id
                AND e.source_content_hash = r.content_hash
                AND e.extractor_version = ?
                AND e.status = 'completed'
               WHERE a.club_id = ?
                 AND a.source_content_hash = r.content_hash
                 AND a.rule_version = ?`;
    const bindings = [EXTRACTOR_VERSION, clubId, RULE_VERSION];

    if (decisionFilter) {
      sql += " AND a.decision = ?";
      bindings.push(decisionFilter);
    }

    sql += " ORDER BY a.decided_at DESC LIMIT ?";
    bindings.push(exampleLimit);
    ({ results: examples } = await db.prepare(sql).bind(...bindings).all());
  }

  const latestRun = await db.prepare(
    `SELECT id, started_at, finished_at, status, candidates, processed,
            relevant, rejected, needs_review, extracted, ready, retry, failed
     FROM processing_runs
     ORDER BY started_at DESC
     LIMIT 1`
  ).first();

  return {
    club_id: clubId,
    versions: { extractor: EXTRACTOR_VERSION, relevance_rules: RULE_VERSION },
    filters: {
      decision: decisionFilter,
      extraction_status: extractionStatusFilter
    },
    waiting: Number(waiting?.n || 0),
    relevant: Number(counts?.relevant || 0),
    rejected: Number(counts?.rejected || 0),
    needs_review: Number(counts?.needs_review || 0),
    ready: Number(ready?.n || 0),
    reasons: reasons || [],
    examples: (examples || []).map(enrichDiagnosticExample),
    latest_run: latestRun || null
  };
}
