export const STORY_EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const STORY_EMBEDDING_VERSION = 'bge-m3-structured-v1';
export const STORY_EMBEDDING_DIMENSION = 1024;
export const STORY_EMBEDDING_ENCODING = 'float32le';

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function norm(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniq(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const key = norm(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cleanText(value));
  }
  return out;
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

function evidenceText(event = {}) {
  const evidence = parseJson(event.evidence_json ?? event.evidence, {}) || {};
  const fragments = uniq(evidence.fragments || []);
  return (fragments.length ? fragments.join(' ') : cleanText(evidence.text || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

export function buildStructuredEventRepresentation(input = {}) {
  const people = uniq(parseJson(input.primary_people_json ?? input.primary_people, []) || []);
  const clubs = uniq(parseJson(input.primary_clubs_json ?? input.primary_clubs, []) || []);
  const lexical = uniq(parseJson(input.lexical_tokens_json ?? input.lexical_tokens, []) || []).slice(0, 18);
  const family = cleanText(input.family || 'unknown') || 'unknown';
  const stage = cleanText(input.stage || 'unknown') || 'unknown';
  const title = cleanText(input.article_title || input.title || '');
  const facts = evidenceText(input);

  const parts = [
    `family=${family}`,
    people.length ? `people=${people.join(' ; ')}` : '',
    clubs.length ? `clubs=${clubs.join(' ; ')}` : '',
    input.relation_from ? `from=${cleanText(input.relation_from)}` : '',
    input.relation_to ? `to=${cleanText(input.relation_to)}` : '',
    stage !== 'unknown' ? `stage=${stage}` : '',
    title ? `title=${title}` : '',
    facts ? `facts=${facts}` : '',
    lexical.length ? `lexical=${lexical.join(' ')}` : ''
  ].filter(Boolean);

  return parts.join(' | ');
}

export function encodeFloat32LE(vector, expectedDimension = STORY_EMBEDDING_DIMENSION) {
  const values = vector instanceof Float32Array
    ? vector
    : Float32Array.from(vector || []);
  if (values.length !== expectedDimension) {
    throw new Error(
      `Float32 dimension mismatch: expected ${expectedDimension}, got ${values.length}`
    );
  }
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(i * 4, values[i], true);
  }
  return buffer;
}

export function parseLegacyFloat32Text(value, expectedDimension = STORY_EMBEDDING_DIMENSION) {
  if (typeof value !== 'string') {
    throw new Error(`Legacy Float32 vector must be text, got ${typeof value}`);
  }
  const parts = value.split(',');
  if (parts.length !== expectedDimension) {
    throw new Error(
      `Legacy Float32 dimension mismatch: expected ${expectedDimension}, got ${parts.length}`
    );
  }
  const values = new Float32Array(expectedDimension);
  for (let i = 0; i < parts.length; i++) {
    const parsed = Number(parts[i]);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Legacy Float32 vector contains a non-finite value at index ${i}`);
    }
    values[i] = parsed;
  }
  return values;
}

export async function hashStructuredEventRepresentation(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildStructuredEventEmbeddingInput(input = {}) {
  const text = buildStructuredEventRepresentation(input);
  return {
    text,
    representation_hash: await hashStructuredEventRepresentation(text)
  };
}
