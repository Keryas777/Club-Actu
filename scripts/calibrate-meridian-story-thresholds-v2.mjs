import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_SAMPLE_SIZE = 150;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const stableRank = (pair) => hash(pair.pair_id || `${pair.event_a}:${pair.event_b}`).slice(0, 12);

function withPairId(pair) {
  if (pair.pair_id) return pair;
  const ids = [pair.event_a || '', pair.event_b || ''].sort();
  return { ...pair, pair_id: ids.join(':') };
}

function nearestUnselected(sorted, wanted, selectedIds) {
  for (let radius = 0; radius < sorted.length; radius++) {
    for (const index of [wanted - radius, wanted + radius]) {
      if (index < 0 || index >= sorted.length) continue;
      if (!selectedIds.has(sorted[index].pair_id)) return sorted[index];
    }
  }
  return null;
}

export function selectCalibrationSample(inputPairs, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const pairs = inputPairs.map(withPairId).sort((a, b) => a.hybrid - b.hybrid || a.pair_id.localeCompare(b.pair_id));
  const size = Math.max(24, Math.min(Number(sampleSize) || DEFAULT_SAMPLE_SIZE, pairs.length));
  const broadTarget = Math.min(size, Math.round(size * 2 / 3));
  const focusTarget = size - broadTarget;
  const selected = [], selectedIds = new Set();

  for (let i = 0; i < broadTarget; i++) {
    const wanted = broadTarget === 1 ? 0 : Math.round(i * (pairs.length - 1) / (broadTarget - 1));
    const pair = nearestUnselected(pairs, wanted, selectedIds);
    if (!pair) break;
    selected.push({ ...pair, sample_bucket: 'spectrum', sample_percentile: pairs.length === 1 ? 0 : wanted / (pairs.length - 1) });
    selectedIds.add(pair.pair_id);
  }

  const focusCandidates = pairs
    .filter((pair) => !selectedIds.has(pair.pair_id))
    .sort((a, b) => Math.abs(a.hybrid - 0.65) - Math.abs(b.hybrid - 0.65) || stableRank(a).localeCompare(stableRank(b)));
  for (const pair of focusCandidates.slice(0, focusTarget)) {
    selected.push({ ...pair, sample_bucket: 'decision_focus', sample_percentile: null });
    selectedIds.add(pair.pair_id);
  }

  if (selected.length < size) {
    const rest = pairs.filter((pair) => !selectedIds.has(pair.pair_id)).sort((a, b) => stableRank(a).localeCompare(stableRank(b)));
    for (const pair of rest) {
      if (selected.length >= size) break;
      selected.push({ ...pair, sample_bucket: 'fill', sample_percentile: null });
      selectedIds.add(pair.pair_id);
    }
  }

  const sample = selected
    .sort((a, b) => b.hybrid - a.hybrid || a.pair_id.localeCompare(b.pair_id))
    .map((pair, index) => ({ review_id: `M${String(index + 1).padStart(3, '0')}`, ...pair, label: null, review_notes: '' }));

  const deciles = {};
  for (let i = 0; i < 10; i++) deciles[`q${i * 10}_${(i + 1) * 10}`] = { available: 0, selected: 0 };
  const indexById = new Map(pairs.map((pair, index) => [pair.pair_id, index]));
  for (let index = 0; index < pairs.length; index++) {
    const bucket = Math.min(9, Math.floor(index / Math.max(1, pairs.length) * 10));
    deciles[`q${bucket * 10}_${(bucket + 1) * 10}`].available++;
  }
  for (const pair of sample) {
    const index = indexById.get(pair.pair_id) ?? 0;
    const bucket = Math.min(9, Math.floor(index / Math.max(1, pairs.length) * 10));
    deciles[`q${bucket * 10}_${(bucket + 1) * 10}`].selected++;
  }
  return { sample, bins: deciles, broadTarget, focusTarget };
}

function metricsAtThreshold(rows, threshold) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const row of rows) {
    const actualSame = row.label === 'same', predictedSame = row.hybrid >= threshold;
    if (actualSame && predictedSame) tp++;
    else if (!actualSame && predictedSame) fp++;
    else if (!actualSame && !predictedSame) tn++;
    else fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const accuracy = rows.length ? (tp + tn) / rows.length : 0;
  return { threshold, tp, fp, tn, fn, precision, recall, f1, accuracy };
}

