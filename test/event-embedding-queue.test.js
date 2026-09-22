import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EVENT_EMBEDDING_LIMIT,
  extractEmbeddingVectors,
  loadPendingEmbeddingEvents,
  processEventEmbeddingBatch,
  repairLegacyTextEmbeddingStorage,
  validateEmbeddingVector
} from '../src/event-embedding-queue.js';

function statement(sql, bindings = [], db) {
  return {
    sql,
    bindings,
    bind(...next) {
      return statement(sql, next, db);
    },
    async all() {
      db.calls.push({ method: 'all', sql, bindings });
      return { results: db.rows || [] };
    },
    async first() {
      db.calls.push({ method: 'first', sql, bindings });
      if (/FROM event_embeddings/.test(sql)) return db.readyEmbedding || null;
      return null;
    },
    async run() {
      db.calls.push({ method: 'run', sql, bindings });
      if (/UPDATE event_candidates/.test(sql) && /embedding_processing/.test(sql)) {
        return { success: true, meta: { changes: db.claimChanges ?? 1 } };
      }
      if (/UPDATE event_candidates/.test(sql) && /ready_match/.test(sql)) {
        return { success: true, meta: { changes: db.readyEventChanges ?? 1 } };
      }
      return { success: true, meta: { changes: 1 } };
    }
  };
}

function makeDb(options = {}) {
  return {
    calls: [],
    batches: [],
    rows: options.rows || [],
    readyEmbedding: options.readyEmbedding || null,
    claimChanges: options.claimChanges,
    readyEventChanges: options.readyEventChanges,
    prepare(sql) {
      return statement(sql, [], this);
    },
    async batch(statements) {
      this.batches.push(statements.map((s) => ({ sql: s.sql, bindings: s.bindings })));
      return statements.map(() => ({ success: true, meta: { changes: 1, rows_written: 1 } }));
    }
  };
}

const row = {
  event_id: 'event-1',
  article_id: 'article-1',
  family: 'transfer',
  stage: 'negotiation',
  primary_people_json: JSON.stringify(['Jean Dupont']),
  primary_clubs_json: JSON.stringify(['Olympique Lyonnais']),
  relation_from: 'Arsenal',
  relation_to: 'Olympique Lyonnais',
  evidence_json: JSON.stringify({ text: 'Jean Dupont négocie avec Lyon.' }),
  lexical_tokens_json: JSON.stringify(['dupont', 'negocie', 'lyon']),
  match_status: 'pending_embedding',
  match_attempts: 0,
  article_title: 'L’OL avance sur un transfert'
};

test('embedding queue uses the existing covering EVENT queue index and stays bounded', async () => {
  const db = makeDb({ rows: [row] });
  const rows = await loadPendingEmbeddingEvents(db);

  assert.equal(rows.length, 1);
  const query = db.calls.find((c) => c.method === 'all');
  assert.ok(query);
  assert.match(query.sql, /INDEXED BY idx_event_candidates_match_queue/);
  assert.match(query.sql, /lifecycle_status = 'active'/);
  assert.match(query.sql, /pending_embedding/);
  assert.match(query.sql, /embedding_retry/);
  assert.match(query.sql, /embedding_processing/);
  assert.match(query.sql, /ORDER BY e\.created_at ASC/);
  assert.equal(query.bindings.at(-1), DEFAULT_EVENT_EMBEDDING_LIMIT);
});

test('Workers AI response parser accepts standard nested vector payloads', () => {
  const vector = Array.from({ length: 1024 }, (_, i) => i / 1024);
  assert.deepEqual(extractEmbeddingVectors({ data: [vector] }, 1), [vector]);
  assert.deepEqual(extractEmbeddingVectors({ result: { data: [vector] } }, 1), [vector]);
});

test('embedding vector validation returns compact Float32 storage', () => {
  const vector = Array.from({ length: 1024 }, (_, i) => i / 1024);
  const typed = validateEmbeddingVector(vector);
  assert.ok(typed instanceof Float32Array);
  assert.equal(typed.length, 1024);
  assert.equal(typed.byteLength, 4096);
});

