# Calls that spend

> These endpoints reach outside this service: to the registry, to the chain, or to a third
> party's own server. All are rate limited per IP, because none of what they spend is ours.

Use [reads that cost nothing](/docs/api/reads) for FYA's saved checks. Use the registry routes below
for indexed registrations or a new check when a human needs it. Looping `/api/verify` over a page
of agents spends the registry budget shared with other visitors and the background sweep.

## Registry browsing and search

`GET /api/registry/agents` accepts `chainId=56`, `page` (positive integer, default 1), `limit` (1–100,
default 25), optional `search` (up to 200 characters), `sortBy` (`created_at` or `total_score`)
and `sortOrder` (`asc` or `desc`, default descending). Page, `(page - 1) * limit` and that offset
plus `limit` must be exact safe integers. There is no fixed 1,000-page cutoff.

`GET /api/registry/search` accepts `q` (1–500 characters), `chainId=56`, `page` and `limit`.
These are semantic registry matches, separate from FYA's served-capability search at `/api/search`.

Both return `data`, `source: "8004scan"` and `meta.pagination` with `page`, `limit`, `total` and
`hasMore`. FYA translates page numbers to the documented registry offsets and rejects mismatched
identities or inconsistent pagination. The browser tries keyword search when semantic search is
unavailable or empty, within one bounded request window.

`GET /api/registry/stats` takes no parameters and returns `data.chain_stats`, independently of
the visible search. Indexed inventory includes placeholders and owner-declared inactive entries.
Their presence, absence or registry score does not establish a completed task or an FYA verdict.

These routes share a 60/minute/IP limit. Page responses are cached for 30 seconds and statistics
for 60 seconds; concurrent identical reads share one upstream request. The registry key stays on
the server. `429` is FYA's request limit, `503 registry-throttled` carries the upstream wait,
and `502` identifies unavailable or invalid upstream data with `source` and `upstreamStatus`.
`registry-unavailable` is retryable; `registry-invalid-response` has `retryable: false` because
repeating a malformed response does not establish a valid listing.
An outage never becomes a successful empty page.

## `GET /api/agents/{chainId}/{tokenId}`

Reads one agent's public 8004scan listing through FYA. This uses the server's registry credentials
and shared five-minute cache, keeping the registry API key out of the browser. Only numeric chain
and token IDs are accepted; callers cannot choose an upstream host or URL.

```bash
curl -s {{API}}/api/agents/56/45422
```

The listing is returned as `data`, alongside its source:

```json
{ "data": { "…": "the agent's registry listing" }, "source": "8004scan" }
```

This is registry data, including the registrant's own claims. It is not a verification verdict or
evidence of a completed task. Use [stored verdicts](/docs/api/reads) or
[`/api/verify`](/docs/api/checks) for FYA's checks.

| Status | Meaning |
| --- | --- |
| `200` | the listing, fresh or from the shared five-minute cache |
| `400` | `chainId` or `tokenId` was not numeric |
| `404` | `agent-not-found`, with `source: "8004scan"` |
| `429` | the caller exceeded the per-IP verification limit; `Retry-After` is set |
| `503` | `registry-throttled`, with `source: "8004scan"`, `retryable: true` and the validated `Retry-After` wait |
| `502` | `registry-unavailable` or `registry-invalid-response`, with `source: "8004scan"`; invalid responses have `retryable: false` |

A throttled or unavailable registry is a failed lookup, not a negative verdict about the agent.
The response contains no registry API key or upstream error text.

## `GET /api/verify/{chainId}/{tokenId}`

Runs a full verification, or serves the cached verdict if one was computed inside the TTL (ten
minutes by default).

```bash
curl -s {{API}}/api/verify/56/153649
```

What one check actually does:

1. Reads the agent's registry record — name, declared endpoints, declared capabilities, wallet.
2. Fetches the agent's own identity file (its card) and, if the card claims a wallet, tries to prove
   that claim against the token itself. An agent is judged on its own activity rather than its
   minter's wherever that proof succeeds.
3. Probes the declared A2A endpoint and the declared MCP endpoint, in parallel.
4. Reads outbound wallet activity from a BSC node, and asks the B402 Bazaar whether settled x402
   payments exist for this agent.
5. Compares what the registry says the agent offers against what the endpoint just served.
6. Checks whether the card that answered can be shown to describe *this* agent.
7. Computes a tier from the above, under the current formula version.

The response is the [verdict object](/docs/api/verdict), plus `cached`:

```json
{ "tier": "verified_live", "…": "…", "computedAt": "2026-09-03T18:22:10.441Z", "cached": false }
```

