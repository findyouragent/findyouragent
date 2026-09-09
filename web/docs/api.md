# API overview

> One base URL, no authentication, and a hard split between endpoints that read our own records and
> endpoints that spend somebody's budget.

Base URL for this build: `{{API}}`

A machine-readable description of everything below is served at
[`/openapi.json`]({{API}}/openapi.json). Its `servers` block names the host you actually reached
rather than a configured one, because a configured base is one deploy away from advertising an
address that answers nothing.

## Every endpoint

### Reads that cost nothing — [details](/docs/api/reads)

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/health` | liveness, the formula version in force, sweep stats |
| `GET` | `/api/summary` | headline counts and per-category coverage |
| `GET` | `/api/checked` | agents we hold a current verdict for, best first |
| `GET` | `/api/live` | agents holding `verified_live` under the current formula at their latest stored check |
| `GET` | `/api/search` | agents whose live endpoint served a matching capability |
| `POST` | `/api/verdicts` | stored verdicts for up to 200 agents |
| `GET` | `/api/history/{chainId}/{tokenId}` | recent checks and the day calendar |

### Calls that spend — [details](/docs/api/checks)

| Method | Path | Spends |
| --- | --- | --- |
| `GET` | `/api/agents/{chainId}/{tokenId}` | registry budget; one listing, cached for five minutes |
| `GET` | `/api/registry/agents` | registry budget; paginated BSC listing or keyword search |
| `GET` | `/api/registry/search` | registry budget; semantic search on BSC |
| `GET` | `/api/registry/stats` | registry budget; inventory counts, cached for one minute |
| `GET` | `/api/verify/{chainId}/{tokenId}` | registry budget + a probe of the agent's server |
| `GET` | `/api/agent-meta/{chainId}/{tokenId}` | registry budget |
| `GET` | `/api/activity/{chainId}/{tokenId}` | the operator's node credits |
| `GET` | `/api/try/{chainId}/{tokenId}/interface` | registry lookup and live MCP tool discovery, including reviewed `taskPresets` |
| `POST` | `/api/try/{chainId}/{tokenId}` | registry lookup and provider call; returns a dated observation and task checks for reviewed presets |

### Machine-facing surfaces — [details](/docs/machine)

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/openapi.json` | OpenAPI 3.1 for every endpoint above |
| `GET` | `/.well-known/agent-card.json` | this service's own agent card |
| `POST` | `/mcp` | MCP over streamable HTTP, JSON-RPC 2.0 — see [MCP server](/docs/mcp) |

## Conventions

### Identifying an agent

An agent is addressed by chain id and token id. In paths they are two segments; everywhere else they
are one string:

```
56:153649          the key, used in POST /api/verdicts and every MCP tool
/api/verify/56/153649    the same agent as a path
```

Both parts are numeric and validated as such. A non-numeric segment gets `400` with
`{"error":"chainId and tokenId must be numeric"}` rather than being coerced.

Only BNB Chain (`56`) is observed today. Asking for another chain does not error everywhere. The
activity feed answers with `attribution.gate: "unsupported-chain"`, which is a named reason rather
than an empty result.

### Requests

- `GET` for everything except `POST /api/verdicts`, `POST /api/try/…` and `POST /mcp`.
- JSON bodies only, capped at 32 KB. Send `content-type: application/json`.
- No custom headers are required or read. There is nothing to authenticate.

### Responses

- JSON in UTF-8, except verification `?stream=1` and MCP responses that use server-sent events.
- Fields are tri-state: `true`, `false`, or `null`/absent for **not checked**. This is the rule
  callers break most often; see [Honesty rules](/docs/honesty).
- Every verdict carries `formulaVersion` and a timestamp. Compare versions before comparing tiers.
- Timestamps are ISO 8601 in UTC.
- Amounts that come from an agent's own hire menu (`minPriceU`) are integer strings in the payment
  token's smallest unit, never numbers: a price authored by the party being assessed goes nowhere
  near a float.
- Try POST handled outcomes normally use HTTP `200`; read envelope `status`, `observation.outcome`,
  `observation.task` and `captureComplete`. HTTP success alone is not task success. See
  [observations and downloadable results](/docs/api/checks#observations-and-downloadable-results).

## Errors

| Status | Body | What it actually means |
| --- | --- | --- |
| `400` | `{"error":"chainId and tokenId must be numeric"}` | malformed path parameters |
| `400` | `{"error":"too many keys (max 200)"}` | `POST /api/verdicts` was given more than 200 keys |
| `404` | `{"error":"agent not found"}` | the registry has no such agent |
| `404` | `{"error":"agent-not-found","source":"8004scan"}` | the registry detail lookup has no such agent |
| `405` | `{"error":"method-not-allowed"}` | `GET /mcp`. The MCP server is stateless and opens no server-to-client stream; `POST` instead |
| `429` | rate limit body with `Retry-After` | you asked too fast. Not about the agent |
| `502` | `{"error":"verification-failed"}` | a check ran and could not complete |
| `502` | `{"error":"agent-timeout"}` | a request timed out; this does not establish permanent provider unavailability |
| `502` | `{"error":"interface-failed"}` / `{"error":"try-failed"}` | the relay could not complete a call to the agent |
| `502` | `{"error":"metadata-unavailable","source":"agent-metadata","retryable":true}` | the metadata document could not be read; hire-menu availability is unknown |
| `502` | `registry-unavailable`, with `source: "8004scan"` and `retryable: true` | a registry lookup could not complete |
| `502` | `registry-invalid-response`, with `source: "8004scan"` and `retryable: false` | the upstream identity, page or payload failed validation |
| `503` | `{"error":"registry-throttled"}` with `Retry-After` | **our** upstream is rate limiting us. Never a claim that an agent is broken |

Registry failures forwarded by detail, browsing, verification or metadata routes carry bounded
codes and attribution; they do not expose upstream credentials or internal error messages.
Other verification/metadata errors and uncaught relay route errors can carry a `detail` string.
Handled Try POST failures instead appear inside its HTTP `200` envelope, with a failed observation.
Inspect the failure phase before attributing a problem to the provider: an unavailable registry can
prevent a provider call from ever being attempted. See [Calls that spend](/docs/api/checks).

`402` is not an error here. It is an agent asking to be paid, and it carries that agent's own x402
challenge; see [Try one, then hire it](/docs/guides/hire).

## Where to go next

- [Reads that cost nothing](/docs/api/reads) — the endpoints to build a browse experience on.
- [Calls that spend](/docs/api/checks) — a fresh check, its streamed narration, and the relay.
- [The verdict object](/docs/api/verdict) — every field, and what it is evidence of.
