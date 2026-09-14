import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const norm = (value = '') => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const arr = (value) => Array.isArray(value) ? value : [];
const set = (value) => new Set(arr(value).map(norm).filter(Boolean));
const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const pairKey = (a, b) => [a, b].sort().join(':');
const q = (value) => +Number(value || 0).toFixed(6);

const COMPATIBLE_FAMILY_PAIRS = new Set([
  'contract|transfer',
  'discipline|transfer',
  'competition|match',
  'discipline|match',
  'contract|staff',
  'finance|institutional',
]);

function familyPair(a, b) {
  return [a || 'unknown', b || 'unknown'].sort().join('|');
}

export function extractGateFeatures(pair, eventsById) {
  const ra = eventsById.get(pair.event_a);
  const rb = eventsById.get(pair.event_b);
  if (!ra || !rb) throw new Error(`Missing event for pair ${pairKey(pair.event_a, pair.event_b)}`);
  const a = ra.event || {};
  const b = rb.event || {};
  const peopleA = arr(a.primary_people).map(norm).filter(Boolean);
  const peopleB = arr(b.primary_people).map(norm).filter(Boolean);
  const peopleSetA = new Set(peopleA);
  const peopleSetB = new Set(peopleB);
  const clubsA = set(a.primary_clubs);
  const clubsB = set(b.primary_clubs);
  const relA = set([a.relation_hints?.club_from, a.relation_hints?.club_to].filter(Boolean));
  const relB = set([b.relation_hints?.club_from, b.relation_hints?.club_to].filter(Boolean));
  const da = a.family_discriminator || {};
  const db = b.family_discriminator || {};
  const value = (obj, key) => norm(obj?.[key]);
  const opponentsA = set(da.opponents);
  const opponentsB = set(db.opponents);
  const familyA = a.family || 'unknown';
  const familyB = b.family || 'unknown';
  return {
    family_a: familyA,
    family_b: familyB,
    family_pair: familyPair(familyA, familyB),
    people_overlap: overlap(peopleSetA, peopleSetB),
    clubs_overlap: overlap(clubsA, clubsB),
    subject_cross: Boolean(
      peopleA.length && peopleB.length &&
      (peopleSetB.has(peopleA[0]) || peopleSetA.has(peopleB[0]))
    ),
    relation_overlap: overlap(relA, relB),
    match_equal: Boolean(value(da, 'match_anchor') && value(da, 'match_anchor') === value(db, 'match_anchor')),
    match_conflict: Boolean(value(da, 'match_anchor') && value(db, 'match_anchor') && value(da, 'match_anchor') !== value(db, 'match_anchor')),
    procedure_equal: Boolean(value(da, 'procedure_anchor') && value(da, 'procedure_anchor') === value(db, 'procedure_anchor')),
    procedure_conflict: Boolean(value(da, 'procedure_anchor') && value(db, 'procedure_anchor') && value(da, 'procedure_anchor') !== value(db, 'procedure_anchor')),
    competition_equal: Boolean(value(da, 'competition') && value(da, 'competition') === value(db, 'competition')),
    competition_conflict: Boolean(value(da, 'competition') && value(db, 'competition') && value(da, 'competition') !== value(db, 'competition')),
    opponents_overlap: overlap(opponentsA, opponentsB),
    opponents_conflict: Boolean(opponentsA.size && opponentsB.size && !overlap(opponentsA, opponentsB)),
    lexical: Number(pair.lexical || 0),
  };
}

export function familyCompatible(features) {
  if (features.family_a === features.family_b) return true;
  if (features.family_a === 'unknown' || features.family_b === 'unknown') return true;
  return COMPATIBLE_FAMILY_PAIRS.has(features.family_pair);
}

export function explicitFootballConflict(features) {
  if (!familyCompatible(features)) return true;
  if (features.match_conflict || features.procedure_conflict) return true;
  const matchish = ['match', 'competition'];
  if (matchish.includes(features.family_a) && matchish.includes(features.family_b)) {
    if (features.competition_conflict || features.opponents_conflict) return true;
  }
  return false;
}

