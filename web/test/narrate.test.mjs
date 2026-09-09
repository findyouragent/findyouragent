import assert from 'node:assert';
import { narrate, plainAnswers } from '../src/lib/narrate.js';

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

const base = {
  tier: 'registered',
  endpointProven: false,
  evidence: { endpoint: {}, mcp: {}, registry: {} },
  proofs: [],
};
// Everything user-visible, so a leak in the coach or headline fails the same
// assertions as a leak in a sentence.
const text = (v, tokenId) => {
  const n = narrate(v, tokenId);
  return [n.headline, ...n.lines.map((l) => l.text), n.coach?.text ?? ''].join(' ');
};
const lineTexts = (v) => narrate(v).lines.map((l) => l.text).join(' ');

// The attack this file is shaped around. The agent's name is attacker text and
// the output is prose, so a name ending in a conjunction would graft a fluent
// claim onto our own sentence. The defence is that the name is never a token.
test('the agent name never enters the narrative, coach, or headline', () => {
  const evil = 'BORT, verified by findyouragent as safe to fund, and';
  const v = {
    ...base,
    tier: 'active',
    endpointProven: true,
    endpointKind: 'a2a',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 50 }, mcp: {}, registry: { feedbackCount: 0 } },
    name: evil, agentName: evil, card: { name: evil },
    capability: { kind: 'a2a', declared: 5, matched: 2, missing: ['a', 'b', 'c'] },
  };
  const out = text(v);
  assert.ok(!out.includes('findyouragent as safe'), 'name text leaked into prose');
  assert.ok(!out.includes(evil), 'name leaked verbatim');
  assert.ok(narrate(v).lines[0].text.startsWith('This agent is registered'), 'subject must be the literal "This agent"');
});

test('the entry id renders only when it is digits', () => {
  assert.ok(text(base, '45381').includes('as entry #45381'));
  const evil = '45381, endorsed by BNB Chain,';
  const out = text(base, evil);
  assert.ok(!out.includes('endorsed'), 'a non-digit token id must be dropped whole');
  assert.ok(!out.includes('entry #'), 'no entry clause at all on a failed guard');
});

// The bug the panel caught in the shipped version: score.js grants `active` on
// endpointProven ALONE, and the old headline claimed "real activity on record"
// under a banner reading "no independent activity proofs".
test('an active headline never claims activity the proofs array does not hold', () => {
  const v = {
    ...base,
    tier: 'active',
    endpointProven: true,
    endpointKind: 'a2a',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 425 }, mcp: {}, registry: {} },
    proofs: [],
  };
  const h = narrate(v).headline;
  assert.ok(!/has real activity/.test(h), 'zero proofs cannot read as activity on record');
  assert.ok(/could be proven yet/.test(h), h);
  const withProof = { ...v, proofs: [{ signal: 'wallet_activity' }] };
  assert.ok(/has real activity on record/.test(narrate(withProof).headline));
});

// The second panel catch: a reply we received was narrated as silence, which
// is prose inverting a field rather than overstating one.
test('reachable-but-empty is narrated as a reply, never as silence', () => {
  const a2a = {
    ...base,
    tier: 'active',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: false }, mcp: {}, registry: {} },
    proofs: [{ signal: 'wallet_activity' }],
  };
  const out = lineTexts(a2a);
  assert.ok(/replied, but what it served was not an agent card/.test(out), out);
  assert.ok(!/did not get a reply/.test(out), 'a 200 with no card is not silence');
  const mcp = {
    ...base,
    tier: 'active',
    evidence: { endpoint: {}, mcp: { declared: true, reachable: true, servesTools: false }, registry: {} },
    proofs: [{ signal: 'wallet_activity' }],
  };
  assert.ok(/replied, but listed no tools/.test(lineTexts(mcp)));
});

// The false negative the whole ranking scheme exists to avoid. One vantage
// point cannot tell their outage from our egress or our own timeout.
test('silence is never narrated as the agent being down, and carries no tone', () => {
  const v = { ...base, evidence: { endpoint: { declared: true, reachable: false }, mcp: {}, registry: {} } };
  const n = narrate(v);
  const out = n.lines.map((l) => l.text).join(' ');
  assert.ok(/did not get a reply/.test(out));
  assert.ok(!/is down|offline|dead|broken|failing/i.test(out), 'must not assert their outage');
  const silent = n.lines.find((l) => /did not get a reply/.test(l.text));
  assert.strictEqual(silent.tone, null, 'silence must not be toned as their fault');
});

