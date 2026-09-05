import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEventCandidates } from '../src/phase-b-events.js';

const context={
  clubs:[
    {id:'psg',name:'PSG',aliases:['PSG','Paris Saint-Germain','Paris SG']},
    {id:'ol',name:'OL',aliases:['OL','Olympique Lyonnais']},
    {id:'om',name:'OM',aliases:['OM','Olympique de Marseille','Marseille']}
  ],
  people:['Ibrahim Mbaye','Malick Fofana','Lamine Camara','Neal Maupay','Ulisses Garcia','Faris Moumbagna','Bruno Genesio','Luis Enrique','Bradley Barcola','Tochukwu Nnadi'].map(name=>({name}))
};
const article=(title,content='',excerpt='')=>({title,content,excerpt});

test('A - mono transfer official',()=>{
  const events=extractEventCandidates(article('Ibrahim Mbaye quitte le PSG et file à Aston Villa. Officiel.'),context);
  assert.equal(events.length,1); assert.equal(events[0].family,'transfer');
  assert.ok(events[0].primary_people.includes('Ibrahim Mbaye'));
  assert.ok(events[0].primary_clubs.includes('PSG')); assert.ok(events[0].primary_clubs.includes('Aston Villa'));
  assert.equal(events[0].stage,'official');
});

test('B - multi transfer creates independent candidates',()=>{
  const events=extractEventCandidates(article('JT Foot Mercato','Malick Fofana file vers Crystal Palace.\n\nIbrahim Mbaye quitte le PSG et rejoint Aston Villa.\n\nLamine Camara est en négociations avec Chelsea.'),context);
  assert.ok(events.length>=3);
  assert.ok(events.some(e=>e.primary_people.includes('Malick Fofana')&&e.primary_clubs.includes('Crystal Palace')));
  assert.ok(events.some(e=>e.primary_people.includes('Ibrahim Mbaye')&&e.primary_clubs.includes('Aston Villa')));
  assert.ok(events.some(e=>e.primary_people.includes('Lamine Camara')&&e.primary_clubs.includes('Chelsea')));
});

test('C - mixed transfer and staff article',()=>{
  const events=extractEventCandidates(article('OM Mercato','Neal Maupay pourrait quitter Marseille.\n\nUlisses Garcia est annoncé sur le départ de l’OM.\n\nFaris Moumbagna pourrait lui aussi partir.\n\nBruno Genesio joue son avenir sur le banc, son départ est discuté.'),context);
  assert.ok(events.filter(e=>e.family==='transfer').length>=3);
  assert.ok(events.some(e=>e.family==='staff'&&e.primary_people.includes('Bruno Genesio')));
});

test('D - statement form does not override transfer substance',()=>{
  const events=extractEventCandidates(article('Luis Enrique explique le départ de Bradley Barcola vers Liverpool'),context);
  assert.equal(events[0].family,'transfer'); assert.ok(events[0].primary_people.includes('Bradley Barcola'));
});

test('E - coach statement about injury yields injury',()=>{
  const events=extractEventCandidates(article('Bruno Genesio donne des nouvelles de Tochukwu Nnadi','Bruno Genesio explique que Tochukwu Nnadi s’est blessé au genou et passera des examens.'),context);
  assert.ok(events.some(e=>e.family==='injury'&&e.primary_people.includes('Tochukwu Nnadi')));
});

test('F - same person can yield different dossier families',()=>{
  const transfer=extractEventCandidates(article('Bradley Barcola quitte le PSG pour Liverpool'),context);
  const injury=extractEventCandidates(article('Bradley Barcola blessé, examens prévus'),context);
  assert.equal(transfer[0].family,'transfer'); assert.equal(injury[0].family,'injury');
});

test('G - recap does not collapse independent dossiers',()=>{
  const events=extractEventCandidates(article('Le point mercato','Malick Fofana est ciblé par Crystal Palace.\n\nIbrahim Mbaye va signer à Aston Villa.\n\nLamine Camara discute avec Chelsea.'),context);
  assert.ok(events.length>=3); assert.ok(events.every(e=>e.primary_people.length<=3));
});
