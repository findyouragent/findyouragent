# Reads that cost nothing

> These endpoints serve this service's own stored records. No upstream call, so they
> spend no upstream registry budget. Deployment-level limits and availability still apply.

Build your browse experience on these. Nothing here triggers an upstream check. JSON examples
illustrate the schema; sample counts and formula versions are not current measurements.

## `GET /health`

Liveness, the formula version currently in force, and the state of the background sweep.

```bash
curl -s {{API}}/health
```

```json
{
  "ok": true,
  "formulaVersion": "0.8",
  "sweep": { "queued": 812, "awaitingRecheck": 0, "swept": 4812, "considered": 9310, "callable": 74 }
}
```

The formula version is published *by the service* so that nothing else has to hardcode it. If your
integration displays a version, read it from here rather than from your own constant.

| Field | Meaning |
| --- | --- |
| `sweep.considered` | registry entries the sweep has walked past |
| `sweep.callable` | of those, how many declared an endpoint worth probing |
| `sweep.swept` | checks the sweep has actually run |
| `sweep.queued` | agents waiting to be checked |
| `sweep.awaitingRecheck` | stored verdicts computed under a superseded formula |

## `GET /api/summary`

Headline counts and per-category coverage, from stored verdicts under the current formula only.

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
    "rebalancing": { "agents": 12, "served": 2, "declared": 10, "endpointProven": 3, "verifiedLive": 1 },
    "grid":        { "agents": 8,  "served": 3, "declared": 5,  "endpointProven": 4, "verifiedLive": 2 },
    "yield":       { "agents": 41, "served": 6, "declared": 35, "endpointProven": 6, "verifiedLive": 2 },
    "health":      { "agents": 5,  "served": 1, "declared": 4,  "endpointProven": 1, "verifiedLive": 0 }
  },
  "formulaVersion": "0.8",
  "sweep": { "queued": 812, "awaitingRecheck": 0, "swept": 4812, "considered": 9310, "callable": 74 }
}
```

`checksRun` counts every check ever run; `uniqueChecked` counts distinct agents. The two differ by
however many times each agent has been re-checked, and quoting the first as if it were the second
would overstate coverage by an order of magnitude.

Coverage columns narrow left to right — `agents` ⊇ `endpointProven` ⊇ `verifiedLive`, with `served`
and `declared` splitting `agents` by how the placement was earned. Every judged category is listed
even when empty, because omitting the empty ones would hide the least flattering result. See
[Core concepts](/docs/concepts#coverage-and-what-each-column-counts).

## `GET /api/checked`

The default browse list: agents we hold a current verdict for, best first.

```bash
curl -s "{{API}}/api/checked?limit=50"
```

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer | `50` | clamped to 1–100 |

Rows are ordered by what was **proven**: top tier first, then agents whose endpoint answered, then by
how much evidence backs them, then by how many categories they earned. Agents at `registered` with
no proven endpoint are excluded entirely, as are verdicts computed under a superseded formula.

This ordering is the site's own judgement rather than the registry's. Sorting by "newest" put
twenty-five auto-generated nameplates on the front page, which is exactly what this project claims
to filter out.

Each row uses the shared row shape:

```json
{
  "chain_id": 56,
  "token_id": "153649",
  "name": "Venus Protocol Agent",
  "avatarUrl": "https://…/agent.png",
  "hireable": true,
  "minPriceU": "500000000000000000",
  "servedNames": ["get_lending_positions", "get_borrow_balance"],
  "tier": "verified_live",
  "endpointProven": true,
  "endpointKind": "mcp",
  "capability": { "kind": "mcp", "noun": "tools", "declared": 12, "matched": 12, "servedCount": 14, "coverage": 1, "missing": [], "extra": [] },
  "categories": [{ "category": "yield", "basis": "served" }],
  "proofs": [{ "signal": "capability_integrity" }],
  "latencyMs": 412,
  "checkedAt": "2026-09-03T18:22:10.441Z",
  "formulaVersion": "0.8"
}
```

`hireable: null` means the card could not be read — not "not hireable". `minPriceU` is `null`, never
`0`, when no offering publishes a usable price: a row must be able to say nothing rather than imply
free work.

## `GET /api/live`

Agents whose endpoint answered on the most recent check and hold `verified_live` **under the current
formula**. Up to 100 rows, newest check first, same row shape as above.

```bash
curl -s {{API}}/api/live
```

A top-tier verdict earned under rules that have since been rejected is not a verdict this service
still stands behind, and this is the most prominent claim on the site, so the version filter here is
strict rather than lenient.

## `GET /api/search`

The distinguishing search: it matches capability names an endpoint **actually served** when we asked
it, not registry text.

```bash
curl -s "{{API}}/api/search?q=lending"
```

| Parameter | Type | Notes |
| --- | --- | --- |
| `q` | string | tokenised on non-alphanumerics; tokens shorter than three characters, and English glue, are ignored |

```json
{
  "q": "lending", "count": 3,
  "agents": [{ "…": "row shape", "matchedTool": "getLendingPositions",
               "matchedTerms": ["lending"], "sameToolList": 0 }]
}
```

A term matches at a **word start**, using the same normalisation that decides category placement, so
`swap` does not match `pancakeswap`. Common glue words such as `for` are removed. A query consisting
only of glue words returns no rows.

Ranking is by the **single most informative capability** a row serves that your query named — the
rarer a term is across the distinct capability sets we hold, the more a match on it counts. Ties fall
to tier, then to whether the endpoint answered, then to what the rest of that row's matches add up
to, then to how recently it was checked. Breadth is a tiebreak. The number itself
is never published; the row carries the two facts that justify its place, which are the tool that
matched and the tier.

One thing this deliberately does not do is privilege an agent's **name**. A query naming a protocol
is answered here only by what endpoints served, so `venus` finds an agent that serves
`get_venus_balance`, not one called "Venus" that serves nothing. Name matching is the registry's job,
and merging the two would be this endpoint quietly ranking on the marketing text it exists to refuse.

Agents serving an **identical** tool list collapse to one row, because they are one operator far more
often than they are independent choices. `sameToolList` is how many others were folded into that row;
in the live corpus one such fleet is 267 agents. Up to 25 rows, counted after the collapse.

`matchedTool` is the whole point: it is a name that agent's endpoint returned to us, so the match can
be inspected alongside its source and timestamp. Registry text search is available separately.

Two limits stated plainly: agents checked before this service began recording served names do not
participate — they are unknown, not "serve nothing" — and an empty `q`, or one with no token of three
characters, returns no rows rather than everything.

## `POST /api/verdicts`

Stored verdicts for a page of agents, in one request. This is the endpoint to use when rendering a
list; it never triggers a check.

```bash
curl -s {{API}}/api/verdicts \
  -H 'content-type: application/json' \
  -d '{"keys":["56:153649","56:98765"]}'
