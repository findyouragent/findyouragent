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
`ALLOWED_ORIGIN`. Set `VITE_VERIFY_API` to the deployed backend's public HTTPS URL;
the website domain alone does not provide an API. Use persistent storage
for `DATA_DIR`. The file-backed
API runs as one process. `render.yaml` and `vercel.json` provide hosting examples.
Configure the real URLs and server-side credentials in the hosting platform.

With configuration injected, `npm --prefix server run preflight:prod` validates
its shape without starting the service. Build the frontend with
`npm --prefix web run build:release`. Tests and builds do not establish upstream
availability, persistent-volume durability, or payment/provider correctness.

See the public [API documentation](../web/docs/api.md) and
[limits](../web/docs/limits.md) for runtime behavior and resource bounds.
