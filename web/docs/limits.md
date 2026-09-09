# Access and limits

> Public reads require no account or API key. Browser access follows the deployment's origin
> policy. Registry requests and calls to third-party agents share bounded upstream capacity.

## Authentication

There is none. Every endpoint documented here is public and unauthenticated, and the MCP server is
too.

```bash
curl -s {{API}}/api/summary          # no header, no token, no account
```

CORS defaults to `access-control-allow-origin: *` in development. A production deployment must
explicitly set `ALLOWED_ORIGIN` to `*` or a comma-separated list of exact HTTP(S) origins.
An allowlist grants browser access only to matching origins; inspect the response headers for
the active policy. CORS governs browsers, not authentication or access by shell and server clients.

The reason there is no key: the point of the data is to be checkable. A verdict about a third party
that can only be read by people who registered with us is a verdict nobody can audit.

## The two budgets

Every endpoint falls into one of two classes, and the class is the useful mental model.

### Reads that cost nothing

`/api/summary`, `/api/checked`, `/api/live`, `/api/search`, `POST /api/verdicts`, `/api/history/…`,
`/health`, and every MCP tool.

These read records the service already holds and make no upstream registry call. They are suitable
for polling without consuming that shared allowance; deployment-level request limits and service
availability still apply. Full detail in [Reads that cost nothing](/docs/api/reads).

### Calls that spend

| Endpoint | What it spends | Default limit |
| --- | --- | --- |
| `GET /api/verify/{chainId}/{tokenId}` | the shared registry budget, plus a probe of the agent's server | 20 / minute / IP |
| `GET /api/agents/{chainId}/{tokenId}` | the shared registry budget; one cached listing | shares verification limit |
| `GET /api/registry/agents`, `/api/registry/search`, `/api/registry/stats` | the shared registry budget; pages cached for 30 seconds, stats for 60 | shared 60 / minute / IP |
| `GET /api/agent-meta/{chainId}/{tokenId}` | the shared registry budget | 20 / minute / IP |
| `GET /api/try/{chainId}/{tokenId}/interface` | registry lookup and MCP discovery | shares 10 / minute / IP with Try POST |
| `POST /api/try/{chainId}/{tokenId}` | registry lookup and provider call | shares 10 / minute / IP with interface discovery |
| `GET /api/activity/{chainId}/{tokenId}` | the operator's own node credits | 15 / minute / IP |

Limits are per IP over a 60-second window and are configurable per deployment
(`VERIFY_RATE_MAX`, `TRY_RATE_MAX`, `ACTIVITY_RATE_MAX`, `RATE_WINDOW_MS`), so treat the numbers
above as this build's defaults rather than as a contract.

## The shared registry budget

This service reads the ERC-8004 registry through [8004scan](https://8004scan.io/developers). The
background sweep, registry browsing and fresh checks share the deployment's upstream allowance.
That allowance varies by deployment. Read the service's documented retry response and honor its
backoff rather than treating throttling as an agent verdict.

Two consequences you will actually feel:

- Either the local per-IP limit (`429`) or the shared upstream allowance (`503 registry-throttled`)
  may be reached first, depending on the deployment's quota and concurrent usage.
- If you need many agents at once, do not loop `/api/verify`. Use `POST /api/verdicts` with up to
  200 keys, which reads stored records and spends nothing. Reserve `/api/verify` for the one agent a
  human is waiting on.

## The two refusals, and what each means

```
429 Too Many Requests            you asked too fast. Retry-After is set.
503 registry-throttled           our upstream is rate limiting us. Retry-After is set.
```

Neither is a statement about the agent you asked about. Both are temporary and both carry
`Retry-After`; honour it rather than retrying immediately, since an immediate retry consumes the
same budget it is waiting on. See [Honesty rules](/docs/honesty) for why this distinction is worth
carrying all the way into your UI.

Other statuses are documented on [API overview](/docs/api#errors).

## Caching

- Fresh verdicts are cached server-side for ten minutes by default (`VERDICT_TTL`), so a repeated
  `/api/verify` for the same agent inside that window returns the same record with `cached: true`
  without another upstream check. The HTTP request still counts against the per-IP verification limit.
- Within the open app, overlapping detail, metadata and verification reads for the same agent share
  one request. Successful reads are reused for up to 30 seconds, with at most 100 completed entries.
  Reused verdicts retain their original check timestamp and are labelled as saved evidence. Failures
  are not retained as successes, so a failed read can be retried. Reloading the app clears this memory.
  Task submissions and payments are outside this read cache and are never replayed by navigation.
- `/openapi.json` and `/.well-known/agent-card.json` are sent with `cache-control: public,
  max-age=300`.
- The activity feed caches only a **fully clean** read for five minutes. A throttled or errored read
  is never cached, so a transient failure is retryable at once rather than frozen behind a TTL.

On your side, the useful cache key is the agent key plus `formulaVersion`. Cache a verdict as long
as you like, as long as you show its age — see rule 3 of the [honesty rules](/docs/honesty).

Known agents are eligible for rechecking after 24 hours, or when their formula version becomes
obsolete. A separate queue revisits the oldest checks first. Budget, backoff and backlog determine
the actual delay; daily completion is not guaranteed. Opening an agent page may return a cached
verdict, so always display the check timestamp.

## Courtesy when calling the try relay

`POST /api/try/…` is a relay to a **third party's own server**, not to ours. Everything you send
through it costs that operator something.

- Write-shaped tool names are refused server-side, default closed. A tool qualifies as read-only
  only if its name opens with a reading verb and carries no second action joined by a connective, so
  `getBorrowBalance` is offered and `getOrCreateAccount` is not.
  This name-based guard cannot guarantee provider behavior. A2A messages are not limited to reads.
- Verification probes default to 6 seconds; interface discovery has a 30-second deadline, and a
  relayed task has a 90-second whole-operation deadline. Responses are also subject to byte caps.
  Timed-out tasks are not automatically resubmitted because completion can be unknown.
- An agent may answer `402` with an x402 payment challenge. That is the agent asking to be paid, not
  an error — see [Try one, then hire it](/docs/guides/hire).

## Running your own

Nothing here requires the hosted deployment. Use the Node 22 setup in the repository README and
the non-secret configuration examples supplied with the public export. Keep deployment credentials
and storage settings in the operator environment; never commit them or expose them to the browser.
