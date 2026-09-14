import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupe, representation, shortlistContext, shortlist } from './benchmark-meridian-bge-m3.mjs';

const MODEL = '@cf/baai/bge-m3';
const CLUBS = ['ol', 'psg', 'om'];

const norm = (v = '') => String(v || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const set = (xs = []) => new Set(xs.map(norm).filter(Boolean));
const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const ts = (v) => { const n = Date.parse(v || ''); return Number.isFinite(n) ? n : 0; };

function lexicalTokens(record) {
  return set((record.event?.lexical_fingerprint?.tokens || []).filter((x) => norm(x).length >= 4));
}
function lexicalScore(a, b) {
  const A = lexicalTokens(a), B = lexicalTokens(b), U = new Set([...A, ...B]);
  return U.size ? inter(A, B) / U.size : 0;
}
function temporalScore(a, b, sigmaDays = 7) {
  const x = ts(a.article?.published_at), y = ts(b.article?.published_at);
  if (!x || !y) return 0.5;
  const days = Math.abs(x - y) / 864e5;
  return Math.exp(-(days * days) / (2 * sigmaDays * sigmaDays));
}
function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function quantile(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), z = (a.length - 1) * p, lo = Math.floor(z), hi = Math.ceil(z);
  return lo === hi ? a[lo] : a[lo] * (hi - z) + a[hi] * (z - lo);
}
function vectors(payload, count) {
  for (const value of [payload?.result?.data, payload?.data, payload?.result?.response, payload?.response]) {
    if (Array.isArray(value) && value.length === count && Array.isArray(value[0])) return value;
  }
  throw new Error(`Unexpected BGE-M3 response: ${JSON.stringify(payload).slice(0, 800)}`);
}
async function embed(texts, account, token) {
  const out = [], url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`;
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: batch }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) throw new Error(`Workers AI HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 1200)}`);
    out.push(...vectors(payload, batch.length));
  }
  return out;
}

export function buildPairAudit(records, embeddingMap) {
  const ctx = shortlistContext(records), pairs = [], allEmbedding = [], shortlistEmbedding = [];
  let possible = 0;
  for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
    const a = records[i], b = records[j];
    if (String(a.article.id) === String(b.article.id)) continue;
    possible++;
    const embedding = cosine(embeddingMap.get(a.id), embeddingMap.get(b.id));
    allEmbedding.push(embedding);
    const routed = shortlist(a, b, ctx);
    if (!routed.keep) continue;
    shortlistEmbedding.push(embedding);
    const lexical = lexicalScore(a, b), temporal = temporalScore(a, b), hybrid = 0.60 * embedding + 0.25 * lexical + 0.15 * temporal;
    pairs.push({
      event_a: a.id, event_b: b.id,
      article_a: a.article.id, article_b: b.article.id,
      title_a: a.article.title, title_b: b.article.title,
      family_a: a.event.family, family_b: b.event.family,
      people_a: a.event.primary_people, people_b: b.event.primary_people,
      clubs_a: a.event.primary_clubs, clubs_b: b.event.primary_clubs,
      reasons: routed.reasons,
      embedding: +embedding.toFixed(6), lexical: +lexical.toFixed(6), temporal: +temporal.toFixed(6), hybrid: +hybrid.toFixed(6),
    });
  }
  pairs.sort((a, b) => b.hybrid - a.hybrid || b.embedding - a.embedding);
  return {
    possible_pairs: possible,
    shortlisted_pairs: pairs.length,
    reduction_rate: possible ? 1 - pairs.length / possible : 0,
    all_embedding_quantiles: { p50: quantile(allEmbedding, 0.5), p90: quantile(allEmbedding, 0.9), p95: quantile(allEmbedding, 0.95), p99: quantile(allEmbedding, 0.99) },
    shortlist_embedding_quantiles: { p50: quantile(shortlistEmbedding, 0.5), p90: quantile(shortlistEmbedding, 0.9), p95: quantile(shortlistEmbedding, 0.95), p99: quantile(shortlistEmbedding, 0.99) },
    pairs,
    top_pairs: pairs.slice(0, 160),
  };
}

async function main() {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
  const sourceDir = arg('--source-dir', 'phase-b-source');
  const outDir = arg('--out-dir', 'phase-b-meridian');
  const limit = Math.max(1, Math.min(120, parseInt(arg('--limit', '60'), 10) || 60));
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '', token = process.env.CLOUDFLARE_API_TOKEN || '';
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');

  const previews = CLUBS.map((club) => {
    const source = JSON.parse(fs.readFileSync(path.join(sourceDir, `${club}.json`), 'utf8'));
    const articles = (source.articles || []).slice(0, limit);
    return { ...source, club_id: club, article_count: articles.length, event_count: articles.reduce((n, row) => n + (row.events || []).length, 0), articles };
  });
  const records = dedupe(previews), texts = records.map((record) => representation(record, 'structured'));
  const embedded = await embed(texts, account, token), embeddingMap = new Map(records.map((record, index) => [record.id, embedded[index]]));
  const pairAudit = buildPairAudit(records, embeddingMap);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'pairs-structured.json'), JSON.stringify(pairAudit, null, 2));
  fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(records, null, 2));
  fs.writeFileSync(path.join(outDir, 'representations-structured.json'), JSON.stringify(records.map((record, index) => ({ event_id: record.id, chars: texts[index].length, text: texts[index] })), null, 2));
  const summary = {
    generated_at: new Date().toISOString(), model: MODEL, representation: 'structured',
    extractor_versions: [...new Set(previews.map((p) => p.version).filter(Boolean))],
    clubs: CLUBS, limit, preview_articles: Object.fromEntries(previews.map((p) => [p.club_id, p.article_count])),
    unique_events: records.length, embedding_dimension: embedded[0]?.length || 0,
    possible_pairs: pairAudit.possible_pairs, shortlisted_pairs: pairAudit.shortlisted_pairs, reduction_rate: pairAudit.reduction_rate,
    score_range: pairAudit.pairs.length ? { min: pairAudit.pairs.at(-1).hybrid, max: pairAudit.pairs[0].hybrid } : { min: null, max: null },
    pair_scope: 'all_shortlisted',
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
