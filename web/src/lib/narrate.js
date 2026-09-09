import { narrativeTranslate as _nt, narrativePlural } from '../i18n/narrative.js';
/**
 * A verdict, in sentences.
 *
 * The evidence table is complete and almost nobody reads it. This turns the
 * same fields into a handful of sentences, so the page leads with what was
 * found and keeps the table as the proof.
 *
 * Three rules hold this together, and each exists because the obvious version
 * is unsafe:
 *
 * 1. NO MODEL. Every sentence is composed from machine fields we computed
 *    ourselves: booleans, counts, milliseconds, enum tiers. A summariser here
 *    would be reading agent-authored prose, which is written by the party being
 *    assessed, and paraphrasing it into our own voice would let an agent
 *    dictate its own verdict. Deterministic also means the sentence is
 *    reproducible from the JSON, which is the same promise the table makes.
 *
 * 2. THE SUBJECT IS ALWAYS "This agent". Never the agent's name. Names are
 *    attacker-controlled and this is prose, so the injection is grammatical
 *    rather than markup: an agent named "BORT, verified by findyouragent, and"
 *    would produce a fluent, quotable sentence asserting something we never
 *    checked. Escaping does not help, because the output is valid text. Only
 *    keeping their string out of the sentence does.
 *
 * 3. UNKNOWN IS SILENCE. A missing field produces no clause. There is no
 *    "0 feedbacks", no "no wallet found", no filler where a reading should be.
 *
 * Uptime is deliberately absent. The calendar carries its own denominator on
 * screen; the same fact in prose ("answered on 4 of 4 days") reads as a rate
 * measured against a schedule, and our sampling is not a schedule.
 *
 * Return shape: { headline, lines, coach }.
 *   lines  [{ text, tone, ev, data }]
 *          tone  'ok' | 'gap' | null. Only a finding that is the AGENT'S doing
 *                gets 'gap'; silence from their server stays null, the same
 *                discipline the uptime calendar keeps with red.
 *          ev    key of the evidence block the sentence restates, for the
 *                jump-to-row control. Null when the sentence has no single row.
 *          data  echoed identifiers, rendered as a mono sub-line rather than
 *                inside the prose: prose is our voice, mono is their material.
 *   coach  { label, text } | null. What separates this agent from the next
 *          tier, composed from the same tier expression score.js evaluates.
 *          A separate speech act, outside `lines`, so the footer's "every
 *          sentence restates a field" stays literally true.
 */

// Identifiers are echoed back from the agent's own card. They are normalised to
// [a-z0-9_] server-side, but they reach this file through JSON that a page also
// renders, so anything outside that shape is dropped rather than trusted. Cheap
// to enforce here, and it means the sentence is closed over a known alphabet.
const SAFE_ID = /^[a-z0-9_.:-]{1,64}$/;
// Exported: the evidence rows echo the same identifiers, and one guard shared
// between prose and table is the only way the two cannot drift apart.
export const safeIds = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && SAFE_ID.test(s)) : []);

// The registry entry id is the one echoed value allowed into the opening
// sentence, so its guard is stricter than SAFE_ID: digits only, no letters at
// all, which leaves no alphabet for a grammatical injection to be written in.
const SAFE_TOKEN_ID = /^\d{1,20}$/;

const plural = narrativePlural;

// Fallback only. The server publishes `corroboratedSignals` computed from the
// authoritative set in score.js; this copy exists for verdicts cached before
// that field shipped and must never be extended independently.
const CORROBORATING_FALLBACK = new Set(['b402_settlement', 'registry_feedback', 'capability_integrity']);

// Our words for the judged categories, keyed by the enum in categorize.js.
// A fixed dictionary, so no card text can reach the sentence through it.
const CATEGORY_PHRASE = {
  rebalancing: 'liquidity rebalancing',
  grid: 'grid trading',
  yield: 'yield strategies',
  health: 'lending health-factor monitoring',
};

// The signals that actually carry a tier, from the server's own list when the
// verdict is fresh enough to have one. One derivation, used by the narrative,
// the coach and the banner sentence, so the three can never disagree.
function corroboratedOf(verdict) {
  if (Array.isArray(verdict?.corroboratedSignals)) return verdict.corroboratedSignals;
  return (verdict?.proofs ?? [])
    .map((p) => p?.signal)
    .filter((sig) => CORROBORATING_FALLBACK.has(sig));
}

const bnb = (wei) => {
  try {
    const v = Number(BigInt(wei)) / 1e18;
    // Dust is not zero. "holding 0.0000 BNB" asserts an empty wallet the
    // chain read contradicts; the floor states exactly what we know.
    if (v > 0 && v < 0.0001) return '<0.0001 BNB';
    return `${v.toFixed(4)} BNB`;
  } catch {
    return null;
  }
};

/**
 * @param {object} verdict  a verdict as returned by /api/verify
 * @param {string} [tokenId]  the registry entry id from the route, digits only
 * @returns {{headline: string, lines: Array<{text: string, tone: string|null, ev: string|null, data: string|null}>, coach: {label: string, text: string}|null}}
 */
