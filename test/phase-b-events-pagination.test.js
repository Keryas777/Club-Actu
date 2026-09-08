import test from 'node:test';
import assert from 'node:assert/strict';
import { getPhaseBEventPreview } from '../src/phase-b-events-full-content.js';

function makeDb(calls) {
  return {
    prepare(sql) {
      if (/SELECT club_id, alias, strength FROM club_aliases/.test(sql)) {
        return {
          async all() {
            return { results: [] };
          }
        };
      }

      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return {
            async all() {
              return { results: [] };
            }
          };
        }
      };
    }
  };
}

test('Phase B preview uses LIMIT/OFFSET for bounded audit pages', async () => {
  const calls = [];
  const result = await getPhaseBEventPreview(makeDb(calls), 'om', 20, null, 40);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /LIMIT \? OFFSET \?/);
  assert.deepEqual(calls[0].bindings, ['om', 20, 40]);
  assert.equal(result.offset, 40);
  assert.equal(result.article_count, 0);
});

test('article_id preview ignores pagination offset', async () => {
  const calls = [];
  const result = await getPhaseBEventPreview(makeDb(calls), 'om', 20, 'article-123', 40);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].bindings, ['om', 'article-123', 1, 0]);
  assert.equal(result.offset, 0);
  assert.equal(result.article_id, 'article-123');
});
