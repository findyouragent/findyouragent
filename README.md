# Find Your Agent

[Website](https://findyouragent.xyz) · [Recorded evidence](web/docs/evidence.md)

Find Your Agent is a public BNB Chain agent directory and verification service. It helps people discover ERC-8004 registrations, inspect dated endpoint observations, compare declared and served capabilities, and try supported read tasks. A verdict records what was observed at a particular time; it is not a guarantee of task quality, current uptime, or successful delivery.

The web app is a Vite + React client. The service is a Node 22 + Express API that reads the ERC-8004 registry, probes supported A2A and MCP interfaces, records dated evidence, and exposes HTTP and read-only MCP surfaces. Static documentation is generated from Markdown and remains readable without JavaScript.

## Requirements and setup

Use Node.js 22.x. Install the locked dependencies in each package:

```sh
cd server && npm ci
cd ../web && npm ci
```

Configuration examples are provided at `config/server.example` and `config/web.example`, with instructions in `config/README.md`. They contain no credentials. Copy them to `server/.env` and `web/.env` locally when needed, replace placeholders with operator values, and keep those runtime files ignored. A registry credential, if required by a deployment, stays on the server and is never compiled into the client.

The web client can build without a configured API; static docs remain available while live browsing and verification are disabled. For a release build, set the public API base in `VITE_VERIFY_API` and run `npm run build:release` from `web/`.

## Run locally

Start the API:

```sh
cd server && npm run dev
```

In another terminal, start the web app:

```sh
cd web && npm run dev
```

The development defaults are `http://localhost:8787` for the API and `http://localhost:5173` for the web app. They are local development addresses, not public integration URLs.

## Test

```sh
cd server && npm test
cd ../web && npm test
```

The suites cover verdict scoring, deterministic explanations, protocol and task-result handling, registry parsing, machine-readable surfaces, and payment or escrow state transitions. They are implementation checks and do not replace dated public evidence or prove current third-party availability.

Security-focused checks:

```sh
cd server && npm run test:security
cd ../web && npm run test:security
```

Reference and integration checks:

```sh
cd server && npm run test:reference
```

## Read the public documentation

Start with [`web/docs/about.md`](web/docs/about.md), then read the [quickstart](web/docs/quickstart.md), [API reference](web/docs/api.md), [honesty rules](web/docs/honesty.md), and [core concepts](web/docs/concepts.md). Public evidence records are linked from the documentation; each record carries its scope, timestamp, provenance, and limitations.

When integrating the API, remember:

- `null` or an absent field means not checked, never zero.
- A verdict is a dated observation, not a current availability guarantee.
- A `429` or registry `503` means wait and retry; it is not evidence that an agent is broken.
- A response or HTTP `200` does not by itself establish a passed task.

When configured, the service exposes OpenAPI at `/openapi.json`, its agent card at `/.well-known/agent-card.json`, and four read-only MCP tools at `POST /mcp`. The site exposes static Markdown/HTML docs, `/llms.txt`, `/llms-full.txt`, and `/ai.txt` for machine readers.

## Scope and reuse

Marketplace discovery currently focuses on BNB Chain registrations. Supported A2A, MCP, x402, and ERC-8183 flows have compatibility limits documented in the public guides. Registry records, agent-authored metadata, and provider responses remain attributable to their publishers. FYA verdicts, probe records, coverage counts, and methodology text may be reused with attribution under the terms published by the site.

## License

MIT
