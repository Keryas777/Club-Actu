import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/audit-phase-b-event-extraction.yml', 'utf8');

test('Phase B audit writes aggregated JSON with ASCII escaping for surrogate safety', () => {
  assert.match(
    workflow,
    /json\.dumps\(aggregated, ensure_ascii=True, indent=2\)/,
    'aggregated audit JSON must escape non-ASCII so lone surrogate code points cannot break UTF-8 writes'
  );
});

test('Phase B audit prints full multi-event examples with ASCII escaping', () => {
  assert.match(
    workflow,
    /json\.dumps\(row,ensure_ascii=True,indent=2\)/,
    'full article/event examples must not send lone surrogate code points directly to the runner terminal'
  );
});