| Status | Meaning |
| --- | --- |
| `200` | a verdict, fresh or cached |
| `400` | `chainId`/`tokenId` were not numeric |
| `429` | you exceeded the per-IP limit (20/min by default). `Retry-After` is set |
| `503` | `registry-throttled`, or `identity-unavailable` with `source: "agent-identity"` and `retryable: true`. An incomplete identity read leaves the previous completed check unchanged |
| `502` | attributed `registry-unavailable` / `registry-invalid-response`, or `verification-failed` with a `detail` string; invalid registry responses are not retryable |

### `?stream=1` — the check narrated as it happens

```bash
curl -N "{{API}}/api/verify/56/153649?stream=1"
```

Returns `text/event-stream`. The verifier emits frames as probe operations resolve; the last
successful frame carries the verdict. Arrival timing helps show progress but is not independent
proof that an external call happened. Inspect the observations and reproduce a request when needed.

```
data: {"step":"registry","ok":true,"name":"Venus Protocol Agent"}

data: {"step":"card","ok":true,"ownWallet":true}

data: {"step":"mcp","declared":true,"reachable":true,"servesTools":true,"toolCount":14,"latencyMs":412}

data: {"step":"a2a","declared":false,"reachable":false,"status":null,"latencyMs":null,"reason":"no endpoint declared","hasAgentCard":false,"skillsCount":null}

data: {"step":"wallet","address":"0x…","checked":true,"txCount":318}

data: {"step":"bazaar","checked":true,"listed":false,"calls30d":null}

data: {"step":"bap578","claimed":true,"tokenId":"11140","attributed":true}

data: {"step":"verdict","verdict":{"tier":"verified_live","…":"…","cached":false}}
```

| `step` | Emitted when |
| --- | --- |
| `registry` | the registry record was read |
| `card` | the agent's identity file was fetched, and whether a wallet claim was proved |
| `a2a` | the A2A probe resolved |
| `mcp` | the MCP probe resolved |
| `wallet` | wallet activity was read |
| `bazaar` | the settlement index answered |
| `bap578` | only when the card claims a BAP-578 token. `attributed` is tri-state |
| `verdict` | last frame. Carries the complete verdict |
| `error` | the check could not complete. Carries `throttled` and `message`; identity failures also carry `code: "identity-unavailable"`, `source: "agent-identity"` and `retryable: true` |

A **cached** verdict streams the `verdict` frame immediately and nothing before it. That is
deliberate: replaying invented probe steps for a check that did not happen would be a re-enactment
presented as a measurement.

## `GET /api/agent-meta/{chainId}/{tokenId}`

Registry metadata and displayable media for one agent. Spends registry budget; successful document reads are cached for 60 seconds. Add `?refresh=1` after a metadata update to discard the cached document and read it again. Concurrent reads for the same agent share one request, and refresh uses the same rate limit. Failed document reads are not cached as successes or replaced with the previous hire menu.

```bash
curl -s {{API}}/api/agent-meta/56/153649
```

The response carries the registration metadata and a `media` object with a `source` that decides how
a client should treat it:

| `media.source` | Trust class | How the site renders it |
| --- | --- | --- |
| `registration` | named by the agent's own registry metadata — self-authored | ungated, same class as its avatar |
| `token` | read from the BAP-578 token the card claims | gated on the verdict's ownership check |

That distinction exists so an unattributed claim can never wear another token's skin. `media` is
`null` when nothing could be read — decoration only, and a failed read costs the picture and nothing
else.

`404 {"error":"agent not found"}` when the registry has no such agent. Registry failures use the
attributed `registry-unavailable`, `registry-invalid-response` or `registry-throttled` forms;
failed metadata document reads use `502` with `error: "metadata-unavailable"`,
`source: "agent-metadata"` and `retryable: true`. This is distinct from a failed registry lookup.
A successful response contains a non-null metadata object. An object without `services` has no
declared services; an unreadable document leaves the hire menu unknown. Media retrieval remains
best-effort and does not turn a valid metadata document into a failure.

## `GET /api/activity/{chainId}/{tokenId}`

On-chain activity, but **only** for agents whose wallet is provably their own. Spends the operator's
node credits rather than the registry budget, so it carries its own limit.

```bash
curl -s {{API}}/api/activity/56/153649
```

```json
{
  "key": "56:153649",
  "attribution": {
    "gate": "verified",
    "wallet": "0x…",
    "walletBasis": "the wallet derived from this agent's token via ERC-6551"
  },
  "coverage": { "fromBlock": 62110000, "toBlock": 62114000, "intervals": 3, "scannedThroughTs": "2026-09-03T18:30:00.000Z" },
  "events": [{ "…": "one per transaction", "class": "framework" }],
  "classLabels": { "framework": "…", "payment": "…" },
  "sources": { "transfers": "ok", "classification": "ok" },
  "cuUsed": 1420
}
```

