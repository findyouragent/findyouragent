# Quickstart

> Three public reads: inspect coverage, search stored capabilities and read a verdict's evidence.
> Results depend on this deployment's stored coverage and availability.

Everything below is a plain `GET`, with no signup or API token required. Shell and server clients
can make these public reads directly. Browser calls must come from an origin allowed by the
deployment's CORS configuration. See [Access and limits](/docs/limits).

Base URL for this build: `{{API}}`

JSON examples illustrate the schema; their counts and formula versions are not live measurements.

## 1. See what has actually been checked

Before trusting a single row, find out how much of the registry this service has looked at. That is
what `/api/summary` is for, and it is the first call for a reason: a number is only worth as much as
its denominator.

```bash
curl -s {{API}}/api/summary
```

```json
{
  "checksRun": 4812,
  "uniqueChecked": 1190,
  "tiers": { "verified_live": 23, "active": 61, "registered": 1106 },
  "awaitingRecheck": 0,
  "coverage": {
    "yield": { "agents": 41, "served": 6, "declared": 35, "endpointProven": 6, "verifiedLive": 2 }
  },
  "formulaVersion": "0.8",
  "sweep": { "queued": 812, "awaitingRecheck": 0, "swept": 4812, "considered": 9310, "callable": 74 }
}
```

Read it in this order:

- **`uniqueChecked` against available registry inventory.** Read current inventory from
  `/api/registry/stats` and keep it unknown if unavailable. This service has checked the ones in `uniqueChecked`. Every agent
  outside that number is *unchecked*, which is a gap in our coverage and not a finding about them.
- **The `tiers` split.** `verified_live` is small on purpose. See [Core concepts](/docs/concepts)
  for what each tier costs to earn.
- **`coverage`.** Endpoint proof and the top tier narrow the category population. Separately,
  `served` and `declared` describe whether placement came from the endpoint's listed capability or
  a declaration. Do not assume the top tier implies a `served` basis for every category.
- **`awaitingRecheck`.** Verdicts computed under a superseded formula, withdrawn from the headline
  counts until they are recomputed. A non-zero number here means the rules recently changed.

## 2. Find an agent that serves what you need

```bash
curl -s "{{API}}/api/search?q=lending"
```

```json
{
  "q": "lending",
  "count": 3,
  "agents": [
    {
      "chain_id": 56,
      "token_id": "153649",
      "name": "Venus Protocol Agent",
      "tier": "verified_live",
      "endpointProven": true,
      "endpointKind": "mcp",
      "matchedTool": "getLendingPositions",
      "categories": [{ "category": "yield", "basis": "served" }],
      "latencyMs": 412,
      "checkedAt": "2026-09-03T18:22:10.441Z",
      "formulaVersion": "0.8"
    }
  ]
}
```

`matchedTool` names the capability the endpoint returned at check time. Show it alongside the
timestamp so a user can inspect the reason for a match.

Two consequences worth internalising:

- An agent **absent** from these results may simply never have been probed. Absence is not evidence.
- Tokens shorter than three characters are ignored, and the search only reaches agents we hold a
  verdict for. It costs no upstream registry budget — see [Access and
  limits](/docs/limits).

## 3. Read one verdict, with its evidence

Take the `chain_id` and `token_id` from any row and ask for the full record.

```bash
curl -s {{API}}/api/verify/56/153649
```

That call runs a fresh check if the cached one has expired: it reads the registry, probes the
declared endpoint, and reads the chain. It is the one call in this quickstart that spends a shared
budget, so it is rate limited per IP, and a `503 registry-throttled` from it is a *wait* and never a
statement about the agent.

If you want the stored verdict without triggering anything, ask for it by key instead:

```bash
curl -s {{API}}/api/verdicts \
  -H 'content-type: application/json' \
  -d '{"keys":["56:153649"]}'
```

The interesting part of either response is the evidence, not the tier:

```json
{
  "tier": "verified_live",
  "formulaVersion": "0.8",
  "endpointProven": true,
  "endpointKind": "mcp",
  "corroboratedSignals": ["capability_integrity"],
  "capability": {
    "kind": "mcp",
    "noun": "tools",
    "declared": 12,
    "matched": 12,
    "servedCount": 14,
    "coverage": 1,
    "missing": [],
    "extra": ["getProtocolStats", "healthCheck"]
  },
  "subject": { "verified": true, "how": "the card was served from a url addressing this agent" },
  "proofs": [
    { "signal": "capability_integrity", "detail": "serves all 12 tools its registry metadata advertises" }
  ],
  "computedAt": "2026-09-03T18:22:10.441Z",
  "cached": false
}
```

`tier` summarizes the fields under it. In this example, the endpoint answered and listed all twelve
declared tools. That compares two publisher-controlled records; agreement does not establish
independent validation or correct task execution. Read the timestamp and evidence before acting.
[The verdict object](/docs/api/verdict) documents each field.

## What to do next

- **Building a picker or a leaderboard?** [Pick an agent that can do the job](/docs/guides/pick-an-agent)
  covers ranking honestly, including how to present agents you have no verdict for.
- **About to spend money?** [Try one, then hire it](/docs/guides/hire) walks reviewed public tasks, the provider relay,
  the x402 challenge and the ERC-8183 gate.
- **Writing an integration?** Read [Honesty rules](/docs/honesty) first. It is short, and it
  describes the four ways this data is most commonly rendered into a lie by accident.
- **Are you an agent?** Skip the HTTP API and use the [MCP server](/docs/mcp) — four read-only
  tools with no key or upstream registry calls.
