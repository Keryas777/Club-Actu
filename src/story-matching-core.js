import {
  STORY_EMBEDDING_DIMENSION,
  STORY_EMBEDDING_ENCODING,
  STORY_EMBEDDING_MODEL,
  STORY_EMBEDDING_VERSION
} from './story-event-representation.js';
export { STORY_EMBEDDING_DIMENSION, STORY_EMBEDDING_ENCODING, STORY_EMBEDDING_MODEL, STORY_EMBEDDING_VERSION };

export const STORY_MATCHER_VERSION = 'story-matcher-v1';
export const STORY_SHORTLIST_CONTEXT_VERSION = 'story-shortlist-df-v1';
export const STORY_LOW_THRESHOLD = 0.535;
export const STORY_HIGH_THRESHOLD = 0.660;
export const STORY_TEMPORAL_SIGMA_DAYS = 7;
export const DEFAULT_STORY_MATCH_LIMIT = 2;
export const DEFAULT_STORY_MATCH_MAX_DURATION_MS = 12000;
export const MAX_STORY_CANDIDATES = 16;
export const MAX_SHORTLIST_MEMBERS_PER_STORY = 24;

const COMPATIBLE_FAMILY_PAIRS = new Set([
  'contract|transfer',
  'discipline|transfer',
  'competition|match',
  'discipline|match',
  'contract|staff',
  'finance|institutional'
]);

export function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return String(message || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

export function normalizeStoryKey(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function uniqNormalized(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeStoryKey)
    .filter(Boolean))].sort();
}

export function lexicalTokens(record = {}) {
  const raw = parseJson(record.lexical_tokens_json ?? record.lexical_tokens, []);
  return uniqNormalized(raw).filter((token) => token.length >= 4);
}

function people(record = {}) {
  return uniqNormalized(parseJson(record.primary_people_json ?? record.primary_people, []));
}

function clubs(record = {}) {
  return uniqNormalized(parseJson(record.primary_clubs_json ?? record.primary_clubs, []));
}

function opponents(record = {}) {
  return uniqNormalized(parseJson(record.opponents_json ?? record.opponents, []));
}

