import fs from 'node:fs';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const inputPath = process.argv[2] || 'content-enrichment/candidates.json';
const sqlPath = process.argv[3] || 'content-enrichment/apply.sql';
const summaryPath = process.argv[4] || 'content-enrichment/summary.json';
const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const USER_AGENT = 'ClubActuBot/0.2 (+https://github.com/Keryas777/Club-Actu)';
const MIN_CHARS = 200;
const MAX_CHARS = 40000;

function sqlString(value) {
  if (value == null) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeBlockText(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function articleHtmlToText(html, url) {
  const dom = new JSDOM(html, { url });
  const parsed = new Readability(dom.window.document).parse();
  if (!parsed) return { text: '', title: '', method: 'readability' };

  let text = '';
  if (parsed.content) {
    const contentDom = new JSDOM(`<body>${parsed.content}</body>`, { url });
    const doc = contentDom.window.document;
    const blocks = [...doc.querySelectorAll('h2,h3,h4,p,blockquote,li')]
      .map((node) => normalizeBlockText(node.textContent || ''))
      .filter((value) => value.length >= 2);
    if (blocks.length) text = blocks.join('\n\n');
  }
  if (!text) text = normalizeBlockText(parsed.textContent || '');

  return {
    text: normalizeBlockText(text).slice(0, MAX_CHARS),
    title: normalizeBlockText(parsed.title || ''),
    method: 'readability'
  };
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
      }
    });
    const html = await response.text();
    return { response, html };
  } finally {
    clearTimeout(timer);
  }
}

const now = new Date().toISOString();
const statements = ['BEGIN TRANSACTION;'];
const results = [];

