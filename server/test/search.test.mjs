import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, STOPWORDS } from '../src/store.js';
import { CAPABILITY_FRAGMENTS } from '../src/verify/categorize.js';

/**
 * What the capability search may and may not do.
 *
 * These cases are compatibility invariants: stopwords must not create matches,
 * exact tool names must outrank incidental fragments, and a query unsupported
 * by the corpus must return no results.
 *
 *   node test/search.test.mjs
 */

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

/*
  The store replays a seed of real verdicts on construction, so a test cannot
  assume it owns the corpus. Every fixture below is therefore matched on a
  nonsense token that appears nowhere in the registry, and assertions are made
  about the fixtures' order among themselves rather than about absolute
  positions in the result.
*/
const NONCE = 'zqx';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-search-'));
const store = createStore(path.join(dir, 'verdicts.jsonl'));

let nextId = 1;
function seed(name, servedNames, options = {}) {
  const { tier = 'active', endpointProven = true } = options;
  const key = `56:9${String(nextId += 1).padStart(5, '0')}`;
  store.record(key, {
    computedAt: Object.hasOwn(options, 'computedAt') ? options.computedAt : Date.now() - 1000,
    tier,
    formulaVersion: 'test',
    endpointProven,
    servedNames,
    name,
    categories: [],
    proofs: [],
  });
  return key;
}

/*
  Each group carries its own nonce, so a test can address exactly its own
  fixtures. They all share the `zqx` prefix — and word-start matching treats a
  prefix as a match — so a bare `zqx` query still reaches every one of them,
  which is what the limit test needs.
*/
seed('Focused', ['zqxs_swap']);
seed('Incidental', ['zqxs_swap_borrow_rate_mode_for_lending_pool']);
seed('Unrelated', ['zqxuonly']);
seed('Venue name only', ['zqxv_pancakeswap_grid_assessment']);
const CLONE_TOOLS = ['zqxcfleet', 'chat', 'holdings'];
for (let i = 0; i < 5; i += 1) seed(`Clone ${i}`, CLONE_TOOLS);

const names = (rows) => rows.map((r) => r.name);

// ---------------------------------------------------------------------------
// The fabrication class. These are the words that made an empty answer look full.
// ---------------------------------------------------------------------------

test('a query of nothing but glue returns no rows rather than a shortlist', () => {
  // Every one of these is a whole word inside some real tool name:
  // `estimate_amounts_for_position_creation`, `get_leverage_and_margin`.
  assert.deepStrictEqual(store.searchServed('design a logo for my project'), []);
  assert.deepStrictEqual(store.searchServed('the best one for me'), []);
  assert.deepStrictEqual(store.searchServed('can you help me with this'), []);
});

test('"agent" separates nothing on a site where every row is an agent', () => {
  assert.deepStrictEqual(store.searchServed('the best agent for me'), []);
});

test('an empty or too-short query still returns nothing, not everything', () => {
  assert.deepStrictEqual(store.searchServed(''), []);
  assert.deepStrictEqual(store.searchServed('at my'), []);
});

// ---------------------------------------------------------------------------
// The invariant that keeps the list above from quietly eating capabilities.
// ---------------------------------------------------------------------------

test('no stopword is a word this site places agents on', () => {
  /*
    Checked WORD BY WORD, not fragment by fragment.

    `close` is the trap — filler in "close to liquidation", a capability in
    `close_position` — and comparing whole fragments would not have caught it,
    because the fragment is `close_position` and the stopword would be `close`.
    So would `supply` against `supply_`, `open` against `open_position`, and
    `borrow` against `borrow_balance`. A guard that misses every case it was
    written for is worse than none: it reads as protection.
  */
  const words = [...new Set(CAPABILITY_FRAGMENTS.flatMap((f) => f.split('_').filter(Boolean)))];
  const collisions = words.filter((word) => STOPWORDS.has(word));
  assert.deepStrictEqual(
    collisions, [],
    `these are words a category is earned on and must stay searchable: ${collisions.join(', ')}`,
  );
  // The guard is only worth having if it is actually looking at the words.
  assert.ok(words.includes('close') && words.includes('supply') && words.includes('open'));
});

// ---------------------------------------------------------------------------
// Word boundaries, borrowed from the categoriser rather than invented again.
// ---------------------------------------------------------------------------