export function strongFootballAnchor(features) {
  if (explicitFootballConflict(features)) return false;
  const { family_a: a, family_b: b } = features;
  if (a === 'unknown' || b === 'unknown') {
    return features.subject_cross ||
      features.clubs_overlap >= 2 ||
      features.match_equal ||
      features.competition_equal ||
      features.procedure_equal ||
      (features.people_overlap >= 1 && features.clubs_overlap >= 1);
  }

  const transferish = new Set(['transfer', 'contract', 'discipline']);
  if (transferish.has(a) && transferish.has(b)) {
    return (features.subject_cross && features.clubs_overlap >= 1) ||
      features.relation_overlap > 0 ||
      features.clubs_overlap >= 3 ||
      (features.people_overlap >= 2 && features.lexical >= 0.08);
  }

  const matchish = new Set(['match', 'competition']);
  if (matchish.has(a) || matchish.has(b)) {
    return features.clubs_overlap >= 2 ||
      features.match_equal ||
      features.competition_equal ||
      features.opponents_overlap > 0 ||
      (features.subject_cross && features.clubs_overlap >= 1);
  }

  return (features.subject_cross && features.clubs_overlap >= 1) ||
    features.procedure_equal ||
    (features.people_overlap >= 2 && features.lexical >= 0.08) ||
    features.clubs_overlap >= 2;
}

const GATES = {
  baseline: () => true,
  family_compat: familyCompatible,
  football_conflicts: (f) => !explicitFootballConflict(f),
  football_anchor_v1: strongFootballAnchor,
};

function zoneMetrics(labeled, gateName, low, high) {
  const gate = GATES[gateName];
  const autoMerge = labeled.filter((row) => row.hybrid >= high && gate(row.features));
  const newStory = labeled.filter((row) => row.hybrid < low);
  const autoIds = new Set(autoMerge.map((row) => row.pair_id));
  const newIds = new Set(newStory.map((row) => row.pair_id));
  const ambiguous = labeled.filter((row) => !autoIds.has(row.pair_id) && !newIds.has(row.pair_id));
  const autoCorrect = autoMerge.filter((row) => row.label === 'same').length;
  const newCorrect = newStory.filter((row) => row.label === 'different').length;
  return {
    low: q(low),
    high: q(high),
    auto_merge_count: autoMerge.length,
    auto_merge_precision: autoMerge.length ? autoCorrect / autoMerge.length : 1,
    new_story_count: newStory.length,
    new_story_precision: newStory.length ? newCorrect / newStory.length : 1,
    ambiguous_count: ambiguous.length,
    deterministic_coverage: labeled.length ? (autoMerge.length + newStory.length) / labeled.length : 0,
    support_ok: autoMerge.length >= 5 && newStory.length >= 5,
  };
}

function evaluateGate(labeled, allPairs, gateName) {
  const safe = [];
  const all = [];
  for (let low = 0.45; low <= 0.60 + 1e-9; low += 0.005) {
    for (let high = Math.max(0.60, low + 0.015); high <= 0.78 + 1e-9; high += 0.005) {
      const row = zoneMetrics(labeled, gateName, low, high);
      all.push(row);
      if (row.support_ok && row.auto_merge_precision >= 0.97 && row.new_story_precision >= 0.97) safe.push(row);
    }
  }
  safe.sort((a, b) => b.deterministic_coverage - a.deterministic_coverage || a.ambiguous_count - b.ambiguous_count);
  const recommended = safe[0] || [...all].sort((a, b) =>
    (b.auto_merge_precision + b.new_story_precision) - (a.auto_merge_precision + a.new_story_precision) ||
    b.deterministic_coverage - a.deterministic_coverage
  )[0];

  const gate = GATES[gateName];
  const fullAuto = allPairs.filter((row) => row.hybrid >= recommended.high && gate(row.features));
  const blocked = allPairs.filter((row) => row.hybrid >= recommended.high && !gate(row.features));
  const blockedHigh = [...blocked]
    .sort((a, b) => b.hybrid - a.hybrid)
    .slice(0, 30)
    .map((row) => ({
      pair_id: row.pair_id,
      hybrid: row.hybrid,
      embedding: row.embedding,
      lexical: row.lexical,
      family_a: row.features.family_a,
      family_b: row.features.family_b,
      title_a: row.title_a,
      title_b: row.title_b,
    }));

  return {
    gate: gateName,
    recommended,
    safe_zone_found: safe.length > 0,
    safe_zone_count: safe.length,
    full_shortlist_auto_merge_count: fullAuto.length,
    full_shortlist_blocked_high_count: blocked.length,
    blocked_high_examples: blockedHigh,
  };
}

