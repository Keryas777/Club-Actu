import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scopedStatusSql = /SUM\(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END\) AS rejected\s+FROM article_club_assessments INDEXED BY idx_article_club_assessments_article\s+WHERE article_id = \?\s+AND source_content_hash = \?\s+AND rule_version = \?/;

for (const [path, functionName] of [
  ['src/processor.js', 'refreshArticleProcessingStatus'],
  ['src/phase-a-residuals.js', 'refreshArticleStatus']
]) {
  test(`${functionName} uses the article-scoped index for status aggregation`, () => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const functionStart = source.indexOf(`async function ${functionName}(`);
    assert.notEqual(functionStart, -1, `Missing ${functionName}`);
    const following = source.slice(functionStart, functionStart + 1250);
    assert.match(following, scopedStatusSql);
    assert.match(following, /SUM\(CASE WHEN decision = 'relevant' THEN 1 ELSE 0 END\)/);
    assert.match(following, /SUM\(CASE WHEN decision = 'needs_review' THEN 1 ELSE 0 END\)/);
    assert.match(following, /SUM\(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END\)/);
  });
}

test('article-scoped index is declared in the baseline migration', () => {
  const migration = readFileSync(new URL('../migrations/0002_phase_a_processing.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_article_club_assessments_article\s+ON article_club_assessments\(article_id, club_id, decided_at DESC\)/);
});