test('a term matches at a word start and not mid-word', () => {
  // The lesson categorize.js learned twice: `swap` inside `pancakeswap`
  // credited a read-only grid checker with trading.
  const [venue] = store.searchServed('zqxv swap');
  assert.strictEqual(venue.name, 'Venue name only');
  assert.ok(
    !venue.matchedTerms.includes('swap'),
    `a venue name is not a swap capability, matched ${venue.matchedTerms.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// Ordering. Never a printed number — but it decides which agent a reader sees.
// ---------------------------------------------------------------------------

test('a tool named for the work outranks one that merely contains the word', () => {
  const order = names(store.searchServed('zqxs swap'));
  assert.ok(
    order.indexOf('Focused') < order.indexOf('Incidental'),
    `swap_evm before swap_borrow_rate_mode, got ${order.join(' > ')}`,
  );
});

test('tier decides between two agents that matched something equally specific', () => {
  // Their matching tool is identical, so only the second name keeps them apart
  // — without it they are one capability set and collapse into a single row.
  seed('Proven', ['zqxrrank', 'alpha'], { tier: 'verified_live' });
  seed('Unproven', ['zqxrrank', 'bravo'], { tier: 'registered', endpointProven: false });
  const order = names(store.searchServed('zqxrrank'));
  assert.ok(
    order.indexOf('Proven') < order.indexOf('Unproven') && order.includes('Unproven'),
    `the endpoint that answered goes first, got ${order.join(' > ')}`,
  );
});

// ---------------------------------------------------------------------------
// Fleet collapse. 267 of the 412 agents that answered serve one identical list.
// ---------------------------------------------------------------------------

test('agents serving an identical tool list collapse to one disclosed row', () => {
  const rows = store.searchServed('zqxcfleet');
  assert.strictEqual(rows.length, 1, 'five identical agents are one answer, not five');
  assert.strictEqual(rows[0].sameToolList, 4, 'and the other four are counted, not hidden');
});

test('a row that is not part of a fleet says so with a zero', () => {
  const [row] = store.searchServed('zqxuonly');
  assert.strictEqual(row.sameToolList, 0);
});

test('the member kept for a fleet is its best-tiered one', () => {
  /*
    Latent rather than live: every one of the 50 capability sets in the current
    corpus is tier-uniform, so nothing today would notice if collapse kept an
    arbitrary member. It only takes one agent in a fleet being re-checked into a
    higher tier for that to start hiding the best answer behind a worse one.
  */
  const FLEET = ['zqxffleet', 'shared'];
  seed('Fleet, unproven', FLEET, { tier: 'registered', endpointProven: false, computedAt: '2026-09-08T12:00:00Z' });
  seed('Fleet, answered', FLEET, { tier: 'verified_live', computedAt: '2026-09-01T12:00:00Z' });
  seed('Fleet, middling', FLEET, { tier: 'active', computedAt: '2026-09-07T12:00:00Z' });
  const rows = store.searchServed('zqxffleet');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Fleet, answered', 'the fleet must not hide its best member');
  assert.strictEqual(rows[0].sameToolList, 2);
});

test('equal-tier fleet peers keep the newest ISO check in either insertion order', () => {
  for (const newestFirst of [false, true]) {
    const token = `zqxfresh${newestFirst ? 'a' : 'b'}`;
    const peers = [
      ['Older peer', '2026-09-07T12:00:00.000Z'],
      ['Newer peer', '2026-09-08T12:00:00.000Z'],
    ];
    if (newestFirst) peers.reverse();
    for (const [name, computedAt] of peers) seed(name, [token], { computedAt });
    const rows = store.searchServed(token);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, 'Newer peer');
    assert.strictEqual(rows[0].sameToolList, 1);
  }
});

test('a valid fleet check beats invalid or missing dates in either insertion order', () => {
  for (const [i, unknown] of [undefined, null, '', 'not-a-date'].entries()) {
    for (const validFirst of [false, true]) {
      const token = `zqxknown${i}${validFirst ? 'a' : 'b'}`;
      const peers = [
        ['Unknown date', unknown],
        ['Known date', '2026-09-08T12:00:00.000Z'],
      ];
      if (validFirst) peers.reverse();
      for (const [name, computedAt] of peers) seed(name, [token], { computedAt });
      assert.strictEqual(store.searchServed(token)[0].name, 'Known date');
    }
  }
});

test('equal or unknown fleet dates have a stable agent-key tie break', () => {
  for (const [i, computedAt] of ['2026-09-08T12:00:00.000Z', null, 'not-a-date'].entries()) {
    for (const lowerFirst of [false, true]) {
      const token = `zqxtied${i}${lowerFirst ? 'a' : 'b'}`;
      const keyPrefix = `56:9900${i}${Number(lowerFirst)}`;
      const peers = [[`${keyPrefix}0`, 'Lower key'], [`${keyPrefix}1`, 'Higher key']];
      if (!lowerFirst) peers.reverse();
      for (const [key, name] of peers) {
        store.record(key, { computedAt, tier: 'active', endpointProven: true, servedNames: [token], name });
      }
      assert.strictEqual(store.searchServed(token)[0].name, 'Lower key');
    }
  }
});

// ---------------------------------------------------------------------------
// The evidence a row is required to carry.
// ---------------------------------------------------------------------------

test('every row names the tool it matched', () => {
  const [row] = store.searchServed('zqxs swap');
  assert.strictEqual(row.matchedTool, 'zqxs_swap');
  assert.ok(Array.isArray(row.matchedTerms) && row.matchedTerms.includes('swap'));
});

test('the limit counts collapsed rows, so it cannot be filled by one fleet', () => {
  assert.ok(store.searchServed(NONCE, 2).length <= 2);
});

fs.rmSync(dir, { recursive: true, force: true });

if (process.exitCode) console.error(`\n${passed} passed, some FAILED`);
else console.log(`  search: ${passed} passed`);
