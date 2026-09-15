import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractGateFeatures, familyCompatible } from './audit-meridian-anchor-gate.mjs';

export const DEFAULT_LOW = 0.535;
export const DEFAULT_HIGH = 0.660;

export const pairKey = (a, b) => [String(a), String(b)].sort().join(':');
const arr = (value) => Array.isArray(value) ? value : [];
const q = (value) => +Number(value ?? 0).toFixed(6);

function evidenceText(record) {
  const evidence = record?.event?.evidence || {};
  const fragments = arr(evidence.fragments).filter(Boolean);
  const text = fragments.length ? fragments.join('\n') : String(evidence.text || '');
  return text.replace(/\s+/g, ' ').trim();
}

function compactEvent(record) {
  const event = record?.event || {};
  const evidence = event.evidence || {};
  return {
    event_id: record?.id || null,
    article_id: record?.article?.id || null,
    title: record?.article?.title || '',
    published_at: record?.article?.published_at || null,
    family: event.family || 'unknown',
    stage: event.stage || 'unknown',
    primary_people: arr(event.primary_people),
    primary_clubs: arr(event.primary_clubs),
    relation_hints: event.relation_hints || {},
    evidence_fragment_count: arr(evidence.fragments).length,
    lexical_token_count: arr(event.lexical_fingerprint?.tokens).length,
    evidence: evidenceText(record).slice(0, 2600),
  };
}

function mixednessSignals(record) {
  const meta = compactEvent(record);
  return {
    people_count: meta.primary_people.length,
    clubs_count: meta.primary_clubs.length,
    evidence_fragment_count: meta.evidence_fragment_count,
    title_has_joiner: /\b(et|mais|avant|apres|après|puis|tandis que|alors que)\b|[,;:]/i.test(meta.title),
    has_from_and_to: Boolean(meta.relation_hints?.club_from && meta.relation_hints?.club_to),
  };
}

function strongPair(pair, eventsById, high) {
  if (Number(pair?.hybrid || 0) < high) return false;
  return familyCompatible(extractGateFeatures(pair, eventsById));
}

export function classifyEndpointRelation(directPair, label, eventsById = null, low = DEFAULT_LOW, high = DEFAULT_HIGH) {
  if (label === 'exclude') return { suspicious: false, gap_class: 'excluded', endpoint_score: directPair?.hybrid ?? null };
  if (label === 'same') return { suspicious: false, gap_class: 'labeled_same', endpoint_score: directPair?.hybrid ?? null };
  if (label === 'different') return { suspicious: true, gap_class: 'ground_truth_different', endpoint_score: directPair?.hybrid ?? null };
  if (!directPair) return { suspicious: true, gap_class: 'not_shortlisted', endpoint_score: null };
  if (eventsById && !familyCompatible(extractGateFeatures(directPair, eventsById))) {
    return { suspicious: true, gap_class: 'family_block', endpoint_score: directPair.hybrid };
  }
  if (directPair.hybrid < low) return { suspicious: true, gap_class: 'below_low', endpoint_score: directPair.hybrid };
  if (directPair.hybrid < high) return { suspicious: true, gap_class: 'ambiguous_gap', endpoint_score: directPair.hybrid };
  return { suspicious: false, gap_class: 'high_connected', endpoint_score: directPair.hybrid };
}

function triadSeverity(triad) {
  const gap = triad.gap_class;
  const base = gap === 'ground_truth_different' ? 1000
    : gap === 'family_block' ? 220
      : gap === 'below_low' ? 150
        : gap === 'ambiguous_gap' ? 80
          : gap === 'not_shortlisted' ? 40
            : 0;
  const weak = triad.endpoint_score == null ? 0 : Math.max(0, DEFAULT_HIGH - triad.endpoint_score) * 100;
  const highStrength = Math.min(triad.center_to_a_score, triad.center_to_b_score) * 10;
  return base + weak + highStrength;
}

