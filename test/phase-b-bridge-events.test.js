import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBridgeAudit,
  classifyEndpointRelation,
  DEFAULT_LOW,
  DEFAULT_HIGH,
} from '../scripts/audit-phase-b-bridge-events.mjs';

test('endpoint relation respects labels and LOW/HIGH zones', () => {
  assert.equal(classifyEndpointRelation({ hybrid: 0.70 }, null).suspicious, false);
  assert.equal(classifyEndpointRelation({ hybrid: 0.60 }, null).gap_class, 'ambiguous_gap');
  assert.equal(classifyEndpointRelation({ hybrid: 0.40 }, null).gap_class, 'below_low');
  assert.equal(classifyEndpointRelation(null, null).gap_class, 'not_shortlisted');
  assert.equal(classifyEndpointRelation({ hybrid: 0.75 }, 'different').gap_class, 'ground_truth_different');
  assert.equal(classifyEndpointRelation({ hybrid: 0.50 }, 'same').suspicious, false);
  assert.equal(DEFAULT_LOW, 0.535);
  assert.equal(DEFAULT_HIGH, 0.660);
});

const event = (id, articleId, title, family = 'transfer') => ({
  id,
  article: { id: articleId, title, published_at: '2026-09-01T12:00:00Z' },
  club_ids: ['ol'],
  event: {
    family,
    primary_people: ['Player A'],
    primary_clubs: ['OL'],
    relation_hints: {},
    family_discriminator: null,
    evidence: { fragments: [title] },
    lexical_fingerprint: { tokens: ['player', 'lyon', 'mercato'] },
  },
});

const pair = (a, b, hybrid, familyA = 'transfer', familyB = 'transfer') => ({
  event_a: a,
  event_b: b,
  article_a: `article-${a}`,
  article_b: `article-${b}`,
  title_a: a,
  title_b: b,
  family_a: familyA,
  family_b: familyB,
  embedding: hybrid,
  lexical: 0,
  temporal: 1,
  hybrid,
});

test('confirmed different endpoints expose their shared HIGH center as a bridge candidate', () => {
  const events = [
    event('center', 'article-center', 'Mixed transfer article'),
    event('left', 'article-left', 'Collective sales topic'),
    event('right', 'article-right', 'Specific player refusal'),
  ];
  const pairs = [
    pair('center', 'left', 0.70),
    pair('center', 'right', 0.69),
    pair('left', 'right', 0.65),
  ];
  const truth = { labels: [{ pair_id: 'left:right', label: 'different' }] };
  const audit = buildBridgeAudit(events, pairs, truth);

  assert.equal(audit.summary.bridge_candidate_count, 1);
  assert.equal(audit.summary.confirmed_bridge_event_count, 1);
  assert.equal(audit.summary.ground_truth_conflict_triad_count, 1);
  assert.equal(audit.candidates[0].center.event_id, 'center');
  assert.equal(audit.candidates[0].risk, 'confirmed');
  assert.equal(audit.candidates[0].triads[0].gap_class, 'ground_truth_different');
});

test('family-incompatible HIGH edges are not allowed to manufacture bridge candidates', () => {
  const events = [
    event('center', 'article-center', 'Institutional center', 'institutional'),
    event('left', 'article-left', 'Transfer left', 'transfer'),
    event('right', 'article-right', 'Institutional right', 'institutional'),
  ];
  const pairs = [
    pair('center', 'left', 0.75, 'institutional', 'transfer'),
    pair('center', 'right', 0.74, 'institutional', 'institutional'),
    pair('left', 'right', 0.50, 'transfer', 'institutional'),
  ];
  const audit = buildBridgeAudit(events, pairs, { labels: [] });

  assert.equal(audit.summary.high_edges_blocked_by_family_compat, 1);
  assert.equal(audit.summary.high_edge_count, 1);
  assert.equal(audit.summary.bridge_candidate_count, 0);
});

test('same-article endpoints are ignored and labeled-same endpoints do not create false bridge alarms', () => {
  const events = [
    event('center', 'article-center', 'Center'),
    event('left', 'article-shared', 'Left'),
    event('right', 'article-shared', 'Right'),
    event('other', 'article-other', 'Other'),
  ];
  const pairs = [
    pair('center', 'left', 0.70),
    pair('center', 'right', 0.69),
    pair('center', 'other', 0.68),
    pair('left', 'other', 0.60),
  ];
  const truth = { labels: [{ pair_id: 'left:other', label: 'same' }] };
  const audit = buildBridgeAudit(events, pairs, truth);

  assert.equal(audit.summary.bridge_candidate_count, 1);
  const triads = audit.candidates[0].triads;
  assert.equal(triads.some((row) => row.endpoint_a_event_id === 'left' && row.endpoint_b_event_id === 'right'), false);
  assert.equal(triads.some((row) => new Set([row.endpoint_a_event_id, row.endpoint_b_event_id]).has('other') && new Set([row.endpoint_a_event_id, row.endpoint_b_event_id]).has('left')), false);
});