```

| Field | Type | Notes |
| --- | --- | --- |
| `keys` | string[] | up to 200, each matching `^\d+:\d+$`. Malformed keys are dropped, not errors |

```json
{ "verdicts": { "56:153649": { "tier": "verified_live", "…": "…", "fromStore": true } } }
```

**A key we have never checked is simply absent from the response.** It is not mapped to a null row or
a zeroed score, because absence is the honest representation of "not checked". Iterate the object you
got back rather than assuming every key you sent has an entry.

Rows carry `fromStore: true` and a deliberately partial `evidence` object — the full record is one
`/api/verify` away, and re-probing every row would misrepresent how fresh this is.

More than 200 keys gets `400 {"error":"too many keys (max 200)"}`.

## `GET /api/history/{chainId}/{tokenId}`

Recent checks for one agent, plus the day calendar.

```bash
curl -s {{API}}/api/history/56/153649
```

```json
{
  "checks": [
    {
      "key": "56:153649",
      "ts": "2026-09-03T18:22:10.441Z",
      "tier": "verified_live",
      "formulaVersion": "0.8",
      "endpointProven": true,
      "endpointKind": "mcp",
      "latencyMs": 412,
      "probe": { "declared": true, "spoke": true, "reason": null },
      "proofs": ["capability_integrity"]
    }
  ],
  "uptime": {
    "days": [
      { "d": "2026-09-01", "c": "o", "n": 4, "ok": 4, "ms": 380 },
      { "d": "2026-09-03", "c": "x", "n": 2, "ok": 0, "ms": null }
    ],
    "summary": { "checkedDays": 12, "answered": 11, "unreachable": 1, "servedNothing": 0,
                 "firstDay": "2026-08-23", "lastDay": "2026-09-03" }
  }
}
```

Checks are newest first and capped at twenty. `latencyMs` belongs to whichever probe actually proved
the endpoint, and `probe` keeps the raw facts the calendar is classified from: whether the agent
*declared* anything callable, and whether its server *spoke* at all — a 404 or a malformed body is a
reply, a timeout is silence, and the two are never coloured alike. The calendar is oldest day first, and **a day we did not check
has no entry at all** — there is deliberately no value a renderer could mistake for a reading.

| `c` | Day outcome |
| --- | --- |
| `o` | the endpoint answered |
| `?` | unreachable — a timeout, which we treat as neutral |
| `x` | answered and served nothing — the only outcome recorded against the agent |

`n` is how many checks ran that day, `ok` how many answered, `ms` the representative latency. The
denominator travels with the number because the sample is not controlled: a cache hit suppresses a
check, backoff drops ticks, and a visitor opening the page adds one.

See [Watch an agent over time](/docs/guides/monitor) for how to build on this without misreading it.

## `GET /api/escrow/{address}`

What one wallet actually did on the ERC-8183 escrow, read from the kernel's job records. A hire menu
is what an agent says it will do; this is what was opened against it and how it ended.

```bash
curl -s {{API}}/api/escrow/0x1F3CBddCb9257A54d10325f900F6364C1d86BdC0
```

```json
{ "address": "0x1f3cbddcb9257a54d10325f900f6364c1d86bdc0",
  "available": true, "found": true,
  "record": { "jobs": 7, "released": 6, "rejected": 0, "expired": 0, "inflight": 0,
              "lapsed": 1, "earnedWei": "6000000000000000000", "lastJobId": 56560 },
  "range": { "topId": 56720, "floorId": 1, "jobs": 56720, "asOf": "2026-09-08T12:00:00Z",
             "kernel": "0xEa4DAa3100A767e86FDed867729ae7446476EBA6", "whole": true, "unread": 0 } }
