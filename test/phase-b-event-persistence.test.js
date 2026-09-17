import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClubContext,
  buildEventCandidateRecord,
  buildPhaseBInputHash,
  persistPhaseBEventCandidatesForArticle,
  resolveTrackedClubIds
} from '../src/phase-b-event-persistence.js';

const clubs = [
  { id: 'ol', name: 'Olympique Lyonnais', aliases: ['OL', 'Lyon'] },
  { id: 'psg', name: 'Paris Saint-Germain', aliases: ['PSG', 'Paris'] }
];

const baseArticle = {
  id: 'article-1',
  title: 'L’OL avance sur un transfert',
  published_at: '2026-09-17T10:00:00Z'
};

const baseEvent = {
  family: 'transfer',
  stage: 'negotiation',
  primary_people: ['Jean Dupont'],
  primary_clubs: ['Olympique Lyonnais', 'Arsenal'],
  relation_hints: { club_from: 'Arsenal', club_to: 'Olympique Lyonnais' },
  family_discriminator: null,
  evidence: { kind: 'lead', text: 'Jean Dupont négocie avec Lyon.', fragments: ['Jean Dupont négocie avec Lyon.'] },
  lexical_fingerprint: { tokens: ['dupont', 'negocie', 'lyon'] }
};

test('candidate identity is stable across anchor ordering but changes with matching-relevant title', async () => {
  const a = await buildEventCandidateRecord(baseArticle, baseEvent);
  const b = await buildEventCandidateRecord(baseArticle, {
    ...baseEvent,
    primary_people: [...baseEvent.primary_people].reverse(),
    primary_clubs: [...baseEvent.primary_clubs].reverse(),
    lexical_fingerprint: { tokens: [...baseEvent.lexical_fingerprint.tokens].reverse() }
  });
  assert.equal(a.id, b.id);
  assert.equal(a.candidate_hash, b.candidate_hash);

  const changed = await buildEventCandidateRecord({ ...baseArticle, title: 'Titre modifié' }, baseEvent);
  assert.notEqual(a.id, changed.id);
});

test('tracked club links come only from explicit event anchors and ambiguous aliases are not guessed', () => {
  const result = resolveTrackedClubIds(baseEvent, clubs);
  assert.deepEqual(result.clubIds, ['ol']);
  assert.deepEqual(result.unmatchedAnchors, ['Arsenal']);

  const ambiguous = resolveTrackedClubIds(
    { primary_clubs: ['Paris'], relation_hints: {} },
    [
      ...clubs,
      { id: 'paris-fc', name: 'Paris FC', aliases: ['Paris'] }
    ]
  );
  assert.deepEqual(ambiguous.clubIds, []);
  assert.deepEqual(ambiguous.ambiguousAnchors, ['Paris']);
});

test('Phase B input hash changes when full content or club extraction context changes', async () => {
  const article = { ...baseArticle, excerpt: '', content: 'Version A', content_source: 'article_content_enrichments' };
  const first = await buildPhaseBInputHash(article, clubs);
  const contentChanged = await buildPhaseBInputHash({ ...article, content: 'Version B' }, clubs);
  const contextChanged = await buildPhaseBInputHash(article, [...clubs, { id: 'om', name: 'Olympique de Marseille', aliases: ['OM'] }]);
  assert.notEqual(first, contentChanged);
  assert.notEqual(first, contextChanged);
});

function bound(sql, bindings = []) {
  return { sql, bindings };
}

