import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractGateFeatures,
  familyCompatible,
  explicitFootballConflict,
  strongFootballAnchor,
} from '../scripts/audit-meridian-anchor-gate.mjs';

function record(id, family, people, clubs, extra = {}) {
  return [id, {
    id,
    event: {
      family,
      primary_people: people,
      primary_clubs: clubs,
      relation_hints: extra.relation_hints || {},
      family_discriminator: extra.family_discriminator || null,
    },
  }];
}

function features(a, b, pairExtra = {}) {
  const events = new Map([a, b]);
  return extractGateFeatures({
    event_a: a[0],
    event_b: b[0],
    lexical: pairExtra.lexical || 0,
  }, events);
}

test('blocks known incompatible transfer/institutional subjects even with shared speaker and club', () => {
  const f = features(
    record('a', 'transfer', ['Stéphane Richard'], ['OM']),
    record('b', 'institutional', ['Stéphane Richard'], ['OM']),
    { lexical: 0.33 },
  );
  assert.equal(familyCompatible(f), false);
  assert.equal(explicitFootballConflict(f), true);
  assert.equal(strongFootballAnchor(f), false);
});

test('allows unknown family when the same match subject remains strongly anchored', () => {
  const f = features(
    record('a', 'match', ['Luis Enrique'], ['PSG', 'Slovan Bratislava']),
    record('b', 'unknown', ['Luis Enrique'], ['PSG', 'Slovan Bratislava']),
  );
  assert.equal(familyCompatible(f), true);
  assert.equal(explicitFootballConflict(f), false);
  assert.equal(strongFootballAnchor(f), true);
});

test('allows a strongly anchored transfer dossier', () => {
  const f = features(
    record('a', 'transfer', ['Malick Fofana'], ['OL', 'Crystal Palace']),
    record('b', 'transfer', ['Malick Fofana'], ['OL', 'Crystal Palace']),
  );
  assert.equal(strongFootballAnchor(f), true);
});

test('blocks explicit match-anchor conflicts', () => {
  const f = features(
    record('a', 'match', ['Coach'], ['PSG', 'Lyon'], {
      family_discriminator: { match_anchor: 'psg-lyon-2026-09-01', competition: 'ligue 1', opponents: ['Lyon'] },
    }),
    record('b', 'match', ['Coach'], ['PSG', 'Marseille'], {
      family_discriminator: { match_anchor: 'psg-om-2026-09-08', competition: 'ligue 1', opponents: ['Marseille'] },
    }),
  );
  assert.equal(explicitFootballConflict(f), true);
  assert.equal(strongFootballAnchor(f), false);
});
