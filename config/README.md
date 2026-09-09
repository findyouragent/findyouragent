# Configuration

The examples contain placeholders only. For local development, copy
`config/server.example` to `server/.env` and `config/web.example` to `web/.env`, relative to the
repository root. Keep local configuration out of Git.

The API listens on port 8787 by default; Vite serves the frontend on port 5173.
`VITE_VERIFY_API` points the browser at the API. Every `VITE_*` value is public in
the browser build, so credentials belong only in the server environment.

Live registry and BSC reads depend on upstream availability and quotas. A registry
API key and dedicated BSC RPC may be supplied through `SCAN8004_API_KEY` and
`BSC_RPC_URL`. Offline tests use fixtures and do not need these credentials.
Background verification is disabled in the examples; set `SWEEP_ENABLED=true`
when intentionally enabling it.

For deployment, `config/server.production.example` shows the required production values.
The production frontend domain is `https://findyouragent.xyz`, also used for
`ALLOWED_ORIGIN`. To support additional frontend URLs, use a comma-separated list
of exact origins, for example
`https://findyouragent.xyz,https://findyouragent-seven.vercel.app`.
Origins must not contain paths or trailing slashes. An explicit `*` allows any
browser origin and cannot be mixed with an allowlist.
Set `VITE_VERIFY_API` to the deployed backend's public HTTPS URL;
the website domain alone does not provide an API. Use persistent storage
for `DATA_DIR`. The file-backed
API runs as one process. `render.yaml` and `vercel.json` provide hosting examples.
Configure the real URLs and server-side credentials in the hosting platform.

The API process runs background sweeps itself; no separate cron job is needed.
The production example and Render blueprint keep them disabled until the API,
providers, and persistent storage have been checked. Set `SWEEP_ENABLED=true`
and restart or redeploy the API to enable them. Their explicit initial settings
admit at most one new background verification every 30 seconds, cycle through
40 discovery pages of 25 records, and sample baseline records with
`SWEEP_BASELINE_SAMPLE=25`. A check can make several provider requests, so this
is a verification pacing limit, not a provider request quota. Keep the explicit
interval when adding a registry key to avoid switching to faster defaults.

Stored agents become due for rechecking after 24 hours; completion depends on
backlog and provider availability. `/health` exposes sweep progress counters,
and `/api/summary` includes saved check counts. Confirm that completed checks
increase after enabling the worker. A healthy HTTP response alone does not
establish successful verification. Set `SWEEP_ENABLED=false` and restart or
redeploy to pause background sweeps.

With configuration injected, `npm --prefix server run preflight:prod` validates
its shape without starting the service. Build the frontend with
`npm --prefix web run build:release`. Tests and builds do not establish upstream
availability, persistent-volume durability, or payment/provider correctness.

See the public [API documentation](../web/docs/api.md) and
[limits](../web/docs/limits.md) for runtime behavior and resource bounds.