**Read `attribution.gate` before you read `events`.** Every non-served state is a named gate with its
own sentence, so an outage or a missing wallet can never render as "no activity":

| Gate | Meaning |
| --- | --- |
| `verified` | events are attributable to this agent's own proved wallet |
| `no-verdict` | never checked, so there is no proved wallet to attach activity to |
| `no-proved-wallet` | no on-chain wallet is provably this agent's |
| `no-wallet-yet` | its token-bound wallet has not been created on-chain yet |
| `unsupported-chain` | only BNB Chain (56) is observed |
| `unconfigured` | the feed is not enabled on this deployment |
| `not-checked` | the chain could not be reached just now — about our check, not the agent |

Each event carries an origin `class`: `framework`, `framework-triggered`, `payment`, `transfer`, or
`not-checked`, with the honest sentence for each in `classLabels`. `coverage` states the exact block
window scanned, so "no events" is always bounded by a range you can see.

Only a fully clean read is cached (five minutes). A throttled or errored read is retryable
immediately rather than frozen behind a TTL.

## `GET /api/try/{chainId}/{tokenId}/interface`

Resolves the agent's declared endpoint from the registry. For MCP it discovers the current tool
list; for A2A it reports a declared message interface without proving the provider will accept it.

```bash
curl -s {{API}}/api/try/56/153649/interface
```

An MCP agent:

```json
{
  "kind": "mcp",
  "endpoint": "https://agent.example/mcp",
  "server": { "name": "venus-mcp", "version": "1.2.0" },
  "tools": [{ "name": "getBorrowBalance", "title": null, "description": "…", "inputSchema": {}, "readOnly": true }],
  "writeToolCount": 6,
  "example": { "tool": "getProtocolStats", "args": {}, "usesSample": false, "checkedAt": "2026-09-03T18:22:10.441Z" }
}
```

An A2A agent takes free text and has no tool list:

```json
{ "kind": "a2a" }
```

`tools` contains only tools passing FYA's name-based read guard. `writeToolCount` counts the excluded
names, including ambiguous names; it does not prove every excluded tool performs a write.

The guard examines a tool name, not provider implementation. It cannot guarantee that an operator
performs no writes behind a read-shaped name. `taskPresets` contains the reviewed public fixtures
for supported agent identities, each with `id`, `version`, `tool`, `args`, `available`,
`unavailableReason` and `limitation`. A changed live schema disables the corresponding fixture.

`example` appears only when the last real check ran that zero-input tool successfully **and** the
tool is still on the live list. Nothing unvalidated is ever offered for auto-run.

`409 {"error":"agent declares no callable endpoint"}` when there is nothing to try;
`502 {"error":"the agent MCP endpoint did not answer a tools/list request"}` when the server refused.

## `POST /api/try/{chainId}/{tokenId}`

A relay to the agent's declared endpoint: read-only MCP tool calls or A2A messages. MCP names pass a
read-only guard; A2A accepts prose, so request only work you intend the provider to perform.

### Run a reviewed public task

Read `/api/try/56/45650/interface` and confirm that `pancake-bsc-lp-position` is available in
`taskPresets`, then invoke it:

```bash
curl -s {{API}}/api/try/56/45650 \
  -H 'content-type: application/json' \
  -d '{"presetId":"pancake-bsc-lp-position"}'
```

The server owns the preset's tool and arguments, rechecks its live schema and returns the actual
input as `taskPreset {id,version,title,tool,args}`. Caller-supplied tool or arguments cannot alter a
reviewed fixture. The supported fixtures are:

| Agent key | Preset ID | What is requested |
| --- | --- | --- |
| `56:45422` | `beefy-bsc-vaults` | reported BSC vault names, assets, TVL and APY |
| `56:43129` | `venus-bsc-account-liquidity` | reported borrow limit and shortfall for a fixed public Venus CORE account |
| `56:45650` | `pancake-bsc-lp-position` | reported assets, amounts and range for a fixed public PancakeSwap V3 position |

These are point-in-time public reads. They do not deposit, rebalance, monitor an account or create a
position. Availability is established by each interface response, not by this static table.

### Invoke a generic interface

MCP — name a tool:

```bash
curl -s {{API}}/api/try/56/153649 \
  -H 'content-type: application/json' \
  -d '{"tool":"getProtocolStats","arguments":{}}'
```

A2A — replace `<a2aTokenId>` with an agent whose interface reports `kind: "a2a"`, then send prose:

```bash
curl -s "{{API}}/api/try/56/<a2aTokenId>" \
  -H 'content-type: application/json' \
  -d '{"message":"what is the current supply APY for USDT?"}'
```

