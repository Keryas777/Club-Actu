import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORY_EMBEDDING_DIMENSION,
  STORY_EMBEDDING_MODEL,
  STORY_EMBEDDING_VERSION,
  buildStructuredEventEmbeddingInput,
  buildStructuredEventRepresentation
} from '../src/story-event-representation.js';

test('structured representation matches the validated benchmark format', () => {
  const text = buildStructuredEventRepresentation({
    family: 'transfer',
    stage: 'negotiation',
    primary_people_json: JSON.stringify(['Jean Dupont', 'Jean Dupont']),
    primary_clubs_json: JSON.stringify(['Olympique Lyonnais', 'Arsenal']),
    relation_from: 'Arsenal',
    relation_to: 'Olympique Lyonnais',
    article_title: 'L’OL avance sur un transfert',
    evidence_json: JSON.stringify({
      text: 'fallback',
      fragments: [
        'Jean Dupont négocie avec Lyon.',
        'Jean Dupont négocie avec Lyon.'
      ]
    }),
    lexical_tokens_json: JSON.stringify(['dupont', 'negocie', 'lyon', 'dupont'])
  });

  assert.equal(
    text,
    'family=transfer | people=Jean Dupont | clubs=Olympique Lyonnais ; Arsenal | from=Arsenal | to=Olympique Lyonnais | stage=negotiation | title=L’OL avance sur un transfert | facts=Jean Dupont négocie avec Lyon. | lexical=dupont negocie lyon'
  );
});

test('unknown stage is omitted and evidence text is used when no fragments exist', () => {
  const text = buildStructuredEventRepresentation({
    family: 'match',
    stage: 'unknown',
    primary_people_json: '[]',
    primary_clubs_json: JSON.stringify(['OL']),
    article_title: 'Victoire de Lyon',
    evidence_json: JSON.stringify({ text: 'Lyon gagne 2-0.' }),
    lexical_tokens_json: '[]'
  });

  assert.equal(
    text,
    'family=match | clubs=OL | title=Victoire de Lyon | facts=Lyon gagne 2-0.'
  );
});

test('embedding input has stable SHA-256 representation hash', async () => {
  const row = {
    family: 'transfer',
    stage: 'official',
    primary_people_json: JSON.stringify(['A']),
    primary_clubs_json: JSON.stringify(['OL']),
    article_title: 'Titre',
    evidence_json: JSON.stringify({ text: 'Fait.' }),
    lexical_tokens_json: JSON.stringify(['fait'])
  };
  const a = await buildStructuredEventEmbeddingInput(row);
  const b = await buildStructuredEventEmbeddingInput(row);

  assert.equal(a.text, b.text);
  assert.equal(a.representation_hash, b.representation_hash);
  assert.match(a.representation_hash, /^[0-9a-f]{64}$/);
  assert.equal(STORY_EMBEDDING_MODEL, '@cf/baai/bge-m3');
  assert.equal(STORY_EMBEDDING_VERSION, 'bge-m3-structured-v1');
  assert.equal(STORY_EMBEDDING_DIMENSION, 1024);
});
