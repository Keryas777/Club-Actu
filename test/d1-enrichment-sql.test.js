import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const enrichmentScript = fs.readFileSync(new URL('../scripts/enrich-article-content.mjs', import.meta.url), 'utf8');
const enrichmentWorkflow = fs.readFileSync(new URL('../.github/workflows/enrich-article-content.yml', import.meta.url), 'utf8');
const optimizationMigration = fs.readFileSync(new URL('../migrations/0010_optimize_d1_hot_queues.sql', import.meta.url), 'utf8');

test('content enrichment SQL does not emit explicit transactions for D1 remote execution', () => {
  assert.equal(/BEGIN\s+TRANSACTION/i.test(enrichmentScript), false);
  assert.equal(/\bCOMMIT\s*;/i.test(enrichmentScript), false);
});

test('content enrichment candidate lookup starts from indexed relevant assessments', () => {
  assert.match(enrichmentWorkflow, /FROM article_club_assessments a JOIN raw_articles r/i);
  assert.match(enrichmentWorkflow, /a\.rule_version='phase-a-relevance-v3' AND a\.decision='relevant'/i);
  assert.equal(/WHERE EXISTS \(SELECT 1 FROM article_club_assessments/i.test(enrichmentWorkflow), false);
});

test('D1 hot queues have dedicated covering indexes', () => {
  assert.match(
    optimizationMigration,
    /idx_article_assessments_enrichment_queue[\s\S]*rule_version,[\s\S]*decision,[\s\S]*article_id,[\s\S]*source_content_hash/i
  );
  assert.match(
    optimizationMigration,
    /idx_article_extractions_cleanup_queue[\s\S]*status,[\s\S]*updated_at,[\s\S]*article_id/i
  );
});