for (const row of rows) {
  const base = {
    article_id: row.id,
    source_id: row.source_id,
    url: row.url,
    source_content_hash: row.source_content_hash
  };

  if (row.source_id === 'ol_official') {
    const result = {
      ...base,
      status: 'failed',
      extraction_method: 'specific_required',
      http_status: null,
      chars: 0,
      error_code: 'specific_extractor_required'
    };
    results.push(result);
    statements.push(`INSERT INTO article_content_enrichments (article_id,source_content_hash,status,extraction_method,http_status,fetched_at,error_code,error_detail,retry_after,updated_at) VALUES (${sqlString(row.id)},${sqlString(row.source_content_hash)},'failed','specific_required',NULL,${sqlString(now)},'specific_extractor_required','OL official pages require the structured API path',NULL,${sqlString(now)}) ON CONFLICT(article_id) DO UPDATE SET source_content_hash=excluded.source_content_hash,status=excluded.status,extraction_method=excluded.extraction_method,content_text=NULL,content_hash=NULL,http_status=NULL,fetched_at=excluded.fetched_at,error_code=excluded.error_code,error_detail=excluded.error_detail,retry_after=NULL,updated_at=excluded.updated_at;`);
    continue;
  }

  try {
    const { response, html } = await fetchHtml(row.url);
    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      const retryAfter = retryable ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null;
      const status = retryable ? 'retry' : 'failed';
      results.push({ ...base, status, http_status: response.status, chars: 0, error_code: `http_${response.status}` });
      statements.push(`INSERT INTO article_content_enrichments (article_id,source_content_hash,status,extraction_method,http_status,fetched_at,error_code,error_detail,retry_after,updated_at) VALUES (${sqlString(row.id)},${sqlString(row.source_content_hash)},${sqlString(status)},'readability',${Number(response.status)},${sqlString(now)},${sqlString(`http_${response.status}`)},NULL,${sqlString(retryAfter)},${sqlString(now)}) ON CONFLICT(article_id) DO UPDATE SET source_content_hash=excluded.source_content_hash,status=excluded.status,extraction_method=excluded.extraction_method,content_text=NULL,content_hash=NULL,http_status=excluded.http_status,fetched_at=excluded.fetched_at,error_code=excluded.error_code,error_detail=NULL,retry_after=excluded.retry_after,updated_at=excluded.updated_at;`);
      continue;
    }

    const extracted = articleHtmlToText(html, response.url || row.url);
    if (extracted.text.length < MIN_CHARS) {
      results.push({ ...base, status: 'failed', http_status: response.status, chars: extracted.text.length, error_code: 'content_too_short' });
      statements.push(`INSERT INTO article_content_enrichments (article_id,source_content_hash,status,extraction_method,http_status,fetched_at,error_code,error_detail,retry_after,updated_at) VALUES (${sqlString(row.id)},${sqlString(row.source_content_hash)},'failed','readability',${Number(response.status)},${sqlString(now)},'content_too_short',${sqlString(`Readability returned ${extracted.text.length} chars`)},NULL,${sqlString(now)}) ON CONFLICT(article_id) DO UPDATE SET source_content_hash=excluded.source_content_hash,status=excluded.status,extraction_method=excluded.extraction_method,content_text=NULL,content_hash=NULL,http_status=excluded.http_status,fetched_at=excluded.fetched_at,error_code=excluded.error_code,error_detail=excluded.error_detail,retry_after=NULL,updated_at=excluded.updated_at;`);
      continue;
    }

    const contentHash = sha256(extracted.text);
    results.push({ ...base, status: 'completed', http_status: response.status, chars: extracted.text.length, content_hash: contentHash, extraction_method: extracted.method });
    statements.push(`INSERT INTO article_content_enrichments (article_id,source_content_hash,status,extraction_method,content_text,content_hash,http_status,fetched_at,error_code,error_detail,retry_after,updated_at) VALUES (${sqlString(row.id)},${sqlString(row.source_content_hash)},'completed','readability',${sqlString(extracted.text)},${sqlString(contentHash)},${Number(response.status)},${sqlString(now)},NULL,NULL,NULL,${sqlString(now)}) ON CONFLICT(article_id) DO UPDATE SET source_content_hash=excluded.source_content_hash,status='completed',extraction_method='readability',content_text=excluded.content_text,content_hash=excluded.content_hash,http_status=excluded.http_status,fetched_at=excluded.fetched_at,error_code=NULL,error_detail=NULL,retry_after=NULL,updated_at=excluded.updated_at;`);
  } catch (error) {
    const retryAfter = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const detail = String(error?.name === 'AbortError' ? 'fetch timeout' : (error?.message || error)).slice(0, 400);
    results.push({ ...base, status: 'retry', http_status: null, chars: 0, error_code: 'fetch_error', error_detail: detail });
    statements.push(`INSERT INTO article_content_enrichments (article_id,source_content_hash,status,extraction_method,http_status,fetched_at,error_code,error_detail,retry_after,updated_at) VALUES (${sqlString(row.id)},${sqlString(row.source_content_hash)},'retry','readability',NULL,${sqlString(now)},'fetch_error',${sqlString(detail)},${sqlString(retryAfter)},${sqlString(now)}) ON CONFLICT(article_id) DO UPDATE SET source_content_hash=excluded.source_content_hash,status='retry',extraction_method='readability',content_text=NULL,content_hash=NULL,http_status=NULL,fetched_at=excluded.fetched_at,error_code='fetch_error',error_detail=excluded.error_detail,retry_after=excluded.retry_after,updated_at=excluded.updated_at;`);
  }
}

statements.push('COMMIT;');
fs.writeFileSync(sqlPath, statements.join('\n') + '\n');

const counts = results.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] || 0) + 1;
  return acc;
}, {});
const bySource = {};
for (const item of results) {
  bySource[item.source_id] ||= { completed: 0, retry: 0, failed: 0, chars: [] };
  bySource[item.source_id][item.status] = (bySource[item.source_id][item.status] || 0) + 1;
  if (item.chars) bySource[item.source_id].chars.push(item.chars);
}
for (const value of Object.values(bySource)) {
  const sorted = value.chars.sort((a, b) => a - b);
  value.median_chars = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  delete value.chars;
}

const summary = { generated_at: now, candidates: rows.length, counts, by_source: bySource, results };
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ candidates: rows.length, counts, by_source: bySource }, null, 2));
