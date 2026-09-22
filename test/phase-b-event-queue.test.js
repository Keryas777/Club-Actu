import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EVENT_BATCH_LIMIT,
  DEFAULT_EVENT_LOOKBACK_HOURS,
  loadPendingEventArticleIds,
  processPhaseBEventPersistenceBatch
} from '../src/phase-b-event-queue.js';

function makeQueueDb(articleIds = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async all() {
              calls.push({ sql, bindings });
              return { results: articleIds.map((article_id) => ({ article_id })) };
            }
          };
        }
      };
    }
  };
}

test('pending EVENT queue is bounded, recent, full-content only and exact-content gated', async () => {
  const db = makeQueueDb(['a1', 'a2']);
  const ids = await loadPendingEventArticleIds(db);

  assert.deepEqual(ids, ['a1', 'a2']);
  assert.equal(db.calls.length, 1);

  const [{ sql, bindings }] = db.calls;
  assert.match(sql, /INDEXED BY idx_content_enrichments_event_queue/);
  assert.match(sql, /ce\.status = 'completed'/);
  assert.match(sql, /ce\.content_hash IS NOT NULL/);
  assert.match(sql, /idx_article_assessments_enrichment_queue/);
  assert.match(sql, /idx_article_event_runs_content_gate/);
  assert.match(sql, /q\.input_content_hash = ce\.content_hash/);
  assert.match(sql, /q\.status = 'completed'/);
  assert.match(sql, /ORDER BY ce\.updated_at ASC/);
  assert.equal(bindings.at(-1), DEFAULT_EVENT_BATCH_LIMIT);

  const cutoff = new Date(bindings[0]).getTime();
  const expectedAgeMs = DEFAULT_EVENT_LOOKBACK_HOURS * 60 * 60 * 1000;
  const actualAgeMs = Date.now() - cutoff;
  assert.ok(actualAgeMs >= expectedAgeMs - 5000);
  assert.ok(actualAgeMs <= expectedAgeMs + 5000);
});

test('bounded EVENT batch reuses one club context and accumulates persistence outcomes', async () => {
  const db = makeQueueDb(['a1', 'a2', 'a3']);
  const clubs = [{ id: 'ol', name: 'Olympique Lyonnais', aliases: ['OL'] }];
  const calls = [];

  const result = await processPhaseBEventPersistenceBatch(db, {
    limit: 3,
    lookbackHours: 24,
    maxDurationMs: 12000,
    clubs,
    persistArticle: async (_db, articleId, options) => {
      calls.push({ articleId, options });
      if (articleId === 'a1') {
        return { status: 'persisted', event_count: 2, writes_executed: 5, already_completed: false };
      }
      if (articleId === 'a2') {
        return { status: 'deferred', event_count: 0, writes_executed: 0, already_completed: false };
      }
      return { status: 'persisted', event_count: 0, writes_executed: 2, already_completed: false };
    }
  });

  assert.equal(result.candidates, 3);
  assert.equal(result.processed, 3);
  assert.equal(result.persisted, 2);
  assert.equal(result.deferred, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.event_candidates, 2);
  assert.equal(result.writes_executed, 7);
  assert.equal(result.stop_reason, 'drained');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((row) => row.options.clubs === clubs));
  assert.ok(calls.every((row) => row.options.leaseMs === 120000));
});

test('bounded EVENT batch isolates one article failure and continues', async () => {
  const db = makeQueueDb(['a1', 'a2']);
  const result = await processPhaseBEventPersistenceBatch(db, {
    clubs: [],
    persistArticle: async (_db, articleId) => {
      if (articleId === 'a1') throw new Error('synthetic failure');
      return { status: 'persisted', event_count: 1, writes_executed: 3 };
    }
  });

  assert.equal(result.processed, 2);
  assert.equal(result.persisted, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.event_candidates, 1);
  assert.equal(result.writes_executed, 3);
});
