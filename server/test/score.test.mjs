import { computeVerdict, TIERS, FORMULA_VERSION } from '../src/verify/score.js';

/**
 * The tier formula must never publish a claim it has not earned.
 *
 * Every case here is a real defect found in v0.2 against live BSC data, not a
 * hypothetical. The two that matter most:
 *
 *   - v0.2 picked its MOST permissive wallet threshold when the agent count was
 *     UNKNOWN, and unknown is the normal case on the anonymous 8004scan tier
 *     because every 429 returns null. A mass-minter therefore earned a wallet
 *     proof precisely when we knew least about it, and run.js persisted that
 *     inflated tier to disk where it is served forever.
 *   - The discount was an offset (owned + 2), but minting costs roughly two
 *     transactions per agent, so a wallet holding hundreds of nameplates
 *     cleared the bar at about one transaction each. Ave.ai mints one wallet
 *     per agent, which made the discount a no-op and tiered an inert nameplate
 *     `active`: the same rung as an agent that answers.
 *
 *   node test/score.test.mjs
 */

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${message}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${message}`);
  }
};

const signals = (v) => v.proofs.map((p) => p.signal);
const has = (v, s) => signals(v).includes(s);

// --- the wallet signal ------------------------------------------------------

const unknownCount = computeVerdict({
  wallet: { checked: true, txCount: 4213, agentsOwned: null },
});
ok(!has(unknownCount, 'wallet_activity'),
  'an UNKNOWN agent count emits no wallet proof, however busy the wallet');
ok(unknownCount.tier === TIERS.REGISTERED,
  'a 429 during verification cannot mint an `active` tier');

const aveAi = computeVerdict({
  wallet: { checked: true, txCount: 5, agentsOwned: 1 },
});
ok(!has(aveAi, 'wallet_activity'),
  'the one-wallet-per-mint nameplate pattern earns no wallet proof (threshold scales)');

const massMinter = computeVerdict({
  wallet: { checked: true, txCount: 800, agentsOwned: 753 },
});
ok(!has(massMinter, 'wallet_activity'),
  'a 753-agent minter with 800 txs is still just minting');

const realUser = computeVerdict({
  wallet: { checked: true, txCount: 400, agentsOwned: 2 },
});
ok(has(realUser, 'wallet_activity'),
  'activity far beyond what minting explains still counts');

// --- wallet activity is corroboration, never the whole case -----------------

const busyNameplate = computeVerdict({
  wallet: { checked: true, txCount: 400, agentsOwned: 2 },
  endpoint: { declared: false },
  mcp: { declared: false },
});
ok(busyNameplate.tier === TIERS.REGISTERED,
  'an identity that serves nothing stays `registered` however busy its wallet');

const halfAlive = computeVerdict({
  wallet: { checked: true, txCount: 400, agentsOwned: 2 },
  endpoint: { declared: true, reachable: false },
});
ok(halfAlive.tier === TIERS.ACTIVE,
  'an agent that declares an endpoint but did not answer is `active`, not hidden');

// --- MCP endpoints are first-class ------------------------------------------

const mcpOnly = computeVerdict({
  endpoint: { declared: false },
  mcp: { declared: true, reachable: true, servesTools: true, toolIds: ['getaccountliquidity', 'borrow'] },
});
ok(mcpOnly.endpointProven && mcpOnly.endpointKind === 'mcp',
  'an MCP server that lists tools counts as a proven endpoint');

// --- declared vs served: the claim nobody else publishes --------------------

const honest = computeVerdict({
  mcp: { declared: true, reachable: true, servesTools: true, toolIds: ['a', 'b', 'c'] },
  declaredTools: ['a', 'b', 'c'],
});
ok(has(honest, 'capability_integrity'),
  'listing every declared capability qualifies as publisher-consistency evidence');
ok(honest.tier === TIERS.VERIFIED_LIVE,
  'a live endpoint that matches its own declaration earns verified_live');

// Venus, live on BSC: declares 24 tools, serves 16.
const overstates = computeVerdict({
  mcp: { declared: true, reachable: true, servesTools: true, toolIds: ['a', 'b'] },
  declaredTools: ['a', 'b', 'c', 'd'],
});
ok(!has(overstates, 'capability_integrity'),
  'an agent that serves less than it advertises earns no integrity proof');
ok(overstates.tier === TIERS.ACTIVE,
  'overstating its toolset keeps an otherwise live agent out of the top tier');
ok(overstates.capability.declared === 4 && overstates.capability.matched === 2
  && overstates.capability.missing.length === 2,
  'the gap is published as evidence rather than hidden');

// --- the top tier still needs a qualifying supporting signal ----------------

const liveButUnproven = computeVerdict({
  endpoint: { declared: true, reachable: true, hasAgentCard: true },
});
ok(liveButUnproven.tier === TIERS.ACTIVE,
  'answering alone is not verified_live without a qualifying supporting signal');

// Found live: five duplicate registrations of one project and an agent named
// "test clipx v4" all reached the top tier on a busy wallet alone. A wallet
// describes an address, not an endpoint.
const liveWithBusyWallet = computeVerdict({
  endpoint: { declared: true, reachable: true, hasAgentCard: true },
  wallet: { checked: true, txCount: 400, agentsOwned: 2 },
});
ok(has(liveWithBusyWallet, 'wallet_activity'),
  'a busy wallet is still recorded as a signal');
ok(liveWithBusyWallet.tier === TIERS.ACTIVE,
  'but wallet activity alone cannot lift an agent to verified_live');

const liveAndUsed = computeVerdict({
  endpoint: { declared: true, reachable: true, hasAgentCard: true },
  bazaar: { listed: true },
});
ok(liveAndUsed.tier === TIERS.VERIFIED_LIVE,
  'answering plus settled payments is verified_live');

// --- an agent card is more than a name --------------------------------------

const nameOnly = computeVerdict({
  endpoint: { declared: true, reachable: true, hasAgentCard: false },
  bazaar: { listed: true },
});
ok(nameOnly.tier === TIERS.ACTIVE,
  'a JSON blob carrying only a name is not a served agent card');

// --- declared vs served must not depend on which protocol an agent speaks ----
//
// Built for MCP only, this was a protocol test dressed as an honesty test.
// BORT #211859 declares 37 skills in its registry metadata and serves them from
// a live A2A card, and earned nothing for it.

// Sized like a real BORT card (18-37 skills), not a two-item toy: the proof
// floors at 3 matched, and a test that quietly sat under the floor would be
// asserting the wrong thing.
const a2aHonest = computeVerdict({
  endpoint: {
    declared: true,
    reachable: true,
    hasAgentCard: true,
    skillIds: ['buy_token', 'sell_token', 'get_price', 'check_balance'],
  },
  declaredSkills: ['buy_token', 'sell_token', 'get_price', 'check_balance'],
});
ok(has(a2aHonest, 'capability_integrity'),
  'an A2A agent serving every skill it declares earns corroboration too');
ok(a2aHonest.tier === TIERS.VERIFIED_LIVE,
  'and can therefore reach verified_live, which it previously could not');
ok(a2aHonest.capability.kind === 'a2a' && a2aHonest.capability.noun === 'skills',
  'the evidence names what was compared, since skills and tools are not the same claim');

const a2aOverstates = computeVerdict({
  endpoint: { declared: true, reachable: true, hasAgentCard: true, skillIds: ['buy_token'] },
  declaredSkills: ['buy_token', 'sell_token', 'open_position'],
});
ok(!has(a2aOverstates, 'capability_integrity'),
  'an A2A agent serving fewer skills than it declares earns nothing');
ok(a2aOverstates.capability.declared === 3 && a2aOverstates.capability.matched === 1,
  'and the shortfall is published for A2A exactly as it is for MCP');

// MCP still wins when an agent speaks both, because tools/list describes
// execution rather than publication.
const both = computeVerdict({
  endpoint: { declared: true, reachable: true, hasAgentCard: true, skillIds: ['x'] },
  mcp: { declared: true, reachable: true, servesTools: true, toolIds: ['a', 'b'] },
  declaredTools: ['a', 'b'],
  declaredSkills: ['x', 'y', 'z'],
});
ok(both.capability.kind === 'mcp',
  'an agent speaking both is judged on its MCP tools, the stronger evidence');

// --- coverage must be the INTERSECTION, not the served-set size ---------------
//
// BORT #211859 on live data: 37 skills declared on-chain, and the fleet card it
// points at serves 6 completely unrelated ones. Reporting served.size rendered
// "declares 37, serves 6" for an overlap of zero.

const disjoint = computeVerdict({
  endpoint: {
    declared: true, reachable: true, hasAgentCard: true,
    skillIds: ['trade', 'market_data', 'holdings', 'signals', 'chat', 'paid_inference'],
  },
  declaredSkills: ['buy_token', 'sell_token', 'open_position', 'get_price'],
});
ok(disjoint.capability.matched === 0,
  'a disjoint served set matches nothing, however many entries it has');
ok(disjoint.capability.coverage === 0,
  'and coverage is zero, not 6/4');
ok(disjoint.capability.servedCount === 6,
  'the served count is still reported, just never as the headline');
ok(disjoint.capability.extra.length === 6,
  'served-but-undeclared capabilities are published too');
ok(!has(disjoint, 'capability_integrity'),
  'and it earns no corroboration');

const partial = computeVerdict({
  mcp: { declared: true, reachable: true, servesTools: true, toolIds: ['a', 'b', 'c', 'z'] },
  declaredTools: ['a', 'b', 'c', 'd', 'e', 'f'],
});
ok(partial.capability.matched === 3 && partial.capability.declared === 6,
  'a partial overlap reports what actually matched');
ok(Math.abs(partial.capability.coverage - 0.5) < 1e-9, 'coverage is matched/declared');
ok(partial.capability.extra.length === 1, 'and names the one served capability never declared');

// A tiny declaration must not buy the proof cheaply.
const twoSkills = computeVerdict({
  mcp: { declared: true, reachable: true, servesTools: true, toolIds: ['a', 'b'] },
  declaredTools: ['a', 'b'],
});
ok(!has(twoSkills, 'capability_integrity'),
  'keeping two promises is not enough to corroborate an endpoint');
ok(twoSkills.capability.coverage === 1, 'though full coverage is still reported honestly');

// --- the card that answers must be a card about THIS agent -------------------
//
// The trap this closes: BORT #211859 points at a shared fleet card. Scope the
// capability comparison to the endpoint's own declarations and that card matches
// itself perfectly, scoring full coverage and earning the top tier for an agent
// it never mentions. Coverage is structurally blind to it.

const fleetCard = computeVerdict({
  endpoint: { declared: true, reachable: true, hasAgentCard: true, skillIds: ['a', 'b', 'c'] },
  declaredSkills: ['a', 'b', 'c'],
  subject: { verified: false, how: 'the card names no token and no wallet of its own' },
});
ok(has(fleetCard, 'capability_integrity'),
  'coverage can still be perfect against a card that is not about this agent');
ok(fleetCard.tier === TIERS.ACTIVE,
  'but an unverified subject hard-bars verified_live regardless of coverage');
ok(fleetCard.subject.verified === false, 'and the reason is published on the verdict');

const ownCard = computeVerdict({
  endpoint: { declared: true, reachable: true, hasAgentCard: true, skillIds: ['a', 'b', 'c'] },
  declaredSkills: ['a', 'b', 'c'],
  subject: { verified: true, how: 'the card was served from a url addressing this token' },
});
ok(ownCard.tier === TIERS.VERIFIED_LIVE,
  'the same agent serving the same skills from its OWN card does earn it');

// MCP is addressed by its own endpoint, so there is no subject to check and the
// absence of one must not be read as a failure.
const mcpNoSubject = computeVerdict({
  mcp: { declared: true, reachable: true, servesTools: true, toolIds: ['a', 'b', 'c'] },
  declaredTools: ['a', 'b', 'c'],
  subject: null,
});
ok(mcpNoSubject.tier === TIERS.VERIFIED_LIVE,
  'an MCP agent is not penalised for having no card subject to verify');

ok(FORMULA_VERSION === '0.8', 'formula version is published and current');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
