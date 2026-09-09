import { categoriesFromSkills, basisForCategory, capabilitiesFromCard } from '../src/verify/categorize.js';

/**
 * Category placement must be earned.
 *
 * Every case here comes from a real false positive found while scouting
 * curation candidates on BSC: searching the registry for "rebalance" returned
 * trading agents whose descriptions read "Liquidity Bloom [Pool
 * Architect]". They rebalance nothing. Filing them under Rebalancing would
 * present a nameplate as a capability, which is what this site exists to
 * argue against.
 *
 *   node test/categorize.test.mjs
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

// The exact false positive that prompted this module.
const flavourTextTrader = ['trade', 'market-data', 'holdings', 'signals', 'chat'];
ok(
  !categoriesFromSkills(flavourTextTrader).some((c) => c.category === 'rebalancing'),
  'a "Liquidity Bloom" trading agent does NOT earn rebalancing',
);
ok(
  basisForCategory('rebalancing', flavourTextTrader).basis === 'text',
  'it is labelled name-match-only rather than hidden from the category',
);
ok(
  categoriesFromSkills(flavourTextTrader).some((c) => c.category === 'trading'),
  'it still earns trading, which it genuinely declares',
);

// Real capability earns the category and names the skill that proves it.
const lendingAgent = ['check_lending_health', 'watch_lending_health', 'get_price'];
const health = categoriesFromSkills(lendingAgent).find((c) => c.category === 'health');
ok(
  health && health.basis === 'declared' && health.evidence === 'check_lending_health',
  'a declared health skill earns the category and cites its evidence',
);

ok(
  categoriesFromSkills(['pcs_add_liquidity', 'collect_fees']).some((c) => c.category === 'rebalancing'),
  'genuine liquidity tooling does earn rebalancing',
);

// Silence is the honest answer for an agent that publishes nothing.
ok(categoriesFromSkills([]).length === 0, 'a nameplate with no skills claims no category');
ok(categoriesFromSkills(null).length === 0, 'a missing skill list is handled without throwing');
ok(basisForCategory('grid', null).basis === 'text', 'basis falls back to text when skills are unknown');
ok(basisForCategory('not_a_category', ['grid']).basis === 'text', 'an unknown category never claims declared');

// --- false positives found in live BSC data ---------------------------------
//
// Both of these were filed under a JUDGED category by an earlier revision, on
// evidence that does not survive being read aloud.

// "Health factor monitoring" is lending liquidation risk. A generic service
// healthcheck is not that, and a bare `health` fragment matched both.
ok(
  !categoriesFromSkills(['get_health']).some((c) => c.category === 'health'),
  'a service healthcheck does not earn health-factor monitoring',
);
ok(
  !categoriesFromSkills(['endpoint_health', 'uptime']).some((c) => c.category === 'health'),
  'an uptime tool does not earn health-factor monitoring either',
);
ok(
  categoriesFromSkills(['getAccountLiquidity', 'getBorrowBalance']).some((c) => c.category === 'health'),
  'reading account liquidity and borrow balance does earn it',
);

// Lowercasing a camelCase name destroys its word boundaries:
// createSingleSidePosition becomes createsinglesideposition, which contains
// "deposit" across the si|de|position seam. A liquidity tool was credited as
// yield on exactly that.
ok(
  !categoriesFromSkills(['createSingleSidePosition']).some((c) => c.category === 'yield'),
  'an accidental substring across a word boundary earns nothing',
);
ok(
  categoriesFromSkills(['depositToVault']).some((c) => c.category === 'yield'),
  'a real deposit tool still earns yield',
);

// camelCase and snake_case name the same operation and must place identically.
ok(
  categoriesFromSkills(['increaseLiquidity', 'decreaseLiquidity']).some((c) => c.category === 'rebalancing')
  && categoriesFromSkills(['increase_liquidity', 'decrease_liquidity']).some((c) => c.category === 'rebalancing'),
  'camelCase and snake_case capabilities place the same',
);

// Adding liquidity is not rebalancing on its own: the agent has to be able to
// pull it back or retarget the range.
ok(
  !categoriesFromSkills(['addLiquidity']).some((c) => c.category === 'rebalancing'),
  'supplying liquidity alone is not rebalancing',
);

// --- capability records, not bare names -------------------------------------
//
// Every case below is a real BSC agent that matched "grid" in the registry
// while the grid category counted zero. Reading only a skill's id was the
// reason: a card files its domain in the fields around the id.

// Assay Grid (token 331751). The id alone already carries it, and that is the
// evidence a reader is pointed at.
const assayGrid = [{ id: 'assay_grid', name: 'Assay Grid', tags: ['grid', 'bnb-chain', 'erc-8004'] }];
const assay = categoriesFromSkills(assayGrid).find((c) => c.category === 'grid');
ok(assay && assay.evidence === 'assay_grid', 'a capability record places on its id and cites it');

// The same skill named for its output rather than its domain. The tag is the
// only thing that carries the category, so the citation has to say so — a bare
// "plan_levels" would send a reader looking for a word that is not there.
const taggedOnly = [{ id: 'plan_levels', tags: ['grid'] }];
const tagged = categoriesFromSkills(taggedOnly).find((c) => c.category === 'grid');
ok(tagged && tagged.evidence === 'plan_levels (tagged grid)', 'a tag places the skill and the citation names the tag');

// AiKi PancakeSwap Grid Trader (token 315945) publishes no skills at all: its
// only capability label is the name of the service it offers.
ok(
  capabilitiesFromCard({ services: [{ name: 'pancakeswap-v3-grid-assessment' }] })
    .some((entry) => categoriesFromSkills([entry]).some((c) => c.category === 'grid')),
  'a descriptively named service is a capability label',
);

// Brain on BNB (token 302258) files its category in a registration attribute.
const brainOnBnb = capabilitiesFromCard({
  attributes: [
    { trait_type: 'Category', value: 'grid-trading' },
    { trait_type: 'Venues', value: 'PancakeSwap V2/V3' },
  ],
});
const attributed = categoriesFromSkills(brainOnBnb).find((c) => c.category === 'grid');
ok(
  attributed && attributed.evidence === 'Category: grid-trading',
  'a Category attribute places the agent and is quoted as written',
);

// Assay Grid again: the A2A skill list hangs off the service entry.
ok(
  categoriesFromSkills(capabilitiesFromCard({ services: [{ name: 'A2A', a2aSkills: ['grid'] }] }))
    .some((c) => c.category === 'grid'),
  'a2aSkills on a service entry are capabilities too',
);

// --- what still earns nothing -----------------------------------------------

// Grid Trader (token 269224) answers live, and everything it serves is the
// ERC-8183 protocol. Negotiating a job is not placing a grid order, so this
// agent does not "serve" the category however grid-shaped its name is. This is
// the honest zero the coverage table exists to show.
const erc8183Seller = {
  name: 'gridtrader-agent',
  description: 'ERC-8183 seller agent (gridtrader-agent): negotiate + notify_funded over A2A.',
  skills: [
    { id: 'negotiate', name: 'Negotiate an ERC-8183 job', tags: ['erc8183', 'negotiation', 'bnb-chain'] },
    { id: 'notify_funded', name: 'Notify the seller a job is funded', tags: ['erc8183', 'delivery', 'bnb-chain'] },
  ],
};
ok(
  !categoriesFromSkills(capabilitiesFromCard(erc8183Seller)).some((c) => c.category === 'grid'),
  'an ERC-8183 seller that only negotiates does not earn the category its name claims',
);

// The card's own prose is where every false positive in this file came from,
// and widening to records must not quietly let it back in.
ok(
  !categoriesFromSkills(capabilitiesFromCard({
    skills: [{ id: 'run', description: 'Deterministic grid planning: symmetric buy and sell ladders.' }],
  })).some((c) => c.category === 'grid'),
  'a description is never read, however clearly it states the category',
);

// A service named for its transport says nothing about what the agent does.
ok(
  categoriesFromSkills(capabilitiesFromCard({
    services: [{ name: 'A2A' }, { name: 'web' }, { name: 'Termix Platform' }],
  })).length === 0,
  'protocol service names earn nothing',
);

ok(capabilitiesFromCard(null).length === 0, 'a missing card yields no capabilities');
ok(
  capabilitiesFromCard({ skills: 'not-an-array', services: null, attributes: 7 }).length === 0,
  'author-supplied fields of the wrong shape are handled without throwing',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