export function narrate(verdict, tokenId) {
  if (!verdict) return { headline: '', lines: [], coach: null };

  const ev = verdict.evidence ?? {};
  const lines = [];
  const push = (text, opts = {}) => lines.push({ text, tone: opts.tone ?? null, ev: opts.ev ?? null, data: opts.data ?? null });

  const signals = (verdict.proofs ?? []).map((p) => p?.signal).filter(Boolean);
  const corroborated = corroboratedOf(verdict);

  // The entry id restates the registry row the page already links. It came off
  // the route, not the card, and the digit-only guard drops anything else.
  const entry = typeof tokenId === 'string' && SAFE_TOKEN_ID.test(tokenId) ? _nt(" as entry #{p0}", { p0: tokenId }) : '';

  // ── 1+2. What it is, and whether its endpoint answered ────────────────────
  // The endpoint clause is built once and used two ways: standalone on BAP-578
  // pages, folded into the opening sentence otherwise, so the always-present
  // registration sentence carries a finding instead of a category.
  const endpoint = endpointClause(verdict, ev);
  const bap = verdict.bap578;
  // Attribution is tri-state: true (registrar confirms), false (registrar says
  // otherwise), null (we could not check). Only `true` may carry the on-chain
  // claims; only `false` may be stated as a finding about the agent.
  const attributed = bap && !bap.unsupported && bap.ownershipVerified === true;
  const attributionUnknown = bap && !bap.unsupported && bap.ownershipVerified == null;

  if (attributed) {
    push(_nt("This agent is registered on ERC-8004{p0} and its card names a BAP-578 token, a programmable NFT with a logic contract behind it.", { p0: entry }), { ev: 'bap578' });
    push(`${endpoint.text[0].toUpperCase()}${endpoint.text.slice(1)}.`, { tone: endpoint.tone, ev: endpoint.ev });
  } else if (bap && bap.ownershipVerified === false) {
    // A registrar answer makes this a finding about the claim.
    push(_nt("This agent is registered on ERC-8004{p0} and claims a BAP-578 token, but no on-chain record ties that token to this registration, so nothing under it is shown here.", { p0: entry }), { tone: 'gap', ev: 'bap578' });
  } else if (attributionUnknown) {
    // Our failure, not theirs: no tone, and no claim about their token.
    push(_nt("This agent is registered on ERC-8004{p0} and claims a BAP-578 token. We could not check the on-chain record that would tie that token to this registration, so nothing under it is shown here.", { p0: entry }), { ev: 'bap578' });
    push(`${endpoint.text[0].toUpperCase()}${endpoint.text.slice(1)}.`, { tone: endpoint.tone, ev: endpoint.ev });
  } else if (bap?.unsupported) {
    push(_nt("This agent is registered on ERC-8004{p0} and claims a BAP-578 token on a collection that does not implement the standard.", { p0: entry }), { tone: 'gap', ev: 'bap578' });
    push(`${endpoint.text[0].toUpperCase()}${endpoint.text.slice(1)}.`, { tone: endpoint.tone, ev: endpoint.ev });
  } else {
    push(_nt("This agent is registered on ERC-8004{p0}, and {p1}.", { p0: entry, p1: endpoint.text }), { tone: endpoint.tone, ev: endpoint.ev });
  }

  // ── 3. Whether the card that answered is about this agent ─────────────────
  // Only worth a sentence when something answered; otherwise there was no card
  // to judge. Placed before any claim about what "it" serves, so on a shared
  // endpoint the caveat arrives before the capabilities it qualifies.
  if (verdict.endpointProven && verdict.subject) {
    // Anchored to the a2a block whatever proved the endpoint: the subject is
    // only ever computed from the A2A card, and when both protocols answer
    // the endpoint kind is mcp while the describes-this-agent row still
    // renders in the a2a section.
    if (verdict.subject.verified) {
      push(_nt("The card it served describes this agent specifically, not a shared service."), { tone: 'ok', ev: 'a2a' });
    } else {
      push(_nt("The card it served could not be shown to describe this agent rather than a shared service, so its liveness may belong to something else."), { tone: 'gap', ev: 'a2a' });
    }
  }

  // ── 4. What it does, from served-basis placements only ────────────────────
  // Declared- and text-basis placements are the agent's own claim or a word
  // match. A sentence strong enough to answer "what does this agent do" rides
  // only on what the live endpoint listed when asked. Silence otherwise.
  const servedCats = (verdict.categories ?? [])
    .filter((c) => c?.basis === 'served')
    .map((c) => _nt(CATEGORY_PHRASE[c.category]))
    .filter(Boolean);
  const noun = verdict.capability?.kind === 'mcp' || ev.mcp?.servesTools ? 'tools' : 'skills';
  if (servedCats.length > 0) {
    // The declared-vs-served section only renders when a capability
    // comparison exists; a served list with an empty declaration has no such
    // section, so the jump falls back to the probe that produced the list.
    push(_nt("The {p0} it serves place it under {p1}.", { p0: noun, p1: servedCats.join(_nt(" and ")) }), { ev: verdict.capability ? 'capability' : endpoint.ev });
  }

  // ── 5. Promises kept ──────────────────────────────────────────────────────
  // Keep the narrative separate from echoed capability identifiers and report
  // any omitted identifiers in the data line.
  const cap = verdict.capability;
  if (cap && cap.declared > 0) {
    const capNoun = cap.kind === 'mcp' ? 'tools' : 'skills';
    if (cap.matched === cap.declared) {
      push(_nt("It serves all {p0} it advertises.", { p0: plural(cap.declared, capNoun.slice(0, -1), capNoun) }), { tone: 'ok', ev: 'capability' });
    } else {
      const K = cap.declared - cap.matched;
      const shown = safeIds(cap.missing).slice(0, 6);
      const tail = K - shown.length;
      const data = shown.length
        ? _nt("missing {p0}: {p1}{p2}", { p0: K, p1: shown.join(', '), p2: tail > 0 ? _nt(", +{p0} more", { p0: tail }) : '' })
        : _nt("missing {p0}", { p0: K });
      push(
        cap.matched === 0
          ? _nt("It advertises {p0} and serves none of them.", { p0: plural(cap.declared, capNoun.slice(0, -1), capNoun) })
          : _nt("It advertises {p0} and serves {p1} of them.", { p0: plural(cap.declared, capNoun.slice(0, -1), capNoun), p1: cap.matched }),
        { tone: 'gap', ev: 'capability', data },
      );
    }
    // Report served capabilities that are absent from the registry record.
    const extras = (cap.servedCount ?? 0) - cap.matched;
    if (extras > 0 && Array.isArray(cap.extra) && cap.extra.length > 0) {
      push(_nt("It also serves {p0} it never advertised, so its registry record understates it.", { p0: plural(extras, capNoun.slice(0, -1), capNoun) }), { ev: 'capability' });
    }
  }

  // ── 6. What corroborates it ───────────────────────────────────────────────
  // Counted or named from our own enum; no agent text can ride in.
  if (signals.includes('registry_feedback') && typeof ev.registry?.feedbackCount === 'number') {
    push(_nt("It carries {p0} on the registry.", { p0: plural(ev.registry.feedbackCount, _nt("on-chain feedback"), _nt("on-chain feedbacks")) }), { tone: 'ok', ev: 'registry' });
  }
  if (signals.includes('b402_settlement')) {
    push(_nt("It has settled at least one paid call on B402."), { tone: 'ok', ev: 'b402' });
  }

  // ── 7. Fragility, for the top tier held by a single proof ─────────────────
  // The owner's "what must I not break". Only capability_integrity carries the
  // demotion conditional: it is the one revocable proof, and the prediction is
  // conditioned on the rest of the verdict holding, so it restates the tier
  // expression rather than guessing a future check.
  if (verdict.tier === 'verified_live' && corroborated.length === 1) {
    if (corroborated[0] === 'capability_integrity') {
      push(_nt("Serving everything it advertises is the one proof carrying this tier: with the rest of this verdict unchanged, breaking that match lands the next check at active."), { ev: 'capability' });
    } else if (corroborated[0] === 'b402_settlement') {
      push(_nt("The B402 settlement record is the one proof carrying this tier."), { ev: 'b402' });
    } else if (corroborated[0] === 'registry_feedback') {
      push(_nt("The on-chain feedback is the one proof carrying this tier."), { ev: 'registry' });
    }
  }

  // ── 8. The sale caveat, last and unconditional for anything sellable ──────
  // Explain the on-chain records that transfer with the token and their read time.
  if (attributed) {
    const t = bap.transferable;
    let carried = '';
    if (t?.tba) {
      const amount = t.tbaBalanceWei != null ? bnb(t.tbaBalanceWei) : null;
      carried = amount
        ? _nt(", including its ERC-6551 wallet holding {p0} at our last read", { p0: amount })
        : _nt(", including its ERC-6551 wallet");
    }
    push(_nt("If it is sold, the on-chain balance and history follow the token{p0}. The model credentials, prompt and triggers do not; the buyer must set them up again before it runs.", { p0: carried }), { ev: 'bap578' });
  }

  return { headline: headlineFor(verdict, corroborated), lines, coach: coach(verdict, ev, corroborated) };
}

