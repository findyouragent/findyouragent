# Watch an agent over time

> A check records one observation. A calendar shows the observations over time, with gaps for days
> when FYA did not check. It is sampled history, not continuous uptime monitoring.

## The shape of the data

```bash
curl -s {{API}}/api/history/56/153649
```

```json
{
  "checks": [{ "ts": "2026-09-03T18:22:10.441Z", "tier": "verified_live", "latencyMs": 412,
               "probe": { "declared": true, "spoke": true, "reason": null } }],
  "uptime": {
    "days": [
      { "d": "2026-08-30", "c": "o", "n": 4, "ok": 4, "ms": 380 },
      { "d": "2026-09-01", "c": "?", "n": 1, "ok": 0, "ms": null },
      { "d": "2026-09-02", "c": "x", "n": 3, "ok": 0, "ms": null }
    ],
    "summary": { "checkedDays": 9, "answered": 7, "unreachable": 1, "servedNothing": 1,
                 "firstDay": "2026-08-23", "lastDay": "2026-09-02" }
  }
}
```

Note what is not there: **2026-08-31 has no entry at all.** Nothing was checked that day, and there
is deliberately no value a renderer could mistake for a reading.

## The three day states, and the one that is theirs

| `c` | Name | Whose finding |
| --- | --- | --- |
| `o` | the endpoint answered | theirs, and good |
| `?` | unreachable — a timeout | **nobody's**. Treated as neutral |
| `x` | answered, and served nothing | theirs, and the only outcome recorded against them |
| *(absent)* | we did not check | **ours** |

A timeout is neutral on purpose. From a single vantage point, "their server went quiet" and "our
egress had a bad minute" are not distinguishable, and colouring the ambiguity red would be a claim
we cannot support. Only a server that answered and then served nothing has demonstrated something
about itself.

## Rendering the observed history

**Never fill gaps.** Do not interpolate, do not carry the previous day forward, do not paint a
missing day grey-as-in-down. If your calendar needs a shape for "no data", give it one that reads as
absent — an empty cell, a hairline, a dot.

**Always show the denominator.** The sample is not controlled: a cache hit suppresses a check,
backoff delays checks, and a visitor may trigger a new check. So `summary` carries `checkedDays`,
`answered`, `unreachable` and `servedNothing` rather than a percentage.

If you must show a percentage, show it as a fraction with its window:

```
answered on 7 of 9 days checked, 2026-08-23 to 2026-09-02
```

not

```
78% uptime
```

The second is not something a reader could re-derive, and over a nine-day sample of an uncontrolled
process it implies a precision that does not exist.

## Polling without spending anything

`GET /api/history/…` reads records the service already holds and makes no upstream registry call.
It supports polling without spending that allowance; deployment-level limits still apply.

What you must **not** do is loop `GET /api/verify/…` to build your own history. That endpoint spends
a registry allowance shared with the background sweep and visitors. Repeated fresh checks consume
capacity needed to maintain the stored corpus.

The division is simple:

| You want | Call |
| --- | --- |
| the history we have | `/api/history/{chainId}/{tokenId}` — no upstream registry calls |
| the verdicts for a list of agents | `POST /api/verdicts` — free, up to 200 keys |
| one check, right now, for a human | `/api/verify/{chainId}/{tokenId}` — rate limited |

Known agents become eligible for rechecking after 24 hours, or when their formula version is
obsolete. A separate queue revisits oldest checks first. Budget, backoff and backlog determine the
actual delay. The `sweep.recheckDue` snapshot and `recheckDueAsOf` in `/api/summary` report the backlog;
stored classifications retain their original timestamp while they wait.

If you need denser sampling, run your own instance with its own registry allowance. Mount persistent
storage configured by the operator and transfer history when moving deployments. A fresh deployment may load a bundled
seed, but does not inherit your local history.

## Watching a fleet

```bash
curl -s {{API}}/api/live
```

Agents whose endpoint answered on the most recent check and hold `verified_live` under the current
formula. Newest check first, up to 100.

For a specific watchlist, batch it:

```js
const { verdicts } = await (await fetch(`${API}/api/verdicts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ keys: watchlist }),  // up to 200
})).json();

for (const key of watchlist) {
  const v = verdicts[key];
  if (!v) { report(key, 'never checked'); continue; }          // absent, not zero
  const ageMs = Date.now() - Date.parse(v.checkedAt);
  report(key, v.tier, { age: ageMs, formula: v.formulaVersion });
}
```

Two things to alert on, and one not to:

- **Alert on a tier drop** — but only between verdicts carrying the **same** `formulaVersion`. A
  drop across a version change may be the rules getting stricter rather than the agent getting
  worse.
- **Alert on staleness.** If `checkedAt` stops advancing, that is about our coverage and worth
  knowing, but it is not a signal about the agent.
- **Do not alert on a missing key.** It means never checked.

## When the formula changes

Every verdict carries the version it was computed under. When the rules change, older verdicts are
withdrawn from headline counts until they are recomputed, and `awaitingRecheck` in
[`/api/summary`](/docs/api/reads) counts how many are waiting.

For a monitor, that means a version bump will look like a fleet-wide event: counts drop, then refill
as the re-sweep drains. Read `formulaVersion` from
[`/health`]({{API}}/health) alongside your alerting so you can tell that apart from an outage.

## On-chain activity, if the agent has a proved wallet

```bash
curl -s {{API}}/api/activity/56/153649
```

Read `attribution.gate` before `events`. Five of its seven states are about *us* — no verdict, no
proved wallet, no wallet yet, unconfigured, chain unreachable — and an empty `events` array means
nothing until you know which one you are in. `coverage` states the exact block window scanned, so
"no activity" is always bounded by a range you can see rather than being an open-ended claim.
