export const FORMULA_VERSION = '0.8';

export const TIERS = {
  VERIFIED_LIVE: 'verified_live',
  ACTIVE: 'active',
  REGISTERED: 'registered',
};

// Explainable tiering from recorded observations; evidence travels with the verdict.
//
//   verified_live  endpoint answers AND a qualifying supporting signal; subject not failed
//   active         no proven endpoint, but real on-chain or settlement activity
//   registered     an identity exists; nothing else could be proven
//
// v0.3 changes three things, each because the previous version could publish a
// claim it had not earned:
//
//  1. An UNKNOWN agent count no longer produces a wallet proof. v0.2 fell back
//     to the most permissive threshold exactly when it knew least, and unknown
//     is the normal case on the anonymous tier because every 429 returns null.
//  2. The shared-wallet discount scales instead of offsetting. Mass minting
//     costs roughly two transactions per agent, so `owned + 2` let a wallet
//     holding hundreds of nameplates clear the bar at about one tx per agent.
//  3. Wallet activity alone can no longer reach `active`. An identity that
//     serves nothing and declares no endpoint is a nameplate however busy the
//     address that minted it is, and ranking it level with an agent that
//     answers is the failure this site exists to name.
//
// v0.4 tightens the top tier: wallet activity alone no longer reaches
// `verified_live` either. Measured against live BSC data, v0.3 promoted five
// duplicate registrations of one project and an agent named "test clipx v4",
// each on a busy wallet and nothing else. Only signals that corroborate the
// ENDPOINT can carry that tier.
//
// v0.8 adds a subject check and makes it a HARD BAR on the top tier. A shared
// fleet endpoint serves a valid, healthy card describing the service, and every
// agent pointing at it inherited that liveness. Worse, the capability
// comparison is blind to it by construction: scoped to the endpoint's own
// declarations a fleet card matches itself perfectly and scores full coverage
// for an agent it never mentions. Coverage cannot catch that. Identity can.
//
// v0.7 reports the INTERSECTION of declared and served, not the size of the
// served set. The old number said "declares 37, serves 6" for an agent whose
// overlap with its own declaration was zero, which overstated coverage by six
// in the one place this site is least entitled to round in its own favour.
// Also floors the proof at 3 matched capabilities so a one-skill declaration
// cannot earn corroboration for keeping a single trivial promise.
//
// v0.6 applies declared-vs-served to A2A as well as MCP. Until then the
// corroboration that carries the top tier was only reachable by one protocol,
// so every BAP-578 agent on this registry was capped at `active` regardless of
// how honestly it published. That was a bias in the formula, not a finding
// about the agents.
//
// v0.5 fixes category placement rather than tiering, but old verdicts are
// withdrawn all the same because the categories they carry were wrong: a bare
// `health` fragment filed two uptime tools under health-factor monitoring, and
// lowercasing camelCase names collapsed `createSingleSidePosition` into a
// string containing "deposit", crediting a liquidity tool as yield.
//
// MCP endpoints are first-class here. Most agents doing the work this site
// cares about publish MCP, not A2A, and `tools/list` is better evidence than an
// agent card: it is the set of operations the server will actually perform.
export function computeVerdict({
  endpoint, mcp, wallet, bazaar, registry, declaredTools, declaredSkills, subject,
}) {
  const proofs = [];

  if (bazaar?.listed) proofs.push({ signal: 'b402_settlement', detail: 'listed in B402 Bazaar, which indexes only settled x402 payments' });
  if ((registry?.feedbackCount ?? 0) > 0) proofs.push({ signal: 'registry_feedback', detail: `${registry.feedbackCount} on-chain feedbacks` });

  if (wallet?.checked) {
    const owned = wallet.agentsOwned;
    if (owned == null) {
      // Unknown is not zero. Saying nothing is the honest output.
    } else {
      const threshold = Math.max(2, owned * 3 + 2);
      if (wallet.txCount > threshold) {
        proofs.push({
          signal: 'wallet_activity',
          detail: `${wallet.txCount} transactions from agent wallet (threshold ${threshold}: wallet owns ${owned} agents, mint cost discounted)`,
        });
      }
    }
  }

  // Compare registry declarations with MCP tool names or A2A skills listed at
  // check time. Both records may share a publisher: agreement establishes
  // consistency, not independent validation or correct task execution.
  let capability = null;
  const compare = mcp?.servesTools
    ? { kind: 'mcp', noun: 'tools', declared: declaredTools, served: mcp.toolIds ?? [] }
    : (endpoint?.hasAgentCard
      ? { kind: 'a2a', noun: 'skills', declared: declaredSkills, served: endpoint.skillIds ?? [] }
      : null);

  if (compare && Array.isArray(compare.declared) && compare.declared.length > 0) {
    const served = new Set(compare.served);
    const declaredSet = new Set(compare.declared);
    const missing = compare.declared.filter((t) => !served.has(t));
    // MATCHED is the intersection, and it is the only honest headline. Reporting
    // the size of the served set instead read "declares 37, serves 6" for an
    // agent whose overlap with its own declaration was ZERO: the 6 were six
    // unrelated names. Overstating coverage by six, on a site whose whole claim
    // is that disagreement gets published rather than softened.
    const matched = compare.declared.length - missing.length;
    const extra = compare.served.filter((t) => !declaredSet.has(t));
    capability = {
      kind: compare.kind,
      noun: compare.noun,
      declared: compare.declared.length,
      matched,
      // Kept for context, never as the headline: it answers "how many does the
      // endpoint offer", not "how many of the promises does it keep".
      servedCount: served.size,
      coverage: compare.declared.length > 0 ? matched / compare.declared.length : 0,
      missing: missing.slice(0, 20),
      // Served but never declared. Not a fault, but worth showing: it means the
      // registry record understates the agent.
      extra: extra.slice(0, 20),
    };
    // Binary proof, continuous reporting. A ratio threshold would reward small
    // denominators, letting a 4-of-5 nameplate clear a bar that a 16-of-24 real
    // agent fails. The `matched >= 3` floor stops a one-skill declaration from
    // earning corroboration for keeping a single trivial promise.
    if (missing.length === 0 && matched >= 3) {
      proofs.push({
        signal: 'capability_integrity',
        detail: `serves all ${compare.declared.length} ${compare.noun} its registry metadata advertises`,
      });
    }
  }

  const a2aProven = Boolean(endpoint?.reachable && endpoint?.hasAgentCard);
  const mcpProven = Boolean(mcp?.reachable && mcp?.servesTools);
  const endpointProven = a2aProven || mcpProven;
  const declaresEndpoint = Boolean(endpoint?.declared || mcp?.declared);

  // Wallet activity is the weakest signal here and it corroborates the wrong
  // thing: it describes an ADDRESS, which may be a person or a platform doing
  // work unrelated to this agent, while the top tier is a claim about an
  // ENDPOINT. Letting it stand alone put five duplicate registrations of one
  // project and an agent named "test clipx v4" in the same tier as an agent
  // serving every tool it advertises.
  //
  // The three signals below each corroborate the endpoint itself: it settles
  // payments, real users left on-chain feedback, or it serves exactly what its
  // registry metadata promises.
  const CORROBORATING = new Set(['b402_settlement', 'registry_feedback', 'capability_integrity']);
  const corroborated = proofs.filter((p) => CORROBORATING.has(p.signal));

  // An A2A card that answers is not automatically a card about THIS agent. A
  // shared fleet endpoint returns a valid, healthy card describing the service,
  // and every agent pointing at it inherits that liveness for free.
  //
  // This is a HARD BAR rather than one more signal, because it is the failure
  // the capability comparison is blindest to. Scope the comparison to the
  // endpoint's own declared capabilities and a fleet card matches itself
  // perfectly: full coverage, corroboration earned, top tier awarded, for an
  // agent the card never mentions. Coverage cannot detect that. Only identity can.
  // Deliberately NOT pushed into `proofs`. The UI counts that array as "activity
  // proofs", so filing a disqualification there would inflate the very number it
  // disqualifies. It is published as its own field instead.
  const subjectUnverified = Boolean(subject && subject.verified === false);

  let tier = TIERS.REGISTERED;
  if (endpointProven && corroborated.length > 0 && !subjectUnverified) tier = TIERS.VERIFIED_LIVE;
  else if (endpointProven || corroborated.length > 0 || (proofs.length > 0 && declaresEndpoint)) tier = TIERS.ACTIVE;

  return {
    tier,
    formulaVersion: FORMULA_VERSION,
    // Which of the proofs actually corroborate the ENDPOINT, published by name.
    // The narrative names the proof that carries a tier, and this is the only
    // way it can do that without keeping its own copy of the CORROBORATING set
    // in another package, where it would drift the first time this one changed.
    corroboratedSignals: corroborated.map((p) => p.signal),
    endpointProven,
    endpointKind: mcpProven ? 'mcp' : a2aProven ? 'a2a' : null,
    capability,
    // Whether the card that answered can be shown to describe this agent, and
    // how it was established. Published either way: "we checked and it does" is
    // as much a part of the verdict as the failure is.
    subject: subject ?? null,
    proofs,
    evidence: { endpoint, mcp, wallet, bazaar, registry },
    computedAt: new Date().toISOString(),
  };
}
