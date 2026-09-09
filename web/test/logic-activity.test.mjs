import assert from 'node:assert/strict';
import test from 'node:test';
import { logicActivityTimestamp } from '../src/lib/logic-activity.js';

const nowMs = Date.parse('2026-09-08T12:00:00Z');
const classify = (seconds) => logicActivityTimestamp(seconds, { nowMs });

test('zero means no contract timestamp, while absent and malformed metrics stay unavailable', () => {
  assert.deepEqual(classify(0), { status: 'none' });
  for (const invalid of [undefined, null, false, true, '', '0', '1788868800', [], [0], {}, NaN, Infinity, -Infinity, -1, 0.5, 1n]) {
    assert.deepEqual(classify(invalid), { status: 'unavailable' }, `invalid type or value: ${String(invalid)}`);
  }
});

test('valid numeric seconds preserve the complete timestamp, including early dates', () => {
  for (const seconds of [1, 86400, nowMs / 1000 - 3600, nowMs / 1000]) {
    assert.deepEqual(classify(seconds), {
      status: 'recorded', milliseconds: seconds * 1000, iso: new Date(seconds * 1000).toISOString(),
    });
  }
});

test('the existing one-day future tolerance is inclusive, with later values unavailable', () => {
  const lastAccepted = nowMs / 1000 + 86400;
  assert.equal(classify(lastAccepted).status, 'recorded');
  assert.equal(classify(lastAccepted).iso, '2026-09-09T12:00:00.000Z');
  assert.deepEqual(classify(lastAccepted + 1), { status: 'unavailable' });
});

test('unrepresentable Date values and corrupt large contract values cannot throw', () => {
  const maxDateMs = 8.64e15;
  const maxSeconds = maxDateMs / 1000;
  assert.equal(logicActivityTimestamp(maxSeconds, { nowMs: maxDateMs }).iso, '+275760-09-13T00:00:00.000Z');
  assert.deepEqual(logicActivityTimestamp(maxSeconds + 1, { nowMs: maxDateMs }), { status: 'unavailable' });
  for (const seconds of [Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, 1e77]) {
    assert.deepEqual(classify(seconds), { status: 'unavailable' });
  }
  assert.deepEqual(logicActivityTimestamp(1, { nowMs: NaN }), { status: 'unavailable' });
});