// Describe endpoint outcomes in a lowercase clause for the surrounding sentence.
function endpointClause(verdict, ev) {
  const kind = verdict.endpointKind;
  if (verdict.endpointProven) {
    const probe = kind === 'mcp' ? ev.mcp : ev.endpoint;
    const label = kind === 'mcp' ? _nt("MCP endpoint") : _nt("A2A endpoint");
    // One inline apposition on the sentence every later sentence leans on: the
    // opening line is the single place the page cannot afford a hover-gated
    // definition. Every other use of the term relies on the tooltip layer.
    const gloss = kind === 'mcp'
      ? _nt("the address where software can list and call its tools")
      : _nt("the web address it publishes for receiving requests");
    const ms = typeof probe?.latencyMs === 'number' ? _nt(" in {p0} ms", { p0: probe.latencyMs }) : '';
    return { text: _nt("its declared {p0}, {p1}, answered our last check{p2}", { p0: label, p1: gloss, p2: ms }), tone: 'ok', ev: kind === 'mcp' ? 'mcp' : 'a2a' };
  }
  // Reachable but empty-handed. This IS the agent's doing, so it carries a
  // tone, unlike silence, which cannot be told apart from our own network.
  if (ev.endpoint?.declared && ev.endpoint?.reachable && !ev.endpoint?.hasAgentCard) {
    return { text: _nt("its declared A2A endpoint replied, but what it served was not an agent card, so the reply proves reachability and nothing more"), tone: 'gap', ev: 'a2a' };
  }
  if (ev.mcp?.declared && ev.mcp?.reachable && !ev.mcp?.servesTools) {
    return { text: _nt("its declared MCP endpoint replied, but listed no tools, so the reply proves reachability and nothing more"), tone: 'gap', ev: 'mcp' };
  }
  // A 404 or 500 is a completed round trip: their server produced an answer,
  // which is exactly how the uptime calendar classifies the same check (a
  // reply that served nothing, their doing). Narrating it as "no reply"
  // inverted a status code and a latency the verdict holds.
  const httpError = (probe) => probe?.declared && !probe?.reachable && probe?.reason === 'http-error';
  if (httpError(ev.endpoint) || httpError(ev.mcp)) {
    const isA2a = httpError(ev.endpoint);
    const probe = isA2a ? ev.endpoint : ev.mcp;
    const status = typeof probe.status === 'number' ? _nt(" (status {p0})", { p0: probe.status }) : '';
    return {
      text: _nt("its declared {p0} endpoint answered our check with an HTTP error{p1}: something is listening, but it served no {p2}", { p0: isA2a ? 'A2A' : 'MCP', p1: status, p2: isA2a ? _nt("agent card") : _nt("tool list") }),
      tone: 'gap',
      ev: isA2a ? 'a2a' : 'mcp',
    };
  }
  // A url that does not parse was the agent's own declaration; no call was
  // ever attempted, so neither "answered" nor "no reply" is true of it.
  const badUrl = (probe) => probe?.declared && probe?.reason === 'invalid-url';
  if (badUrl(ev.endpoint) || badUrl(ev.mcp)) {
    return {
      text: _nt("the endpoint url it declares is not a valid url, so the call could not even be attempted"),
      tone: 'gap',
      ev: badUrl(ev.endpoint) ? 'a2a' : 'mcp',
    };
  }
  if (ev.endpoint?.declared || ev.mcp?.declared) {
    // Never "the agent is down". One vantage point cannot separate their
    // outage from our egress, our DNS, or our own timeout.
    return { text: _nt("it declares an endpoint, but we did not get a reply from it on our last check"), tone: null, ev: ev.mcp?.declared && !ev.endpoint?.declared ? 'mcp' : 'a2a' };
  }
  return { text: _nt("it declares no callable endpoint, so there is nothing here to reach"), tone: null, ev: 'probe' };
}

