# Honesty rules

> Four semantics this API will not bend. Each one names a specific way correct data becomes a lie on
> the way to a screen, and each is a bug on the caller's side when it happens.

If you read nothing else here, read this page. It is shorter than the reference and it is where
integrations actually go wrong.

## 1. Unknown is `null`, never `0`

Every checkable field is tri-state:

| Value | Meaning |
| --- | --- |
| `true` | checked, and it held |
| `false` | checked, and it failed |
| `null` or absent | **not checked** |

Rendering `null` as `0`, as `false`, or as a bottom-rank score is the specific bug this whole project
exists to argue against. An agent nothing has been checked on is not a bad agent; it is an agent we
have not reached. Compare stored coverage with available registry inventory rather than assuming
that every indexed identity has been checked.

Where it shows up:

- `hireable: null` means the agent's card could not be read. It does not mean "not hireable".
- A verdict absent from `POST /api/verdicts` means never checked. The key is simply missing from the
  response object rather than mapped to a zeroed row.
- `wallet.agentsOwned: null` means the registry did not tell us how many agents that address owns.
  The formula then emits **no wallet proof at all**, rather than falling back to the most permissive
  threshold exactly when it knows least.
- `attribution.gate` on the activity feed is a named reason, never an empty list of events. See
  rule 4.

**What to render instead.** "Not checked" is a real state and deserves real words: *unchecked*, *no
verdict yet*, a dash, an empty cell. What it must never be is a zero sitting in a column of scores,
where a reader will compare it against a measurement.

## 2. A `503` is a wait, not a verdict

This service reads the registry through an allowance shared by the background sweep and visitors.
The deployment's key and service tier determine that allowance; the upstream `X-RateLimit` headers
are authoritative. When it is throttled, a check cannot be completed and the response says so:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 15

{ "error": "registry-throttled",
  "detail": "The agent registry is rate limiting reads. This is temporary; try again shortly." }
```

That is a statement about **our upstream budget**. It is not a statement about the agent you asked
about. Calling it "verification failed" in your UI would read as "this agent is broken", which is
the opposite of true.

The same applies to `429` from our own per-IP limiter: you asked too fast, and the agent is not
implicated. Both carry `Retry-After`; honour it.

## 3. A verdict is dated, and describes an observation

Every verdict carries the time it was computed (`computedAt` on a fresh check, `checkedAt` on a
stored row) and the `formulaVersion` it was computed under. Neither is decoration.

- **A stored verdict is not a claim about now.** Endpoints change. If freshness matters to your use
  case, either re-check through `GET /api/verify/{chainId}/{tokenId}` or show the age next to the
  tier. A badge without a date is the context-free artefact this site was built to argue against.
- **Compare versions before you compare tiers.** A `verified_live` earned under rules that have
  since been rejected is not a verdict this service still stands behind, which is why such rows are
  withdrawn from headline counts until rechecked.

And what a verdict says is narrower than it looks. What this service holds is:

> *"This endpoint did not answer when we called it at 14:02."*

What it does not hold, and what you should not print:

> *"This agent is dead."*

## 4. A gap is our sampling, never their downtime

The uptime calendar has **no entry** for a day nothing was checked. This is structural rather than a
convention: there is no value the renderer could mistake for a reading, so our own outage, a rate
limit, or a paused sweep can never be drawn as the agent being down.

```json
{ "days": [{ "d": "2026-09-01", "c": "o", "n": 4, "ok": 4, "ms": 380 }],
  "summary": { "checkedDays": 12, "answered": 11, "unreachable": 1, "servedNothing": 0,
               "firstDay": "2026-08-23", "lastDay": "2026-09-03" } }
```

Note that the denominator travels with the number. The sample is not controlled — a cache hit
suppresses a check, backoff drops ticks, a visitor opening a page adds one — so a bare percentage
over four days is not something a reader could re-derive.

A timeout is recorded as neutral (`?`), not as a failure. From a single vantage point our own egress
and their server going quiet are indistinguishable, so only a day where their server answered and
served nothing (`x`) is recorded against them.

The activity feed applies the same rule through `attribution.gate`, which always names why a feed is
empty:

| Gate | What it means |
| --- | --- |
| `verified` | events below are attributable to this agent's own proved wallet |
| `no-verdict` | never checked, so there is no proved wallet to attach activity to |
| `no-proved-wallet` | no on-chain wallet is provably this agent's |
| `no-wallet-yet` | its token-bound wallet has not been created on-chain yet |
| `unsupported-chain` | we only observe BNB Chain (56) |
| `unconfigured` | the activity feed is not enabled on this deployment |
| `not-checked` | we could not reach the chain just now — about our check, not the agent |

Five of those seven are about **us**. An empty `events` array on its own means nothing until you have
read the gate.

## Why this is written down

Because the failure mode is not malice, it is a default. A dashboard renders a missing number as
zero, a badge is screenshotted without its date, a throttle is caught by a generic error handler and
printed as "unavailable". Each is one line of code, and each turns a careful measurement into a
claim about a third party that nobody actually checked.

These rules are also applied to us. This service publishes its own coverage gaps, its own
`awaitingRecheck` count, and its own throttle state, and it declares no interface it does not serve
— see [Machine-readable surfaces](/docs/machine).
