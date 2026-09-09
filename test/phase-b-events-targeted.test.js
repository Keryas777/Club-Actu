import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEventCandidates } from '../src/phase-b-events-targeted.js';

const context = {
  clubs: [
    { id: 'psg', name: 'PSG', aliases: ['PSG', 'Paris Saint-Germain', 'Paris SG'] },
    { id: 'ol', name: 'OL', aliases: ['OL', 'Olympique Lyonnais'] },
    { id: 'om', name: 'OM', aliases: ['OM', 'Olympique de Marseille', 'Marseille'] }
  ],
  people: [
    'Frank McCourt', 'Geoffrey Kondogbia', 'Bruno Genesio', 'Luis Enrique',
    'Christophe Dugarry', 'Emile Hojbjerg', 'Malick Fofana', 'Ibrahim Mbaye',
    'Lamine Camara', 'L’incertitude', 'Diable Rouge', 'Ch’ti', 'Au-del'
  ].map((name) => ({ name }))
};

const article = (title, content = '', excerpt = '') => ({ title, content, excerpt });

test('DNCG title beats generic agreement vocabulary and collapses to one finance dossier', () => {
  const events = extractEventCandidates(article(
    'OM : Frank McCourt s’est mis d’accord avec la DNCG pour les prochaines années !',
    [
      'L’Olympique de Marseille va changer sa manière de recruter.',
      'Frank McCourt a présenté à la DNCG un plan destiné à assainir les finances et réduire la masse salariale.'
    ].join('\n\n'),
    'L’OM prépare un plan financier avec la DNCG.'
  ), context);

  assert.equal(events.length, 1);
  assert.equal(events[0].family, 'finance');
  assert.equal(events[0].evidence.kind, 'lead');
});

test('generic coup dur title uses the retained injury evidence as the dominant dossier', () => {
  const events = extractEventCandidates(article(
    'OM : gros coup dur pour un cadre marseillais !',
    [
      'Touché musculairement lors de la défaite à Monaco, Geoffrey Kondogbia pourrait être éloigné des terrains plusieurs semaines.',
      'Cette blessure concerne Geoffrey Kondogbia et un diagnostic doit préciser la durée de son indisponibilité.'
    ].join('\n\n'),
    'Touché musculairement, Geoffrey Kondogbia pourrait être éloigné des terrains pendant plusieurs semaines.'
  ), context);

  assert.equal(events.length, 1);
  assert.equal(events[0].family, 'injury');
  assert.ok(events[0].primary_people.includes('Geoffrey Kondogbia'));
});

test('phrase choc article becomes one statement dossier instead of unknown plus statement', () => {
  const events = extractEventCandidates(article(
    'PSG : Luis Enrique lâche une phrase choc avant Bratislava',
    [
      'Le PSG traverse un début de saison compliqué.',
      'Présent en conférence de presse, Luis Enrique déclare que les résultats sont insuffisants.'
    ].join('\n\n'),
    'Luis Enrique veut provoquer une réaction de son équipe.'
  ), context);

  assert.equal(events.length, 1);
  assert.equal(events[0].family, 'statement');
  assert.ok(events[0].primary_people.includes('Luis Enrique'));
});

test('criticism article coalesces institutional context into the speaker statement dossier', () => {
  const events = extractEventCandidates(article(
    'OM : Christophe Dugarry, le mensonge dénoncé',
    [
      'Christophe Dugarry critique vivement l’ancienne direction de l’OM.',
      'Christophe Dugarry dénonce la gouvernance du club et met en cause son président.'
    ].join('\n\n')
  ), context);

  assert.equal(events.length, 1);
  assert.equal(events[0].family, 'statement');
  assert.ok(events[0].primary_people.includes('Christophe Dugarry'));
});

test('same transfer continuation without an extracted person is attached to the title protagonist', () => {
  const events = extractEventCandidates(article(
    'Mercato OM : Hojbjerg refuse de rejoindre l’AS Rome',
    [
      'Emile Hojbjerg a repoussé les avances de l’AS Roma et veut rester à l’OM.',
      'L’OM a refusé une offre de l’AS Roma et ne souhaite pas le laisser partir à bas prix.'
    ].join('\n\n'),
    'Emile Hojbjerg a repoussé les avances de l’AS Roma et donne sa priorité à l’OM.'
  ), context);

  assert.equal(events.length, 1);
  assert.equal(events[0].family, 'transfer');
  assert.ok(events[0].primary_people.includes('Emile Hojbjerg'));
  assert.ok(events[0].evidence.fragments.length >= 2);
});

test('contract title beats generic signature vocabulary', () => {
  const events = extractEventCandidates(article(
    'PSG : la signature de Luis Enrique jusqu’en 2030 se fait attendre',
    'La prolongation de Luis Enrique jusqu’en 2030 n’est pas encore signée, mais les discussions avec le PSG avancent.'
  ), context);

  assert.equal(events.length, 1);
  assert.equal(events[0].family, 'contract');
});

test('true mercato roundups stay multi-event', () => {
  const events = extractEventCandidates(article(
    'Le point mercato du jour',
    'Malick Fofana est ciblé par Crystal Palace.\n\nIbrahim Mbaye quitte le PSG et rejoint Aston Villa.\n\nLamine Camara est en négociations avec Chelsea.'
  ), context);

  assert.ok(events.length >= 3);
  assert.ok(events.some((event) => event.primary_people.includes('Malick Fofana')));
  assert.ok(events.some((event) => event.primary_people.includes('Ibrahim Mbaye')));
  assert.ok(events.some((event) => event.primary_people.includes('Lamine Camara')));
});

test('new editorial pseudo-people are removed without changing roundup structure', () => {
  const events = extractEventCandidates(article(
    'Le point mercato du jour',
    [
      'L’incertitude signe à Chelsea après un accord.',
      'Diable Rouge rejoint Liverpool.',
      'Ch’ti signe à Aston Villa.',
      'Au-del rejoint Crystal Palace.'
    ].join('\n\n')
  ), context);

  const people = events.flatMap((event) => event.primary_people);
  for (const pseudo of ['L’incertitude', 'Diable Rouge', 'Ch’ti', 'Au-del']) {
    assert.ok(!people.includes(pseudo));
  }
});