```

**Three states, and collapsing any two of them puts a claim on an agent that the chain never made.**
`available: false` means no census has been collected on this deployment — a gap in ours. `found:
false` means the range was searched and this address is not in it, which is *absent from a range*,
not zero jobs; `range` is returned with it so you can see how much of the escrow that covers.
Only a `record` is a measurement.

| Field | Meaning |
| --- | --- |
| `released` | the escrow paid out — **not** a rating, see below |
| `rejected` | the buyer rejected the delivery |
| `expired` | the job reached its expiry unsettled |
| `inflight` | open, funded or submitted, still inside its expiry |
| `lapsed` | still open on the contract but past the expiry its own buyer set |
| `earnedWei` | sum of the budgets of released jobs, exact decimal string, 18 decimals |
| `range.unread` | job ids the chain would not answer for; above zero, every count is a floor |

`released` is the contract's `completed` status, which arrives on its own once the seven-day dispute
window closes — [the exhibit job on this site](/docs/guides/hire) was disputed and released anyway.
It says money moved, not that a buyer was happy. A released job can also carry a **zero budget**, so
`released` and `earnedWei` answer different questions.

There is deliberately **no success rate**. Chain-wide only about a third of jobs on this contract
reach `completed`; the rest sit open, funded or submitted at any moment, so a percentage over jobs
created would score a provider for jobs the buyer never funded. The counts carry their own
denominator instead.

`GET /api/escrow?limit=20` returns the working providers across the whole census — ours and
everyone else's — as `{ available, rows, range, providers }`, sorted by `released`, with idle
addresses omitted. Both endpoints read a snapshot file produced out of band by `escrow-census.mjs`,
so neither spends a chain call or the registry budget.
