import assert from 'node:assert';
import {
  narrate, plainAnswers, bannerWhy, BANNED_PATTERNS, BANNED_EXCEPTIONS,
} from '../src/lib/narrate.js';
import { TERMS } from '../src/lib/terms.js';

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

/**
 * Every string the site composes for one verdict, in one list. The strength
 * rules sweep THIS, so adding a surface without adding it here is caught the
 * first time someone greps for why their new copy is untested.
 */
function surfaces(verdict, tokenId, flags) {
  const n = narrate(verdict, tokenId);
  return [
    n.headline,
    ...n.lines.map((l) => l.text),
    n.coach?.text ?? '',
    n.coach?.label ?? '',
    bannerWhy(verdict),
    ...plainAnswers(verdict, tokenId, flags).flatMap((r) => [r.q, ...r.a]),
  ].filter(Boolean);
}

const stripExceptions = (s) => BANNED_EXCEPTIONS.reduce((acc, ex) => acc.split(ex).join(''), s);

const base = {
  tier: 'registered',
  endpointProven: false,
  evidence: { endpoint: {}, mcp: {}, registry: {} },
  proofs: [],
};

// A gallery of verdict shapes covering every branch family. The sweep runs
// all of them, so a future branch that reintroduces a banned word fails here
// regardless of which shape reaches it.
const GALLERY = [
  base,
  { ...base, proofs: [{ signal: 'wallet_activity' }] },
  {
    ...base, tier: 'active', endpointProven: true, endpointKind: 'a2a',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 385 }, mcp: {}, registry: { feedbackCount: 0 }, bazaar: { checked: true, listed: false } },
    subject: { verified: false, how: 'x' },
    capability: { kind: 'a2a', declared: 37, matched: 0, servedCount: 6, missing: ['buy_token'], extra: ['trade'] },
    proofs: [],
  },
  {
    ...base, tier: 'active', endpointProven: true, endpointKind: 'a2a',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 416 }, mcp: {}, registry: { feedbackCount: 0 }, bazaar: { checked: true, listed: false } },
    subject: { verified: true, how: 'x' },
    capability: { kind: 'a2a', declared: 28, matched: 18, servedCount: 18, missing: ['plan_launch'] },
    proofs: [],
    bap578: { collection: '0xabc', tokenId: '11138', ownershipVerified: true, transferable: { checked: true, tba: '0xdef', tbaBalanceWei: '20000000000000000' } },
    categories: [{ category: 'yield', basis: 'served' }],
  },
  {
    ...base, tier: 'verified_live', endpointProven: true, endpointKind: 'mcp',
    corroboratedSignals: ['capability_integrity'], proofs: [{ signal: 'capability_integrity' }],
    evidence: { endpoint: {}, mcp: { declared: true, reachable: true, servesTools: true, latencyMs: 315 }, registry: {} },
    capability: { kind: 'mcp', declared: 22, matched: 22, servedCount: 22, missing: [], extra: [] },
    categories: [{ category: 'health', basis: 'served' }],
  },
  {
    ...base, tier: 'active',
    evidence: { endpoint: { declared: true, reachable: false, status: 404, latencyMs: 180, reason: 'http-error' }, mcp: {}, registry: {} },
    proofs: [{ signal: 'wallet_activity' }],
  },
  {
    ...base, tier: 'active',
    evidence: { endpoint: { declared: true, reachable: false, reason: 'invalid-url' }, mcp: {}, registry: {} },
    proofs: [{ signal: 'wallet_activity' }],
  },
  {
    ...base,
    bap578: { collection: '0xabc', tokenId: '11100', ownershipVerified: false },
  },
];

test('no composed surface, term, or subtitle contains a banned pattern', () => {
  const all = [];
  for (const v of GALLERY) {
    all.push(...surfaces(v, '211859', { hasRegistrationTx: true }));
    all.push(...surfaces(v, '211859', { hasRegistrationTx: false }));
  }
  all.push(...Object.values(TERMS), ...Object.keys(TERMS));
  for (const s of all) {
    const cleaned = stripExceptions(s);
    for (const pattern of BANNED_PATTERNS) {
      assert.ok(!pattern.test(cleaned), `banned ${pattern} in: "${s}"`);
    }
  }
});