// Name the tier using only the fields that the headline restates.
function headlineFor(verdict, corroborated) {
  switch (verdict.tier) {
    case 'verified_live': {
      if (corroborated.length >= 2) {
        // Denominated in the banner's own number: the banner counts ALL
        // proofs, corroboration is the subset that carries the tier, and two
        // different counts of "proofs" one line apart read as a contradiction.
        const total = verdict.proofs?.length ?? corroborated.length;
        return _nt("Answers, and {p0} of its {p1} activity proofs corroborate the endpoint itself.", { p0: corroborated.length, p1: total });
      }
      const one = corroborated[0];
      if (one === 'capability_integrity') {
        const noun = verdict.capability?.kind === 'mcp' ? 'tool' : 'skill';
        return _nt("Answered, and listed every {p0} its registry record advertises.", { p0: noun });
      }
      if (one === 'b402_settlement') return _nt("Answers, and has settled at least one paid call on B402.");
      if (one === 'registry_feedback') return _nt("Answers, and carries on-chain feedback on the registry.");
      // Unreachable under the current formula, kept so a malformed verdict
      // degrades to something true rather than something specific.
      return _nt("Answered, with supporting evidence recorded.");
    }
    case 'active':
      if (!verdict.endpointProven) return _nt("Real activity on record, but nothing callable answered.");
      return (verdict.proofs?.length ?? 0) > 0
        ? _nt("Answers, and has real activity on record. Not everything we look for could be proven.")
        : _nt("Answers, but none of the supporting evidence we look for could be proven yet.");
    default:
      // A registered verdict can hold a wallet_activity proof (an active
      // wallet behind an agent with no endpoint stays registered), and the
      // banner counts it. "Nothing beyond that could be proven" would deny a
      // field shown two lines above.
      return (verdict.proofs?.length ?? 0) > 0
        ? _nt("An identity exists and the wallet behind it shows activity, but nothing about the agent itself could be proven.")
        : _nt("An identity exists. Nothing beyond that could be proven.");
  }
}

/**
 * What separates this agent from the next tier, from the same expression
 * score.js evaluates: verified_live = endpointProven AND one corroborating
 * signal AND the subject check not failed.
 *
 * Two deliberate silences. wallet_activity is never coached: it describes an
 * address rather than the agent, and coaching it coaches transaction-padding.
 * And a remedy is only listed when the field behind it was actually read: a
 * null feedback count or an unchecked B402 lookup produces no remedy, because
 * "go earn feedback" on the strength of a failed lookup is advice built on an
 * unknown.
 */