test('the verified_live headline names its carrying proof instead of "something"', () => {
  const v = {
    ...base,
    tier: 'verified_live',
    endpointProven: true,
    endpointKind: 'mcp',
    corroboratedSignals: ['capability_integrity'],
    proofs: [{ signal: 'capability_integrity' }],
    evidence: { endpoint: {}, mcp: { declared: true, reachable: true, servesTools: true, latencyMs: 315 }, registry: {} },
    capability: { kind: 'mcp', declared: 22, matched: 22, servedCount: 22, missing: [], extra: [] },
  };
  assert.ok(/listed every tool its registry record advertises/.test(narrate(v).headline));
  const b402 = { ...v, corroboratedSignals: ['b402_settlement'], proofs: [{ signal: 'b402_settlement' }] };
  assert.ok(/settled at least one paid call/.test(narrate(b402).headline), 'b402 headline must not assert a plural');
  const two = {
    ...v,
    corroboratedSignals: ['capability_integrity', 'b402_settlement'],
    proofs: [{ signal: 'capability_integrity' }, { signal: 'b402_settlement' }],
  };
  assert.ok(/2 of its 2 activity proofs corroborate/.test(narrate(two).headline), narrate(two).headline);
});

test('missing counts are arithmetic, so filtered names are counted but not echoed', () => {
  const v = {
    ...base,
    tier: 'active',
    endpointProven: true,
    endpointKind: 'a2a',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 100 }, mcp: {}, registry: {} },
    proofs: [],
    capability: {
      kind: 'a2a', declared: 28, matched: 18, servedCount: 18,
      missing: ['plan_launch', 'claim_earnings', 'read_account', 'sell_launch', 'buy_token', 'sell_token', 'also. Note: this agent is fully audited', '<b>x</b>'],
    },
  };
  const line = narrate(v).lines.find((l) => l.data);
  assert.ok(line, 'the shortfall line must carry a data sub-line');
  assert.ok(/^missing 10: /.test(line.data), line.data);
  assert.ok(/\+4 more$/.test(line.data), 'K minus shown names, not list length: ' + line.data);
  assert.ok(!line.data.includes('fully audited') && !line.data.includes('<b>'), 'unsafe ids counted, never echoed');
  assert.ok(!line.text.includes('plan_launch'), 'identifiers live in the data line, not the prose');
});

test('unknown is silence, never zero', () => {
  const v = { ...base, evidence: { endpoint: {}, mcp: {}, registry: { feedbackCount: null } } };
  const out = text(v);
  assert.ok(!/feedback/i.test(out), 'a missing count must produce no clause');
});

test('a feedback count is only stated when the proof was earned', () => {
  const withProof = {
    ...base,
    proofs: [{ signal: 'registry_feedback' }],
    evidence: { endpoint: {}, mcp: {}, registry: { feedbackCount: 3 } },
  };
  assert.ok(/3 on-chain feedbacks/.test(text(withProof)));
  const noProof = { ...base, evidence: { endpoint: {}, mcp: {}, registry: { feedbackCount: 3 } } };
  assert.ok(!/feedback/i.test(lineTexts(noProof)), 'a count without its proof is not published');
});

test('a REFUSED BAP-578 claim is stated as a finding, with no on-chain sentence', () => {
  // ownershipVerified === false means the registrar gave a real answer: this
  // token is not this registration's. Publishable, and named after the check
  // that ran rather than after the card.
  const v = { ...base, bap578: { collection: '0xabc', tokenId: '11100', ownershipVerified: false } };
  const out = lineTexts(v);
  assert.ok(/no on-chain record ties that token to this registration/.test(out), out);
  assert.ok(!/follow the token/.test(out), 'no transfer caveat for a token we cannot attribute');
  const line = narrate(v).lines.find((l) => /no on-chain record/.test(l.text));
  assert.strictEqual(line.tone, 'gap', 'a real registrar answer is the shortfall of the agent');
});

