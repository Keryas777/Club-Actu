import fs from 'node:fs';
import path from 'node:path';
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import { extractEventCandidates } from '../src/phase-b-events.js';
import { normalizeTopicText } from '../src/grouper.js';

const inputPath = process.argv[2] || 'phase-b-tool-benchmark/corpus.json';
const outputDir = process.argv[3] || 'phase-b-tool-benchmark/results';
const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const articles = Array.isArray(payload.articles) ? payload.articles : [];
const aliases = Array.isArray(payload.aliases) ? payload.aliases : [];

fs.mkdirSync(outputDir, { recursive: true });

const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
};

const clubMap = new Map();
for (const row of aliases) {
  if (!clubMap.has(row.club_id)) clubMap.set(row.club_id, { id: row.club_id, name: row.club_id.toUpperCase(), aliases: [] });
  clubMap.get(row.club_id).aliases.push(row.alias);
}
const context = { clubs: [...clubMap.values()] };

const clubAliasToId = new Map();
for (const club of context.clubs) {
  for (const alias of uniq([club.id, club.name, ...(club.aliases || [])])) {
    const norm = normalizeTopicText(alias);
    if (norm) clubAliasToId.set(norm, club.id);
  }
}

// wink has no dedicated French model. We benchmark only sentence boundaries and
// literal custom entities here. POS/NER output is deliberately not used as truth.
const nlp = winkNLP(model);
const customClubPatterns = uniq([...clubAliasToId.keys()]).filter((x) => x.length >= 2);
if (customClubPatterns.length) {
  nlp.learnCustomEntities([{ name: 'club', patterns: customClubPatterns }], {
    matchValue: true,
    usePOS: false,
    useEntity: false
  });
}

function regexSentences(text = '') {
  return String(text || '')
    .trim()
    .split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Ý0-9«“\"])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18);
}

function winkSentences(text = '') {
  const value = String(text || '').trim();
  if (!value) return [];
  return nlp.readDoc(value).sentences().out().map((s) => s.trim()).filter((s) => s.length >= 18);
}

function literalClubIds(text = '') {
  const norm = ` ${normalizeTopicText(text)} `;
  const ids = [];
  for (const [alias, clubId] of clubAliasToId) {
    if (norm.includes(` ${alias} `)) ids.push(clubId);
  }
  return uniq(ids).sort();
}

function winkClubIds(text = '') {
  if (!String(text || '').trim() || !customClubPatterns.length) return [];
  const details = nlp.readDoc(String(text)).customEntities().out(nlp.its.detail);
  const ids = [];
  for (const entity of details) {
    const value = normalizeTopicText(entity?.value || entity);
    const clubId = clubAliasToId.get(value);
    if (clubId) ids.push(clubId);
  }
  return uniq(ids).sort();
}

function tokens(text = '') {
  return normalizeTopicText(text)
    .split(' ')
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
}

function tfidfVectors(docs) {
  const dfs = new Map();
  const termCounts = [];
  for (const doc of docs) {
    const counts = new Map();
    for (const token of tokens(doc.text)) counts.set(token, (counts.get(token) || 0) + 1);
    termCounts.push(counts);
    for (const token of counts.keys()) dfs.set(token, (dfs.get(token) || 0) + 1);
  }
  const n = Math.max(1, docs.length);
  return termCounts.map((counts) => {
    const vector = new Map();
    let norm2 = 0;
    for (const [token, count] of counts) {
      const tf = 1 + Math.log(count);
      const idf = Math.log((1 + n) / (1 + (dfs.get(token) || 0))) + 1;
      const weight = tf * idf;
      vector.set(token, weight);
      norm2 += weight * weight;
    }
    return { vector, norm: Math.sqrt(norm2) || 1 };
  });
}

function cosine(a, b) {
  let dot = 0;
  const [small, large] = a.vector.size <= b.vector.size ? [a.vector, b.vector] : [b.vector, a.vector];
  for (const [token, weight] of small) dot += weight * (large.get(token) || 0);
  return dot / (a.norm * b.norm);
}

function intersection(a = [], b = []) {
  const bs = new Set(b.map(normalizeTopicText));
  return a.filter((x) => bs.has(normalizeTopicText(x)));
}

const contentStatsBySource = new Map();
const contentStatsByClub = new Map();
const sentenceDeltas = [];
const clubEntityDiffs = [];
const eventDocs = [];
const extractionByClub = new Map();

