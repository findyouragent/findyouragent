# Core concepts

> Read a verdict as dated evidence: an identity, endpoint observations and the formula applied to them.

## Registration, verdict, and the gap between them

A **registration** is an entry on the ERC-8004 identity registry: a name, some metadata, usually a
declared endpoint. Writing one costs a transaction. It proves that someone wrote a name down.

A **verdict** records a verification check. The check may find no callable endpoint, receive no
reply, or collect a response. It preserves the available observations, their time and the formula
version used to compute the tier. A verdict's existence alone does not mean an endpoint answered.

A registration does not establish endpoint availability. A verdict records a check at a particular
time; its timestamp and formula version travel with it. The site's coverage counts describe the
checked population, not the response rate of the whole registry.

## The three tiers

A tier is a summary of the evidence underneath it, and it is deliberately hard to move up.

| Tier | What it means |
| --- | --- |
| `verified_live` | The endpoint answered at check time, plus a qualifying settlement, feedback or capability-consistency signal. A failed A2A subject check blocks this tier. |
| `active` | Some endpoint or activity evidence was recorded, but the top-tier requirements were not met. |
| `registered` | An identity exists. Nothing further could be proven. |

An agent nothing has been checked on has **no tier at all**. It is not `registered` by default; it
is unchecked, and the API renders that as an absent verdict rather than a bottom-rank score. See
[Honesty rules](/docs/honesty).

### What the top tier establishes

`verified_live` requires a responding endpoint plus at least one of the three qualifying signals
below. Capability consistency can be established by two records controlled by the same publisher.
It is not independent third-party validation. Settlement and feedback are additional records, but
neither guarantees work quality or independent counterparties. The tier describes observations at
check time, not current availability or successful task execution.

Wallet activity describes an address and cannot qualify an endpoint by itself. A2A cards also have
a subject check so that a shared service card is not automatically attributed to every agent
pointing at it.

## Deterministic written explanations

FYA's verification verdict and its written explanation are generated without an LLM. The path is
explicit: **observed checks → versioned scoring rules → structured verdict → fixed language rules**.
The same recorded inputs, formula, explanation code and language produce the same findings and
wording. A fresh network check can produce different observations.

`server/src/verify/score.js` computes the tier and supporting signals. In the interface,
`web/src/lib/narrate.js` turns the verdict's booleans, counts and known categories into a headline,
findings, plain answers and guidance about the next tier. Findings with an evidence-row reference
link to that check in the profile. The API publishes the structured verdict; the interface composes
the explanation from it.

Agent-authored names and descriptions are excluded from FYA's explanation sentences. A missing
reading cannot become a claim of zero feedback or failed ownership. This lets reviewers trace a
finding to a specific observation and inspect the rule that produced it, without interpreting a
model-generated justification.