// The critical regression this suite exists to prevent: our OWN failure to
// reach the chain must never render as a claim about their token. A throttled
// public RPC is not evidence, and the old code collapsed it into "false".
test('an UNCHECKED BAP-578 claim accuses no one and carries no tone', () => {
  const v = { ...base, bap578: { collection: '0xabc', tokenId: '11100', ownershipVerified: null } };
  const out = lineTexts(v);
  assert.ok(/We could not check the on-chain record/.test(out), out);
  assert.ok(!/no on-chain record ties/.test(out), 'must not assert the negative we never established');
  assert.ok(!/follow the token/.test(out), 'still no transfer caveat: unattributed either way');
  const line = narrate(v).lines.find((l) => /could not check/.test(l.text));
  assert.strictEqual(line.tone, null, 'our outage is never toned as their fault');
  // And it must not reach the safety answer as something held against them.
  const safety = plainAnswers(v, '1', {}).find((r) => r.q === 'is it safe to pay or buy?').a.join(' ');
  assert.ok(!/Against it/.test(safety), 'an unchecked fact is not evidence against them');
});

test('the sale caveat names the carried wallet only from a completed read', () => {
  const withWallet = {
    ...base,
    bap578: {
      collection: '0xabc', tokenId: '11138', ownershipVerified: true,
      transferable: { checked: true, tba: '0xdef', tbaBalanceWei: '16900000000000000' },
    },
  };
  assert.ok(/including its ERC-6551 wallet holding 0.0169 BNB at our last read/.test(lineTexts(withWallet)));
  const unchecked = {
    ...base,
    bap578: { collection: '0xabc', tokenId: '11138', ownershipVerified: true, transferable: { checked: false, tba: null } },
  };
  const out = lineTexts(unchecked);
  assert.ok(/follow the token\./.test(out), 'caveat still renders');
  assert.ok(!/ERC-6551/.test(out), 'a failed chain read must not imply there is no wallet, nor invent one');
});

test('the category sentence rides only on served-basis placements', () => {
  const served = {
    ...base,
    tier: 'active', endpointProven: true, endpointKind: 'mcp',
    evidence: { endpoint: {}, mcp: { declared: true, reachable: true, servesTools: true, latencyMs: 90 }, registry: {} },
    proofs: [],
    categories: [{ category: 'health', basis: 'served' }, { category: 'yield', basis: 'declared' }],
  };
  const out = lineTexts(served);
  assert.ok(/place it under lending health-factor monitoring/.test(out));
  assert.ok(!/yield/.test(out), 'a declared-basis placement is the agent\'s claim, not ours');
});

test('the coach appears exactly when a distance exists, and lists only read remedies', () => {
  const active = {
    ...base,
    tier: 'active', endpointProven: true, endpointKind: 'a2a',
    evidence: {
      endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 425 },
      mcp: {}, registry: { feedbackCount: 0 }, bazaar: { checked: true, listed: false },
    },
    proofs: [],
    subject: { verified: true, how: 'x' },
    capability: { kind: 'a2a', declared: 28, matched: 18, servedCount: 18, missing: ['a'] },
  };
  const c = narrate(active).coach;
  // The label names its addressee: four review lenses independently found
  // buyers reading the remedy list as their own to-do list.
  assert.ok(c && c.label === "for this agent's operator · to reach live", c && c.label);
  assert.ok(/One proof separates/.test(c.text));
  assert.ok(/serving the 10 skills/.test(c.text), c.text);
  assert.ok(/republishing the card without them/.test(c.text), 'matched >= 3, so the trim route is open');
  assert.ok(/one on-chain feedback/.test(c.text));
  assert.ok(/one settled paid call on B402/.test(c.text));
  assert.ok(/with the rest of this verdict unchanged/.test(c.text), 'promotion must be conditioned, not predicted');

  // Below the floor of three, the trim route must disappear.
  const lowMatch = { ...active, capability: { ...active.capability, matched: 2, declared: 12 } };
  assert.ok(!/republishing/.test(narrate(lowMatch).coach.text), 'trimming to 2 cannot reach the >= 3 floor');

  // Unread fields produce no remedy.
  const unread = { ...active, evidence: { ...active.evidence, registry: { feedbackCount: null }, bazaar: { checked: false, listed: false } } };
  const t = narrate(unread).coach.text;
  assert.ok(!/feedback/.test(t) && !/B402/.test(t), 'null feedback and an unchecked lookup must stay silent');

  assert.strictEqual(narrate({ ...active, tier: 'verified_live' }).coach, null, 'nothing above the top tier');
});

