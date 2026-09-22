import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORY_LOW_THRESHOLD,
  STORY_HIGH_THRESHOLD,
  STORY_TEMPORAL_SIGMA_DAYS,
  buildCandidateSetHash,
  buildEventIndexKeys,
  buildShortlistContextSnapshot,
  buildStoryCandidateLookupKeys,
  cosineSimilarity,
  decodeFloat32Blob,
  familyCompatible,
  hybridStoryScore,
  lexicalJaccard,
  pairwiseShortlist,
  temporalGaussianScore,
  updateCentroid
} from '../src/story-matching-core.js';
import {
  chooseStoryDecision,
  loadQualifiedMembers,
  loadReadyStoryMatchEvents,
  loadStoryCandidates
} from '../src/story-match-store.js';
import { acquireStoryCentroidLease, isFinalStoryMatchStatus } from '../src/story-matcher.js';

function event(overrides = {}) {
  return {
    event_id: 'e1',
    article_id: 'a1',
    published_at: '2026-09-20T12:00:00Z',
    language: 'fr',
    family: 'transfer',
    primary_people_json: JSON.stringify(['Jean Dupont']),
    primary_clubs_json: JSON.stringify(['OL']),
    relation_from: 'Arsenal',
    relation_to: 'OL',
    competition: null,
    opponents_json: '[]',
    lexical_tokens_json: JSON.stringify(['dupont', 'arsenal', 'lyon']),
    ...overrides
  };
}

function makeDb({ rows = [], changes = 1 } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        sql,
        bindings: [],
        bind(...bindings) { this.bindings = bindings; return this; },
        async all() {
          calls.push({ method: 'all', sql, bindings: this.bindings });
          return { results: rows, meta: { rows_read: rows.length } };
        },
        async run() {
          calls.push({ method: 'run', sql, bindings: this.bindings });
          return { success: true, meta: { changes, rows_written: changes, rows_read: 0 } };
        }
      };
    }
  };
}

test('Float32 BLOB decoding is little-endian and exactly 1024D compatible', () => {
  const original = new Float32Array(1024);
  original[0] = 1.25;
  original[1] = -0.5;
  original[1023] = 3.75;
  const decoded = decodeFloat32Blob(new Uint8Array(original.buffer));
  assert.equal(decoded.length, 1024);
  assert.equal(decoded[0], 1.25);
  assert.equal(decoded[1], -0.5);
  assert.equal(decoded[1023], 3.75);
});

test('pairwise shortlist reproduces validated exact rules and excludes same ARTICLE', () => {
  const a = event();
  const ctx = { maxDf: 3, df: new Map([['dupont', 1], ['arsenal', 1], ['lyon', 1], ['commun', 9]]) };

  assert.equal(pairwiseShortlist(a, event({ event_id: 'e2' }), ctx).keep, false);

  const person = event({ event_id: 'e2', article_id: 'a2', primary_clubs_json: '[]', relation_from: null, relation_to: null, lexical_tokens_json: '[]' });
  assert.deepEqual(pairwiseShortlist(a, person, ctx).reasons, ['person:1']);

  const clubs = event({ event_id: 'e3', article_id: 'a3', primary_people_json: '[]', primary_clubs_json: JSON.stringify(['OL', 'Arsenal']), relation_from: null, relation_to: null, lexical_tokens_json: '[]' });
  const a2 = event({ primary_clubs_json: JSON.stringify(['OL', 'Arsenal']), primary_people_json: '[]', relation_from: null, relation_to: null, lexical_tokens_json: '[]' });
  assert.ok(pairwiseShortlist(a2, clubs, ctx).reasons.includes('clubs:2'));

  const relationCross = event({ event_id: 'e4', article_id: 'a4', primary_people_json: '[]', primary_clubs_json: JSON.stringify(['Arsenal']), relation_from: null, relation_to: null, lexical_tokens_json: '[]' });
  const relA = event({ primary_people_json: '[]', primary_clubs_json: '[]', relation_from: 'Arsenal', relation_to: null, lexical_tokens_json: '[]' });
  assert.ok(pairwiseShortlist(relA, relationCross, ctx).reasons.some((r) => r.startsWith('from_to:')));

  const salientA = event({ primary_people_json: '[]', primary_clubs_json: JSON.stringify(['OL']), relation_from: null, relation_to: null, lexical_tokens_json: JSON.stringify(['alpha', 'beta', 'commun']) });
  const salientB = event({ event_id: 'e5', article_id: 'a5', primary_people_json: '[]', primary_clubs_json: JSON.stringify(['OL']), relation_from: null, relation_to: null, lexical_tokens_json: JSON.stringify(['alpha', 'beta', 'commun']) });
  const ctx2 = { maxDf: 3, df: new Map([['alpha', 2], ['beta', 2], ['commun', 20]]) };
  assert.ok(pairwiseShortlist(salientA, salientB, ctx2).reasons.includes('family+club+salient2'));
  assert.ok(!pairwiseShortlist(salientA, salientB, ctx2).reasons.includes('family+salient3'));
});

