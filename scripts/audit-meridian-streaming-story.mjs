import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortlistContext, shortlist } from './benchmark-meridian-bge-m3.mjs';
import { familyCompatible } from './audit-meridian-anchor-gate.mjs';

const MODEL = '@cf/baai/bge-m3';
export const LOW = 0.535;
export const HIGH = 0.660;
const ANCHOR_THRESHOLDS = [null, 0.50, 0.55, 0.60, 0.625, 0.65, 0.675, 0.70, 0.725, 0.75];
const MODES = ['conservative', 'stress'];

const norm = (value = '') => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const set = (xs = []) => new Set((Array.isArray(xs) ? xs : []).map(norm).filter(Boolean));
const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const ts = (value) => { const n = Date.parse(value || ''); return Number.isFinite(n) ? n : 0; };
const q = (value) => +Number(value || 0).toFixed(6);

export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function updateCentroid(current, next, countBefore) {
  if (!current?.length) return next.slice();
  if (current.length !== next.length) throw new Error('Centroid/vector dimension mismatch');
  const n = Math.max(0, Number(countBefore) || 0);
  return current.map((value, index) => (value * n + next[index]) / (n + 1));
}

function lexicalTokens(record) {
  return set((record.event?.lexical_fingerprint?.tokens || []).filter((x) => norm(x).length >= 4));
}

export function lexicalScore(a, b) {
  const A = lexicalTokens(a), B = lexicalTokens(b), union = new Set([...A, ...B]);
  return union.size ? inter(A, B) / union.size : 0;
}

export function temporalScore(a, b, sigmaDays = 7) {
  const x = ts(a.article?.published_at), y = ts(b.article?.published_at);
  if (!x || !y) return 0.5;
  const days = Math.abs(x - y) / 864e5;
  return Math.exp(-(days * days) / (2 * sigmaDays * sigmaDays));
}

function familyFeatures(a, b) {
  const fa = a.event?.family || 'unknown';
  const fb = b.event?.family || 'unknown';
  return { family_a: fa, family_b: fb, family_pair: [fa, fb].sort().join('|') };
}

export function familyCompatibleRecords(a, b) {
  return familyCompatible(familyFeatures(a, b));
}

export function anchorGatePass(anchorSimilarity, threshold) {
  return threshold == null || anchorSimilarity >= threshold;
}

function vectors(payload, count) {
  for (const value of [payload?.result?.data, payload?.data, payload?.result?.response, payload?.response]) {
    if (Array.isArray(value) && value.length === count && Array.isArray(value[0])) return value;
  }
  throw new Error(`Unexpected BGE-M3 response: ${JSON.stringify(payload).slice(0, 800)}`);
}