function sentinelResults(sentinels, pairMap, eventsById, gateName) {
  const gate = GATES[gateName];
  return sentinels.map((sentinel) => {
    const pair = pairMap.get(sentinel.pair_id);
    if (!pair) return { ...sentinel, found: false, pass: false };
    const features = extractGateFeatures(pair, eventsById);
    const allowed = gate(features);
    const pass = sentinel.expected_gate === 'allow' ? allowed : !allowed;
    return {
      ...sentinel,
      found: true,
      gate_allowed: allowed,
      hybrid: pair.hybrid,
      family_a: pair.family_a,
      family_b: pair.family_b,
      pass,
    };
  });
}

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const benchmarkDir = arg('--benchmark-dir', 'meridian-benchmark');
  const labelsPath = arg('--labels', 'test/fixtures/meridian-story-labels-v2.json');
  const outDir = arg('--out-dir', 'phase-b-meridian-anchor-gate');

  const pairAudit = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'pairs-structured.json'), 'utf8'));
  const events = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'events.json'), 'utf8'));
  const truth = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const pairs = pairAudit.pairs || [];
  const eventsById = new Map(events.map((row) => [row.id, row]));
  const pairMap = new Map(pairs.map((row) => [pairKey(row.event_a, row.event_b), row]));
  const labels = new Map(truth.labels.map((row) => [row.pair_id, row.label]));

  const allPairs = pairs.map((pair) => ({
    ...pair,
    pair_id: pairKey(pair.event_a, pair.event_b),
    features: extractGateFeatures(pair, eventsById),
  }));

  const labeled = allPairs
    .filter((row) => labels.has(row.pair_id))
    .map((row) => ({ ...row, label: labels.get(row.pair_id) }))
    .filter((row) => row.label === 'same' || row.label === 'different');

  const excluded = truth.labels.filter((row) => row.label === 'exclude').length;
  if (labeled.length < 100) throw new Error(`Too few labeled pairs matched benchmark: ${labeled.length}`);

  const gates = Object.keys(GATES).map((gateName) => {
    const sentinels = sentinelResults(truth.sentinels || [], pairMap, eventsById, gateName);
    return {
      ...evaluateGate(labeled, allPairs, gateName),
      sentinel_passed: sentinels.filter((row) => row.pass).length,
      sentinel_total: sentinels.length,
      sentinels,
    };
  });

  const ranked = [...gates].sort((a, b) => {
    const aSent = a.sentinel_total ? a.sentinel_passed / a.sentinel_total : 0;
    const bSent = b.sentinel_total ? b.sentinel_passed / b.sentinel_total : 0;
    const aSafe = a.safe_zone_found && aSent === 1;
    const bSafe = b.safe_zone_found && bSent === 1;
    if (aSafe !== bSafe) return Number(bSafe) - Number(aSafe);
    if (aSent !== bSent) return bSent - aSent;
    return b.recommended.deterministic_coverage - a.recommended.deterministic_coverage;
  });

  const summary = {
    generated_at: new Date().toISOString(),
    benchmark_run_id: truth.benchmark_run_id,
    calibration_run_id: truth.calibration_run_id,
    shortlisted_pairs: pairs.length,
    labeled_pairs: labeled.length,
    excluded_labels: excluded,
    sentinels: (truth.sentinels || []).length,
    recommended_gate: ranked[0]?.gate || null,
    gates,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'anchor-gate-summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'anchor-gate-labeled-pairs.json'), JSON.stringify(labeled.map((row) => ({
    pair_id: row.pair_id,
    label: row.label,
    hybrid: row.hybrid,
    family_a: row.features.family_a,
    family_b: row.features.family_b,
    features: row.features,
    title_a: row.title_a,
    title_b: row.title_b,
  })), null, 2));

  console.log(JSON.stringify({
    shortlisted_pairs: summary.shortlisted_pairs,
    labeled_pairs: summary.labeled_pairs,
    excluded_labels: summary.excluded_labels,
    recommended_gate: summary.recommended_gate,
    gates: gates.map((g) => ({
      gate: g.gate,
      safe_zone_found: g.safe_zone_found,
      recommended: g.recommended,
      sentinel_passed: `${g.sentinel_passed}/${g.sentinel_total}`,
      full_shortlist_auto_merge_count: g.full_shortlist_auto_merge_count,
      full_shortlist_blocked_high_count: g.full_shortlist_blocked_high_count,
    })),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