function setIntersectionCount(a, b) {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function familyPair(a, b) {
  return [a || 'unknown', b || 'unknown'].sort().join('|');
}

export function familyCompatible(a, b) {
  const fa = a || 'unknown';
  const fb = b || 'unknown';
  if (fa === fb) return true;
  if (fa === 'unknown' || fb === 'unknown') return true;
  return COMPATIBLE_FAMILY_PAIRS.has(familyPair(fa, fb));
}

export function decodeFloat32Blob(blob, dimension = STORY_EMBEDDING_DIMENSION) {
  if (blob == null) throw new Error('Missing Float32 BLOB');
  let bytes;
  if (blob instanceof ArrayBuffer) {
    bytes = new Uint8Array(blob);
  } else if (ArrayBuffer.isView(blob)) {
    bytes = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  } else if (Array.isArray(blob)) {
    bytes = Uint8Array.from(blob);
  } else {
    throw new Error(`Unsupported Float32 BLOB type: ${typeof blob}`);
  }
  if (bytes.byteLength !== dimension * 4) {
    throw new Error(`Float32 BLOB length mismatch: expected ${dimension * 4}, got ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dimension);
  for (let i = 0; i < dimension; i++) vector[i] = view.getFloat32(i * 4, true);
  return vector;
}

export function cosineSimilarity(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function lexicalJaccard(a, b) {
  const A = new Set(lexicalTokens(a));
  const B = new Set(lexicalTokens(b));
  const union = new Set([...A, ...B]);
  return union.size ? setIntersectionCount(A, B) / union.size : 0;
}

export function temporalGaussianScore(eventAt, storyLastAt, sigmaDays = STORY_TEMPORAL_SIGMA_DAYS) {
  const a = Date.parse(eventAt || '');
  const b = Date.parse(storyLastAt || '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0.5;
  const days = Math.abs(a - b) / 86400000;
  return Math.exp(-(days * days) / (2 * sigmaDays * sigmaDays));
}

export function hybridStoryScore(embedding, lexical, temporal) {
  return 0.60 * embedding + 0.25 * lexical + 0.15 * temporal;
}

export function updateCentroid(oldCentroid, eventVector, oldCount) {
  if (!oldCentroid?.length || oldCentroid.length !== eventVector?.length) {
    throw new Error('Centroid/vector dimension mismatch');
  }
  const count = Number(oldCount || 0);
  if (count < 1) return Float32Array.from(eventVector);
  const next = new Float32Array(oldCentroid.length);
  for (let i = 0; i < next.length; i++) {
    next[i] = (Number(oldCentroid[i]) * count + Number(eventVector[i])) / (count + 1);
  }
  return next;
}

export function buildEventIndexKeys(record = {}, { discriminantTokens = null } = {}) {
  const entries = [];
  const push = (keyType, values) => {
    for (const value of values) if (value) entries.push({ key_type: keyType, key_value: value });
  };
  push('person', people(record));
  push('club', clubs(record));
  push('relation_from', [normalizeStoryKey(record.relation_from)].filter(Boolean));
  push('relation_to', [normalizeStoryKey(record.relation_to)].filter(Boolean));
  push('competition', [normalizeStoryKey(record.competition)].filter(Boolean));
  push('opponent', opponents(record));
  const salient = discriminantTokens == null ? lexicalTokens(record) : [...discriminantTokens].sort();
  push('salient', salient);
  const seen = new Set();
  return entries.filter((row) => {
    const key = `${row.key_type}\u0000${row.key_value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.key_type.localeCompare(b.key_type) || a.key_value.localeCompare(b.key_value));
}

export function buildStoryCandidateLookupKeys(record, discriminantTokens) {
  const rows = [];
  const push = (keyType, values, reason) => {
    for (const keyValue of values) {
      if (keyValue) rows.push({ key_type: keyType, key_value: keyValue, lookup_reason: reason });
    }
  };
  const p = people(record);
  const c = clubs(record);
  const from = normalizeStoryKey(record.relation_from);
  const to = normalizeStoryKey(record.relation_to);
  const rel = [from, to].filter(Boolean);
  const salient = [...(discriminantTokens || new Set())].sort();

  push('person', p, 'person');
  push('club', c, 'club');
  push('relation_from', rel, 'relation');
  push('relation_to', rel, 'relation');
  push('club', rel, 'relation_cross');
  push('relation_from', c, 'relation_cross');
  push('relation_to', c, 'relation_cross');
  push('competition', [normalizeStoryKey(record.competition)].filter(Boolean), 'competition');
  push('opponent', opponents(record), 'opponent');
  push('salient', salient, 'salient');

  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.key_type}\u0000${row.key_value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.key_type.localeCompare(b.key_type) || a.key_value.localeCompare(b.key_value));
}

export function buildPairwiseLookupKeys(record, discriminantTokens) {
  const rows = [];
  const push = (ruleType, keyType, values) => {
    for (const keyValue of values) if (keyValue) rows.push({ rule_type: ruleType, key_type: keyType, key_value: keyValue });
  };
  const p = people(record);
  const c = clubs(record);
  const rel = [normalizeStoryKey(record.relation_from), normalizeStoryKey(record.relation_to)].filter(Boolean);
  const salient = [...(discriminantTokens || new Set())].sort();
  push('person', 'person', p);
  push('club', 'club', c);
  push('relation', 'relation_from', c);
  push('relation', 'relation_to', c);
  push('relation', 'club', rel);
  push('relation', 'relation_from', rel);
  push('relation', 'relation_to', rel);
  push('salient', 'salient', salient);
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.rule_type}\u0000${row.key_type}\u0000${row.key_value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pairwiseShortlist(a, b, ctx) {
  if (String(a.article_id || '') === String(b.article_id || '')) return { keep: false, reasons: [] };
  const Apeople = new Set(people(a));
  const Bpeople = new Set(people(b));
  const Aclubs = new Set(clubs(a));
  const Bclubs = new Set(clubs(b));
  const Arel = new Set([normalizeStoryKey(a.relation_from), normalizeStoryKey(a.relation_to)].filter(Boolean));
  const Brel = new Set([normalizeStoryKey(b.relation_from), normalizeStoryKey(b.relation_to)].filter(Boolean));
  const Aall = lexicalTokens(a);
  const Ball = lexicalTokens(b);
  const maxDf = Number(ctx?.maxDf ?? 3);
  const df = ctx?.df || new Map();
  const Asalient = new Set(Aall.filter((token) => Number(df.get(token) || 0) <= maxDf));
  const Bsalient = new Set(Ball.filter((token) => Number(df.get(token) || 0) <= maxDf));
  const sharedPeople = setIntersectionCount(Apeople, Bpeople);
  const sharedClubs = setIntersectionCount(Aclubs, Bclubs);
  const relationCross = setIntersectionCount(Arel, Brel)
    + setIntersectionCount(Arel, Bclubs)
    + setIntersectionCount(Brel, Aclubs);
  const sharedSalient = setIntersectionCount(Asalient, Bsalient);
  const sameKnownFamily = (a.family || 'unknown') === (b.family || 'unknown') && (a.family || 'unknown') !== 'unknown';
  const reasons = [];
  if (sharedPeople) reasons.push(`person:${sharedPeople}`);
  if (relationCross) reasons.push(`from_to:${relationCross}`);
  if (sharedClubs >= 2) reasons.push(`clubs:${sharedClubs}`);
  if (sameKnownFamily && sharedClubs && sharedSalient >= 2) reasons.push('family+club+salient2');
  if (sameKnownFamily && sharedSalient >= 3) reasons.push('family+salient3');
  if (sharedSalient >= 4) reasons.push('salient4');
  return { keep: reasons.length > 0, reasons };
}

export function buildShortlistContextSnapshot({ language = 'und', eventCount = 0, tokens = [], counts = new Map() } = {}) {
  const normalizedLanguage = String(language || 'und').trim().toLowerCase() || 'und';
  const uniqueTokens = uniqNormalized(tokens).filter((token) => token.length >= 4);
  const nextEventCount = Number(eventCount || 0) + 1;
  const maxDf = Math.max(3, Math.ceil(nextEventCount * 0.03));
  const df = new Map();
  for (const token of uniqueTokens) df.set(token, Number(counts.get(token) || 0) + 1);
  const discriminantTokens = new Set(uniqueTokens.filter((token) => Number(df.get(token) || 0) <= maxDf));
  const commonTokens = uniqueTokens.filter((token) => !discriminantTokens.has(token));
  return { language: normalizedLanguage, eventCount: nextEventCount, maxDf, df, discriminantTokens, commonTokens };
}

export async function shortlistContextVersion(ctx) {
  const tokenCounts = [...ctx.df.entries()].sort(([a], [b]) => a.localeCompare(b));
  const hash = await sha256Hex(stableStringify({
    language: ctx.language,
    event_count: ctx.eventCount,
    max_df: ctx.maxDf,
    token_counts: tokenCounts
  }));
  return `${STORY_SHORTLIST_CONTEXT_VERSION}:${ctx.eventCount}:${hash.slice(0, 16)}`;
}

export async function buildCandidateSetHash(candidates, contextVersion) {
  const snapshot = (candidates || []).map((candidate) => ({
    story_id: candidate.id,
    centroid_revision: Number(candidate.centroid_revision || 0),
    member_count: Number(candidate.member_count || 0),
    shortlist_members: (candidate.shortlist_members || []).map((member) => member.event_id).sort()
  })).sort((a, b) => a.story_id.localeCompare(b.story_id));
  return sha256Hex(stableStringify({ shortlist_context_version: contextVersion || null, candidates: snapshot }));
}

export async function buildStoryId(eventId) {
  return sha256Hex(`club-actu:story:v1\u0000${eventId}`);
}