// The advice is operator-work (serve a file, answer on an address), so the
// addressee is the operator: whoever runs it, which on a platform-registered
// agent is not necessarily the wallet that owns it.
const COACH_LIVE = "for this agent's operator · to reach live";
const COACH_ACTIVE = "for this agent's operator · to reach active";

function coach(verdict, ev, corroborated) {
  if (!verdict.tier || verdict.tier === 'verified_live') return null;

  if (verdict.tier === 'registered') {
    const declares = Boolean(ev.endpoint?.declared || ev.mcp?.declared);
    return {
      label: _nt(COACH_ACTIVE),
      text: declares
        ? _nt("Its declared endpoint must answer: an A2A endpoint with an agent card, or an MCP endpoint with a tool list. The moment it does, the next check promotes it.")
        : _nt("This registration declares no callable endpoint. Declaring one (A2A or MCP) in its registry metadata, and answering on it, is what moves the verdict."),
    };
  }

  // tier === 'active'. Three distinct distances, matching the three ways the
  // top-tier expression can fail.
  const subjectBlocked = verdict.subject?.verified === false;

  if (!verdict.endpointProven) {
    const declares = Boolean(ev.endpoint?.declared || ev.mcp?.declared);
    // Corroboration already on record means the endpoint answering is the
    // whole remaining distance; asking for a signal the verdict already
    // holds would state a distance longer than the tier expression measures.
    if (corroborated.length > 0) {
      return {
        label: _nt(COACH_LIVE),
        text: declares
          ? _nt("Corroboration is already on record. Its declared endpoint answering with an agent card or a tool list is the whole remaining distance.")
          : _nt("Corroboration is already on record, but it declares no callable endpoint. Declaring one and answering on it is the whole remaining distance."),
      };
    }
    return {
      label: _nt(COACH_LIVE),
      text: declares
        ? _nt("Its declared endpoint must answer with an agent card or a tool list, with one qualifying supporting signal.")
        : _nt("It has activity on record but declares no callable endpoint. Declaring one, answering on it, and one corroborating signal is the whole distance."),
    };
  }

  if (corroborated.length > 0 && subjectBlocked) {
    // Corroboration exists; only identity blocks the tier.
    return {
      label: _nt(COACH_LIVE),
      text: _nt("One thing separates this agent from the top tier: a card that provably describes it. Serving the card from a url whose path contains its registry entry number as a whole segment settles it; with the rest of this verdict unchanged, the next check promotes it."),
    };
  }

  // No corroborating proof. List every route the formula accepts whose
  // precondition we actually read.
  const remedies = [];
  const cap = verdict.capability;
  const capNoun = cap?.kind === 'mcp' ? 'tools' : 'skills';
  if (cap && cap.declared > 0 && cap.declared < 3) {
    // The floor gates EVERY capability route, not just the trim. Serving all
    // the missing items of a 2-item declaration lands matched at 2, under
    // the formula's floor of three, and the promised promotion would never
    // come: a false promise from the one block whose job is true distances.
    remedies.push(_nt("advertising and serving at least 3 {p0}: the {p1} it declares {p2} under the formula's floor of three", { p0: capNoun, p1: plural(cap.declared, 'item', 'items'), p2: cap.declared === 1 ? 'sits' : 'sit' }));
  } else if (cap && cap.matched < cap.declared) {
    const K = cap.declared - cap.matched;
    // The trim route only works above the floor; below it, republishing a
    // smaller card cannot earn the proof, but serving the missing items can,
    // because that lands matched at declared, which is 3 or more here.
    remedies.push(cap.matched >= 3
      ? _nt("serving the {p0} {p1} its card advertises but its endpoint does not, or republishing the card without them", { p0: K, p1: capNoun })
      : _nt("serving the {p0} {p1} its card advertises but its endpoint does not", { p0: K, p1: capNoun }));
  } else if (!cap) {
    remedies.push(_nt("advertising the capabilities it serves in its registry metadata, so the served list has something to be checked against"));
  }
  if (ev.registry?.feedbackCount === 0) remedies.push(_nt("one on-chain feedback on the registry"));
  if (ev.bazaar?.checked && !ev.bazaar?.listed) remedies.push(_nt("one settled paid call on B402"));

  if (remedies.length === 0) return null;

  const opening = subjectBlocked
    ? _nt("Two things separate this agent from the top tier: a card that provably describes it (served from a url whose path contains its registry entry number as a whole segment), and one qualifying supporting signal. The formula accepts any of: ")
    : _nt("One proof separates this agent from the top tier. The formula accepts any of: ");
  const closing = subjectBlocked
    ? _nt(" Both together, with the rest of this verdict unchanged, and the next check promotes it.")
    : _nt(" Any one of these, with the rest of this verdict unchanged, and the next check promotes it.");

  return { label: _nt(COACH_LIVE), text: `${opening}${remedies.join(_nt('; '))}${_nt('.')}${closing}` };
}

/**
 * The banner's one-line reason, per tier branch, composed here beside
 * headlineFor so the two most-read surfaces on the page can never drift.
 *
 * This replaces a static "endpoint answered" that rendered unqualified even
 * when the subject check had failed: the page's strongest-reading surface was
 * its weakest-attributed claim.
 */
