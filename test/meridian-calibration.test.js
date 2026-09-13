import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCalibrationSample, evaluateLabels } from '../scripts/calibrate-meridian-story-thresholds.mjs';

test('calibration sample is deterministic, bounded and stratified', () => {
  const pairs = Array.from({ length: 240 }, (_, i) => ({
    pair_id: `p${i}`,
    hybrid: 0.50 + (i % 60) * 0.005,
    embedding: 0.6,
    risk_flags: [],
  })).sort((a, b) => b.hybrid - a.hybrid);
  const a = selectCalibrationSample(pairs, 120);
  const b = selectCalibrationSample(pairs, 120);
  assert.equal(a.sample.length, 120);
  assert.deepEqual(a.sample.map((x) => x.pair_id), b.sample.map((x) => x.pair_id));
  assert.ok(Object.values(a.bins).filter((x) => x.selected > 0).length >= 6);
  assert.ok(a.sample.every((x) => x.label === null));
});

test('evaluation finds a separating threshold and an ambiguity zone', () => {
  const sample = [
    ...[0.78, 0.75, 0.72, 0.70].map((hybrid, i) => ({ pair_id: `s${i}`, hybrid, label: 'same' })),
    ...[0.62, 0.60, 0.57, 0.53].map((hybrid, i) => ({ pair_id: `d${i}`, hybrid, label: 'different' })),
  ];
  const result = evaluateLabels(sample);
  const t = result.thresholds.find((x) => x.threshold === 0.65);
  assert.equal(t.precision, 1);
  assert.equal(t.recall, 1);
  assert.ok(result.recommended_zones.some((z) => z.auto_merge_precision === 1 && z.new_story_precision === 1));
});
