/**
 * Category placement, derived from evidence.
 *
 * The registry only lets you search names and descriptions, and descriptions
 * are marketing copy. Searching "rebalance" on BSC returns trading agents whose
 * flavour text happens to say "Liquidity Bloom [Pool Architect]" — agents that
 * rebalance nothing. Putting those under Rebalancing would be presenting a
 * nameplate as a capability, which is the exact thing this project argues
 * against.
 *
 * So placement has a BASIS, and the basis is shown to the user:
 *
 *   served    the agent's live endpoint listed this capability when we asked.
 *   declared  the agent's own card lists a capability that performs this
 *             category's work. This is a claim the agent publishes about
 *             itself, and it is checkable by fetching the card.
 *   text      the words matched, nothing more. Weaker, and labelled as such.
 *
 * A category is never inferred from a description alone without saying so.
 */

/**
 * Put a capability name into one comparable form.
 *
 * Catalogs name the same operation differently: A2A skills tend to be
 * snake_case (add_liquidity), MCP tools camelCase (increaseLiquidity). Simply
 * lowercasing destroys the word boundaries and matching then fires on letters
 * that only happen to sit next to each other: `createSingleSidePosition`
 * flattens to `createsinglesideposition`, which contains "deposit", and a
 * liquidity tool was credited as yield on that evidence. Restoring the
 * separators keeps matches on word boundaries.
 */
export function normalizeCapability(raw) {
  return String(raw || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s\-.:]+/g, '_')
    .toLowerCase();
}

const arr = (v) => (Array.isArray(v) ? v : []);

/*
  A capability is not always a bare name, and reading only the name is how a
  live grid agent stayed invisible to a category built for it.

  A2A publishes skills as {id, name, tags}, and the tags are where cards
  routinely put the domain word: Assay Grid ships skill `assay_grid` tagged
  `grid`, an ERC-8004 service entry names itself
  `pancakeswap-v3-grid-assessment`, and a registration can file its own category
  in an attribute, {trait_type: "Category", value: "grid-trading"}. Each of
  those is a label the author chose to file the capability under, and each is
  checkable by fetching the same file.

  Descriptions are deliberately NOT read, and that is the line this module
  holds. Prose is written to sell, and every false positive this file exists to
  prevent came from prose. An id, a name and a tag are filing labels; a sentence
  is an advertisement.

  Each label travels with the capability it came from, so the evidence shown to
  a reader names something they can go and find in the card rather than a bare
  fragment that happened to match.
*/
function labelsOf(entry) {
  if (entry === null || entry === undefined) return [];
  if (typeof entry === 'string' || typeof entry === 'number') {
    const label = normalizeCapability(entry);
    return label ? [{ label, cite: String(entry).trim() }] : [];
  }
  if (typeof entry !== 'object') return [];

  // What a reader is told to go and look for. The id is the capability's real
  // handle; the name is the fallback for catalogs that publish no id.
  const handle = String(entry.id ?? entry.name ?? '').trim();
  const out = [];
  const push = (raw, tagged) => {
    const label = normalizeCapability(raw);
    if (!label) return;
    // A tag that merely repeats its own capability's handle adds nothing to
    // cite, so only a tag that carries new information is spelled out.
    const cite = tagged && handle && normalizeCapability(handle) !== label
      ? `${handle} (tagged ${String(raw).trim()})`
      : (handle || String(raw).trim());
    out.push({ label, cite });
  };
  push(entry.id, false);
  push(entry.name, false);
  for (const tag of arr(entry.tags).slice(0, 12)) push(tag, true);
  return out;
}

// Flatten a mixed list of names and capability records into matchable labels.
// Capped because every one of these fields is author-supplied: a card
// publishing thousands of tags must not turn one placement into an unbounded
// scan.
function toLabels(list) {
  const seen = new Set();
  const out = [];
  for (const entry of arr(list)) {
    for (const item of labelsOf(entry)) {
      if (seen.has(item.label)) continue;
      seen.add(item.label);
      out.push(item);
      if (out.length >= 240) return out;
    }
  }
  return out;
}

