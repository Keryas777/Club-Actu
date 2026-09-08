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
    'Bruno Genesio', 'Bradley Barcola', 'Tochukwu Nnadi', 'Paulo Fonseca',
    'Karim Benzema', 'Pierre Sage'
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
    'Mercato OL : coup de théâtre annoncé pour Malick Fofana',
    [
      'D’abord, Malick Fofana reste ciblé par Crystal Palace.',
      'L’information confirme que Malick Fofana est encore sous contrat à l’OL.',
      'L’autre scénario concerne Malick Fofana et Sunderland.'
    ].join('\n\n')
  ), context);

  const people = events.flatMap((event) => event.primary_people);
  for (const pseudo of ['D’abord', 'L’information', 'L’autre', 'Premier', 'C’est']) {
    assert.ok(!people.includes(pseudo));
  }
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

test('same protagonist cross-family context is coalesced into the dominant transfer dossier', () => {
  const events = extractEventCandidates(article(
    'Mercato OL : coup de théâtre annoncé pour Malick Fofana',
    [
      'Crystal Palace prépare une offre pour recruter Malick Fofana à l’OL.',
      'Malick Fofana est encore sous contrat avec l’OL jusqu’en 2028.',
      'Malick Fofana veut disputer une compétition européenne la saison prochaine.',
      'L’entraîneur Paulo Fonseca souhaite éviter le départ de Malick Fofana.'
    ].join('\n\n')
  ), context);

  const fofana = events.filter((event) => event.primary_people.includes('Malick Fofana'));
  assert.equal(fofana.length, 1);
  assert.equal(fofana[0].family, 'transfer');
  assert.ok(fofana[0].evidence.fragments.length >= 3);
});

test('a genuine injury rupture for the same protagonist remains a separate event', () => {
  const events = extractEventCandidates(article(
    'Mercato OL : Malick Fofana ciblé par Crystal Palace',
    [
      'Crystal Palace prépare une offre pour recruter Malick Fofana à l’OL.',
      'Malick Fofana s’est blessé à l’entraînement et un diagnostic a confirmé une lésion.'
    ].join('\n\n')
  ), context);

  const fofana = events.filter((event) => event.primary_people.includes('Malick Fofana'));
  assert.equal(fofana.length, 2);
  assert.ok(fofana.some((event) => event.family === 'transfer'));
  assert.ok(fofana.some((event) => event.family === 'injury'));
});

test('title-named protagonist wins over an incidental person extracted in the lead', () => {
  const events = extractEventCandidates(article(
    'OM : un départ de Bruno Genesio est déjà redouté à Marseille',
    [
      'Stéphane Martins évoque la situation de Bruno Genesio à l’OM.',
      'Bruno Genesio pourrait quitter son poste d’entraîneur et son avenir inquiète le club.',
      'Bruno Genesio est encore sous contrat avec l’OM.'
    ].join('\n\n'),
    'Stéphane Martins estime que Bruno Genesio reste au centre du dossier.'
  ), context);

  const genesio = events.filter((event) => event.primary_people.includes('Bruno Genesio'));
  assert.equal(genesio.length, 1);
  assert.equal(genesio[0].family, 'staff');
});
