import { getAgentDetail, getAccountAgentCount } from '../sources/scan8004.js';
import { getBazaarUsage } from '../sources/bazaar.js';
import { getWalletActivity } from '../sources/chain.js';
import { probeEndpoint, probeMcp } from './probe.js';
import { computeVerdict } from './score.js';
import { IdentityReadError, identityObservation } from './identity.js';
import { categoriesFromCapabilities, capabilitiesFromCard, normalizeCapability } from './categorize.js';
import { getAgentMetadata, mediaFromRegistration } from '../sources/registry.js';
import { walletClaimFromCard, verifyWalletClaim, verifyCardSubject } from './wallet.js';
import {
  bap578FromCard, detectBap578, getAgentState, getAgentMetrics, getTransferables, verifyBapOwnership,
} from '../sources/bap578.js';
import { externalWorkAdmission, WorkCapacityError } from '../work-admission.js';

// The registry stores a declared tool list as either bare names or objects.
// Normalized to the same lowercased shape the live probe returns so the two are
// comparable: that comparison is the whole point.
function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => normalizeCapability(typeof t === 'string' ? t : (t?.id || t?.name)))
    .filter(Boolean)
    .slice(0, 120);
}

// The cheapest PRICED offering on a hire menu, as a wei string, so a browse row
// can show what hiring costs before the click. null when the menu publishes no
// usable price: a row must be able to say nothing rather than imply free work.
// Prices are authored by the party being assessed, so anything that is not a
// clean positive integer is ignored rather than guessed at or coerced.
export function minOfferingPriceU(entry) {
  const offerings = Array.isArray(entry?.offerings) ? entry.offerings : [];
  let min = null;
  for (const offering of offerings) {
    const raw = String(offering?.priceU ?? '');
    if (!/^\d{1,40}$/.test(raw)) continue;
    const value = BigInt(raw);
    if (value <= 0n) continue;
    if (min === null || value < min) min = value;
  }
  return min === null ? null : min.toString();
}

// One full verification pass for one agent. Shared by the API route and the
// background sweeper so a verdict means the same thing wherever it came from.
export function persistVerdict(store, verdictCache, key, verdict) {
  store.record(key, verdict);
  verdictCache.set(key, verdict);
}