test('candidate lookup explicitly covers relation-to-club cross-overlap in both directions', () => {
  const keys = buildStoryCandidateLookupKeys(event(), new Set(['dupont']));
  const has = (type, value) => keys.some((row) => row.key_type === type && row.key_value === value);
  assert.ok(has('club', 'arsenal'));
  assert.ok(has('relation_from', 'ol'));
  assert.ok(has('relation_to', 'ol'));
  assert.ok(has('person', 'jean dupont'));
  assert.ok(has('salient', 'dupont'));
});

test('family compatibility stays small and permissive exactly where specified', () => {
  assert.equal(familyCompatible('transfer', 'transfer'), true);
  assert.equal(familyCompatible('unknown', 'match'), true);
  assert.equal(familyCompatible('transfer', 'contract'), true);
  assert.equal(familyCompatible('match', 'competition'), true);
  assert.equal(familyCompatible('finance', 'institutional'), true);
  assert.equal(familyCompatible('transfer', 'institutional'), false);
});

test('score components preserve the benchmark formula and Gaussian sigma=7 days', () => {
  assert.equal(STORY_TEMPORAL_SIGMA_DAYS, 7);
  const temporal = temporalGaussianScore('2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z');
  assert.ok(Math.abs(temporal - Math.exp(-0.5)) < 1e-12);
  assert.equal(hybridStoryScore(0.7, 0.4, 0.9), 0.60 * 0.7 + 0.25 * 0.4 + 0.15 * 0.9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-12);
  assert.equal(
    lexicalJaccard(
      event({ lexical_tokens_json: JSON.stringify(['alpha', 'beta']) }),
      event({ lexical_tokens_json: JSON.stringify(['beta', 'gamma']) })
    ),
    1 / 3
  );
});

test('incremental shortlist context uses exact benchmark maxDf formula', () => {
  const c99 = buildShortlistContextSnapshot({ eventCount: 98, tokens: ['alpha'], counts: new Map([['alpha', 2]]) });
  assert.equal(c99.eventCount, 99);
  assert.equal(c99.maxDf, 3);
  assert.ok(c99.discriminantTokens.has('alpha'));

  const c101 = buildShortlistContextSnapshot({ eventCount: 100, tokens: ['alpha'], counts: new Map([['alpha', 3]]) });
  assert.equal(c101.eventCount, 101);
  assert.equal(c101.maxDf, 4);
  assert.ok(c101.discriminantTokens.has('alpha'));
});

test('candidate_set_hash changes when centroid revision/member snapshot changes', async () => {
  const a = [{ id: 's1', centroid_revision: 2, member_count: 3, shortlist_members: [{ event_id: 'e0' }] }];
  const b = [{ id: 's1', centroid_revision: 3, member_count: 4, shortlist_members: [{ event_id: 'e0' }] }];
  assert.notEqual(await buildCandidateSetHash(a, 'ctx:1'), await buildCandidateSetHash(b, 'ctx:1'));
  assert.notEqual(await buildCandidateSetHash(a, 'ctx:1'), await buildCandidateSetHash(a, 'ctx:2'));
});

test('decision thresholds never auto-attach the ambiguous zone and family gate blocks HIGH', () => {
  const candidate = (hybrid, extra = {}) => ({
    id: 's1',
    shortlist_pass: true,
    hybrid_score: hybrid,
    family_compatible: true,
    members_truncated: false,
    ...extra
  });
  assert.equal(chooseStoryDecision([candidate(STORY_LOW_THRESHOLD - 0.001)]).decision, 'AUTO_NEW_STORY');
  assert.equal(chooseStoryDecision([candidate(STORY_LOW_THRESHOLD)]).decision, 'AMBIGUOUS_AI');
  assert.equal(chooseStoryDecision([candidate(STORY_HIGH_THRESHOLD)]).decision, 'AUTO_ATTACH');
  assert.equal(chooseStoryDecision([candidate(0.9, { family_compatible: false })]).decision, 'AMBIGUOUS_AI');
  assert.equal(chooseStoryDecision([candidate(0.9, { members_truncated: true })]).decision, 'AMBIGUOUS_AI');
});

