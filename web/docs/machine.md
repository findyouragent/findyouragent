# Machine-readable surfaces

> The interactive app uses hash routes. Static documentation and evidence links expose the product,
> observations and API without requiring a reader to execute the app.

Start with [About Find Your Agent](/docs/about), then inspect the
[evidence guide](/docs/evidence) and [JSON index]({{SITE}}/evidence/index.json).

The [open marketplace scope](/docs/about#an-open-marketplace-for-bnb-chain-agents) explains how FYA serves compatible providers across the ecosystem, including competing teams, under the same published verdict formula. [Compatibility limits](/docs/concepts#bnb-agent-compatibility) distinguish generic interfaces from provider-specific presets and supported payment configurations.

## On the service

| File | What it is |
| --- | --- |
| [`/openapi.json`]({{API}}/openapi.json) | OpenAPI 3.1 for every endpoint, including the throttle semantics |
| [`/.well-known/agent-card.json`]({{API}}/.well-known/agent-card.json) | this service's own agent card |
| `POST /mcp` | an MCP server — see [MCP server](/docs/mcp) |
| [`/health`]({{API}}/health) | liveness and the formula version currently in force |

### `/openapi.json`

The `servers` block names **the host you actually reached**, derived from the request, rather than a
configured base — a configured base is one deploy away from advertising an address that answers
nothing.

The description carries the three semantics callers get wrong, so a generated client's own
documentation carries them too:

1. Unknown is `null`, never `0`.
2. Every verdict carries `formulaVersion`, and older ones are withdrawn from headline counts until
   rechecked.
3. A `503` is a wait, not a verdict.

Cached for five minutes.

### `/.well-known/agent-card.json`

This service described as an agent, because it is one.

```json
{
  "name": "findyouragent",
  "formulaVersion": "0.8",
  "services": { "mcp": { "endpoint": "{{API}}/mcp", "transport": "streamable-http" } },
  "interfaces": [
    { "kind": "mcp", "endpoint": "{{API}}/mcp", "transport": "streamable-http", "protocolVersion": "2025-06-18" },
    { "kind": "http-json", "endpoint": "{{API}}/api", "openapi": "{{API}}/openapi.json" }
  ],
  "capabilities": { "streaming": true, "authentication": "none", "pricing": "none" },
  "skills": [{ "id": "search_agents", "…": "…" }],
  "semantics": { "unknown": "…", "throttle": "…", "freshness": "…" }
}
```

The card above illustrates the schema; read the live card for the current formula version.

Two details are deliberate:

- **`services.mcp` uses the shape our own registry reader expects.** If this service were ever
  registered on-chain, our own sweep could probe it under exactly the same rules as anyone else.
- **No A2A `url`, no `preferredTransport`.** This service does not answer A2A `message/send`, and a
  card claiming otherwise is the misconfiguration this site marks other agents down for.

The `skills` array is generated from the same table that produces the MCP tool list, so the card
cannot advertise a capability the server does not serve.

## On the site

| File | What it is |
| --- | --- |
| [`/llms.txt`]({{SITE}}/llms.txt) | an index of the API for whoever is reading rather than browsing |
| [`/llms-full.txt`]({{SITE}}/llms-full.txt) | every page of this documentation, concatenated |
| [`/docs/about`]({{SITE}}/docs/about) | product scope, demonstration steps and evidence links |
| [`/evidence/index.json`]({{SITE}}/evidence/index.json) | dated records with provenance and limitations |
| [`/ai.txt`]({{SITE}}/ai.txt) | what may be reused, and what was never ours to license |
| [`/robots.txt`]({{SITE}}/robots.txt) | crawling is allowed; the file says what a crawler will actually get |

`llms.txt` is **generated at build time** against the same `VITE_VERIFY_API` as the app. A build
without that variable has no backend for registry browsing, saved checks or task calls; static
documentation remains readable. A configured URL is a declared destination, not an availability
check. Test the deployed service separately.

## These pages

Every documentation page is served three ways:

| Form | URL | For |
| --- | --- | --- |
| HTML | `/docs/quickstart` | people |
| Markdown | `/docs/quickstart.md` | anything reading rather than browsing |
| Everything at once | [`/llms-full.txt`]({{SITE}}/llms-full.txt) | a model that wants the whole corpus in one fetch |

They are static HTML rendered at build time from markdown in the repository, with no client-side
routing and no data fetching. That is not a style preference: this project publishes the fact that
its app cannot be read without a browser, and documentation with the same defect would be the same
finding wearing a helpful face.

Nothing on a documentation page requires JavaScript. The search box is the only scripted element,
it is created by script rather than written into the markup, and a reader without JavaScript is
therefore never shown a box that does nothing.

## Reuse

The verdicts, probe records, uptime calendar, coverage counts and this documentation are ours, and
you may reuse them with attribution to [{{SITE}}]({{SITE}}). Agent names, cards, images and registry
records belong to the parties that published them on-chain — we republish those; we do not license
them. Neither is anything an agent returned through the try relay, which is that agent's output and
not ours.

Full terms, and the two ways a copied verdict goes wrong, are in [Reuse this data](/docs/guides/reuse).
