import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../scripts/enrich-article-content.mjs', import.meta.url), 'utf8');

test('content enrichment SQL does not emit explicit transactions for D1 remote execution', () => {
  assert.equal(/BEGIN\s+TRANSACTION/i.test(source), false);
  assert.equal(/\bCOMMIT\s*;/i.test(source), false);
});
