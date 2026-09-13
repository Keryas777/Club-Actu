import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_SAMPLE_SIZE = 120;
const SAMPLE_BINS = [
  { name: 'lt_064', min: -Infinity, max: 0.64 },
  { name: '064_065', min: 0.64, max: 0.65 },
  { name: '065_0675', min: 0.65, max: 0.675 },
  { name: '0675_070', min: 0.675, max: 0.70 },
  { name: '070_0725', min: 0.70, max: 0.725 },
  { name: '0725_075', min: 0.725, max: 0.75 },
  { name: 'gte_075', min: 0.75, max: Infinity },
];

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const stableRank = (pair) => hash(pair.pair_id || `${pair.event_a}:${pair.event_b}`).slice(0, 12);

function withPairId(pair) {
  if (pair.pair_id) return pair;
  const ids = [pair.event_a || '', pair.event_b || ''].sort();
  return { ...pair, pair_id: ids.join(':') };
}

export function selectCalibrationSample(inputPairs, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const pairs = inputPairs.map(withPairId);
  const size = Math.max(16, Math.min(Number(sampleSize) || DEFAULT_SAMPLE_SIZE, pairs.length));
  const targetPerBin = Math.floor(size / SAMPLE_BINS.length);
  const selected = [];
  const selectedIds = new Set();
  const binStats = {};

  for (const bin of SAMPLE_BINS) {
    const candidates = pairs
      .filter((pair) => pair.hybrid >= bin.min && pair.hybrid < bin.max)
      .sort((a, b) => stableRank(a).localeCompare(stableRank(b)));
    const take = Math.min(targetPerBin, candidates.length);
    for (const pair of candidates.slice(0, take)) {
      selected.push({ ...pair, sample_bin: bin.name });
      selectedIds.add(pair.pair_id);
    }
    binStats[bin.name] = { available: candidates.length, selected: take };
  }

  if (selected.length < size) {
    const boundaryFirst = pairs
      .filter((pair) => !selectedIds.has(pair.pair_id))
      .sort((a, b) => Math.abs(a.hybrid - 0.65) - Math.abs(b.hybrid - 0.65) || stableRank(a).localeCompare(stableRank(b)));
    for (const pair of boundaryFirst) {
      if (selected.length >= size) break;
      const bin = SAMPLE_BINS.find((candidate) => pair.hybrid >= candidate.min && pair.hybrid < candidate.max)?.name || 'other';
      selected.push({ ...pair, sample_bin: bin });
      selectedIds.add(pair.pair_id);
      if (binStats[bin]) binStats[bin].selected++;
    }
  }

  const sample = selected
    .sort((a, b) => b.hybrid - a.hybrid || a.pair_id.localeCompare(b.pair_id))
    .map((pair, index) => ({
      review_id: `M${String(index + 1).padStart(3, '0')}`,
      ...pair,
      label: null,
      review_notes: '',
    }));

  return { sample, bins: binStats };
}

function metricsAtThreshold(rows, threshold) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const row of rows) {
    const actualSame = row.label === 'same';
    const predictedSame = row.hybrid >= threshold;
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
  const thresholds = [];
  for (let value = 0.60; value <= 0.78 + 1e-9; value += 0.005) {
    thresholds.push(metricsAtThreshold(rows, +value.toFixed(3)));
  }

  const zones = [];
  for (let low = 0.60; low <= 0.69 + 1e-9; low += 0.005) {
    for (let high = Math.max(low + 0.015, 0.64); high <= 0.78 + 1e-9; high += 0.005) {
      const autoMerge = rows.filter((row) => row.hybrid >= high);
      const newStory = rows.filter((row) => row.hybrid < low);
      const ambiguous = rows.filter((row) => row.hybrid >= low && row.hybrid < high);
      const autoCorrect = autoMerge.filter((row) => row.label === 'same').length;
      const newCorrect = newStory.filter((row) => row.label === 'different').length;
      const autoMergePrecision = autoMerge.length ? autoCorrect / autoMerge.length : 1;
      const newStoryPrecision = newStory.length ? newCorrect / newStory.length : 1;
      const deterministicCoverage = rows.length ? (autoMerge.length + newStory.length) / rows.length : 0;
      zones.push({
        low: +low.toFixed(3),
        high: +high.toFixed(3),
        auto_merge_count: autoMerge.length,
        auto_merge_precision: autoMergePrecision,
        new_story_count: newStory.length,
        new_story_precision: newStoryPrecision,
        ambiguous_count: ambiguous.length,
        ambiguous_rate: rows.length ? ambiguous.length / rows.length : 0,
        deterministic_coverage: deterministicCoverage,
      });
    }
  }

  zones.sort((a, b) => {
    const aSafe = a.auto_merge_precision >= 0.97 && a.new_story_precision >= 0.97;
    const bSafe = b.auto_merge_precision >= 0.97 && b.new_story_precision >= 0.97;
    if (aSafe !== bSafe) return Number(bSafe) - Number(aSafe);
    return b.deterministic_coverage - a.deterministic_coverage || a.ambiguous_rate - b.ambiguous_rate;
  });

  return {
    labeled: rows.length,
    same: rows.filter((row) => row.label === 'same').length,
    different: rows.filter((row) => row.label === 'different').length,
    thresholds,
    recommended_zones: zones.slice(0, 20),
  };
}

async function main() {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
  };
  const benchmarkDir = arg('--benchmark-dir', 'meridian-benchmark');
  const outDir = arg('--out-dir', 'phase-b-meridian-calibration');
  const sampleSize = Math.max(16, Math.min(400, parseInt(arg('--sample-size', String(DEFAULT_SAMPLE_SIZE)), 10) || DEFAULT_SAMPLE_SIZE));
  const labelsPath = arg('--labels', '');

  const pairAudit = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'pairs-structured.json'), 'utf8'));
  const benchmarkSummary = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'summary.json'), 'utf8'));
  const pairs = (pairAudit.pairs || pairAudit.all_pairs || pairAudit.top_pairs || []).map(withPairId);
  if (!pairs.length) throw new Error('No structured candidate pairs found in benchmark artifact');

  fs.mkdirSync(outDir, { recursive: true });
  const { sample, bins } = selectCalibrationSample(pairs, sampleSize);
  fs.writeFileSync(path.join(outDir, 'calibration-sample.json'), JSON.stringify(sample, null, 2));

  let evaluation = null;
  if (labelsPath) {
    const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
    evaluation = evaluateLabels(Array.isArray(labels) ? labels : labels.sample || []);
    fs.writeFileSync(path.join(outDir, 'calibration-evaluation.json'), JSON.stringify(evaluation, null, 2));
  }

  const summary = {
    generated_at: new Date().toISOString(),
    benchmark_generated_at: benchmarkSummary.generated_at || null,
    model: benchmarkSummary.model || '@cf/baai/bge-m3',
    representation: 'structured',
    source_extractor_versions: benchmarkSummary.extractor_versions || [],
    available_pairs: pairs.length,
    source_pair_scope: pairAudit.pairs ? 'all_shortlisted' : pairAudit.all_pairs ? 'all_shortlisted' : 'top_pairs_only',
    sample_size: sample.length,
    sample_bins: bins,
    score_range: { min: Math.min(...pairs.map((pair) => pair.hybrid)), max: Math.max(...pairs.map((pair) => pair.hybrid)) },
    labels_evaluated: evaluation?.labeled || 0,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
