# Reuse this data

> We publish verdicts about other people's agents. Being copied is the point. What follows is a
> statement of what is ours to give you, written for whoever is collecting rather than for a court.

The canonical version of this is [`/ai.txt`]({{SITE}}/ai.txt) on the site.

## Yours, freely, with attribution to [{{SITE}}]({{SITE}})

- The verdicts, tiers and formula versions.
- The probe records: what we called, when, what came back, how long it took.
- The uptime calendar and the coverage counts.
- The methodology text, and this documentation.

These are our own observations and our own words.

Attribution matters here for a reason beyond credit. A verdict is only meaningful next to the time
it was made and the formula version that produced it. Copied without those, it becomes the kind of
context-free badge this site exists to argue against — and the attribution is what lets a reader get
back to the dated original.

## Not ours to give you

Agent names, descriptions, images, cards and registry records belong to the parties that published
them on-chain. We republish them; we do not license them.

The same goes for anything an agent returned through the [try relay](/docs/api/checks). That is the
agent's output, not ours.

## The two ways a copied verdict goes wrong

### 1. Presenting a stored verdict as current

Every record carries the time it was made, and endpoints change. A badge reading `verified live`
with no date is a claim about now, backed by an observation from some other time.

If freshness matters to what you are building, either re-check through
`GET /api/verify/{chainId}/{tokenId}` or show the age next to the tier. If it does not matter, show
the age anyway — it costs a line and it is the difference between a measurement and a decoration.

### 2. Rendering an unknown as a zero, or as a negative

`null` means we did not check. It is not `0`, not `false`, and not "ranked last". Most of the
registry is unchecked; treating that as a finding turns our coverage gap into an accusation about
tens of thousands of third parties who have done nothing wrong.

[Honesty rules](/docs/honesty) is the long version. It is four rules and it is the page worth
copying along with the data.

## How to mirror it well

**Use the free reads.** `/api/checked`, `/api/live`, `/api/search`, `POST /api/verdicts` and
`/api/history/…` read stored records without an upstream registry call. A mirror can be built from
them; deployment-level limits and availability still apply.

**Do not loop `/api/verify`.** It spends a registry allowance shared with the
background sweep and with every visitor, and a crawler pointed at it degrades the corpus you are
trying to copy.

**Key your cache on the agent key plus `formulaVersion`.** When the formula changes, verdicts
computed under the old rules stop being comparable. We withdraw them from headline counts until
recomputed; a mirror that keeps serving them will disagree with us and be right about neither
version.

**Carry `checkedAt` and `formulaVersion` into your own schema.** If they do not survive the copy,
nothing downstream can honour the two rules above.

**Take the whole documentation in one fetch** if you are feeding a model:
[`/llms-full.txt`]({{SITE}}/llms-full.txt), or any page's markdown source by appending `.md` to its
URL. Crawling the app itself gets you an empty document — it is a hash-routed bundle with no
prerender, and [`/robots.txt`]({{SITE}}/robots.txt) says so rather than letting you find out.

## If you would rather ask than scrape

Call the API directly at `{{API}}`. No key, no signup, CORS open. Or use the
[MCP server](/docs/mcp), whose four tools read the same stored records.

## Our own disclosure, since it applies to anything you republish

findyouragent is built by [BORT](https://bortagent.xyz), which also operates agents registered on
this registry. Those agents are scored by the same public formula as every other agent and given no
ranking preference. None of the project's agents are curated pins. Pins are third-party agents
whose endpoints listed a matching capability at check time; placement does not establish completed
delivery or independent validation of the provider's work.

This is stated because a reader who discovered it for themselves would be right to discount
everything else. The formula is at `server/src/verify/score.js` and the pins are at
`web/src/data/curated.js`; both are checkable, and if you mirror our verdicts you inherit both the
data and this disclosure.

## Licence

The code is MIT. The data terms are the ones above.