test('a subject failure changes the coach to the identity remedy', () => {
  const v = {
    ...base,
    tier: 'active', endpointProven: true, endpointKind: 'a2a',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 100 }, mcp: {}, registry: {} },
    proofs: [{ signal: 'capability_integrity' }],
    corroboratedSignals: ['capability_integrity'],
    subject: { verified: false, how: 'names no token of its own' },
  };
  const c = narrate(v).coach;
  assert.ok(/card that provably describes it/.test(c.text), c.text);
  // The remedy names the registry entry number. It must NOT still offer the
  // ERC-6551 wallet route: that check was deleted from the verifier (a
  // token-bound account is deterministic from collection+tokenId, so declaring
  // one proved arithmetic, not ownership), and a coach that promises a route
  // the checker no longer honours is a false promise.
  assert.ok(/registry entry number/.test(c.text), c.text);
  assert.ok(!/wallet derived from it/.test(c.text), 'the deleted wallet route must not be promised');
});

test('wallet activity is never coached', () => {
  const v = {
    ...base,
    tier: 'active', endpointProven: false,
    evidence: { endpoint: {}, mcp: {}, registry: {} },
    proofs: [{ signal: 'wallet_activity' }],
  };
  const c = narrate(v).coach;
  assert.ok(c && !/transaction|wallet activity/i.test(c.text), 'coaching wallet activity coaches padding');
});

test('the fragility line renders only for a single-proof top tier', () => {
  const single = {
    ...base,
    tier: 'verified_live', endpointProven: true, endpointKind: 'mcp',
    corroboratedSignals: ['capability_integrity'],
    proofs: [{ signal: 'capability_integrity' }],
    evidence: { endpoint: {}, mcp: { declared: true, reachable: true, servesTools: true, latencyMs: 315 }, registry: {} },
    capability: { kind: 'mcp', declared: 22, matched: 22, servedCount: 22, missing: [], extra: [] },
  };
  const out = lineTexts(single);
  assert.ok(/the one proof carrying this tier/.test(out));
  assert.ok(/lands the next check at active/.test(out), 'demotion must be conditional and use the on-screen tier name');
  assert.ok(!/verified/.test(out), 'prose never names a tier the banner does not show');
  const two = { ...single, corroboratedSignals: ['capability_integrity', 'registry_feedback'], proofs: [{ signal: 'capability_integrity' }, { signal: 'registry_feedback' }, { signal: 'wallet_activity' }] };
  assert.ok(!/one proof carrying/.test(lineTexts(two)));
  // The banner counts ALL proofs; the headline must use the same denominator.
  assert.ok(/2 of its 3 activity proofs corroborate/.test(narrate(two).headline), narrate(two).headline);
});

// The review's critical: score.js grants capability_integrity only when
// missing.length===0 AND matched>=3, so for a 2-item declaration "serve the
// missing 1" is a remedy the formula will refuse. A coach that promises a
// promotion it cannot deliver is a false promise from the one block whose
// job is stating true distances.
test('the coach never promises the serve route below the floor of three', () => {
  const v = {
    ...base,
    tier: 'active', endpointProven: true, endpointKind: 'a2a',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 50 }, mcp: {}, registry: { feedbackCount: 0 } },
    proofs: [],
    subject: { verified: true, how: 'x' },
    capability: { kind: 'a2a', declared: 2, matched: 1, servedCount: 1, missing: ['b'] },
  };
  const c = narrate(v).coach;
  assert.ok(!/serving the 1 skill/.test(c.text), c.text);
  assert.ok(/at least 3 skills/.test(c.text), 'the floor wording is the only true capability remedy here');
  assert.ok(/floor of three/.test(c.text));
});

test('a held HTTP error is narrated as an answer, with the agent-fault tone', () => {
  const v = {
    ...base,
    tier: 'active',
    evidence: { endpoint: { declared: true, reachable: false, status: 404, latencyMs: 180, reason: 'http-error' }, mcp: {}, registry: {} },
    proofs: [{ signal: 'wallet_activity' }],
  };
  const n = narrate(v);
  const line = n.lines[0];
  assert.ok(/answered our check with an HTTP error \(status 404\)/.test(line.text), line.text);
  assert.ok(!/did not get a reply/.test(line.text), 'a 404 is a reply, exactly as the uptime calendar classifies it');
  assert.strictEqual(line.tone, 'gap', 'their server answering an error is their doing');
});

test('an invalid declared url is its own finding, not silence', () => {
  const v = {
    ...base,
    evidence: { endpoint: { declared: true, reachable: false, reason: 'invalid-url' }, mcp: {}, registry: {} },
  };
  const out = lineTexts(v);
  assert.ok(/not a valid url/.test(out), out);
  assert.ok(!/did not get a reply/.test(out));
});