/**
 * Capability records an ERC-8004 identity file publishes, beyond its tool list.
 *
 * Three places a card names what it does, all of them machine-readable fields
 * rather than prose:
 *
 *   skills[]      the A2A catalog, with the tags that carry the domain word
 *   services[]    a descriptive service name, and any a2aSkills it lists
 *   attributes[]  a Category trait, which is the agent filing itself
 *
 * A service named for its protocol (`A2A`, `web`) simply matches nothing, which
 * is the correct outcome rather than a case worth special-casing away.
 */
export function capabilitiesFromCard(card) {
  if (!card || typeof card !== 'object') return [];
  const out = [];

  for (const skill of arr(card.skills).slice(0, 60)) {
    if (typeof skill === 'string') out.push(skill);
    else if (skill && typeof skill === 'object') out.push({ id: skill.id, name: skill.name, tags: skill.tags });
  }

  for (const service of arr(card.services).slice(0, 20)) {
    if (!service || typeof service !== 'object') continue;
    out.push({ name: service.name, tags: arr(service.a2aSkills) });
  }

  for (const attr of arr(card.attributes).slice(0, 30)) {
    if (!attr || typeof attr !== 'object') continue;
    if (!/^categor(y|ies)$/i.test(String(attr.trait_type ?? '').trim())) continue;
    const value = String(attr.value ?? '').trim();
    if (value) out.push({ id: `${String(attr.trait_type).trim()}: ${value}` });
  }

  return out;
}

// Capability fragments, matched against the normalized snake_case form above.
//
// `any` means one match is enough. `all` means every group must match, which is
// how a category avoids crediting a primitive for the whole job: supplying
// liquidity is not rebalancing unless the agent can also pull it back or
// retarget the range.
const CAPABILITY_RULES = {
  rebalancing: {
    all: [
      ['add_liquidity', 'increase_liquidity', 'mint_position', 'create_position'],
      ['remove_liquidity', 'decrease_liquidity', 'rebalance', 'price_range', 'lp_range', 'collect_fee'],
    ],
  },
  grid: { any: ['grid'] },
  yield: { any: ['yield', 'farm', 'stake', 'unstake', 'apr', 'apy', 'supply_', 'vault', 'deposit'] },
  // "Health factor monitoring" means lending liquidation risk, so a generic
  // service healthcheck must not qualify. A bare `health` fragment matched
  // `get_health` and `endpoint_health` and filed two uptime tools under a
  // judged DeFi category. Bare borrow/repay are lending primitives and do not
  // qualify either: the agent has to READ position health.
  health: {
    any: ['health_factor', 'lending_health', 'position_health', 'liquidation',
      'account_liquidity', 'collateral', 'borrow_balance', 'borrow_limit', 'ltv'],
  },
  trading: { any: ['buy_token', 'sell_token', 'swap', 'trade', 'open_position', 'close_position'] },
  research: { any: ['scan', 'analyz', 'research', 'monitor', 'token_info', 'rush', 'signal'] },
};

/*
  A fragment matches at a WORD START and nowhere else.

  Widening to service names put venue names in front of these rules for the
  first time, and `swap` is a substring of `pancakeswap`: AiKi's
  `pancakeswap-v3-grid-assessment`, a read-only grid checker, was credited with
  trading on the strength of the exchange it reads. The normalizer already
  restores word boundaries, so honouring them here costs nothing and closes the
  whole class — the same class that once read `deposit` out of
  `createSingleSidePosition`.

  A fragment may still match a word PREFIX, because that is how these labels are
  written: `grid` earns on `gridband_observer`, `analyz` on `analyze_token`.
*/
export function hasFragment(label, fragment) {
  let from = 0;
  for (;;) {
    const at = label.indexOf(fragment, from);
    if (at === -1) return false;
    if (at === 0 || label[at - 1] === '_') return true;
    from = at + 1;
  }
}