test('plain answers: the six questions render in order, unknowns included', () => {
  const rows = plainAnswers(base, '13', {});
  const qs = rows.map((r) => r.q);
  assert.deepStrictEqual(qs, [
    'is this real?', 'does it work right now?', 'can I try it?', 'is it safe to pay or buy?', 'who is behind it?',
  ], 'Q3 is absent when no comparison exists; the rest always render');
  assert.ok(/[Ee]ntry #13/.test(rows[0].a[0]), 'the entry number reaches the sentence');
  assert.ok(/proves existence, not quality/.test(rows[0].a[0]));
  assert.ok(/publishes no address to call/.test(rows[1].a[0]), 'a nameplate page states the absence as the finding');
});

test('plain answers: the subject failure shapes work, try, and safety consistently', () => {
  const v = GALLERY[2];
  const rows = plainAnswers(v, '211859', {});
  const works = rows.find((r) => r.q === 'does it work right now?').a[0];
  assert.ok(/Something answered, but we could not confirm it was this agent/.test(works), works);
  assert.ok(!/^It answered, as itself/.test(works), '"as itself" is reserved for a passed subject check');
  const tryIt = rows.find((r) => r.q === 'can I try it?').a[0];
  assert.ok(/could not be confirmed to be this agent/.test(tryIt), 'the caveat follows the reader to the try answer');
  const safety = rows.find((r) => r.q === 'is it safe to pay or buy?').a;
  assert.ok(safety[0].includes('it proves facts, it does not endorse'));
  assert.ok(safety.some((s) => /Against it, for now: what answered our check/.test(s)), 'the same caveat reaches the safety answer');
});

test('plain answers: capability wording is "offered", never fulfillment', () => {
  const v = GALLERY[3];
  const rows = plainAnswers(v, '173264', {});
  const claims = rows.find((r) => r.q === 'does it do what it claims?').a.join(' ');
  assert.ok(/^Partly/.test(claims), 'a partial match is neither a yes nor a no');
  assert.ok(/advertises 28 skills/.test(claims), claims);
  assert.ok(/offered 18 of the 28/.test(claims), 'both numbers travel together, so neither can be read alone');
  assert.ok(!/deliver|fulfil|works as advertised/i.test(claims), 'the comparison is a name-set intersection, not fulfillment');
});

test('plain answers: the buy clause is gated on the wallet read', () => {
  const withTba = plainAnswers(GALLERY[3], '173264', {}).find((r) => r.q === 'is it safe to pay or buy?').a.join(' ');
  assert.ok(/the token, its on-chain wallet and its recorded history transfer/.test(withTba));
  const noTba = {
    ...GALLERY[3],
    bap578: { ...GALLERY[3].bap578, transferable: { checked: false, tba: null } },
  };
  const out = plainAnswers(noTba, '173264', {}).find((r) => r.q === 'is it safe to pay or buy?').a.join(' ');
  assert.ok(!/its on-chain wallet and/.test(out), 'no wallet clause without a completed read');
  assert.ok(/the token and its recorded on-chain history transfer/.test(out));
});

test('plain answers: no price claim in either direction', () => {
  for (const v of GALLERY) {
    const rows = plainAnswers(v, '1', {});
    const tryIt = rows.find((r) => r.q === 'can I try it?').a.join(' ');
    assert.ok(!/\bfree\b/i.test(tryIt), 'the panel measures no price');
    if (/Yes, from this page/.test(tryIt)) {
      assert.ok(/if this one does, the panel asks before anything is paid/.test(tryIt));
    }
  }
});

test('bannerWhy: every branch stays inside its fields', () => {
  assert.strictEqual(bannerWhy(GALLERY[4]), 'it answered at check time, with at least one qualifying supporting signal');
  assert.strictEqual(
    bannerWhy(GALLERY[2]),
    'something answered, but it could not be confirmed as this agent, and no supporting signal was recorded',
    'the subject failure reaches the banner, which used to say "endpoint answered" unqualified',
  );
  const subjectBlockedWithProof = {
    ...GALLERY[2],
    proofs: [{ signal: 'registry_feedback' }],
    corroboratedSignals: ['registry_feedback'],
  };
  assert.strictEqual(
    bannerWhy(subjectBlockedWithProof),
    'something answered with supporting evidence, but it could not be confirmed as this agent',
  );
  assert.strictEqual(bannerWhy(base), 'registered; nothing beyond that could be proven');
  assert.strictEqual(
    bannerWhy({ ...base, proofs: [{ signal: 'wallet_activity' }] }),
    'the wallet behind it shows activity; the agent itself proved nothing',
  );
  const activeNoEndpoint = { ...base, tier: 'active', proofs: [{ signal: 'wallet_activity' }] };
  assert.strictEqual(bannerWhy(activeNoEndpoint), 'activity is on record, but nothing callable answered');
});

test('plain answers echo no agent-authored text', () => {
  const evil = 'PWNED, endorsed by findyouragent,';
  const v = {
    ...GALLERY[2],
    name: evil,
    capability: { ...GALLERY[2].capability, missing: [evil], extra: [evil] },
  };
  const all = plainAnswers(v, '211859', {}).flatMap((r) => r.a).join(' ');
  assert.ok(!all.includes('PWNED'), 'identifiers never reach the plain layer, not even filtered ones');
});

test('the http-error and invalid-url branches reach the plain layer', () => {
  const err = plainAnswers(GALLERY[5], '9', {}).find((r) => r.q === 'does it work right now?').a[0];
  assert.ok(/answered our check with an error \(status 404\)/.test(err), err);
  assert.ok(!/no reply/.test(err), 'a 404 is a reply in every layer');
  const bad = plainAnswers(GALLERY[6], '9', {}).find((r) => r.q === 'does it work right now?').a[0];
  assert.ok(/not a valid web address/.test(bad), bad);
});

test('term definitions never assert quality or safety', () => {
  for (const [term, def] of Object.entries(TERMS)) {
    // Positive quality words only: "proves registration, not quality" is the
    // dictionary doing its job, and a ban that catches the disclaimer would
    // outlaw the honest sentence to protect against the dishonest one.
    assert.ok(!/\b(safe|trustworthy|reliable|reputable)\b/i.test(def), `${term}: definition editorializes`);
    assert.ok(!/\bquality\b/i.test(def.replace('not quality', '')), `${term}: quality claim outside the disclaimer`);
    assert.ok(def.length > 40 && def.length < 260, `${term}: one plain sentence or two, not an essay`);
  }
});

test('a null verdict produces empty surfaces everywhere', () => {
  assert.deepStrictEqual(plainAnswers(null, '1', {}), []);
  assert.strictEqual(bannerWhy(null), '');
});

console.log(`${passed} passed, ${process.exitCode ? 'some' : 0} failed`);
