import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStoryCandidates } from '../src/story-match-store.js';

function makeDb(rows = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        sql,
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async all() {
          calls.push({ sql, bindings: this.bindings });
          return { results: rows, meta: { rows_read: rows.length } };
        }
      };
    }
  };
}

test('STORY candidate lookup pre-aggregates index hits before joining stories', async () => {
  const expectedRows = [
    { id: 'story-a', matched_key_count: 4 },
    { id: 'story-b', matched_key_count: 2 }
  ];
  const db = makeDb(expectedRows);
  const event = {
    article_id: 'article-1',
    primary_people_json: JSON.stringify(['Paulo Fonseca']),
    primary_clubs_json: JSON.stringify(['Olympique Lyonnais']),
    relation_from: null,
    relation_to: null,
    competition: null,
    opponents_json: '[]',
    lexical_tokens_json: JSON.stringify(['fonseca', 'lyon'])
  };
  const ctx = { discriminantTokens: new Set(['fonseca', 'lyon']) };
  const metrics = { queries: 0, rows_read: 0 };

  const result = await loadStoryCandidates(db, event, ctx, metrics);
  const call = db.calls[0];

  assert.ok(call);
  assert.deepEqual(result.candidates, expectedRows);
  assert.equal(call.bindings.length, 2);
  assert.match(call.sql, /WITH event_keys AS MATERIALIZED/i);
  assert.match(call.sql, /matched AS MATERIALIZED/i);
  assert.match(call.sql, /CROSS JOIN story_index_keys AS k INDEXED BY idx_story_index_keys_lookup/i);
  assert.match(call.sql, /GROUP BY k\.story_id/i);
  assert.match(call.sql, /FROM matched m\s+JOIN stories s ON s\.id = m\.story_id/i);
  assert.match(call.sql, /ORDER BY m\.matched_key_count DESC/i);
  assert.doesNotMatch(call.sql, /JOIN stories s ON s\.id = k\.story_id/i);
});