async function embed(texts, account, token) {
  const out = [];
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`;
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: batch }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(`Workers AI HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 1200)}`);
    }
    out.push(...vectors(payload, batch.length));
  }
  return out;
}

function storyLexicalScore(record, story) {
  let best = 0;
  for (const member of story.members) best = Math.max(best, lexicalScore(record, member.record));
  return best;
}

function candidateStories(record, stories, ctx) {
  return stories.filter((story) => story.members.some((member) => shortlist(record, member.record, ctx).keep));
}

function storyScore(record, vector, story) {
  const embedding = cosine(vector, story.centroid);
  const lexical = storyLexicalScore(record, story);
  const temporal = temporalScore(record, story.members.at(-1).record);
  const hybrid = 0.60 * embedding + 0.25 * lexical + 0.15 * temporal;
  return {
    embedding,
    lexical,
    temporal,
    hybrid,
    anchor_embedding: cosine(vector, story.anchorVector),
    anchor_lexical: lexicalScore(record, story.anchor),
  };
}

function newStory(record, vector) {
  const at = ts(record.article?.published_at);
  return {
    id: `story-${record.id}`,
    anchor: record,
    anchorVector: vector.slice(),
    centroid: vector.slice(),
    members: [{ record, vector }],
    first: at,
    last: at,
    decisions: [],
  };
}

function addToStory(story, record, vector, decision) {
  story.centroid = updateCentroid(story.centroid, vector, story.members.length);
  story.members.push({ record, vector });
  const at = ts(record.article?.published_at);
  if (at) {
    story.first = story.first ? Math.min(story.first, at) : at;
    story.last = Math.max(story.last || 0, at);
  }
  story.decisions.push(decision);
}

export function simulateStreamingStories(records, embeddingMap, {
  low = LOW,
  high = HIGH,
  anchorThreshold = null,
  mode = 'conservative',
} = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  const ordered = [...records].sort((a, b) => ts(a.article?.published_at) - ts(b.article?.published_at) || a.id.localeCompare(b.id));
  const ctx = shortlistContext(ordered);
  const stories = [];
  const assignments = new Map();
  const counters = {
    candidate_comparisons: 0,
    high_attaches: 0,
    stress_ambiguous_attaches: 0,
    low_new_story: 0,
    ambiguous_new_story: 0,
    no_candidate_new_story: 0,
    family_blocks: 0,
    anchor_blocks: 0,
    centroid_pass_anchor_fail: 0,
  };
  const shortlistSizes = [];

  for (const record of ordered) {
    const vector = embeddingMap.get(record.id);
    if (!vector) throw new Error(`Missing embedding for event ${record.id}`);
    const candidates = candidateStories(record, stories, ctx);
    shortlistSizes.push(candidates.length);
    let bestRaw = null;
    let bestEligible = null;

    for (const story of candidates) {
      counters.candidate_comparisons++;
      const scores = storyScore(record, vector, story);
      const familyOk = familyCompatibleRecords(record, story.anchor);
      const anchorOk = anchorGatePass(scores.anchor_embedding, anchorThreshold);
      const candidate = { story, scores, familyOk, anchorOk };
      if (!bestRaw || scores.hybrid > bestRaw.scores.hybrid || (scores.hybrid === bestRaw.scores.hybrid && story.id < bestRaw.story.id)) bestRaw = candidate;
      if (!familyOk) { counters.family_blocks++; continue; }
      if (!anchorOk) {
        counters.anchor_blocks++;
        if (scores.hybrid >= high) counters.centroid_pass_anchor_fail++;
        continue;
      }
      if (!bestEligible || scores.hybrid > bestEligible.scores.hybrid || (scores.hybrid === bestEligible.scores.hybrid && story.id < bestEligible.story.id)) bestEligible = candidate;
    }

    if (!bestRaw) {
      const story = newStory(record, vector);
      stories.push(story);
      assignments.set(record.id, story.id);
      counters.no_candidate_new_story++;
      continue;
    }

    const attachHigh = bestEligible && bestEligible.scores.hybrid >= high;
    const attachStressAmbiguous = bestEligible && mode === 'stress' && bestEligible.scores.hybrid >= low && bestEligible.scores.hybrid < high;

    if (attachHigh || attachStressAmbiguous) {
      const decision = {
        event_id: record.id,
        score: q(bestEligible.scores.hybrid),
        centroid_embedding: q(bestEligible.scores.embedding),
        anchor_embedding: q(bestEligible.scores.anchor_embedding),
        lexical: q(bestEligible.scores.lexical),
        temporal: q(bestEligible.scores.temporal),
        kind: attachHigh ? 'high_attach' : 'stress_ambiguous_attach',
      };
      addToStory(bestEligible.story, record, vector, decision);
      assignments.set(record.id, bestEligible.story.id);
      if (attachHigh) counters.high_attaches++;
      else counters.stress_ambiguous_attaches++;
      continue;
    }

    const story = newStory(record, vector);
    stories.push(story);
    assignments.set(record.id, story.id);
    const decisionScore = bestEligible?.scores.hybrid ?? bestRaw.scores.hybrid;
    if (decisionScore < low) counters.low_new_story++;
    else counters.ambiguous_new_story++;
  }

  const sizes = stories.map((story) => story.members.length);
  const spans = stories.map((story) => story.first && story.last ? (story.last - story.first) / 864e5 : 0);
  const anchorSimilarities = [];
  for (const story of stories) {
    for (const member of story.members.slice(1)) anchorSimilarities.push(cosine(member.vector, story.anchorVector));
  }
  const sortedShortlists = [...shortlistSizes].sort((a, b) => a - b);
  const p95Index = sortedShortlists.length ? Math.min(sortedShortlists.length - 1, Math.floor(sortedShortlists.length * 0.95)) : 0;

  return {
    stories,
    assignments,
    metrics: {
      story_count: stories.length,
      singletons: sizes.filter((x) => x === 1).length,
      max_story_size: Math.max(0, ...sizes),
      max_story_span_days: Math.max(0, ...spans),
      candidate_comparisons: counters.candidate_comparisons,
      shortlist_mean: shortlistSizes.reduce((sum, x) => sum + x, 0) / Math.max(1, shortlistSizes.length),
      shortlist_p95: sortedShortlists.length ? sortedShortlists[p95Index] : 0,
      min_member_anchor_embedding: anchorSimilarities.length ? Math.min(...anchorSimilarities) : 1,
      ...counters,
    },
  };
}

export function evaluateAssignments(assignments, truth) {
  const labels = (truth.labels || []).filter((row) => row.label === 'same' || row.label === 'different');
  let sameTotal = 0, sameTogether = 0, differentTotal = 0, differentSeparated = 0, togetherSame = 0, togetherDifferent = 0;
  const misses = [];
  for (const row of labels) {
    const [a, b] = row.pair_id.split(':');
    if (!assignments.has(a) || !assignments.has(b)) continue;
    const together = assignments.get(a) === assignments.get(b);
    if (row.label === 'same') {
      sameTotal++;
      if (together) { sameTogether++; togetherSame++; }
      else misses.push({ pair_id: row.pair_id, label: row.label, outcome: 'split' });
    } else {
      differentTotal++;
      if (!together) differentSeparated++;
      else { togetherDifferent++; misses.push({ pair_id: row.pair_id, label: row.label, outcome: 'merged' }); }
    }
  }
  const coClustered = togetherSame + togetherDifferent;
  return {
    evaluated_pairs: sameTotal + differentTotal,
    same_pairs: sameTotal,
    same_recall: sameTotal ? sameTogether / sameTotal : 1,
    different_pairs: differentTotal,
    different_separation: differentTotal ? differentSeparated / differentTotal : 1,
    co_clustered_labeled_pairs: coClustered,
    co_cluster_precision: coClustered ? togetherSame / coClustered : 1,
    pair_accuracy: sameTotal + differentTotal ? (sameTogether + differentSeparated) / (sameTotal + differentTotal) : 1,
    misses: misses.slice(0, 30),
  };
}

function storySummary(story) {
  const anchor = story.anchor;
  const memberAnchor = story.members.map((member) => cosine(member.vector, story.anchorVector));
  return {
    story_id: story.id,
    size: story.members.length,
    span_days: story.first && story.last ? (story.last - story.first) / 864e5 : 0,
    anchor_id: anchor.id,
    anchor_title: anchor.article?.title || '',
    anchor_family: anchor.event?.family || 'unknown',
    min_anchor_embedding: Math.min(...memberAnchor),
    families: [...new Set(story.members.map((member) => member.record.event?.family || 'unknown'))],
    members: story.members.slice(0, 16).map((member) => ({
      id: member.record.id,
      title: member.record.article?.title || '',
      family: member.record.event?.family || 'unknown',
      people: member.record.event?.primary_people || [],
      clubs: member.record.event?.primary_clubs || [],
      anchor_embedding: q(cosine(member.vector, story.anchorVector)),
    })),
  };
}

function rankRun(row) {
  const e = row.evaluation;
  const m = row.metrics;
  const safe = e.co_cluster_precision >= 0.97 && e.different_separation >= 0.97;
  return {
    safe,
    score: (safe ? 100 : 0) + 20 * e.same_recall + 10 * e.pair_accuracy - 0.25 * m.max_story_size - 0.01 * m.max_story_span_days,
  };
}

export function chooseRecommendation(rows) {
  const conservative = rows.filter((row) => row.mode === 'conservative');
  return [...conservative].sort((a, b) => {
    const ra = rankRun(a), rb = rankRun(b);
    if (ra.safe !== rb.safe) return Number(rb.safe) - Number(ra.safe);
    if (ra.score !== rb.score) return rb.score - ra.score;
    const ta = a.anchor_threshold == null ? -1 : a.anchor_threshold;
    const tb = b.anchor_threshold == null ? -1 : b.anchor_threshold;
    return ta - tb;
  })[0] || null;
}

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const benchmarkDir = arg('--benchmark-dir', 'meridian-benchmark');
  const labelsPath = arg('--labels', 'test/fixtures/meridian-story-labels-v2.json');
  const outDir = arg('--out-dir', 'phase-b-meridian-streaming-story');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');

  const events = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'events.json'), 'utf8'));
  const representations = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'representations-structured.json'), 'utf8'));
  const benchmarkSummary = JSON.parse(fs.readFileSync(path.join(benchmarkDir, 'summary.json'), 'utf8'));
  const truth = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const textById = new Map(representations.map((row) => [row.event_id, row.text]));
  const missing = events.filter((row) => !textById.has(row.id));
  if (missing.length) throw new Error(`Missing structured representations for ${missing.length} events`);

  const texts = events.map((row) => textById.get(row.id));
  const embedded = await embed(texts, account, token);
  const embeddingMap = new Map(events.map((row, index) => [row.id, embedded[index]]));

  const rows = [];
  for (const mode of MODES) {
    for (const anchorThreshold of ANCHOR_THRESHOLDS) {
      const simulation = simulateStreamingStories(events, embeddingMap, { low: LOW, high: HIGH, anchorThreshold, mode });
      const evaluation = evaluateAssignments(simulation.assignments, truth);
      rows.push({
        mode,
        low: LOW,
        high: HIGH,
        anchor_threshold: anchorThreshold,
        metrics: simulation.metrics,
        evaluation,
        largest_stories: [...simulation.stories]
          .sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id))
          .slice(0, 12)
          .map(storySummary),
      });
    }
  }

  const recommended = chooseRecommendation(rows);
  const summary = {
    generated_at: new Date().toISOString(),
    model: MODEL,
    benchmark_run_id: truth.benchmark_run_id || null,
    source_benchmark_generated_at: benchmarkSummary.generated_at || null,
    extractor_versions: benchmarkSummary.extractor_versions || [],
    unique_events: events.length,
    low: LOW,
    high: HIGH,
    family_gate: 'family_compat',
    ambiguity_modes: {
      conservative: 'Only HIGH attaches automatically; ambiguous events start a new provisional story.',
      stress: 'All events >= LOW may attach when gates pass; intentionally stresses centroid drift.',
    },
    tested_anchor_thresholds: ANCHOR_THRESHOLDS,
    recommended: recommended ? {
      mode: recommended.mode,
      anchor_threshold: recommended.anchor_threshold,
      metrics: recommended.metrics,
      evaluation: recommended.evaluation,
    } : null,
    runs: rows,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'streaming-story-summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'streaming-story-runs.json'), JSON.stringify(rows, null, 2));

  console.log(JSON.stringify({
    unique_events: summary.unique_events,
    low: summary.low,
    high: summary.high,
    family_gate: summary.family_gate,
    recommended: summary.recommended,
    runs: rows.map((row) => ({
      mode: row.mode,
      anchor_threshold: row.anchor_threshold,
      story_count: row.metrics.story_count,
      max_story_size: row.metrics.max_story_size,
      max_story_span_days: q(row.metrics.max_story_span_days),
      centroid_pass_anchor_fail: row.metrics.centroid_pass_anchor_fail,
      same_recall: q(row.evaluation.same_recall),
      different_separation: q(row.evaluation.different_separation),
      co_cluster_precision: q(row.evaluation.co_cluster_precision),
      pair_accuracy: q(row.evaluation.pair_accuracy),
    })),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