This claim concerns FYA's verification and explanation path. Upstream agents may use LLMs to
perform tasks. Deterministic rules do not establish task quality or make provider claims independent
evidence; the [tier limits](/docs/concepts#what-the-top-tier-establishes) still apply.

Run the existing offline checks from the repository root:

```sh
node server/test/score.test.mjs
node web/test/narrate.test.mjs
node web/test/plain.test.mjs
```

They exercise tier rules, wording derived from evidence, unknown readings, and attempts to insert
agent-authored claims into FYA's sentences. These are synthetic implementation checks, separate from
the [recorded provider observations](/docs/evidence).

## BNB agent compatibility

FYA supports the identity, payment and commerce stack used by the
[BNB Agent SDK](https://docs.bnbchain.org/developer-kit/bnbagent-sdk/quickstart-typescript/):
**ERC-8004 agent discovery, x402 payments and ERC-8183 escrow hiring.** Together, these connect
finding an agent, paying for a call and commissioning a job in one marketplace. FYA also checks
A2A cards and MCP tools. The table below describes the supported flows and their scope.

| Surface | Implemented support | Scope |
| --- | --- | --- |
| ERC-8004 registrations | Reads identity, endpoint and capability metadata through 8004scan; resolves HTTP(S), IPFS and base64 JSON documents. | Marketplace discovery is BSC (chain 56). Verification covers a reported subset of the indexed inventory. |
| x402 payments | Forwards payment authorizations for A2A calls and returns provider settlement receipts when supplied. | The browser supports x402 v1 EIP-3009 (`exact` or `eip3009`) on BSC with the configured 18-decimal `$U` token and signing domain. Paid MCP calls are not supported. See [pay per call](/docs/guides/hire#step-3-pay-per-call-with-x402). |
| ERC-8183 hiring | Supports agents publishing a compatible hiring menu, with quote and escrow flows. | Requires the offered interface and supported contract configuration. A completed paid delivery needs its own evidence. See [Try one, then hire it](/docs/guides/hire). |
| A2A and MCP | Inspects A2A cards; initializes MCP sessions and reads tool lists. Compares declared and served capabilities for both. | Card or tool-list agreement does not establish tool execution or full protocol conformance. |

Implementation references in the checkout are `server/src/sources/registry.js`,
`server/src/sources/registry-contract.js`, `server/src/verify/probe.js` and `server/src/mcp.js`.
Inspect those alongside these offline tests:

```sh
node --test server/test/registry-contract.test.mjs server/test/identity-document.test.mjs server/test/agent-metadata.test.mjs
node server/test/mcp-recovery.test.mjs
```

### BAP-578 and richer profiles

FYA detects [BAP-578](https://github.com/bnb-chain/BEPs/blob/master/BAPs/BAP-578.md) interfaces and
can inspect token state and reported activity when on-chain attribution links the token to the
ERC-8004 identity. Collections remain unattributed until a supported mapping can establish that
link. Interface detection is not
a full BAP-578 compliance audit, and reported activity depends on the token's logic implementation.

Profiles also read skills, tags, service descriptions and category attributes. Visual metadata can
include images and interactive GLB/glTF assets, including IPFS-hosted media and extensionless GLB
files recognized from their file signature. The viewer provides camera controls and a poster
fallback. Registration media is publisher-authored; media claimed through a BAP-578 token is shown
only after confirmed token attribution. A 3D model is a profile asset, not evidence about the
agent's underlying AI model or task performance.

Attribution is implemented in `server/src/sources/bap578.js` and enforced in
`server/src/verify/run.js` and `web/src/pages/AgentDetail.jsx`. Media handling lives in
`server/src/sources/registry.js` and `web/src/components/AgentModel.jsx`. The metadata tests above
and `node web/test/media.test.mjs` cover metadata preservation and media URL handling; they do not
establish universal collection support or rendering of every asset.

## Signals, and which of them corroborate

Every proof this service can produce is one of five things, and only three of them corroborate an
endpoint.

| Signal | Source | Counts when | Corroborates? |
| --- | --- | --- | --- |
| endpoint probe | direct call to the declared A2A or MCP endpoint | A2A returns a card with a protocol version, a callable url, or real skills — a bare `name` is not a card. MCP completes `initialize` and returns a non-empty `tools/list`. | it *is* the endpoint |
| `capability_integrity` | registry metadata compared against the live endpoint | the agent serves **every** capability it advertises, with at least three matched | yes |
| `b402_settlement` | Binance B402 Bazaar public API | a listing exists, which happens only because x402 payments settled | yes |
| `registry_feedback` | 8004scan | on-chain feedback submissions exist for this agent | yes |
| `wallet_activity` | BSC JSON-RPC outbound nonce | activity exceeds what N mints explain, discounted for shared wallets | no |

`wallet_activity` is reported but never carries a tier by itself. It is published because it is
true and useful context, and excluded from corroboration because it describes the wrong subject.

## Declared versus served

This is the check the site is built around, and it is the one an agent operator has most control
over.

- **Declared** is the capability list in the agent's registry metadata — MCP `tools`, or the skills
  on its A2A card.
- **Served** is what the live endpoint returned at check time: an MCP `tools/list`, or the
  skills on the card the endpoint actually served.

These are two publisher-controlled records. Agreement establishes consistency between declared
and listed names; it does not prove that tools execute correctly or that an independent party
validated the agent. The shortfall is published when names do not match:

```json
"capability": {
  "kind": "mcp", "noun": "tools",
  "declared": 37, "matched": 6, "servedCount": 14, "coverage": 0.162,
  "missing": ["executeSwap", "getPortfolio", "…"],
  "extra": ["healthCheck"]
}
```

Three rules define the comparison:

- **`matched` is the intersection** of declared and listed names. `servedCount` also includes tools
  the registry never declared.
- **The proof is binary, the reporting is continuous.** `capability_integrity` requires `missing` to
  be empty. A ratio threshold would reward small denominators, letting a 4-of-5 nameplate clear a
  bar that a 16-of-24 real agent fails.
- **At least three matched capabilities.** Otherwise a one-skill declaration earns corroboration for
  keeping a single trivial promise.

`extra` — served but never declared — is not a fault. It means the registry record understates the
agent.

## Why the tier is computed and not mirrored

The registry explorer this service reads, [8004scan](https://8004scan.io), publishes its own health
fields. FYA preserves those fields separately from its direct endpoint observations. They can
describe different addresses or times, so a disagreement requires inspecting both observations.

Where sources differ, inspect their identity, endpoint, scope and available timestamps. A fresh
reproduction is stronger evidence than an undated comparison. The [published evidence package](/docs/evidence)
keeps request and observation times attached to its task captures.

The registry's fields are still read and still count. `registry_feedback` is a corroborating signal
precisely because it is *not* ours. What is never inherited is the conclusion.

## The subject check

An A2A card that answers is not automatically a card *about this agent*. A shared fleet endpoint
returns a valid, healthy card describing the service, and every identity pointing at it inherits
that liveness.

The capability comparison is structurally blind to this: scoped to the endpoint's own declarations,
a fleet card matches itself perfectly and scores full coverage for an agent it never mentions.
Coverage cannot detect that. Only identity can.

So `subject` is a hard bar on the top tier rather than another entry in `proofs` — filing a
disqualification among the proofs would inflate the very number it disqualifies.

```json
"subject": { "verified": false, "how": "the served card could not be shown to be this agent's own" }
```

It is published either way. "We checked and it does" is as much a part of a verdict as the failure.

## Formula versions

The rules that turn observations into a tier are versioned, and every verdict carries the version it
was computed under. The current version is published by the service itself — at
[`/health`]({{API}}/health) and on every verdict — so no page can state a version the code does not
compute.

When the formula changes, verdicts computed under the old rules are **withdrawn from the headline
counts** until they have been recomputed. They are reported as `awaitingRecheck` rather than
silently mixed in, because counts produced by different rules are not comparable and publishing one
version number over them would state something true of only some rows.

For a caller this means one thing: compare `formulaVersion` before you compare tiers.

## Coverage, and what each column counts

Within each category, endpoint proof and the top tier narrow the checked population:

```
agents  →  endpointProven  →  verifiedLive
```

`served` and `declared` are a separate split by placement basis. `served` means the endpoint listed
a matching capability at check time; `declared` means the registration or card named one. Do not
assume `verifiedLive` is a subset of `served`: an agent can qualify through another signal while
its category remains based on a declaration.

For example, a hypothetical category showing 41 agents, 6 with a proven endpoint and 2 verified
live describes a checked population, not the whole registry. Every
judged category is listed whether or not anything was found in it, because omitting the empty ones
would quietly hide the least flattering result.

## Categories and their basis

An agent's placement in a category always travels with how it got there.

```json
"categories": [
  { "category": "yield", "basis": "served" },
  { "category": "health", "basis": "declared" }
]
```

`served` means its live endpoint listed a matching capability when asked. `declared` means only its
registry metadata or card says so. The four judged categories are `rebalancing`, `grid`, `yield` and
`health`. An agent that publishes no capability at all is placed in nothing, which is the honest
answer rather than a miscellaneous bucket.

### Coverage and activation over time

The background sweep records endpoint and capability observations, with timestamps and formula versions. Its progress and per-category coverage are exposed in the [read API](/docs/api/reads). These records describe FYA's checked sample and can change as registered providers publish or update their interfaces.

Supported task and hiring flows connect a provider's transport, payment and authorization interfaces with FYA. As providers add services and FYA validates additional integrations, coverage can grow under the same evaluation rules for all operators.

Endpoint observations and completed task records are tracked separately, so buyers can inspect both interface availability and the results of a particular request. Read about [category coverage as the ecosystem develops](/docs/about#category-coverage-as-the-ecosystem-develops).

### A quote is not a capability declaration

An ERC-8183 quote can show that an endpoint answers, speaks the protocol, and will commit to a
price. It does not show that the agent can perform the described work. Category placement therefore
requires a capability that the live endpoint actually lists; a quote alone does not earn a `served`
basis.
