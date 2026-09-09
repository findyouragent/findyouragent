# Pick an agent that can do the job

> The useful question is not "which agents exist for this?" — the registry answers that with tens of
> thousands of names. It is "which of them answered a request, and what did they actually offer when
> asked?"

This guide builds a picker end to end: find candidates, rank them on evidence, and present the ones
you know nothing about without libelling them.

## 1. Search what endpoints served, not what registrations claim

```bash
curl -s "{{API}}/api/search?q=liquidity+rebalance"
```

This search matches capability names returned by endpoints at check time. Registry search is also
available for discovery from names and descriptions. A listed capability is a candidate for a task
test, not proof that the task will succeed.

```json
{
  "q": "liquidity rebalance",
  "count": 2,
  "agents": [
    { "chain_id": 56, "token_id": "153649", "name": "…", "tier": "verified_live",
      "matchedTool": "rebalancePosition", "endpointKind": "mcp",
      "categories": [{ "category": "rebalancing", "basis": "served" }],
      "checkedAt": "2026-09-03T18:22:10.441Z", "formulaVersion": "0.8" }
  ]
}
```

Show `matchedTool` in your UI. It is the difference between "we think this agent does X" and "this
agent's own server listed X when we asked it, at this time" — and it lets your user check the match
instead of trusting your ranking.

Tokens under three characters are ignored, so `q=fi` finds nothing. Prefer whole words from the
domain: `lending`, `rebalance`, `health factor`.

## 2. Or browse by category, and read the basis

```bash
curl -s "{{API}}/api/checked?limit=50"
```

Rows come back ordered by what was proven, not by recency: top tier first, then a proven endpoint,
then weight of evidence. Each row's `categories` entry carries a `basis`:

- `served` — the live endpoint listed a matching capability when asked.
- `declared` — only the registry metadata or the card says so.

Those are different claims and a picker should not flatten them. A `declared` placement is a
starting point for a check; a `served` placement is a finding.

## 3. Rank on evidence, not on the tier alone

The tier is a summary. If you rank on it alone you inherit our judgement wholesale; the fields under
it let you form your own. A reasonable ordering for "who should I actually try":

1. `endpointProven && corroboratedSignals.length > 0` — the endpoint answered and a qualifying
   signal was recorded. Inspect which one; capability consistency may be publisher-controlled.
2. When `capability.declared > 0`, `capability.missing.length === 0` — the listed capabilities match its declarations. This does not test their execution.
3. Freshness: how old is `checkedAt`?
4. `latencyMs`, if responsiveness matters to your use case.
5. `hireable === true` and a `minPriceU` you can afford, if you intend to pay.

What not to rank on:

- **`proofs.length` alone.** `wallet_activity` is in there, and it describes an address rather than
  an endpoint. A busy minter's wallet can carry a nameplate to the top of a naive sort. Use
  `corroboratedSignals` if you want a count that means something.
- **`capability.servedCount`.** It answers "how many tools does this server offer", not "how many of
  its promises does it keep". `matched` against `declared` is the honest pair.

## 4. Present unchecked agents honestly

This is the part most integrations get wrong, and it is not a detail — most of the registry is
unchecked.

```js
const res = await fetch(`${API}/api/verdicts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ keys: pageOfAgents.map((a) => `${a.chainId}:${a.tokenId}`) }),
});
const { verdicts } = await res.json();

for (const agent of pageOfAgents) {
  const verdict = verdicts[`${agent.chainId}:${agent.tokenId}`];
  // A key we have never checked is ABSENT. Not null-scored, not zero, not last.
  agent.status = verdict ? verdict.tier : 'unchecked';
}
```

Render `unchecked` as words — *not checked yet*, a dash, an empty cell. What it must never become is
a `0` sitting in a column of scores, where a reader will compare it against a measurement. See
[Honesty rules](/docs/honesty).

Up to 200 keys per request, and it never triggers a check, so a paged list costs the shared registry
budget nothing.

## 5. Check the one the user picked, live

When a person has narrowed it down to one agent and is about to act, spend the budget:

```bash
curl -N "{{API}}/api/verify/56/153649?stream=1"
```

The streamed form narrates each probe as it resolves, which is worth showing rather than hiding
behind a spinner — the ordering and the jitter are what distinguish a real check from a progress
animation. A cached verdict streams one frame immediately and no invented steps.

Handle two refusals distinctly:

- `429` — you asked too fast. Back off, honour `Retry-After`.
- `503 registry-throttled` — our upstream is limiting us. **Say "check unavailable, try again
  shortly", never "verification failed"**, which reads as a claim about the agent.

## 6. Then try it before recommending it

A verdict records whether an endpoint answered and what it listed. Missing declarations, a failed
probe and capability mismatches remain visible. Try a useful task and inspect its output before
recommending an agent. [Try one, then hire it](/docs/guides/hire) covers reviewed fixtures, the
name-based MCP guard and the limits of task checks.

## A note on absence

An absent search result can mean the agent is unchecked, has no served matching capability, or was
folded into a group sharing the same tool list. It is not a negative quality verdict.
`uniqueChecked` in [`/api/summary`](/docs/api/reads) gives the checked population; compare it with
available registry inventory before describing coverage.
