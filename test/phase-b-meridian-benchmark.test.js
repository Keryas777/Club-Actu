import test from 'node:test';
import assert from 'node:assert/strict';
import {record,representation,shortlistContext,dedupe,shortlist} from '../scripts/benchmark-meridian-bge-m3.mjs';

const art=(id,title='OL : Liverpool avance pour Malick Fofana')=>({id,source_id:`s-${id}`,title,published_at:'2026-09-09T10:00:00Z'});
const ev=(o={})=>({family:'transfer',primary_people:['Malick Fofana'],primary_clubs:['OL','Liverpool'],relation_hints:{club_from:'OL',club_to:'Liverpool'},stage:'negotiation',evidence:{kind:'lead',text:'Liverpool négocie avec l’OL pour Malick Fofana.'},lexical_fingerprint:{tokens:['liverpool','fofana','negocie','offre']},...o});

test('representation keeps football anchors',()=>{const r=record(art('a'),ev(),'ol'),t=representation(r);assert.match(t,/family=transfer/);assert.match(t,/from=OL/);assert.match(t,/to=Liverpool/);});

test('same article never shortlists',()=>{const a=record(art('x'),ev(),'ol'),b=record(art('x'),ev({family:'contract'}),'ol'),c=shortlistContext([a,b]);assert.equal(shortlist(a,b,c).keep,false);});

test('shared person shortlists cross-source event',()=>{const a=record(art('a'),ev(),'ol'),b=record(art('b'),ev({primary_clubs:['OL']}),'ol'),c=shortlistContext([a,b]);assert.equal(shortlist(a,b,c).keep,true);});

test('same club alone is insufficient',()=>{const a=record(art('a'),ev({primary_people:['Malick Fofana'],primary_clubs:['OL'],relation_hints:{},lexical_fingerprint:{tokens:['fofana','liverpool','offre']}}),'ol'),b=record(art('b','OL : blessure de Corentin Tolisso'),ev({family:'injury',primary_people:['Corentin Tolisso'],primary_clubs:['OL'],relation_hints:{},evidence:{kind:'lead',text:'Tolisso souffre du genou.'},lexical_fingerprint:{tokens:['tolisso','blessure','genou']}}),'ol'),c=shortlistContext([a,b]);assert.equal(shortlist(a,b,c).keep,false);});

test('same event exposed through two club previews is deduplicated',()=>{const row={article:art('a'),events:[ev()]},rs=dedupe([{club_id:'ol',articles:[row]},{club_id:'psg',articles:[row]}]);assert.equal(rs.length,1);assert.deepEqual(rs[0].club_ids.sort(),['ol','psg']);});