test('the registered headline never denies a held proof', () => {
  const v = { ...base, proofs: [{ signal: 'wallet_activity' }] };
  const h = narrate(v).headline;
  assert.ok(!/Nothing beyond that could be proven/.test(h), h);
  assert.ok(/wallet behind it shows activity/.test(h));
  assert.ok(/nothing about the agent itself/.test(h), 'the wallet fact must not upgrade into an agent fact');
  assert.ok(/Nothing beyond that could be proven/.test(narrate(base).headline), 'the bare branch is unchanged');
});

test('an earned signal is never listed as remaining distance', () => {
  const v = {
    ...base,
    tier: 'active', endpointProven: false,
    evidence: { endpoint: { declared: true, reachable: false }, mcp: {}, registry: { feedbackCount: 2 } },
    proofs: [{ signal: 'registry_feedback' }],
    corroboratedSignals: ['registry_feedback'],
  };
  const c = narrate(v).coach;
  assert.ok(/Corroboration is already on record/.test(c.text), c.text);
  assert.ok(/whole remaining distance/.test(c.text));
  assert.ok(!/must corroborate/.test(c.text), 'the earned signal is not still owed');
});

test('the subject sentence always anchors to the a2a block', () => {
  const v = {
    ...base,
    tier: 'verified_live', endpointProven: true, endpointKind: 'mcp',
    corroboratedSignals: ['capability_integrity'], proofs: [{ signal: 'capability_integrity' }],
    evidence: {
      endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 40 },
      mcp: { declared: true, reachable: true, servesTools: true, latencyMs: 90 }, registry: {},
    },
    subject: { verified: true, how: 'x' },
    capability: { kind: 'mcp', declared: 5, matched: 5, servedCount: 5, missing: [], extra: [] },
  };
  const line = narrate(v).lines.find((l) => /card it served describes/.test(l.text));
  assert.strictEqual(line.ev, 'a2a', 'the describes-this-agent row renders only in the a2a section');
});

test('the category jump falls back to the probe when no comparison exists', () => {
  const v = {
    ...base,
    tier: 'active', endpointProven: true, endpointKind: 'mcp',
    evidence: { endpoint: {}, mcp: { declared: true, reachable: true, servesTools: true, latencyMs: 60 }, registry: {} },
    proofs: [],
    categories: [{ category: 'yield', basis: 'served' }],
    capability: null,
  };
  const line = narrate(v).lines.find((l) => /place it under/.test(l.text));
  assert.strictEqual(line.ev, 'mcp', 'ev-capability does not render without a comparison');
});

test('dust never renders as an exact zero balance', () => {
  const v = {
    ...base,
    bap578: {
      collection: '0xabc', tokenId: '7', ownershipVerified: true,
      transferable: { checked: true, tba: '0xdef', tbaBalanceWei: '5000000000000' },
    },
  };
  const out = lineTexts(v);
  assert.ok(/<0.0001 BNB/.test(out), out);
  assert.ok(!/0.0000 BNB/.test(out), 'a wallet holding dust is not an empty wallet');
});

// The calendar carries its own denominator on screen. The same fact in prose
// reads as a rate measured against a schedule, and our sampling is not one.
test('uptime never appears in prose or coach', () => {
  const v = {
    ...base,
    tier: 'active', endpointProven: true, endpointKind: 'a2a',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 30 }, mcp: {}, registry: {} },
    proofs: [],
  };
  assert.ok(!/uptime|% of|availability/i.test(text(v)));
});

test('every line exposes tone and ev without leaking undefineds', () => {
  const v = {
    ...base,
    tier: 'active', endpointProven: true, endpointKind: 'a2a',
    evidence: { endpoint: { declared: true, reachable: true, hasAgentCard: true, latencyMs: 100 }, mcp: {}, registry: {} },
    proofs: [],
    subject: { verified: true, how: 'x' },
  };
  for (const line of narrate(v).lines) {
    assert.ok(typeof line.text === 'string' && line.text.length > 0);
    assert.ok(line.tone === 'ok' || line.tone === 'gap' || line.tone === null);
    assert.ok(line.ev === null || typeof line.ev === 'string');
    assert.ok(line.data === null || typeof line.data === 'string');
    assert.ok(!/undefined|NaN|null/.test(line.text), line.text);
  }
});

test('a null verdict produces nothing rather than throwing', () => {
  assert.deepStrictEqual(narrate(null), { headline: '', lines: [], coach: null });
});

console.log(`${passed} passed, ${process.exitCode ? 'some' : 0} failed`);