export function bannerWhy(verdict) {
  if (!verdict?.tier) return '';
  const proofs = verdict.proofs?.length ?? 0;
  const corroborated = corroboratedOf(verdict);
  const subjectFailed = verdict.subject?.verified === false;

  if (verdict.tier === 'verified_live') {
    return _nt("it answered at check time, with at least one qualifying supporting signal");
  }
  if (verdict.tier === 'active') {
    if (!verdict.endpointProven) return _nt("activity is on record, but nothing callable answered");
    if (subjectFailed && corroborated.length > 0) {
      return _nt("something answered with supporting evidence, but it could not be confirmed as this agent");
    }
    if (subjectFailed) {
      return _nt("something answered, but it could not be confirmed as this agent, and no supporting signal was recorded");
    }
    return proofs > 0
      ? _nt("it answered, and activity is on record, but none of it corroborates the endpoint itself yet")
      : _nt("it answered; no supporting signal was recorded");
  }
  return proofs > 0
    ? _nt("the wallet behind it shows activity; the agent itself proved nothing")
    : _nt("registered; nothing beyond that could be proven");
}

/**
 * The reader's questions, answered in plain words from the same fields.
 *
 * This block exists so a reader who knows none of the protocol vocabulary
 * still leaves with the verdict; the narrative below it stays the precise
 * layer. Same composer rules as everything else in this file: deterministic,
 * no agent text, unknowns produce silence, and every plain phrasing is
 * exactly as strong as the field it restates. The hard cases are pinned by
 * tests: "offered", never "delivers", because the comparison is a name-set
 * intersection, not a fulfillment check; "as itself" only on a passed subject
 * check; no price claim either way, because the panel measures none.
 *
 * Each row carries `ev`, an array parallel to `a`: the evidence anchor each
 * sentence restates, or null where a sentence restates nothing (the framing
 * lines). Parallel arrays rather than an array of objects on purpose — the
 * strength sweep and every pinned assertion in plain.test.mjs read `r.a` as
 * strings, and the guardrail tests are not worth reshaping for a field the
 * renderer alone consumes.
 *
 * @returns {Array<{q: string, a: string[], ev: Array<string|null>}>}
 */