/*
  A compound rule can be satisfied by two labels of the SAME capability — a
  skill whose id is `rebalance_position` and whose tags include `add_liquidity`
  earns rebalancing on its own. That is one entry claiming both halves of the
  job, and it is only ever reachable on the `declared` basis: a served
  capability list carries no tags.
*/
function matchRule(rule, items) {
  if (rule.any) {
    const hit = items.find((i) => rule.any.some((p) => hasFragment(i.label, p)));
    return hit ? hit.cite : null;
  }
  // Every group must be satisfied; the evidence shown is the whole set that
  // earned it, so a reader can see why the compound claim holds.
  const hits = [];
  for (const group of rule.all) {
    const hit = items.find((i) => group.some((p) => hasFragment(i.label, p)));
    if (!hit) return null;
    hits.push(hit.cite);
  }
  return hits.join(' + ');
}

/**
 * Category placement from an agent's capabilities, strongest evidence first.
 *
 * served    the agent's live endpoint listed this tool when we asked it just
 *           now. This is the strongest claim on the site: not what the agent
 *           says it does, what it answered that it does.
 * declared  the agent's registry metadata or A2A card lists it. A published
 *           claim, checkable, but only a claim.
 *
 * Both lists accept bare names or capability records ({id, name, tags}).
 *
 * @param {{ served?: Array, declared?: Array }} capabilities
 */
export function categoriesFromCapabilities({ served = [], declared = [] } = {}) {
  const servedItems = toLabels(served);
  const declaredItems = toLabels(declared);
  if (servedItems.length === 0 && declaredItems.length === 0) return [];

  const found = [];
  for (const [category, rule] of Object.entries(CAPABILITY_RULES)) {
    const servedHit = servedItems.length ? matchRule(rule, servedItems) : null;
    if (servedHit) {
      found.push({ category, basis: 'served', evidence: servedHit });
      continue;
    }
    const declaredHit = declaredItems.length ? matchRule(rule, declaredItems) : null;
    if (declaredHit) found.push({ category, basis: 'declared', evidence: declaredHit });
  }
  return found;
}

/**
 * Which categories an agent has actually demonstrated it can serve.
 *
 * @param {Array} skills  declared capabilities from the agent's card
 * @returns {Array<{ category: string, basis: 'declared', evidence: string }>}
 */
export function categoriesFromSkills(skills) {
  return categoriesFromCapabilities({ declared: skills });
}

/**
 * Whether an agent's declared skills support a specific category claim.
 * Used to mark rows in a category browse as earned or merely text-matched.
 *
 * @returns {{ basis: 'declared', evidence: string } | { basis: 'text' }}
 */
export function basisForCategory(category, skills) {
  const rule = CAPABILITY_RULES[category];
  if (!rule || !Array.isArray(skills)) return { basis: 'text' };
  const hit = matchRule(rule, toLabels(skills));
  return hit ? { basis: 'declared', evidence: hit } : { basis: 'text' };
}

/*
  Every fragment any category is earned on, flattened.

  Exported so the search path can assert that it never discards one of these as
  a noise word. The stopword list over there is editorial — someone will extend
  it — and `close` is the trap: it reads like filler in "close to liquidation"
  and is a capability in `close_position`. This array is what makes that a test
  failure rather than a silent loss of recall.
*/
export const CAPABILITY_FRAGMENTS = [...new Set(
  Object.values(CAPABILITY_RULES).flatMap((rule) => (rule.any ?? []).concat(...(rule.all ?? []))),
)];

// The four core marketplace categories, kept separate from trading/research so
// the coverage view can report them on their own terms.
export const JUDGED_CATEGORIES = ['rebalancing', 'grid', 'yield', 'health'];