test('one EVENT is claimed, embedded once, stored as Float32 BLOB input and moved to ready_match', async () => {
  const db = makeDb();
  let aiCalls = 0;
  const vector = Array.from({ length: 1024 }, (_, i) => (i + 1) / 2048);

  const result = await processEventEmbeddingBatch(db, null, {
    rows: [row],
    embed: async (texts) => {
      aiCalls++;
      assert.equal(texts.length, 1);
      assert.match(texts[0], /^family=transfer \| people=Jean Dupont/);
      return [vector];
    }
  });

  assert.equal(aiCalls, 1);
  assert.equal(result.candidates, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.embedded, 1);
  assert.equal(result.retry, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.ai_calls, 1);
  assert.equal(result.writes_executed, 4);

  assert.equal(db.batches.length, 1);
  const readyEmbedding = db.batches[0].find((s) => /SET vector = \?/.test(s.sql));
  const readyEvent = db.batches[0].find((s) => /match_status = 'ready_match'/.test(s.sql));
  assert.ok(readyEmbedding);
  assert.ok(readyEvent);
  assert.ok(readyEmbedding.bindings[0] instanceof ArrayBuffer);
  assert.equal(readyEmbedding.bindings[0].byteLength, 4096);
  assert.ok(Math.abs(new DataView(readyEmbedding.bindings[0]).getFloat32(0, true) - (1 / 2048)) < 1e-8);
});

test('legacy comma-separated embedding TEXT is repaired to BLOB without an AI call and matching error is requeued', async () => {
  const legacy = Array.from({ length: 1024 }, (_, i) => (i - 512) / 4096).join(',');
  const db = makeDb({
    rows: [{ id: 7, event_id: 'event-1', vector: legacy }]
  });

  const result = await repairLegacyTextEmbeddingStorage(db, { limit: 20 });

  assert.equal(result.scanned, 1);
  assert.equal(result.repaired, 1);
  assert.equal(result.requeued, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.writes_executed, 2);
  assert.equal(db.batches.length, 1);
  const repair = db.batches[0][0];
  const requeue = db.batches[0][1];
  assert.match(repair.sql, /typeof\(vector\) = 'text'/);
  assert.ok(repair.bindings[0] instanceof ArrayBuffer);
  assert.equal(repair.bindings[0].byteLength, 4096);
  assert.match(requeue.sql, /Unsupported Float32 BLOB type: string/);
  assert.ok(requeue.bindings.includes('event-1'));
});

test('an exact ready embedding is reused without another AI call', async () => {
  const db = makeDb({
    readyEmbedding: { id: 7, dimension: 1024, encoding: 'float32le' }
  });
  let aiCalls = 0;

  const result = await processEventEmbeddingBatch(db, null, {
    rows: [row],
    embed: async () => {
      aiCalls++;
      throw new Error('must not be called');
    }
  });

  assert.equal(aiCalls, 0);
  assert.equal(result.reused, 1);
  assert.equal(result.embedded, 0);
  assert.equal(result.ai_calls, 0);
  assert.equal(result.writes_executed, 1);
  assert.equal(db.batches.length, 0);
  const lookup = db.calls.find((call) => call.method === 'first' && /FROM event_embeddings/.test(call.sql));
  assert.ok(lookup);
  assert.match(lookup.sql, /typeof\(vector\) = 'blob'/);
});

test('fifth failed embedding attempt becomes terminal instead of tight-looping retry', async () => {
  const db = makeDb();
  const fifthAttempt = { ...row, match_attempts: 4 };

  const result = await processEventEmbeddingBatch(db, null, {
    rows: [fifthAttempt],
    embed: async () => {
      throw new Error('synthetic Workers AI failure');
    }
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.embedded, 0);
  assert.equal(result.retry, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.ai_calls, 1);
  assert.equal(db.batches.length, 1);
  assert.ok(db.batches[0].some((s) => s.bindings.includes('embedding_failed')));
});
