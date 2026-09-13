import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPairAudit } from '../scripts/benchmark-meridian-bge-m3-calibration.mjs';
import { selectCalibrationSample, evaluateLabels } from '../scripts/calibrate-meridian-story-thresholds-v2.mjs';

const event = (id, person, tokens) => ({
  id,
  article: { id: `a-${id}`, title: id, published_at: '2026-09-09T10:00:00Z' },
  event: { family: 'transfer', primary_people: [person], primary_clubs: ['Club A'], relation_hints: {}, lexical_fingerprint: { tokens } },
});

test('full benchmark exports every shortlisted pair', () => {
  const records = [event('e1','Player One',['player','target','offer']), event('e2','Player One',['player','target','talks']), event('e3','Player Two',['other','injury','knee'])];
  const embeddings = new Map([['e1',[1,0]],['e2',[0.99,0.01]],['e3',[0,1]]]);
  const audit = buildPairAudit(records, embeddings);
  assert.equal(audit.pairs.length, audit.shortlisted_pairs);
  assert.deepEqual(audit.top_pairs, audit.pairs.slice(0,160));
});

test('v2 sample covers score spectrum and decision focus', () => {
  const pairs = Array.from({ length: 1000 }, (_, i) => ({ pair_id: `p${i}`, hybrid: 0.20 + i * 0.0006 }));
  const { sample, bins, broadTarget, focusTarget } = selectCalibrationSample(pairs, 150);
  assert.equal(sample.length, 150);
  assert.equal(broadTarget, 100);
  assert.equal(focusTarget, 50);
  assert.ok(Object.values(bins).every((row) => row.selected > 0));
  assert.ok(sample.some((row) => row.hybrid < 0.30));
  assert.ok(sample.some((row) => row.hybrid > 0.75));
});

test('exclude labels are ignored by threshold metrics', () => {
  const result = evaluateLabels([{hybrid:0.8,label:'same'},{hybrid:0.75,label:'same'},{hybrid:0.2,label:'different'},{hybrid:0.25,label:'different'},{hybrid:0.9,label:'exclude'}]);
  assert.equal(result.labeled, 4);
  assert.equal(result.excluded, 1);
});
