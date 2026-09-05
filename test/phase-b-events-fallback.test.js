import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEventCandidates } from '../src/phase-b-events.js';

const context={clubs:[{id:'psg',name:'PSG',aliases:['PSG','Paris Saint-Germain']}]};

test('extracts a multi-word central person without a people dictionary',()=>{
  const events=extractEventCandidates({title:'Ibrahim Mbaye quitte le PSG et rejoint Aston Villa. Officiel.',excerpt:'',content:''},context);
  assert.equal(events.length,1);
  assert.equal(events[0].family,'transfer');
  assert.ok(events[0].primary_people.includes('Ibrahim Mbaye'));
});