export function buildBridgeAudit(events, pairs, truth = {}, options = {}) {
  const low = Number(options.low ?? DEFAULT_LOW);
  const high = Number(options.high ?? DEFAULT_HIGH);
  const eventsById = new Map(events.map((row) => [String(row.id), row]));
  const pairMap = new Map();
  const highAdj = new Map();

  const addNeighbor = (a, b, pair) => {
    if (!highAdj.has(a)) highAdj.set(a, []);
    highAdj.get(a).push({ event_id: b, pair });
  };

  let highEdges = 0;
  let blockedHighEdges = 0;
  for (const pair of pairs) {
    const a = String(pair.event_a), b = String(pair.event_b);
    pairMap.set(pairKey(a, b), pair);
    if (Number(pair.hybrid) < high) continue;
    if (!strongPair(pair, eventsById, high)) {
      blockedHighEdges++;
      continue;
    }
    highEdges++;
    addNeighbor(a, b, pair);
    addNeighbor(b, a, pair);
  }

  const labels = new Map(arr(truth.labels).map((row) => [String(row.pair_id), row.label]));
  const triads = [];

  for (const [centerId, neighbors] of highAdj.entries()) {
    const center = eventsById.get(centerId);
    if (!center || neighbors.length < 2) continue;
    for (let i = 0; i < neighbors.length; i++) {
      for (let j = i + 1; j < neighbors.length; j++) {
        const left = neighbors[i], right = neighbors[j];
        const a = eventsById.get(left.event_id), b = eventsById.get(right.event_id);
        if (!a || !b) continue;
        if (String(a.article?.id || '') === String(b.article?.id || '')) continue;

        const endpointKey = pairKey(left.event_id, right.event_id);
        const direct = pairMap.get(endpointKey) || null;
        const label = labels.get(endpointKey) || null;
        const relation = classifyEndpointRelation(direct, label, eventsById, low, high);
        if (!relation.suspicious) continue;

        const triad = {
          center_event_id: centerId,
          endpoint_a_event_id: left.event_id,
          endpoint_b_event_id: right.event_id,
          endpoint_pair_id: endpointKey,
          center_to_a_score: q(left.pair.hybrid),
          center_to_b_score: q(right.pair.hybrid),
          endpoint_score: relation.endpoint_score == null ? null : q(relation.endpoint_score),
          endpoint_label: label,
          gap_class: relation.gap_class,
          center_title: center.article?.title || '',
          endpoint_a_title: a.article?.title || '',
          endpoint_b_title: b.article?.title || '',
        };
        triad.severity = q(triadSeverity(triad));
        triads.push(triad);
      }
    }
  }

  triads.sort((a, b) => b.severity - a.severity || b.center_to_a_score + b.center_to_b_score - a.center_to_a_score - a.center_to_b_score);

  const byCenter = new Map();
  for (const triad of triads) {
    if (!byCenter.has(triad.center_event_id)) byCenter.set(triad.center_event_id, []);
    byCenter.get(triad.center_event_id).push(triad);
  }

  const candidates = [...byCenter.entries()].map(([centerId, rows]) => {
    const record = eventsById.get(centerId);
    const counts = {
      ground_truth_different: rows.filter((row) => row.gap_class === 'ground_truth_different').length,
      family_block: rows.filter((row) => row.gap_class === 'family_block').length,
      below_low: rows.filter((row) => row.gap_class === 'below_low').length,
      ambiguous_gap: rows.filter((row) => row.gap_class === 'ambiguous_gap').length,
      not_shortlisted: rows.filter((row) => row.gap_class === 'not_shortlisted').length,
    };
    const risk = counts.ground_truth_different > 0 ? 'confirmed'
      : counts.family_block > 0 || counts.below_low > 0 ? 'high'
        : counts.ambiguous_gap > 0 ? 'medium'
          : 'review';
    return {
      center: compactEvent(record),
      risk,
      high_degree: highAdj.get(centerId)?.length || 0,
      suspicious_triad_count: rows.length,
      counts,
      mixedness_signals: mixednessSignals(record),
      max_severity: q(Math.max(...rows.map((row) => row.severity))),
      triads: rows.slice(0, 24),
    };
  }).sort((a, b) => {
    const rank = { confirmed: 4, high: 3, medium: 2, review: 1 };
    return rank[b.risk] - rank[a.risk] || b.max_severity - a.max_severity || b.suspicious_triad_count - a.suspicious_triad_count;
  });

  const confirmed = candidates.filter((row) => row.risk === 'confirmed');
  const highRisk = candidates.filter((row) => row.risk === 'high');
  const medium = candidates.filter((row) => row.risk === 'medium');
  const review = candidates.filter((row) => row.risk === 'review');

  const knownBridge = {
    center_event_id: '1c0acf06449b7c7a45ff75c0',
    endpoint_pair_id: pairKey('24ce94393700c7d189bd371d', '33967dcba466bea72dfb0204'),
  };
  const knownCandidate = candidates.find((row) => row.center.event_id === knownBridge.center_event_id);
  const knownTriad = knownCandidate?.triads.find((row) => row.endpoint_pair_id === knownBridge.endpoint_pair_id) || null;

  return {
    summary: {
      low, high,
      family_gate: 'family_compat',
      event_count: events.length,
      shortlisted_pair_count: pairs.length,
      high_edge_count: highEdges,
      high_edges_blocked_by_family_compat: blockedHighEdges,
      bridge_candidate_count: candidates.length,
      confirmed_bridge_event_count: confirmed.length,
      high_risk_bridge_event_count: highRisk.length,
      medium_risk_bridge_event_count: medium.length,
      review_bridge_event_count: review.length,
      suspicious_triad_count: triads.length,
      ground_truth_conflict_triad_count: triads.filter((row) => row.gap_class === 'ground_truth_different').length,
      family_block_triad_count: triads.filter((row) => row.gap_class === 'family_block').length,
      below_low_triad_count: triads.filter((row) => row.gap_class === 'below_low').length,
      ambiguous_gap_triad_count: triads.filter((row) => row.gap_class === 'ambiguous_gap').length,
      not_shortlisted_triad_count: triads.filter((row) => row.gap_class === 'not_shortlisted').length,
      known_fofana_bridge: {
        found: Boolean(knownTriad),
        endpoint_score: knownTriad?.endpoint_score ?? null,
        endpoint_label: knownTriad?.endpoint_label ?? null,
        gap_class: knownTriad?.gap_class ?? null,
        pass: Boolean(knownTriad && knownTriad.endpoint_label === 'different' && knownTriad.gap_class === 'ground_truth_different'),
      },
      top_candidates: candidates.slice(0, 12).map((row) => ({
        event_id: row.center.event_id,
        title: row.center.title,
        family: row.center.family,
        risk: row.risk,
        high_degree: row.high_degree,
        suspicious_triad_count: row.suspicious_triad_count,
        counts: row.counts,
        mixedness_signals: row.mixedness_signals,
      })),
    },
    candidates,
    triads,
  };
}

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const benchmarkDir = arg('--benchmark-dir', 'meridian-benchmark');
  const labelsPath = arg('--labels', 'test/fixtures/meridian-story-labels-v2.json');
  const outDir = arg('--out-dir', 'phase-b-bridge-events');
  const low = Number(arg('--low', String(DEFAULT_LOW)));
  const high = Number(arg('--high', String(DEFAULT_HIGH)));

  const pairAudit = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'pairs-structured.json'), 'utf8'));
  const events = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'events.json'), 'utf8'));
  const truth = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, 'utf8')) : { labels: [] };
  const pairs = pairAudit.pairs || [];
  if (!pairs.length || !events.length) throw new Error('Benchmark artifact must contain pairs[] and events[]');

  const audit = buildBridgeAudit(events, pairs, truth, { low, high });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bridge-event-summary.json'), JSON.stringify(audit.summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'bridge-event-candidates.json'), JSON.stringify(audit.candidates, null, 2));
  fs.writeFileSync(path.join(outDir, 'bridge-triads.json'), JSON.stringify(audit.triads, null, 2));

  console.log(JSON.stringify(audit.summary, null, 2));
  if (!audit.summary.known_fofana_bridge.pass) throw new Error('Known Fofana bridge sentinel was not reproduced');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
