import test from 'node:test';
import assert from 'node:assert/strict';
import {
  updateCentroid,
  familyCompatibleRecords,
  simulateStreamingStories,
  evaluateAssignments,
} from '../scripts/audit-meridian-streaming-story.mjs';

function record(id, family = 'transfer', day = 1) {
  return {
    id,
    article: {
      id: `article-${id}`,
      title: `Story ${id}`,
      published_at: `2026-09-${String(day).padStart(2, '0')}T12:00:00Z`,
    },
    event: {
      family,
      primary_people: ['Player X'],
      primary_clubs: ['OL'],
      relation_hints: {},
      lexical_fingerprint: { tokens: ['player', 'dossier', 'lyon'] },
    },
  };
}

test('centroid update is incremental and stable', () => {
  assert.deepEqual(updateCentroid([1, 0], [0, 1], 1), [0.5, 0.5]);
  assert.deepEqual(updateCentroid([0.5, 0.5], [1, 1], 2), [2 / 3, 2 / 3]);
});

test('family compatibility blocks clearly distinct event families', () => {
  assert.equal(familyCompatibleRecords(record('a', 'transfer'), record('b', 'institutional')), false);
  assert.equal(familyCompatibleRecords(record('a', 'match'), record('b', 'unknown')), true);
});

test('founder anchor gate stops centroid drift while keeping stable story id', () => {
  const records = [record('a', 'transfer', 1), record('b', 'transfer', 2), record('c', 'transfer', 3)];
  const embeddings = new Map([
    ['a', [1, 0]],
    ['b', [0.8, 0.6]],
    ['c', [0.6, 0.8]],
  ]);

  const withoutAnchor = simulateStreamingStories(records, embeddings, { anchorThreshold: null, mode: 'conservative' });
  assert.equal(withoutAnchor.stories.length, 1);
  assert.equal(withoutAnchor.stories[0].id, 'story-a');
  assert.equal(withoutAnchor.assignments.get('c'), 'story-a');

  const withAnchor = simulateStreamingStories(records, embeddings, { anchorThreshold: 0.65, mode: 'conservative' });
  assert.equal(withAnchor.stories.length, 2);
  assert.equal(withAnchor.assignments.get('a'), 'story-a');
  assert.equal(withAnchor.assignments.get('b'), 'story-a');
  assert.equal(withAnchor.assignments.get('c'), 'story-c');
  assert.ok(withAnchor.metrics.centroid_pass_anchor_fail >= 1);
});

test('family gate prevents a high semantic collision from joining the story', () => {
  const records = [record('a', 'transfer', 1), record('b', 'institutional', 2)];
  const embeddings = new Map([['a', [1, 0]], ['b', [1, 0]]]);
  const result = simulateStreamingStories(records, embeddings, { anchorThreshold: null, mode: 'conservative' });
  assert.equal(result.stories.length, 2);
  assert.equal(result.assignments.get('a'), 'story-a');
  assert.equal(result.assignments.get('b'), 'story-b');
  assert.ok(result.metrics.family_blocks >= 1);
});

test('labeled-pair evaluation measures merge precision and separation', () => {
  const assignments = new Map([['a', 's1'], ['b', 's1'], ['c', 's2']]);
  const truth = { labels: [
    { pair_id: 'a:b', label: 'same' },
    { pair_id: 'a:c', label: 'different' },
  ] };
  const result = evaluateAssignments(assignments, truth);
  assert.equal(result.same_recall, 1);
  assert.equal(result.different_separation, 1);
  assert.equal(result.co_cluster_precision, 1);
  assert.equal(result.pair_accuracy, 1);
});
