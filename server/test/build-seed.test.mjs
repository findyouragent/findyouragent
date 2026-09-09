import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSeedRows } from '../seed/build-seed.mjs';

const row = (key, overrides = {}) => ({
  key,
  formulaVersion: 'test',
  tier: 'registered',
  endpointProven: false,
  servedNames: [],
  ...overrides,
});

test('seed budget counts UTF-8 bytes when selecting filler rows', () => {
  const evidence = row('1', { endpointProven: true });
  const unicodeFiller = row('2', { name: 'é'.repeat(20) });
  const evidenceBytes = Buffer.byteLength(`${JSON.stringify(evidence)}\n`, 'utf8');
  const fillerAsStringUnits = `${JSON.stringify(unicodeFiller)}\n`.length;
  assert.ok(Buffer.byteLength(`${JSON.stringify(unicodeFiller)}\n`, 'utf8') > fillerAsStringUnits);
  const latest = new Map([[evidence.key, evidence], [unicodeFiller.key, unicodeFiller]]);

  const { rows } = selectSeedRows(latest, {
    formulaVersion: 'test',
    budgetBytes: evidenceBytes + fillerAsStringUnits,
  });

  assert.deepEqual(rows.map((entry) => entry.key), ['1']);
  assert.ok(Buffer.byteLength(`${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8') <= evidenceBytes + fillerAsStringUnits);
});