export function plainAnswers(verdict, tokenId, flags = {}) {
  if (!verdict) return [];
  const ev = verdict.evidence ?? {};
  const rows = [];

  // Q1 · real?
  // "Its registration is." answers a question the reader has to hold in their
  // head to parse. The full clause costs three words and needs no reassembly.
  const entry = typeof tokenId === 'string' && SAFE_TOKEN_ID.test(tokenId)
    ? _nt("Entry #{p0} exists in a public on-chain registry, and anyone can look it up.", { p0: tokenId })
    : _nt("Its entry exists in a public on-chain registry, and anyone can look it up.");
  rows.push({
    q: _nt("is this real?"),
    a: [_nt("The registration is real. {p0} Registration proves existence, not quality; the questions below cover the rest.", { p0: entry })],
    ev: ['registry'],
  });

  // Q2 · does it work right now?
  const kind = verdict.endpointKind;
  const probe = kind === 'mcp' ? ev.mcp : ev.endpoint;
  const inMs = typeof probe?.latencyMs === 'number' ? _nt(" in {p0} ms", { p0: probe.latencyMs }) : '';
  const declared = Boolean(ev.endpoint?.declared || ev.mcp?.declared);
  let works;
  /* Describe the published address and the result of the latest probe. */
  if (verdict.endpointProven && verdict.subject?.verified === true) {
    works = _nt("Yes, on our last check. The web address it publishes replied{p0}, and the reply could be tied to this agent specifically, not to a shared service.", { p0: inMs });
  } else if (verdict.endpointProven && verdict.subject?.verified === false) {
    works = _nt("Something answered, but we could not confirm it was this agent. On our last check the web address it lists replied{p0}. Nothing in that reply tied it to this agent rather than to a shared service.", { p0: inMs });
  } else if (verdict.endpointProven) {
    works = _nt("Yes, on our last check. The web address it publishes replied{p0} and {p1}", { p0: inMs, p1: kind === 'mcp' ? _nt("listed the tools it offers.") : _nt("returned a valid identity file.") });
  } else if (ev.endpoint?.declared && ev.endpoint?.reachable && !ev.endpoint?.hasAgentCard) {
    works = _nt("Can't say. Its web address replied, but not with the identity file a working agent returns. That proves the address is reachable, and nothing more.");
  } else if (ev.mcp?.declared && ev.mcp?.reachable && !ev.mcp?.servesTools) {
    works = _nt("Can't say. Its tool interface replied, but no tool list came back. That proves it is reachable, and nothing more.");
  } else if ((ev.endpoint?.declared && ev.endpoint?.reason === 'http-error') || (ev.mcp?.declared && ev.mcp?.reason === 'http-error')) {
    const errProbe = ev.endpoint?.reason === 'http-error' ? ev.endpoint : ev.mcp;
    const status = typeof errProbe?.status === 'number' ? _nt(" (status {p0})", { p0: errProbe.status }) : '';
    works = _nt("Can't say. Its web address answered our check with an error{p0}. Something is listening there, but it gave us nothing usable.", { p0: status });
  } else if ((ev.endpoint?.declared && ev.endpoint?.reason === 'invalid-url') || (ev.mcp?.declared && ev.mcp?.reason === 'invalid-url')) {
    works = _nt("We could not check. The address it publishes is not a valid web address, so there was nothing to call.");
  } else if (declared) {
    works = _nt("Unknown. We got no reply from the web address it lists on our last check. We check from one place, so we cannot tell a problem on their side from a problem on ours. That counts as no evidence either way.");
  } else {
    works = _nt("There is nothing to check: it publishes no address to call.");
  }
  const worksLines = [works];
  const worksEv = [verdict.endpointProven && kind === 'mcp' ? 'mcp' : declared ? 'probe' : 'probe'];

  /* Include the observed multi-day response summary when available. */
  const up = flags.uptime?.summary;
  if (up && up.checkedDays >= 2) {
    worksLines.push(_nt("It answered on {p0} of the {p1} days we checked.", { p0: up.answered, p1: up.checkedDays }));
    worksEv.push('uptime');
  }

/* Summarize an explicit registry/probe disagreement only when both readings exist. */
  const reg = ev.registry;
  if (reg?.isEndpointVerified === false && verdict.endpointProven) {
    worksLines.push(_nt("The public directory still lists that address as unverified. The reply above is our own call."));
    worksEv.push('registry');
  }
  rows.push({ q: _nt("does it work right now?"), a: worksLines, ev: worksEv });

  // Q3 · does it do what it claims? Only when the comparison exists.
  const cap = verdict.capability;
  if (cap && cap.declared > 0) {
    const noun = cap.kind === 'mcp' ? 'tools' : 'skills';
/* Keep the capability explanation explicit about who performed the check. */
    const claims = [];
    const claimsEv = [];
    if (cap.matched === cap.declared) {
      claims.push(_nt("Yes, on the one claim we can test. Its listing advertises {p0}. We asked it directly, and it offered all {p1}.", { p0: plural(cap.declared, noun.slice(0, -1), noun), p1: cap.declared }));
    } else if (cap.matched === 0) {
      claims.push(_nt("No. Its listing advertises {p0}. We asked it directly, and it offered none of the {p1}.", { p0: plural(cap.declared, noun.slice(0, -1), noun), p1: cap.declared }));
    } else {
      claims.push(_nt("Partly. Its listing advertises {p0}. We asked it directly, and it offered {p1} of the {p2}.", { p0: plural(cap.declared, noun.slice(0, -1), noun), p1: cap.matched, p2: cap.declared }));
    }
    claimsEv.push('capability');
    const extras = (cap.servedCount ?? 0) - cap.matched;
    if (extras > 0 && Array.isArray(cap.extra) && cap.extra.length > 0) {
      // Name the unit so the additional count is unambiguous.
      claims.push(_nt("It also offered {p0} {p1} that are not in its listing.", { p0: extras, p1: extras === 1 ? noun.slice(0, -1) : noun }));
      claimsEv.push('capability');
    }

/* A successful sample call is reported separately from capability-name comparison. */
    const ex = ev.mcp?.tryExample;
    if (ex && ex.ok === true) {
      const took = typeof ex.latencyMs === 'number' ? _nt(" in {p0} ms", { p0: ex.latencyMs }) : '';
      claims.push(ex.usesSample === true
        ? _nt("We also called one of them ourselves, with a public sample address as input, and it returned a result{p0}.", { p0: took })
        : _nt("We also called one of them ourselves, and it returned a result{p0}.", { p0: took }));
      claimsEv.push('mcp');
    }
    rows.push({ q: _nt("does it do what it claims?"), a: claims, ev: claimsEv });
  }

  // Q4 · can I try it? Gated on the same boolean that renders the try panel,
  // so this answer and the panel's existence cannot disagree.
/* Keep the payment warning visible whenever a try action is offered. */
  let tryIt;
  if (verdict.endpointProven && verdict.subject?.verified === false) {
    tryIt = _nt("Yes, with a caveat. The try panel sends a real request to the web address it publishes, but whatever answers could not be confirmed to be this agent. Some agents charge per call; if this one does, the panel asks before anything is paid.");
  } else if (verdict.endpointProven) {
    tryIt = _nt("Yes, from this page. The try panel sends a real request to the web address it publishes and shows you the reply. Some agents charge per call; if this one does, the panel asks before anything is paid.");
  } else if (!declared) {
    tryIt = _nt("No. It publishes no address to call.");
  } else {
    tryIt = _nt("Not from this page. Our check got nothing usable back from the address it lists, so there is no try panel.");
  }
  rows.push({ q: _nt("can I try it?"), a: [tryIt], ev: [verdict.endpointProven ? null : 'probe'] });

  // Q5 · safe to pay or buy? Facts labeled, never scored; a null read
  // produces no clause; positives first.
/* Group positive and negative facts under one clear lead-in. */
  const safety = [_nt("That is your call, not this page's: it proves facts, it does not endorse.")];
  const safetyEv = [null];
  const favour = [];
  const against = [];
  const favourEv = [];
  const againstEv = [];
  if (ev.bazaar?.listed) {
    // "settled" is a payments term; the record's own word is "completed".
    favour.push(_nt("at least 1 payment to it has completed, on a public record that lists only completed payments"));
    favourEv.push('b402');
  }
  if (typeof ev.registry?.feedbackCount === 'number' && ev.registry.feedbackCount > 0) {
    // "1 feedback" is not English; the entry is the countable thing.
    favour.push(_nt("{p0} on the public registry", { p0: plural(ev.registry.feedbackCount, _nt("feedback entry"), _nt("feedback entries")) }));
    favourEv.push('registry');
  }
/* Keep capability evidence concise and avoid repeating the earlier explanation. */
  if (cap && cap.declared > 0 && cap.matched === cap.declared) {
    favour.push(_nt("all {p0} advertised {p1} offered when asked", { p0: cap.declared, p1: cap.kind === 'mcp' ? 'tools' : 'skills' }));
    favourEv.push('capability');
  }
  if (verdict.subject?.verified === false) {
    against.push(_nt("what answered our check could not be confirmed to be this agent"));
    againstEv.push('probe');
  }
  if (cap && cap.declared > 0 && cap.matched < cap.declared) {
    const noun = cap.kind === 'mcp' ? 'tools' : 'skills';
    against.push(_nt("{p0} of its {p1} advertised {p2} offered when asked", { p0: cap.matched, p1: cap.declared, p2: noun }));
    againstEv.push('capability');
  }
  const bap = verdict.bap578;
  // Only a registrar answer of `false` is stated against them. An unchecked
  // attribution (null) says nothing here: we did not learn anything, and an
  // unknown is not evidence against a third party.
  if (bap && !bap.unsupported && bap.ownershipVerified === false) {
    against.push(_nt("it advertises an on-chain token, but no public record ties that token to this registration"));
    againstEv.push('bap578');
  }
  // Semicolons rather than "and": these are separate readings that happen to
  // point the same way, not one finding with a conjunction. The anchor is the
  // first item's, since a grouped line can only jump to one row.
  if (favour.length) { safety.push(_nt("In its favour: {p0}.", { p0: favour.join('; ') })); safetyEv.push(favourEv[0]); }
  if (against.length) { safety.push(_nt("Against it, for now: {p0}.", { p0: against.join('; ') })); safetyEv.push(againstEv[0]); }
  if (bap && !bap.unsupported && bap.ownershipVerified === true) {
    // The sentence addressed "you" and then switched to "a buyer" mid-way.
    safety.push(bap.transferable?.tba
      ? _nt("If you are buying the token itself: the token, its on-chain wallet and its recorded history transfer with it; its credentials, prompt and triggers do not, so you would set those up again before it runs.")
      : _nt("If you are buying the token itself: the token and its recorded on-chain history transfer with it; its credentials, prompt and triggers do not, so you would set those up again before it runs."));
    safetyEv.push('bap578');
  }
  rows.push({ q: _nt("is it safe to pay or buy?"), a: safety, ev: safetyEv });

  // Q6 · who is behind it? Presence booleans only; the identity panel carries
  // the actual strings and links.
  // "The owner and the registration transaction" are two nouns a reader cannot
  // picture; naming what each one is costs a few words.
  rows.push({
    q: _nt("who is behind it?"),
    a: [flags.hasRegistrationTx
      ? _nt("A wallet address, not a verified identity. The wallet that owns it and the transaction that registered it are both public; the identity panel links to them. Nobody here has checked who operates it.")
      : _nt("A wallet address, not a verified identity. The wallet that owns it is public; the identity panel links to it. Nobody here has checked who operates it.")],
    ev: ['wallet'],
  });

  return rows;
}

