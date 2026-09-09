import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRecord, recordParts, earnedClause, coverageSentence } from '../src/lib/escrow-record.js';

const RANGE_WHOLE = { topId: 56720, floorId: 1, jobs: 56720, asOf: '2026-09-08T12:00:00Z', whole: true, unread: 0 };
const RANGE_WINDOW = { topId: 56720, floorId: 55921, jobs: 800, asOf: '2026-09-08T12:00:00Z', whole: false, unread: 0 };

test('a deployment with no census says so about itself, not about the agent', () => {
  const view = describeRecord({ available: false, found: false, record: null, range: null });
  assert.equal(view.kind, 'unavailable');
  assert.match(view.note, /gap in ours, not a finding about this agent/);
  assert.deepEqual(view.parts, []);
  assert.doesNotMatch(view.note, /\b0\b/);
});

test('an address the census did not see is absent from a stated range, never a zero', () => {
  const view = describeRecord({ available: true, found: false, record: null, range: RANGE_WINDOW });
  assert.equal(view.kind, 'absent');
  assert.match(view.note, /the newest 800 jobs/);
  assert.match(view.note, /not the same as never hired/);
  // The failure this guards: "0 released" standing where a measurement goes.
  assert.doesNotMatch(view.note, /\b0 (released|jobs|escrow)/);
});

test('a real record reads as counts with their denominator, never as a rate', () => {
  const view = describeRecord({
    available: true,
    found: true,
    record: { jobs: 7, released: 6, rejected: 0, expired: 0, inflight: 0, lapsed: 1, earnedWei: '6000000000000000000', lastJobId: 56560 },
    range: RANGE_WHOLE,
  });
  assert.equal(view.kind, 'present');
  assert.equal(view.jobs, 7);
  assert.deepEqual(view.parts, ['6 escrow released', '1 past expiry']);
  assert.equal(view.earned, '6.0 $U');
  assert.match(view.coverage, /all 56,720 jobs on the kernel/);
  // No percentage anywhere in the rendered parts: chain-wide only about a
  // third of jobs reach completed, so a rate would score the provider for
  // jobs the buyer never funded.
  assert.doesNotMatch([view.coverage, ...view.parts].join(' '), /%/);
});

test('buckets that did not happen are omitted rather than printed as zeroes', () => {
  const parts = recordParts({ jobs: 3, released: 3, rejected: 0, expired: 0, inflight: 0, lapsed: 0 });
  assert.deepEqual(parts, ['3 escrow released']);
});

test('every bucket that did happen is named, in the order a buyer reads them', () => {
  const parts = recordParts({ jobs: 8, released: 6, rejected: 1, expired: 1, inflight: 2, lapsed: 1 });
  assert.deepEqual(parts, ['6 escrow released', '1 expired', '1 rejected', '2 in flight', '1 past expiry']);
});

test('a release with no budget shows no amount, because zero paid is not an amount', () => {
  assert.equal(earnedClause('0'), null);
  assert.equal(earnedClause(null), null);
  assert.equal(earnedClause('not a number'), null);
  assert.equal(earnedClause('6000000000000000000'), '6.0 $U');
});

test('amounts survive as exact wei strings rather than floats', () => {
  // 1234.567890123456789 $U: the last digits are gone the moment this is a
  // Number, and an amount a reader could not re-derive is not evidence.
  assert.equal(earnedClause('1234567890123456789012'), '1234.567890123456789012 $U');
});

test('the coverage sentence distinguishes the whole history from a window', () => {
  assert.match(coverageSentence(RANGE_WHOLE), /^all 56,720 jobs on the kernel/);
  assert.match(coverageSentence(RANGE_WINDOW), /^the newest 800 jobs/);
  assert.equal(coverageSentence({ jobs: 0 }), null);
});

test('unread ids travel with the counts so they read as floors', () => {
  const view = describeRecord({
    available: true,
    found: true,
    record: { jobs: 2, released: 2, earnedWei: '0' },
    range: { ...RANGE_WHOLE, unread: 12 },
  });
  assert.equal(view.unread, 12);
  assert.equal(view.earned, null);
});