export function evaluateLabels(sample) {
  const rows = sample.filter((row) => row.label === 'same' || row.label === 'different');
  const excluded = sample.filter((row) => row.label === 'exclude').length;
  if (!rows.length) return { labeled: 0, same: 0, different: 0, excluded, thresholds: [], recommended_zones: [] };
  const min = Math.max(0, Math.floor(Math.min(...rows.map((row) => row.hybrid)) * 200) / 200);
  const max = Math.min(1, Math.ceil(Math.max(...rows.map((row) => row.hybrid)) * 200) / 200);
  const thresholds = [];
  for (let value = min; value <= max + 1e-9; value += 0.005) thresholds.push(metricsAtThreshold(rows, +value.toFixed(3)));

  const values = thresholds.map((row) => row.threshold);
  const zones = [];
  for (const low of values) for (const high of values) {
    if (high < low + 0.015) continue;
    const autoMerge = rows.filter((row) => row.hybrid >= high);
    const newStory = rows.filter((row) => row.hybrid < low);
    const ambiguous = rows.filter((row) => row.hybrid >= low && row.hybrid < high);
    const autoMergePrecision = autoMerge.length ? autoMerge.filter((row) => row.label === 'same').length / autoMerge.length : 1;
    const newStoryPrecision = newStory.length ? newStory.filter((row) => row.label === 'different').length / newStory.length : 1;
    zones.push({
      low, high,
      auto_merge_count: autoMerge.length, auto_merge_precision: autoMergePrecision,
      new_story_count: newStory.length, new_story_precision: newStoryPrecision,
      ambiguous_count: ambiguous.length,
      ambiguous_rate: ambiguous.length / rows.length,
      deterministic_coverage: (autoMerge.length + newStory.length) / rows.length,
      support_ok: autoMerge.length >= 5 && newStory.length >= 5,
    });
  }
  zones.sort((a, b) => {
    const aSafe = a.support_ok && a.auto_merge_precision >= 0.97 && a.new_story_precision >= 0.97;
    const bSafe = b.support_ok && b.auto_merge_precision >= 0.97 && b.new_story_precision >= 0.97;
    if (aSafe !== bSafe) return Number(bSafe) - Number(aSafe);
    return b.deterministic_coverage - a.deterministic_coverage || a.ambiguous_rate - b.ambiguous_rate;
  });
  return {
    labeled: rows.length, same: rows.filter((row) => row.label === 'same').length,
    different: rows.filter((row) => row.label === 'different').length, excluded,
    thresholds, recommended_zones: zones.slice(0, 30),
  };
}

async function main() {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
  const benchmarkDir = arg('--benchmark-dir', 'meridian-benchmark');
  const outDir = arg('--out-dir', 'phase-b-meridian-calibration');
  const sampleSize = Math.max(24, Math.min(500, parseInt(arg('--sample-size', String(DEFAULT_SAMPLE_SIZE)), 10) || DEFAULT_SAMPLE_SIZE));
  const labelsPath = arg('--labels', '');
  const pairAudit = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'pairs-structured.json'), 'utf8'));
  const benchmarkSummary = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'summary.json'), 'utf8'));
  const pairs = (pairAudit.pairs || pairAudit.all_pairs || pairAudit.top_pairs || []).map(withPairId);
  if (!pairs.length) throw new Error('No structured candidate pairs found in benchmark artifact');

  fs.mkdirSync(outDir, { recursive: true });
  const { sample, bins, broadTarget, focusTarget } = selectCalibrationSample(pairs, sampleSize);
  fs.writeFileSync(path.join(outDir, 'calibration-sample.json'), JSON.stringify(sample, null, 2));
  let evaluation = null;
  if (labelsPath) {
    const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
    evaluation = evaluateLabels(Array.isArray(labels) ? labels : labels.sample || []);
    fs.writeFileSync(path.join(outDir, 'calibration-evaluation.json'), JSON.stringify(evaluation, null, 2));
  }
  const summary = {
    generated_at: new Date().toISOString(), benchmark_generated_at: benchmarkSummary.generated_at || null,
    model: benchmarkSummary.model || '@cf/baai/bge-m3', representation: 'structured',
    source_extractor_versions: benchmarkSummary.extractor_versions || [], available_pairs: pairs.length,
    source_pair_scope: pairAudit.pairs ? 'all_shortlisted' : pairAudit.all_pairs ? 'all_shortlisted' : 'top_pairs_only',
    sample_size: sample.length, broad_spectrum_target: broadTarget, decision_focus_target: focusTarget,
    sample_bins: bins,
    score_range: { min: Math.min(...pairs.map((pair) => pair.hybrid)), max: Math.max(...pairs.map((pair) => pair.hybrid)) },
    labels_evaluated: evaluation?.labeled || 0, labels_excluded: evaluation?.excluded || 0,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