for (const article of articles) {
  const content = String(article.content || '');
  const excerpt = String(article.excerpt || '');
  const sourceKey = article.source_id || 'unknown';
  const clubKey = article.club_id || 'unknown';

  for (const [map, key] of [[contentStatsBySource, sourceKey], [contentStatsByClub, clubKey]]) {
    if (!map.has(key)) map.set(key, { articles: 0, nonempty_content: 0, content_lengths: [], excerpt_lengths: [] });
    const s = map.get(key);
    s.articles++;
    if (content.trim()) s.nonempty_content++;
    s.content_lengths.push(content.length);
    s.excerpt_lengths.push(excerpt.length);
  }

  if (content.trim()) {
    const regex = regexSentences(content);
    const wink = winkSentences(content);
    if (regex.length !== wink.length) {
      sentenceDeltas.push({
        article_id: article.id,
        club_id: clubKey,
        source_id: sourceKey,
        title: article.title,
        content_length: content.length,
        regex_sentences: regex.length,
        wink_sentences: wink.length,
        regex_sample: regex.slice(0, 4),
        wink_sample: wink.slice(0, 4)
      });
    }

    const literal = literalClubIds(content);
    const winkClubs = winkClubIds(content);
    if (JSON.stringify(literal) !== JSON.stringify(winkClubs)) {
      clubEntityDiffs.push({
        article_id: article.id,
        club_id: clubKey,
        source_id: sourceKey,
        title: article.title,
        literal,
        wink: winkClubs
      });
    }
  }

  const events = extractEventCandidates(article, context);
  if (!extractionByClub.has(clubKey)) extractionByClub.set(clubKey, { articles: 0, events: 0, multi: 0, zero: 0, body_events: 0 });
  const eStats = extractionByClub.get(clubKey);
  eStats.articles++;
  eStats.events += events.length;
  if (!events.length) eStats.zero++;
  if (events.length > 1) eStats.multi++;
  eStats.body_events += events.filter((e) => e.evidence?.kind !== 'lead').length;

  events.forEach((event, eventIndex) => {
    eventDocs.push({
      id: `${article.id}:${eventIndex}`,
      article_id: article.id,
      club_id: clubKey,
      source_id: sourceKey,
      title: article.title,
      family: event.family,
      people: event.primary_people || [],
      clubs: event.primary_clubs || [],
      text: event.evidence?.text || '',
      evidence_kind: event.evidence?.kind || null
    });
  });
}

function summarizeStats(map) {
  return Object.fromEntries([...map.entries()].sort().map(([key, s]) => [key, {
    articles: s.articles,
    nonempty_content: s.nonempty_content,
    content_coverage: s.articles ? s.nonempty_content / s.articles : 0,
    content_length_p50: percentile(s.content_lengths, 0.5),
    content_length_p90: percentile(s.content_lengths, 0.9),
    excerpt_length_p50: percentile(s.excerpt_lengths, 0.5)
  }]));
}

const tfidf = tfidfVectors(eventDocs);
const pairs = [];
for (let i = 0; i < eventDocs.length; i++) {
  for (let j = i + 1; j < eventDocs.length; j++) {
    const a = eventDocs[i], b = eventDocs[j];
    if (a.article_id === b.article_id || a.club_id !== b.club_id) continue;
    const score = cosine(tfidf[i], tfidf[j]);
    if (score < 0.18) continue;
    const sharedPeople = intersection(a.people, b.people);
    const sharedClubs = intersection(a.clubs, b.clubs);
    const anchorConsistent = a.family === b.family && (sharedPeople.length > 0 || sharedClubs.length >= 2);
    pairs.push({
      score: Number(score.toFixed(4)),
      club_id: a.club_id,
      family_a: a.family,
      family_b: b.family,
      shared_people: sharedPeople,
      shared_clubs: sharedClubs,
      anchor_consistent: anchorConsistent,
      article_a: { id: a.article_id, source_id: a.source_id, title: a.title },
      article_b: { id: b.article_id, source_id: b.source_id, title: b.title }
    });
  }
}
pairs.sort((a, b) => b.score - a.score);
const topPairs = pairs.slice(0, 120);
const top30 = topPairs.slice(0, 30);

const summary = {
  generated_at: new Date().toISOString(),
  corpus_articles: articles.length,
  unique_article_ids: new Set(articles.map((a) => a.id)).size,
  note_wink_language: 'wink English model benchmarked only for sentence boundaries and literal custom entities; POS/NER is not treated as French ground truth',
  content_by_club: summarizeStats(contentStatsByClub),
  content_by_source: summarizeStats(contentStatsBySource),
  extraction_by_club: Object.fromEntries([...extractionByClub.entries()].sort().map(([club, s]) => [club, {
    ...s,
    multi_rate: s.articles ? s.multi / s.articles : 0,
    body_event_rate: s.events ? s.body_events / s.events : 0
  }])),
  sentence_boundary_differences: sentenceDeltas.length,
  custom_club_entity_differences: clubEntityDiffs.length,
  event_documents: eventDocs.length,
  tfidf_pairs_over_018: pairs.length,
  tfidf_top30_anchor_consistency: top30.length ? top30.filter((p) => p.anchor_consistent).length / top30.length : 0
};

fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outputDir, 'sentence-differences.json'), JSON.stringify(sentenceDeltas.slice(0, 100), null, 2));
fs.writeFileSync(path.join(outputDir, 'club-entity-differences.json'), JSON.stringify(clubEntityDiffs.slice(0, 100), null, 2));
fs.writeFileSync(path.join(outputDir, 'tfidf-top-pairs.json'), JSON.stringify(topPairs, null, 2));

console.log(JSON.stringify(summary, null, 2));