/**
 * The strength-preservation rules, frozen as data so the tests can sweep
 * every composed surface with the same list, and so a future edit that
 * weakens or sharpens a claim fails a test instead of shipping.
 *
 * Each pattern exists because the naive plain rewrite produced it:
 *  - accusation words: a failed check is "could not confirm", never an alleged
 *    fraud; the field holds an absence of proof, not a proof of absence.
 *  - outage words: silence from one vantage point is not their downtime.
 *  - uptime words: the calendar carries its own denominator; prose implies a
 *    schedule we do not keep.
 *  - vague quantifiers: counts stay numeric. "almost none" is an opinion
 *    about a number the reader was entitled to see.
 *  - "free": the panel measures no price in either direction.
 *  - "verified" as a word: the banner's tier vocabulary never uses it, and
 *    prose naming a tier the banner does not show breaks the one-vocabulary
 *    rule. The single allowed use is the fixed negative phrase below.
 */
export const BANNED_PATTERNS = [
  /\b(fake|scam|fraud|imposter|malicious|untrustworthy)\b/i,
  /\bnot (a )?real\b/i,
  /\b(is down|offline|dead|broken|failing)\b/i,
  /\b(uptime|availability)\b/i,
  /\b(almost|nearly|most|many|few|hardly|barely|virtually|plenty)\b/i,
  /%|\bpercent\b/i,
  /\bfree\b/i,
  /\bguarantee[ds]?\b/i,
  /\bverified\b/i,
];

// The one phrase allowed to contain a banned word: a fixed negative that
// grants nothing. Tests strip these before sweeping.
export const BANNED_EXCEPTIONS = ['not a verified identity'];
