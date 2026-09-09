import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEscrowCensus } from '../src/escrow/census.js';

function tmpFile(name = 'census.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fya-census-')), name);
}

const SNAPSHOT = {
  version: 1,
  asOf: '2026-09-08T12:00:00Z',
  kernel: '0xEa4DAa3100A767e86FDed867729ae7446476EBA6',
  topId: 56720,
  floorId: 1,
  jobsRead: 56720,
  idsUnread: [],
  providers: {
    '0x1f3cbddcb9257a54d10325f900f6364c1d86bdc0': {
      jobs: 7, released: 6, rejected: 0, expired: 0, inflight: 0, lapsed: 1,
      earned: '6000000000000000000', lastJobId: 56560,
    },
    '0x0475c8fa8ac94888eab9b4329b93c263708a9a07': {
      jobs: 11, released: 9, rejected: 0, expired: 0, inflight: 2, lapsed: 0,
      earned: '0', lastJobId: 56700,
    },
    '0xc0d7d8880000000000000000000000000000dead': {
      jobs: 9516, released: 0, rejected: 0, expired: 12, inflight: 9504, lapsed: 0,
      earned: '0', lastJobId: 56710,
    },
  },
};

test('no census file means unavailable, which is not an agent with no jobs', () => {
  const census = createEscrowCensus(tmpFile());
  assert.equal(census.available(), false);
  const answer = census.lookup('0x1F3CBddCb9257A54d10325f900F6364C1d86BdC0');
  assert.deepEqual(answer, { available: false, found: false, record: null, range: null });
  assert.equal(census.range(), null);
});

test('a provider in the census reads back with its counts and exact wei', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify(SNAPSHOT));
  const census = createEscrowCensus(file);
  const answer = census.lookup('0x1F3CBddCb9257A54d10325f900F6364C1d86BdC0'); // checksummed input
  assert.equal(answer.available, true);
  assert.equal(answer.found, true);
  assert.equal(answer.record.jobs, 7);
  assert.equal(answer.record.released, 6);
  assert.equal(answer.record.lapsed, 1);
  // A string all the way through: 6e18 as a Number is fine, but the next
  // provider's 1234.56789012345678 $U would not be, and the boundary that
  // loses it must not exist at all.
  assert.equal(answer.record.earnedWei, '6000000000000000000');
  assert.equal(typeof answer.record.earnedWei, 'string');
});

test('an address absent from the census carries the range that was searched', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify(SNAPSHOT));
  const census = createEscrowCensus(file);
  const answer = census.lookup('0x000000000000000000000000000000000000beef');
  assert.equal(answer.available, true);
  assert.equal(answer.found, false);
  assert.equal(answer.record, null);
  assert.equal(answer.range.jobs, 56720);
  assert.equal(answer.range.whole, true);
});

test('a window census says it is a window, so a count cannot read as a total', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ ...SNAPSHOT, floorId: 55921, jobsRead: 800 }));
  const census = createEscrowCensus(file);
  assert.equal(census.range().whole, false);
  assert.equal(census.range().jobs, 800);
});

test('unread ids are counted, so the page can call the numbers floors', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ ...SNAPSHOT, idsUnread: [10, 11, 12] }));
  const census = createEscrowCensus(file);
  assert.equal(census.lookup('0x1f3cbddcb9257a54d10325f900f6364c1d86bdc0').range.unread, 3);
});

test('a half-written checkpoint keeps the last good snapshot instead of emptying it', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify(SNAPSHOT));
  const census = createEscrowCensus(file);
  assert.equal(census.lookup('0x1f3cbddcb9257a54d10325f900f6364c1d86bdc0').found, true);
  // The collector writes for a quarter of an hour; a read landing mid-write
  // must not answer "this agent has no jobs".
  fs.writeFileSync(file, '{"version":1,"providers":{"0x1f3c');
  const answer = census.lookup('0x1f3cbddcb9257a54d10325f900f6364c1d86bdc0');
  assert.equal(answer.found, true);
  assert.equal(answer.record.released, 6);
});

test('a fresh census replaces the cached one without a restart', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify(SNAPSHOT));
  const census = createEscrowCensus(file);
  assert.equal(census.lookup('0x1f3cbddcb9257a54d10325f900f6364c1d86bdc0').record.released, 6);
  const next = structuredClone(SNAPSHOT);
  next.providers['0x1f3cbddcb9257a54d10325f900f6364c1d86bdc0'].released = 8;
  next.asOf = '2026-09-09T12:00:00Z';
  fs.writeFileSync(file, JSON.stringify(next));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  assert.equal(census.lookup('0x1f3cbddcb9257a54d10325f900f6364c1d86bdc0').record.released, 8);
});

test('the public census lists working providers, best first, and hides the idle', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify(SNAPSHOT));
  const census = createEscrowCensus(file);
  const top = census.top(10);
  assert.equal(top.available, true);
  assert.equal(top.providers, 3);
  assert.deepEqual(top.rows.map((r) => r.released), [9, 6]);
  // The flood address holds 9,516 of the jobs and released none of them. It
  // belongs in the provider count and nowhere near a list of working ones.
  assert.equal(top.rows.some((r) => r.address.startsWith('0xc0d7')), false);
});