export function createVerifier({
  verdictCache,
  accountCache,
  store,
  readAgentDetail = getAgentDetail,
  readAgentMetadata = getAgentMetadata,
  admission = externalWorkAdmission,
  maxWaitersPerAgent = 64,
}) {
  if (!admission || typeof admission.run !== 'function') throw new TypeError('verification admission controller is required');
  if (!Number.isSafeInteger(maxWaitersPerAgent) || maxWaitersPerAgent < 1) {
    throw new TypeError('maxWaitersPerAgent must be a positive safe integer');
  }
  const inFlight = new Map();

  // onEvent, when given, receives one object per check AS IT ACTUALLY RESOLVES
  // ({step, ...measured facts}), so a caller can narrate the verification live.
  // It is an observer only: a throwing listener must never break a check, and
  // the sweep passes nothing and behaves exactly as before.
  async function verifyOne(chainId, tokenId, emit) {
    const key = `${chainId}:${tokenId}`;
    const cached = verdictCache.get(key);
    if (cached) return { verdict: cached, cached: true };

    const detail = await readAgentDetail(chainId, tokenId);
    emit({ step: 'registry', ok: true, name: detail?.name ?? null });
    const endpointUrl = detail?.services?.a2a?.endpoint || null;
    // Most agents doing the work this site cares about publish MCP, not A2A.
    // Reading only services.a2a made every one of them invisible: never probed,
    // never categorized, and structurally unable to earn the top tier.
    const mcpUrl = detail?.services?.mcp?.endpoint || null;
    const declaredTools = toolNames(detail?.services?.mcp?.tools);
    // The A2A equivalent. Declared-vs-served was built for MCP only, which
    // quietly made it a protocol test rather than an honesty test: an A2A agent
    // could publish 37 skills in its registry metadata and serve every one of
    // them, and still never earn the corroboration that an MCP agent gets for
    // exactly the same behaviour.
    const declaredSkills = toolNames(
      detail?.raw_metadata?.offchain_content?.skills ?? detail?.services?.a2a?.skills,
    );
    const walletAddress = detail?.agent_wallet || null;

    // The registry's address is whoever REGISTERED the agent, which for a
    // platform that mints for its users is the platform. Prefer the agent's
    // own wallet when its card declares one AND that claim can be proved
    // against the token itself, so an agent is judged on its own activity
    // rather than its minter's.
    let ownWallet = null;
    let card = null;
    let identity;
    try {
      identity = identityObservation(await readAgentMetadata(detail.contract_address, tokenId));
      card = identity.card;
    } catch {
      emit({ step: 'card', ok: false, status: 'unavailable', ownWallet: false });
      // Stop before computing, persisting or caching a replacement verdict.
      // A failed document read is an incomplete check, not a new observation
      // that the previously attributed token and wallet no longer exist.
      throw new IdentityReadError();
    }
    try {
      const claim = walletClaimFromCard(card);
      if (claim) {
        const proof = await verifyWalletClaim(claim);
        if (proof.verified) ownWallet = { address: proof.wallet, how: proof.how };
      }
    } catch {
      // A failed wallet proof does not erase the identity file we did read.
    }

    emit({ step: 'card', ok: Boolean(card), status: identity.status, ownWallet: Boolean(ownWallet) });

    const subjectWallet = ownWallet?.address ?? walletAddress;
    let agentsOwned = subjectWallet ? accountCache.get(subjectWallet) : null;
    // Each probe reports the moment IT resolves, not when the batch does: the
    // jitter and ordering of these lines is the proof they are real calls.
    const [endpoint, mcp, walletBase, bazaar, ownedFresh] = await Promise.all([
      probeEndpoint(endpointUrl, tokenId).then((r) => {
        emit({
          step: 'a2a', declared: Boolean(endpointUrl), reachable: Boolean(r?.reachable),
          status: r?.status ?? null, latencyMs: r?.latencyMs ?? null, reason: r?.reason ?? null,
          hasAgentCard: Boolean(r?.hasAgentCard), skillsCount: r?.skillsCount ?? null,
        });
        return r;
      }),
      probeMcp(mcpUrl).then((r) => {
        emit({
          step: 'mcp', declared: Boolean(mcpUrl), reachable: Boolean(r?.reachable),
          servesTools: Boolean(r?.servesTools), toolCount: r?.toolCount ?? null,
          latencyMs: r?.latencyMs ?? null,
        });
        return r;
      }),
      getWalletActivity(subjectWallet).then((r) => {
        emit({
          step: 'wallet', address: subjectWallet ?? null,
          checked: Boolean(r?.checked), txCount: r?.txCount ?? null,
        });
        return r;
      }),
      getBazaarUsage(subjectWallet).then((r) => {
        emit({
          step: 'bazaar', checked: Boolean(r?.checked),
          listed: Boolean(r?.listed), calls30d: r?.calls30d ?? null,
        });
        return r;
      }),
      // Only ask how many agents share this wallet when we are falling back to
      // the registrant. A proved ERC-6551 account belongs to one token by
      // construction, so the mass-minter discount has nothing to correct for.
      agentsOwned === undefined && walletAddress && !ownWallet
        ? getAccountAgentCount(walletAddress)
        : Promise.resolve(agentsOwned ?? null),
    ]);
    if (agentsOwned === undefined) {
      agentsOwned = ownedFresh;
      if (subjectWallet && agentsOwned != null) accountCache.set(subjectWallet, agentsOwned);
    }
    const wallet = {
      ...walletBase,
      agentsOwned: agentsOwned ?? null,
      // Say WHOSE wallet was measured. "the agent's own, proved from its token"
      // and "whoever registered it" are very different claims, and a reader
      // should not have to guess which one a verdict rests on.
      isOwnWallet: Boolean(ownWallet),
      walletBasis: ownWallet ? ownWallet.how : 'the address that registered this agent',
      registrant: walletAddress,
    };

    // BAP-578: BNB Chain's Non-Fungible Agent standard. An 8004 registration
    // says an identity exists; a BAP-578 token says there is a logic contract
    // behind it, and on some implementations the agent records its own work
    // on-chain. Detected by interface so it holds for any collection.
    const bapRef = bap578FromCard(card);

    // Is the card-claimed BAP-578 token REALLY this agent's, on-chain? The card
    // names its own token and everything read off that token is published as
    // this agent's, so a card that claims a well-known agent's token would wear
    // its history and 3D skin. The old check accepted a path-segment match, but
    // both the token id and the url doing the matching were authored by the
    // party being assessed: circular. This asks the registrar that minted the
    // pair, the one record the attacker cannot forge. It is null (not false)
    // for a card that claims no BAP-578 token at all.
    const bapAttributed = bapRef
      ? await verifyBapOwnership({ collection: bapRef.collection, bapTokenId: bapRef.tokenId, agentId: tokenId })
      : null;
    if (bapRef) {
      emit({
        step: 'bap578', claimed: true, tokenId: bapRef.tokenId,
        attributed: bapAttributed === true ? true : bapAttributed === false ? false : null,
      });
    }

    // Does the card that answered actually describe THIS agent? Only asked of
    // A2A: an MCP server is addressed by its own endpoint and has no fleet-card
    // equivalent to be confused with. The path-segment proof may accept the
    // BAP-578 token id ONLY when that token is on-chain-confirmed to be this
    // agent's, so a foreign token id in an attacker's own url proves nothing.
    const subject = endpoint?.hasAgentCard
      ? await verifyCardSubject({
        endpoint, tokenId, attributedBapTokenId: bapAttributed ? bapRef.tokenId : null,
      })
      : null;

    let bap578 = null;
    if (bapRef) {
      const detected = await detectBap578(bapRef.collection);
      // Attribution is an ON-CHAIN fact now, not the card's say-so. An
      // unattributed claim is recorded as a claim and nothing is read against
      // it: not read-then-hide, an assertion we may not publish is not worth
      // three chain calls to obtain.
      // TRI-STATE. `false` is a finding about the claim (the registrar ties
      // this token to someone else, or to nobody). `null` is our own failure to
      // ask, and must never be rendered as the agent's shortfall: publishing
      // "no on-chain record ties that token to this agent" on the strength of a
      // throttled RPC is an accusation sourced from our own quota.
      const ownershipVerified = bapAttributed;
      if (detected?.isBap578 && ownershipVerified !== true) {
        bap578 = {
          ...bapRef,
          interfaces: detected.interfaces,
          ownershipVerified,
          ...(ownershipVerified === false
            // A real answer from the registrar, so it is publishable and the
            // remedy is stated so the finding is actionable, not merely negative.
            ? { howToProve: 'the registrar that mints these tokens has no record tying this token to this ERC-8004 registration, so a card-declared claim cannot be attributed on its own' }
            // We could not ask. Say that, and say nothing about their token.
            : { unattributedReason: 'we could not check the on-chain record that ties this token to this registration, so nothing under it is shown here' }),
        };
      } else if (detected?.isBap578) {
        const state = await getAgentState(bapRef.collection, bapRef.tokenId);
        const metrics = state ? await getAgentMetrics(state.logicAddress, bapRef.tokenId) : null;
        // What a buyer would actually receive. An agent is a transferable NFT,
        // and what moves with it is not what most people assume.
        const transferable = await getTransferables({
          collection: bapRef.collection, tokenId: bapRef.tokenId, state,
        });
        if (metrics?.reported) transferable.activePositions = metrics.activePositions;
        bap578 = {
          ...bapRef, interfaces: detected.interfaces, ownershipVerified: true, state, metrics, transferable,
        };
      } else if (detected) {
        // The card claims a BAP-578 token on a collection that does not
        // implement the standard. Worth recording, not worth hiding.
        bap578 = { ...bapRef, interfaces: detected.interfaces, unsupported: true };
      }
    }

    // What the REGISTRY says, recorded alongside what we found rather than
    // instead of it. 8004scan runs its own cached health check, and where the
    // two disagree that disagreement is worth showing: this agent carries
    // health_score 100 and is_endpoint_verified false at the same time.
    const registryMcp = detail?.health_status?.services?.mcp ?? null;
    const registry = {
      // Null, not zero. If the registry detail call did not land we do not know
      // how much feedback this agent has, and "0 feedbacks" is a statement we
      // would be making up. score.js already treats a missing count as no
      // proof, so this narrows what the page may say without moving a verdict.
      feedbackCount: detail?.total_feedbacks ?? null,
      healthScore: detail?.scores?.health_score ?? null,
      // Null, not false, for the same reason as the count above. Boolean() on a
      // missing detail turned OUR failed fetch into "the registry reports this
      // endpoint unverified" — a claim about a third party's record, made from
      // the fact that we never read it. Nothing in score.js reads this field,
      // so widening it moves no verdict; it only narrows what the page may say.
      isEndpointVerified: detail?.is_endpoint_verified == null
        ? null
        : Boolean(detail.is_endpoint_verified),
      endpointVerificationError: detail?.endpoint_verification_error ?? null,
      protocols: detail?.supported_protocols ?? [],
      x402Supported: Boolean(detail?.x402_supported),
      observedMcp: registryMcp
        ? {
          status: registryMcp.status ?? null,
          toolCount: registryMcp.stats?.tools_count ?? null,
          checkedAt: registryMcp.checked_at ?? null,
        }
        : null,
    };

    // The agent's poster image, from the registration metadata already
    // fetched above. Recorded so the browse table can show a real avatar from
    // the store with zero extra requests per row. Byte-sniffed where the url
    // is mute, so a GLB filed as `image` is never handed to an <img> tag: a
    // 3D-only agent yields null here and keeps its letter, its model lives on
    // the detail page. Decoration: a failure costs the picture, nothing else.
    let avatarUrl = null;
    try {
      const regMedia = await mediaFromRegistration(card);
      if (regMedia?.kind === 'image') avatarUrl = regMedia.url;
      else if (regMedia?.kind === '3d') avatarUrl = regMedia.image;
    } catch {
      avatarUrl = null;
    }

    // What the endpoint listed when we asked, in one place: it feeds the
    // category rules AND is persisted for capability search. Built once here
    // because it was previously constructed inline and discarded.
    const servedNames = [...(mcp?.toolIds ?? []), ...(endpoint?.skillIds ?? [])].slice(0, 120);

    /*
      Whether the LIVE endpoint speaks the ERC-8183 negotiation protocol.

      Deliberately not folded into `hireable`, which stays what it has always
      been: an ERC-8183 menu published in the agent's own registration, with a
      provider address the hire panel can actually open an escrow against. An
      agent that negotiates but publishes no menu cannot be hired through this
      site, and promoting it would produce a hire button that leads nowhere —
      the dead end that field exists to prevent.

      It is recorded because the alternative is a false negative. These agents
      publish `negotiate` and `notify_funded` from a live endpoint, sign price
      quotes on request, and the page was calling them "not hireable via
      erc-8183". The metadata says no and the endpoint says yes; that is the
      same shape as the registry-versus-probe gap, and the probe is the half we
      gathered ourselves.

      Costs nothing: these names are already in servedNames from the ordinary
      capability read. No tier depends on it — score.js never sees it — so it
      carries no formula change.
    */
    const erc8183Endpoint = servedNames.includes('negotiate') && servedNames.includes('notify_funded');

    // Everything the agent's own identity file publishes as a capability label.
    //
    // Reading only the MCP tool list made this a protocol test rather than a
    // capability test, twice over: `declaredSkills` was computed above and then
    // never passed in, so an A2A agent's whole catalog was dropped; and a card
    // files its domain in fields a bare tool list does not have — skill tags, a
    // descriptive service name, a Category attribute. A live PancakeSwap grid
    // agent publishing skill `assay_grid` tagged `grid` placed in nothing.
    //
    // Both copies are read: `card` is the identity file as it stands right now,
    // `offchain_content` is the registry's cached parse of it, and they drift.
    const cardCapabilities = [
      ...capabilitiesFromCard(card),
      ...capabilitiesFromCard(detail?.raw_metadata?.offchain_content),
    ];

    // The agent's own ERC-8183 hire menu, found once and reused for both
    // "can this be hired" and "what does it cost".
    const hireEntry = card
      ? (Array.isArray(card.services) ? card.services : []).find(
        (s) => String(s?.name ?? '').toLowerCase() === 'erc8183'
          && /^eip155:56:0x[0-9a-fA-F]{40}$/.test(String(s?.endpoint ?? '')),
      ) ?? null
      : null;

    const verdict = {
      agentId: detail?.agent_id ?? key,
      name: detail?.name ?? null,
      avatarUrl,
      // Whether the agent's own identity file publishes an ERC-8183 hire menu.
      // Read here because the card is already in hand, and persisted so a
      // browse row can offer "hire" only where it is genuinely on offer — a
      // hire button that leads to "not hireable" is a dead end dressed as an
      // action. null when the card could not be read: unknown, not "no".
      // Mirrors the web's findErc8183Service: the entry must be named erc8183
      // AND point at a BNB Chain (eip155:56) provider, or the row would offer a
      // hire the agent page then refuses.
      hireable: card ? Boolean(hireEntry) : null,
      // What the cheapest published offering costs, so the browse row can carry
      // a price. null (never 0) when no offering names one.
      minPriceU: minOfferingPriceU(hireEntry),
      // Categories the agent proved. `served` is what its live endpoint listed
      // when asked just now; `declared` is what its registry metadata claims.
      // Empty is the honest answer for an agent that publishes no capability.
      categories: categoriesFromCapabilities({
        served: servedNames,
        declared: [...declaredTools, ...declaredSkills, ...cardCapabilities],
      }),
      // The capability names its live endpoint actually served, kept so search
      // can match what an agent DEMONSTRABLY does rather than what its registry
      // text claims. Absent means not-yet-rechecked, never "serves nothing".
      servedNames,
      erc8183Endpoint,
      bap578,
      ...computeVerdict({
        endpoint, mcp, wallet, bazaar, registry, declaredTools, declaredSkills, subject,
      }),
    };
    // A verdict is cacheable only after its durable evidence write succeeds.
    // Otherwise a disk-full/retention error would return cached success on the
    // next request while no restart could reproduce that claim.
    persistVerdict(store, verdictCache, key, verdict);
    return { verdict, cached: false };
  }

  return async function verify(chainId, tokenId, onEvent = null) {
    const key = `${chainId}:${tokenId}`;
    const cached = verdictCache.get(key);
    if (cached) return { verdict: cached, cached: true };

    let entry = inFlight.get(key);
    if (entry) {
      if (entry.waiters >= maxWaitersPerAgent) {
        throw new WorkCapacityError('verification observers', maxWaitersPerAgent);
      }
      entry.waiters += 1;
      if (typeof onEvent === 'function') entry.listeners.add(onEvent);
      try {
        return await entry.promise;
      } finally {
        entry.waiters -= 1;
        if (typeof onEvent === 'function') entry.listeners.delete(onEvent);
      }
    }

    const listeners = new Set(typeof onEvent === 'function' ? [onEvent] : []);
    const emit = (event) => {
      for (const listener of listeners) {
        try { listener(event); } catch { /* observer error is not our failure */ }
      }
    };
    entry = { listeners, waiters: 1, promise: null };
    entry.promise = admission.run(() => verifyOne(chainId, tokenId, emit));
    inFlight.set(key, entry);
    try {
      return await entry.promise;
    } finally {
      if (inFlight.get(key) === entry) inFlight.delete(key);
      listeners.clear();
    }
  };
}