test('centroid update applies one incremental mean step', () => {
  const next = updateCentroid(Float32Array.from([1, 0]), Float32Array.from([0, 1]), 1);
  assert.deepEqual([...next], [0.5, 0.5]);
});

test('event index keys include structural and lexical lookup dimensions', () => {
  const keys = buildEventIndexKeys(event({ competition: 'Ligue 1', opponents_json: JSON.stringify(['PSG']) }));
  const types = new Set(keys.map((row) => row.key_type));
  for (const type of ['person', 'club', 'relation_from', 'relation_to', 'competition', 'opponent', 'salient']) {
    assert.ok(types.has(type), `missing ${type}`);
  }
});

test('ready-match queue is bounded/indexed and has no OFFSET hot path', async () => {
  const db = makeDb({ rows: [] });
  const metrics = { queries: 0, rows_read: 0 };
  await loadReadyStoryMatchEvents(db, { limit: 2 }, metrics);
  const call = db.calls.find((row) => row.method === 'all');
  assert.ok(call);
  assert.match(call.sql, /INDEXED BY idx_event_candidates_match_queue/);
  assert.match(call.sql, /typeof\(emb\.vector\) = 'blob'/);
  assert.match(call.sql, /LIMIT \?/);
  assert.doesNotMatch(call.sql, /OFFSET/i);
  assert.equal(call.bindings.at(-1), 2);
});

test('centroid concurrency uses a scoped STORY lease instead of a global lock/CAS assumption', async () => {
  const db = makeDb({ changes: 1 });
  const metrics = { queries: 0, rows_read: 0, write_statements: 0, rows_written: 0 };
  const lease = await acquireStoryCentroidLease(db, 's1', metrics);
  assert.equal(lease.acquired, true);
  const call = db.calls.find((row) => row.method === 'run');
  assert.match(call.sql, /WHERE id = \?/);
  assert.match(call.sql, /centroid_lease_expires_at/);
  assert.doesNotMatch(call.sql, /centroid_revision\s*=\s*\?/);
});


test('candidate and pairwise hot paths keep SQL variable count constant with JSON bindings', async () => {
  const richEvent = event({
    primary_people_json: JSON.stringify(['Paulo Fonseca', 'Ernest Nuamah']),
    primary_clubs_json: JSON.stringify(['Olympique Lyonnais', 'Stade Rennais']),
    relation_from: null,
    relation_to: null,
    lexical_tokens_json: JSON.stringify(
      Array.from({ length: 24 }, (_, i) => `salient-${String(i).padStart(2, '0')}`)
    )
  });
  const ctx = {
    discriminantTokens: new Set(JSON.parse(richEvent.lexical_tokens_json)),
    maxDf: 3,
    df: new Map()
  };
  const db = makeDb({ rows: [] });
  const metrics = { queries: 0, rows_read: 0 };

  await loadStoryCandidates(db, richEvent, ctx, metrics);
  const candidateCall = db.calls.at(-1);
  assert.match(candidateCall.sql, /json_each\(\?\)/);
  assert.equal(candidateCall.bindings.length, 2);
  assert.equal(JSON.parse(candidateCall.bindings[0]).length > 24, true);

  const candidateIds = Array.from({ length: 16 }, (_, i) => `story-${i}`);
  await loadQualifiedMembers(db, richEvent, ctx, candidateIds, metrics);
  const pairwiseCall = db.calls.at(-1);
  assert.match(pairwiseCall.sql, /FROM json_each\(\?\)/);
  assert.match(pairwiseCall.sql, /candidate_story_ids/);
  assert.equal(pairwiseCall.bindings.length, 6);
  assert.equal(JSON.parse(pairwiseCall.bindings[1]).length, 16);
});


test('targeted manual status only treats persisted STORY decisions as final', () => {
  assert.equal(isFinalStoryMatchStatus('auto_new_story'), true);
  assert.equal(isFinalStoryMatchStatus('auto_attach'), true);
  assert.equal(isFinalStoryMatchStatus('ambiguous_ai'), true);
  assert.equal(isFinalStoryMatchStatus('matching_retry'), false);
  assert.equal(isFinalStoryMatchStatus('matching'), false);
  assert.equal(isFinalStoryMatchStatus('ready_match'), false);
  assert.equal(isFinalStoryMatchStatus('matching_failed'), false);
});