| Field | Type | Notes |
| --- | --- | --- |
| `presetId` | string | Reviewed MCP task ID from `taskPresets`; overrides caller tool and arguments with the server-owned fixture |
| `tool` | string | MCP agents. Must pass the read-only check |
| `arguments` | object | MCP agents. JSON object, max 8 KB |
| `message` | string | A2A agents. Max 4000 characters |
| `payment` | string | A2A only: an encoded `X-PAYMENT` header value, non-empty and shorter than 8192 characters, passed through untouched. Not a JSON object; not forwarded for MCP |

Handled Try outcomes normally return HTTP `200`, including validation refusals and failed calls
inside the envelope. A payment challenge returns HTTP `402`. **Read the envelope's `status` and
`observation` before treating a request as successful**; `status` can be a relay refusal rather than
an upstream HTTP code. `observation.transport.status` records the upstream status when one was received.
Malformed path parameters, local rate limits and uncaught route errors can still return HTTP errors.

```json
{ "status": 200, "body": { "…": "the agent's reply" }, "endpoint": "https://agent.example/mcp", "kind": "mcp" }
```

Handled refusals in the envelope's `status`:

- `403` — the named tool is not read-only. This is enforced here and not only in the UI, because a
  client can post any name it likes and this is the only place that actually stops it. A tool
  qualifies only if its name opens with a reading verb and carries no second action joined by a
  connective: `getBorrowBalance` yes, `getOrCreateAccount` no.
- `409` — the agent declares no valid endpoint of the kind you addressed.
- `400` — invalid `presetId`, missing or oversized `message`/`arguments`.
- `502` / `503` — a failed or throttled lookup/discovery/call. When available, `source`, `phase`,
  `code`, `upstreamStatus` and `retryable` locate the failure. A registry lookup failure occurs
  before any provider invocation; a transient failure at that stage can permit a later explicit
  retry. Respect `retryAfterSeconds` when returned. A timeout after a tool or message was sent
  leaves completion unknown; the server does not automatically resubmit a task or payment.

When an agent's declared address serves a **web page** rather than an agent interface, the relay says
so in words instead of dumping HTML at you: *"The address this agent publishes serves a web page
titled …, not an agent interface."* That is a finding about the registration, not a transport
failure, and it is one of the more common things this API will tell you.

### Observations and downloadable results

Every handled Try response includes a versioned `observation` with `runId`, protocol, endpoint,
start/finish times, latency, transport status, `captureComplete`, `outcome` and `reason`.
Protocol outcomes distinguish `response_received`, `deliverable_received`, `pending`,
`payment_required`, `error` and `unknown`. An MCP error result is not a successful response; an A2A
task marked completed without output is not a captured deliverable.

Generic calls carry `observation.task.status: "not_evaluated"`. Reviewed tasks add a task status
(`passed`, `failed`, `pending` or `incomplete`), preset/criteria versions and, when evaluated, named checks and a
limitation. Those checks test requested scope and response shape. They do not independently verify
reported prices, yields, ownership, account attribution or profitability; read each preset's exact
limitation.

The reviewed `pancake-bsc-range-assessment` task additionally checks its named position and pool facts through a separate BSC RPC at the provider's exact block. `observation.task.corroboration` retains that check's status, time, block, named checks, decoded facts and RPC request/response evidence. It must pass before the task passes. RPC unavailability remains `incomplete`; a factual contradiction fails. The provider response is retained in both cases. Observation latency describes the provider relay; corroboration carries its own check time. No costs, profitability, approvals or continuous execution are certified by this task.

`captureComplete: true` means FYA captured the protocol response rather than a shortened display.
It does not mean the provider returned all relevant real-world data or that its answer is correct.
A failed capture remains explicit. The HTTP status, protocol outcome, task checks and capture flag
are separate facts.

The browser's **Download result** saves `schemaVersion: 1`, `recordType: "fya-observed-agent-result"`,
agent identity and endpoint, exact request, observation and captured response as JSON. Request
headers and wallet payment signatures are excluded. `response.paymentReceipt` preserves the decoded
provider receipt, or `null` when none was returned. That metadata requires separate on-chain
verification; it does not pass task checks. Older exports omitted this field even when a receipt
may have been returned. This file is not provider-signed or a settlement receipt.
A failed rerun preserves earlier results with their original observation times; it does not
make them fresh. See the [evidence guide](/docs/evidence) for published records and reproduction.

This service never signs or holds funds. For A2A messages, an `X-PAYMENT` header produced by your wallet passes
through untouched, and any settlement receipt the agent returns comes back as `paymentReceipt` —
decoded server-side because browsers usually cannot read that header cross-origin. See
[Try one, then hire it](/docs/guides/hire).

MCP payment forwarding is not supported. The browser wallet flow accepts x402 version 1 EIP-3009
challenges (`exact` or `eip3009`) on BSC for the configured 18-decimal `$U` token and signing domain
only; an unsupported asset must not be displayed as `$U`.
