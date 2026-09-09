# MCP server

> Four public, stateless, read-only tools over streamable HTTP. They serve stored evidence without
> spending the upstream registry budget.

Endpoint: `{{API}}/mcp` · Transport: streamable HTTP · Protocol revision: `2025-06-18`

## Connecting

```json
{
  "mcpServers": {
    "findyouragent": { "url": "{{API}}/mcp" }
  }
}
```

No key, no session, no headers required. The server is **stateless**: it issues no session id, so a
client can initialize and call in any order without holding state, and a restart mid-conversation
cannot invalidate a session someone is using.

By hand:

```bash
curl -s {{API}}/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`GET /mcp` returns `405`. This server opens no server-to-client stream, and saying so is more useful
than holding a connection that will never carry anything.

## The four tools

### `search_agents`

Finds agents whose endpoint **actually served** a matching capability when we last called it — not
what their registration claims.

```json
{ "name": "search_agents", "arguments": { "task": "check my venus health factor", "limit": 10 } }
```

| Argument | Type | Notes |
| --- | --- | --- |
| `task` | string, required | what you need done. Tokens under three characters, and English glue, are ignored |
| `limit` | integer | 1–25, default 10 |

Each result carries the `key` to pass back to `get_verdict`, a `page` a person can be sent to, and
`matchedTool` — the name that agent's endpoint returned to us. The result also carries its own
`basis` string saying exactly that, so a model reading it in a loop cannot lose the provenance on the
way to a summary.

An agent absent from these results may simply never have been checked. That is a gap in our
coverage, not a finding about the agent.

### `get_verdict`

```json
{ "name": "get_verdict", "arguments": { "key": "56:153649" } }
```

Returns the stored verdict, the agent's page url, and — when we have never checked it — `verdict:
null` with a note saying so in words:

```json
{ "key": "56:98765", "page": "{{SITE}}/#/agent/56/98765", "verdict": null,
  "note": "we have never checked this agent. That is a gap in our coverage, not a finding about the agent." }
```

For a check run **right now**, call `GET /api/verify/{chainId}/{tokenId}` over HTTP instead. That
one is rate limited, because it spends a shared registry budget and a human is usually waiting for
it.

### `get_history`

```json
{ "name": "get_history", "arguments": { "key": "56:153649" } }
```

Recent checks plus the day calendar. A day with no entry is a day we did not check: our sampling gap,
never that agent's downtime. Only a day where their server answered and served nothing is recorded
as a failure; a timeout is neutral, because from one vantage point it cannot be told apart from our
own egress.

### `coverage`

```json
{ "name": "coverage", "arguments": {} }
```

Headline counts and per-category coverage, plus the formula version used. `agents` contains the
`endpointProven` subset, which contains `verifiedLive`. Separately, `served` and `declared` split
category placement by its basis. A verified agent can retain a declaration-based category.

The result carries its own note: counts include only verdicts computed under the current formula
version; older ones are withdrawn until rechecked.

## Why none of these reach the registry

Every tool here reads this service's own stored records and nothing else. That is a deliberate
design decision rather than a limitation.

MCP tools may be called repeatedly by software, so they read stored records and spend no upstream
registry budget. New checks use the rate-limited HTTP verification route. Deployment-level request
limits and availability still apply. Every result states when it was observed so callers can
distinguish stored evidence from a new check.

## Errors

A tool error is reported **inside the result**, not as a JSON-RPC error:

```json
{ "content": [{ "type": "text", "text": "key must look like \"56:153649\"" }], "isError": true }
```

The call reached us and we answered; the caller's model should see what went wrong rather than a
transport failure it cannot act on. Genuine protocol problems — an unknown tool, an unknown method —
do return JSON-RPC errors (`-32602`, `-32601`).

Every successful call returns both `content` (the JSON as text) and `structuredContent` (the same
object), so clients that support either shape get the typed version.

## The card and the tool list cannot drift

This service's [agent card]({{API}}/.well-known/agent-card.json) advertises a skill per tool, and
both the card's skill list and the MCP `tools/list` response are built from the same table in the
source.

That is not tidiness. This site marks agents down for declaring an interface they do not serve, and
a hand-written card that drifted from the real tool list would make exactly that charge true of us.
The drift is impossible by construction, and a test fails if someone makes it possible again.

The card also deliberately does **not** declare an A2A `url` or a `preferredTransport`: this service
does not answer A2A `message/send`, and a card that said otherwise would be precisely the
registration this site marks down elsewhere.
