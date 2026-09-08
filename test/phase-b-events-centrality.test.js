import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEventCandidates } from '../src/phase-b-events-centrality.js';

const context = {
  clubs: [
    { id: 'psg', name: 'PSG', aliases: ['PSG', 'Paris Saint-Germain', 'Paris SG'] },
    { id: 'ol', name: 'OL', aliases: ['OL', 'Olympique Lyonnais'] },
    { id: 'om', name: 'OM', aliases: ['OM', 'Olympique de Marseille', 'Marseille'] }
  ],
  people: [
    'Ibrahim Mbaye', 'Malick Fofana', 'Lamine Camara', 'Neal Maupay',
    'Bruno Genesio', 'Bradley Barcola', 'Tochukwu Nnadi', 'Paulo Fonseca'
  ].map((name) => ({ name }))
};

const article = (title, content = '', excerpt = '') => ({ title, content, excerpt });

test('pronostic body context does not become independent events', () => {
  const events = extractEventCandidates(article(
    'Pronostic Lyon Auxerre – Ligue 1',
    [
      'Historique. La saison dernière, l’OL avait battu Auxerre 2-1.',
      'L’infirmerie. Malick Fofana est blessé et reste forfait.',
      'Composition probable : l’OL devrait évoluer en 4-3-3 face à Auxerre.'
    ].join('\n\n'),
    'L’OL reçoit Auxerre pour un match de Ligue 1.'
  ), context);

  assert.equal(events.length, 1);
  assert.equal(events[0].evidence.kind, 'lead');
});

test('different-person historical context is discarded in a normal article', () => {
  const events = extractEventCandidates(article(
    'Bradley Barcola quitte le PSG pour Liverpool',
    'Bradley Barcola rejoint Liverpool après un accord avec le PSG.\n\nLa saison dernière, Ibrahim Mbaye avait quitté le PSG pour Aston Villa.'
  ), context);

  assert.ok(events.some((event) => event.primary_people.includes('Bradley Barcola')));
  assert.ok(!events.some((event) => event.primary_people.includes('Ibrahim Mbaye')));
});

test('body continuation about the main protagonist is retained', () => {
  const events = extractEventCandidates(article(
    'Malick Fofana ciblé par Crystal Palace',
    'Crystal Palace prépare une offre pour recruter Malick Fofana à l’OL.\n\nMalick Fofana reste la priorité du club anglais et les négociations avancent.'
  ), context);

  assert.equal(events.length, 1);
  assert.ok(events[0].primary_people.includes('Malick Fofana'));
  assert.ok(events[0].evidence.fragments.length >= 2);
});

test('mercato roundup keeps several explicit independent transfers', () => {
  const events = extractEventCandidates(article(
    'Le point mercato du jour',
    'Malick Fofana est ciblé par Crystal Palace.\n\nIbrahim Mbaye quitte le PSG et rejoint Aston Villa.\n\nLamine Camara est en négociations avec Chelsea.'
  ), context);

  assert.ok(events.length >= 3);
  assert.ok(events.some((event) => event.primary_people.includes('Malick Fofana')));
  assert.ok(events.some((event) => event.primary_people.includes('Ibrahim Mbaye')));
  assert.ok(events.some((event) => event.primary_people.includes('Lamine Camara')));
});

test('editorial signal fragments are not emitted as body events', () => {
  const events = extractEventCandidates(article(
    'Bradley Barcola ciblé par Liverpool',
    'Un feu vert. Premier signal faible : l’information vient d’apparaître et reste une simple rumeur. ?\n\nLiverpool prépare une offre pour recruter Bradley Barcola au PSG.'
  ), context);

  assert.equal(events.length, 1);
  assert.ok(events[0].primary_people.includes('Bradley Barcola'));
});

test('editorial pseudo-people are removed from primary_people', () => {
  const events = extractEventCandidates(article(
    'Pronostic PSG Monaco – Ligue 1',
    'L’infirmerie. Bradley Barcola est forfait.\n\nPremier signal faible : le PSG pourrait changer sa composition.'
  ), context);

  const people = events.flatMap((event) => event.primary_people);
  assert.ok(!people.includes('L’infirmerie'));
  assert.ok(!people.includes('Premier'));
  assert.ok(!people.includes('C’est'));
});

test('same dossier is merged even when repeated in non-adjacent body paragraphs', () => {
  const events = extractEventCandidates(article(
    'Malick Fofana ciblé par Crystal Palace',
    'Crystal Palace prépare une offre pour Malick Fofana.\n\nLe marché anglais reste très actif cet été.\n\nMalick Fofana est toujours la cible prioritaire de Crystal Palace et les négociations continuent.'
  ), context);

  const fofana = events.filter((event) => event.primary_people.includes('Malick Fofana'));
  assert.equal(fofana.length, 1);
  assert.ok(fofana[0].evidence.fragments.length >= 2);
});