function makeDb({ existing = [], links = [] } = {}) {
  const batches = [];
  const article = {
    id: 'article-1', source_id: 'source-1', source_content_hash: 'raw-hash', language: 'fr',
    title: baseArticle.title, published_at: baseArticle.published_at, excerpt: '',
    content: 'Jean Dupont négocie avec Lyon.', content_source: 'article_content_enrichments'
  };
  const aliasRows = [
    { id: 'ol', name: 'Olympique Lyonnais', alias: 'OL', strength: 'strong' },
    { id: 'ol', name: 'Olympique Lyonnais', alias: 'Lyon', strength: 'weak' },
    { id: 'psg', name: 'Paris Saint-Germain', alias: 'PSG', strength: 'strong' }
  ];

  return {
    batches,
    prepare(sql) {
      const statement = {
        sql,
        bindings: [],
        bind(...bindings) {
          return { ...statement, bindings };
        },
        async all() {
          if (/FROM clubs c/.test(sql)) return { results: aliasRows };
          return { results: [] };
        }
      };
      statement.bind = (...bindings) => ({
        sql,
        bindings,
        async all() {
          if (/FROM raw_articles r/.test(sql)) return { results: [article] };
          if (/FROM event_candidates\s+WHERE article_id/.test(sql)) return { results: existing };
          if (/FROM event_candidate_clubs ec/.test(sql)) return { results: links };
          return { results: [] };
        }
      });
      return statement;
    },
    async batch(statements) {
      batches.push(statements.map((statement) => bound(statement.sql, statement.bindings)));
      return statements.map(() => ({ success: true }));
    }
  };
}

test('manual persistence writes one global event and only its explicitly anchored tracked club', async () => {
  const db = makeDb();
  const result = await persistPhaseBEventCandidatesForArticle(db, 'article-1', {
    extractor: () => [baseEvent]
  });

  assert.equal(result.event_count, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.tracked_club_links, 1);
  assert.equal(db.batches.length, 1);
  const statements = db.batches[0];
  assert.ok(statements.some((row) => /INSERT INTO event_candidates/.test(row.sql)));
  const clubInsert = statements.find((row) => /INSERT OR IGNORE INTO event_candidate_clubs/.test(row.sql));
  assert.ok(clubInsert);
  assert.equal(clubInsert.bindings.at(-1), 'ol');
  assert.ok(!statements.some((row) => row.bindings?.includes('psg')));
});

test('exact replay performs zero writes', async () => {
  const firstDb = makeDb();
  const first = await persistPhaseBEventCandidatesForArticle(firstDb, 'article-1', {
    extractor: () => [baseEvent]
  });
  const insert = firstDb.batches[0].find((row) => /INSERT INTO event_candidates/.test(row.sql));
  const eventId = insert.bindings[0];
  const sourceHash = insert.bindings[2];
  const inputSource = insert.bindings[3];
  const inputHash = insert.bindings[4];
  const extractorVersion = insert.bindings[5];
  const candidateHash = insert.bindings[6];
  const language = insert.bindings[8];

  const replayDb = makeDb({
    existing: [{
      id: eventId,
      lifecycle_status: 'active',
      source_content_hash: sourceHash,
      phase_b_input_source: inputSource,
      phase_b_input_hash: inputHash,
      extractor_version: extractorVersion,
      candidate_hash: candidateHash,
      language
    }],
    links: [{ event_id: eventId, club_id: 'ol' }]
  });

  const replay = await persistPhaseBEventCandidatesForArticle(replayDb, 'article-1', {
    extractor: () => [baseEvent]
  });
  assert.equal(first.status, 'persisted');
  assert.equal(replay.unchanged, 1);
  assert.equal(replay.writes_executed, 0);
  assert.equal(replayDb.batches.length, 0);
});

test('club context groups aliases by club id', () => {
  const context = buildClubContext([
    { id: 'ol', name: 'Olympique Lyonnais', alias: 'OL' },
    { id: 'ol', name: 'Olympique Lyonnais', alias: 'Lyon' },
    { id: 'om', name: 'Olympique de Marseille', alias: null }
  ]);
  assert.deepEqual(context, [
    { id: 'ol', name: 'Olympique Lyonnais', aliases: ['OL', 'Lyon'] },
    { id: 'om', name: 'Olympique de Marseille', aliases: [] }
  ]);
});
