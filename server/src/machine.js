import { FORMULA_VERSION } from './verify/score.js';
import { queryTokens } from './store.js';
import { trySchemas } from './try-schema.js';
import {
  SEARCH_LIMITS, SearchPolicyError, createSearchControl, estimateSearchWork, searchErrorBody,
  validateSearchQuery,
} from './search-policy.js';

/**
 * The interfaces this service offers to other agents, rather than to the app.
 *
 * Three surfaces, one source of truth: an OpenAPI description of the HTTP API,
 * an agent card, and an MCP server. The card's skills and the MCP tool list are
 * both built from TOOLS below, so this service cannot declare a capability it
 * does not serve — which is the exact defect it publishes about everyone else.
 * A hand-written card that drifts from the tool list would be a site that fails
 * its own declared-vs-served test.
 */

// The MCP protocol revision our own client speaks (see mcp.js initializeParams).
// Answering with the same one keeps the prober and the served endpoint honest
// about each other.
const MCP_PROTOCOL = '2025-06-18';

// Where a person is sent when an agent wants to hand a human the evidence.
const SITE = 'https://findyouragent.xyz';

const KEY = { type: 'string', pattern: '^\\d+:\\d+$', description: 'chain id and token id, e.g. "56:153649"' };

/**
 * Every tool reads our OWN stored records and nothing else.
 *
 * Deliberate: an MCP tool is called by software in a loop, and a tool that
 * reached the registry would let any caller drain the shared registry budget
 * that visitors and the sweep both depend on. A fresh check stays behind the
 * rate-limited HTTP route where a human is waiting for it. So these answer
 * without registry calls, and every result says
 * when it was observed, so "stored" is never mistaken for "now".
 */
export function buildTools(store, { searchControl = createSearchControl() } = {}) {
  return [
    {
      name: 'search_agents',
      title: 'Search agents by what they actually serve',
      description:
        'Finds agents whose endpoint ACTUALLY served a matching capability when we last called it — not what their registration claims. Every result names the matched tool, so the match can be checked instead of trusted. Searches only agents we have already probed; an agent absent from these results may simply never have been checked.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', minLength: 1, maxLength: SEARCH_LIMITS.maxCharacters, pattern: '\\S', description: `what you need done, e.g. "check my venus health factor". At most ${SEARCH_LIMITS.maxUniqueTokens} distinct searchable terms; the current stored corpus can lower that bound when a broader query would exceed the synchronous work limit. Tokens under 3 characters, and English glue such as "for" and "and", are ignored — a task made only of those matches nothing rather than everything. Agents serving an identical tool list are folded into one result, with the count in sameToolList.` },
          limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
        },
        required: ['task'],
        additionalProperties: false,
      },
      run: ({ task, limit }, context = {}) => {
        /*
          The schema says task is required; nothing enforced it.

          A caller that omitted it — or spelled the field something else, which
          is the likelier accident — got `count: 0` back, and zero results to a
          question nobody asked reads exactly like "no agent serves this". That
          is a finding we did not make, and it is the same confusion between an
          absent question and a negative answer that this service refuses to
          make everywhere else. So it is a tool error: the caller's model is
          told what it did, rather than handed an empty list to conclude from.
        */
        const checked = validateSearchQuery(task, { field: 'task', tokenize: queryTokens });
        const corpus = store.searchCorpusStats();
        const work = estimateSearchWork(checked.tokens, corpus, { field: 'task' });
        searchControl.consume({ ip: context.ip, workUnits: work.workUnits });

        // Asked with real words, or asked with none? The tokeniser drops words
        // under three characters and English glue, so "for the" arrives at the
        // search as an empty query and comes back empty — which in the reply is
        // indistinguishable from a search that ran and found nobody. The same
        // tokeniser the search uses answers that here, rather than a second
        // guess at its rules.
        const tokens = checked.tokens;
        if (!tokens.length) {
          return {
            query: task,
            count: 0,
            agents: [],
            note: 'nothing in this task was searchable: words under three characters and common English glue are dropped, and these were all of it. That is not a statement that no agent serves it.',
          };
        }

        // The store's row shape carries chain_id/token_id for the app's own
        // links. A caller here needs the `key` it must pass back to get_verdict
        // and a page a person can be sent to, so both are added rather than
        // leaving the client to reassemble them from parts.
        const agents = store.searchServed(checked.query, clamp(limit, 1, 25, 10))
          .map((a) => ({ key: `${a.chain_id}:${a.token_id}`, page: `${SITE}/#/agent/${a.chain_id}/${a.token_id}`, ...a }));
        return {
          query: checked.query,
          searchedFor: tokens,
          count: agents.length,
          agents,
          basis: 'matchedTool is a name this agent\'s endpoint returned to us, at the time given by its verdict',
        };
      },
    },
    {
      name: 'get_verdict',
      title: 'The stored verdict for one agent',
      description:
        'The verdict we hold for one agent: tier, whether its endpoint answered, the signals behind the tier, what it declares versus what it served, and when it was checked. Returns null when we have never checked it — which is not a claim about the agent. For a check run right now, call GET /api/verify/{chainId}/{tokenId} over HTTP instead; it is rate limited because it spends a shared registry budget.',
      inputSchema: {
        type: 'object',
        properties: { key: KEY },
        required: ['key'],
      },
      run: ({ key }) => {
        const k = String(key ?? '');
        if (!/^\d+:\d+$/.test(k)) throw new Error('key must look like "56:153649"');
        const verdict = store.latestFor([k])[k] ?? null;
        const page = `${SITE}/#/agent/${k.replace(':', '/')}`;
        if (!verdict) {
          return { key: k, page, verdict: null, note: 'we have never checked this agent. That is a gap in our coverage, not a finding about the agent.' };
        }
        return { key: k, page, verdict };
      },
    },
    {
      name: 'get_history',
      title: 'Every check we have run against one agent',
      description:
        'The recent checks for one agent plus the day calendar. A day with no entry is a day we did not check: it is our sampling gap and never that agent\'s downtime. Only a day where their server answered and served nothing is recorded as a failure; a timeout is neutral, because from one vantage point it cannot be told apart from our own egress.',
      inputSchema: {
        type: 'object',
        properties: { key: KEY },
        required: ['key'],
      },
      run: ({ key }) => {
        const k = String(key ?? '');
        if (!/^\d+:\d+$/.test(k)) throw new Error('key must look like "56:153649"');
        return { key: k, checks: store.historyFor(k), uptime: store.uptimeFor(k) };
      },
    },
    {
      name: 'coverage',
      title: 'What has been checked, and what has not',
      description:
        'Headline counts and per-category coverage. Each coverage column is a narrowing of the one before it — agents, then endpoint proven, then serves that capability, then verified live — so the drop-off between them is the finding. Also carries the formula version every verdict was computed under.',
      inputSchema: { type: 'object', properties: {} },
      run: () => ({
        ...store.summary(),
        coverage: store.coverage(),
        formulaVersion: FORMULA_VERSION,
        note: 'counts include only verdicts computed under the current formula version; older ones are withdrawn until rechecked.',
      }),
    },
  ];
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * The agent card.
 *
 * It declares MCP and an HTTP API, and deliberately does NOT declare an A2A
 * `url` or `preferredTransport`: this service does not answer A2A message/send,
 * and a card that says otherwise is precisely the registration this site marks
 * down elsewhere. `services` uses the shape our own registry reader expects, so
 * if this service is ever registered on-chain our own sweep can probe it under
 * the same rules as anyone else.
 */
export function agentCard(base, tools) {
  return {
    name: 'findyouragent',
    description:
      'Stored checks and task discovery for ERC-8004 agents on BNB Chain. A verdict can record an answered endpoint, no reply, or no callable endpoint; inspect its signals and observation time. FYA serves MCP and an HTTP API, and probes third-party MCP/A2A endpoints. A reply or matched capability is not proof of independent delivery.',
    version: '1',
    formulaVersion: FORMULA_VERSION,
    provider: { organization: 'findyouragent', url: 'https://findyouragent.xyz' },
    documentation: `${base}/openapi.json`,
    services: {
      mcp: { endpoint: `${base}/mcp`, transport: 'streamable-http' },
    },
    interfaces: [
      { kind: 'mcp', endpoint: `${base}/mcp`, transport: 'streamable-http', protocolVersion: MCP_PROTOCOL },
      { kind: 'http-json', endpoint: `${base}/api`, openapi: `${base}/openapi.json` },
    ],
    capabilities: { streaming: true, authentication: 'none', pricing: 'none' },
    skills: tools.map((t) => ({
      id: t.name,
      name: t.title,
      description: t.description,
      tags: ['erc-8004', 'agent-discovery', 'liveness', 'bnb-chain'],
    })),
    terms: {
      reuse: 'verdicts, probe records and coverage counts are reusable with attribution to https://findyouragent.xyz',
      notOurs: 'agent names, cards, images and registry records belong to the parties that published them on-chain',
      url: 'https://findyouragent.xyz/ai.txt',
    },
    semantics: {
      unknown: 'null means not checked. true means checked and held, false means checked and failed. Rendering null as 0 is a caller-side bug.',
      throttle: 'HTTP 503 registry-throttled is a wait, never a verdict about an agent.',
      freshness: 'every verdict carries the time it was made; a stored verdict is not a claim about now.',
    },
  };
}

export function openapi(base, tools) {
  const key = (name) => ({
    name, in: 'path', required: true, schema: { type: 'string', pattern: '^\\d+$' },
  });
  const json = (description, schema = { type: 'object' }) => ({ description, content: { 'application/json': { schema } } });
  const schema = (name) => ({ $ref: `#/components/schemas/${name}` });
  const apiError = (description) => json(description, schema('ApiError'));
  const rateLimited = { ...apiError('Per-IP rate limit; wait before another request. No task was submitted.'), headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 }, description: 'Seconds to wait.' } } };
  const throttled = {
    503: json('The registry is rate limiting reads. A wait, not a verdict: the body is {error:"registry-throttled"} and Retry-After is set. Never render this as a failed agent.'),
  };
  const registryPaging = [
    { name: 'chainId', in: 'query', schema: { type: 'integer', enum: [56], default: 56 } },
    { name: 'page', in: 'query', description: 'Positive page with exact safe-integer offset and offset + limit; no fixed page-count cutoff.', schema: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 } },
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
  ];
  const registryResponses = {
    200: json('Registry data with source:8004scan; listings include meta.pagination {page,limit,total,hasMore}.'),
    400: json('invalid-registry-query'), 429: json('per-IP registry limit, with Retry-After'),
    502: json('registry-unavailable | registry-invalid-response, with source and upstreamStatus'), ...throttled,
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'findyouragent — verdict API',
      version: '1',
      summary: 'Which ERC-8004 agents on BNB Chain actually answer, and the evidence for each verdict.',
      description: [
        'No caller key or signup. CORS defaults to open; an operator may restrict allowed origins.',
        '',
        'Four semantics worth knowing before you rely on a field:',
        '',
        '1. **Unknown is `null`, never `0`.** `true` = checked and held, `false` = checked and failed, `null`/absent = not checked.',
        '2. **Every verdict carries `formulaVersion`.** When the formula changes, older verdicts are withdrawn from headline counts until rechecked, so counts never mix rules.',
        '3. **Registry throttling is not an agent verdict.** Registry reads share the configured server credential/budget, or anonymous access when unconfigured. Registry adapter throttling answers `503 registry-throttled` with `Retry-After`. Budgets and upstream availability are external constraints.',
        '4. **HTTP 200 is not task success.** Try returns a relay envelope; inspect its status, observation outcome, capture completeness and separate task assessment. Reviewed task checks verify selected fields and scope, not independent provider truth or paid delivery.',
        '',
        `Formula version currently in force: ${FORMULA_VERSION}.`,
      ].join('\n'),
      license: { name: 'MIT' },
    },
    servers: [{ url: base }],
    components: { schemas: trySchemas },
    paths: {
      '/health': { get: { summary: 'Liveness, formula version and sweep stats', operationId: 'health', responses: { 200: json('ok') } } },
      '/api/summary': {
        get: {
          summary: 'Headline counts and per-category coverage',
          description: 'From stored verdicts only. Each coverage column narrows the one before it: agents → endpointProven → served → verifiedLive. The drop-off is the finding.',
          operationId: 'summary',
          responses: { 200: json('counts, coverage, formulaVersion, sweep stats') },
        },
      },
      '/api/checked': {
        get: {
          summary: 'Agents we hold a current verdict for, best first',
          description: 'Served entirely from our own records, so reading it costs the shared registry budget nothing.',
          operationId: 'checked',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }],
          responses: { 200: json('{agents: []}') },
        },
      },
      '/api/live': {
        get: { summary: 'Agents whose endpoint answered on the most recent check', operationId: 'live', responses: { 200: json('{agents: []}') } },
      },
      '/api/search': {
        get: {
          summary: 'Search what agents actually served',
          description: `Matches capability names an endpoint returned to us when asked, not registry text. Each hit carries \`matchedTool\` so the match can be checked. Reads stored records without registry calls. Queries are limited to ${SEARCH_LIMITS.maxCharacters} characters, ${SEARCH_LIMITS.maxUniqueTokens} distinct searchable terms, and ${SEARCH_LIMITS.maxWorkUnitsPerQuery.toLocaleString('en-US')} estimated synchronous work units, with per-address and shared process limits.`,
          operationId: 'search',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: SEARCH_LIMITS.maxCharacters, pattern: '\\S' }, example: 'lending' }],
          responses: {
            200: json('{q, agents: [{..., matchedTool}], count}'),
            400: json('search-query-required | search-query-too-long | search-query-too-many-terms | search-query-too-broad'),
            429: json('search-rate-limited | search-capacity-limited, with Retry-After'),
          },
        },
      },
      '/api/verdicts': {
        post: {
          summary: 'Stored verdicts for up to 200 agents',
          description: 'Read-only and instant; never triggers a check, so it cannot be used to drive load against the registry.',
          operationId: 'verdicts',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { keys: { type: 'array', maxItems: 200, items: { type: 'string', pattern: '^\\d+:\\d+$' } } }, required: ['keys'] } } },
          },
          responses: { 200: json('{verdicts: {key: verdict}}'), 400: json('more than 200 keys') },
        },
      },
      '/api/history/{chainId}/{tokenId}': {
        get: {
          summary: 'Recent checks and the day calendar for one agent',
          description: 'A day with no entry is a day we did not check — our sampling gap, never their downtime.',
          operationId: 'history',
          parameters: [key('chainId'), key('tokenId')],
          responses: { 200: json('{checks: [], uptime: []}') },
        },
      },
      '/api/activity/{chainId}/{tokenId}': {
        get: {
          summary: 'On-chain activity for an agent whose wallet is provably its own',
          description: 'Every response carries an `attribution.gate` (verified | no-verdict | no-proved-wallet | no-wallet-yet | unsupported-chain | unconfigured | not-checked) so an outage or a missing wallet can never read as "no activity". Events carry a per-transaction origin class.',
          operationId: 'activity',
          parameters: [key('chainId'), key('tokenId')],
          responses: { 200: json('{attribution, coverage, events, sources, note}') },
        },
      },
      '/api/verify/{chainId}/{tokenId}': {
        get: {
          summary: 'Run a full check, or serve the cached verdict',
          description: 'Spends the shared registry budget, so it is rate limited per IP. `?stream=1` narrates the check as Server-Sent Events, one frame per call as it actually resolves, with the verdict in the last frame.',
          operationId: 'verify',
          parameters: [key('chainId'), key('tokenId'), { name: 'stream', in: 'query', schema: { type: 'string', enum: ['1'] } }],
          responses: { 200: json('the verdict, plus `cached`'), 429: json('per-IP rate limit, with retry-after'), ...throttled,
            503: json('registry-throttled, or identity-unavailable with source agent-identity and retryable true; incomplete identity reads leave the previous completed check unchanged'),
            502: json('verification-failed') },
        },
      },
      '/api/agent-meta/{chainId}/{tokenId}': {
        get: {
          summary: 'Registry metadata and media for one agent', operationId: 'agentMeta',
          description: 'A successful read contains a non-null metadata object, cached for 60 seconds. Use ?refresh=1 to discard the cached document after a metadata update. Concurrent reads for the same agent share one request; the same rate limit applies. Missing services in a successfully read object means no services were declared; an unavailable document does not establish absence. Failed reads are not cached as successes or replaced with the previous hire menu.',
          parameters: [key('chainId'), key('tokenId'), { name: 'refresh', in: 'query', description: 'Discard cached metadata and read the current document.', schema: { type: 'string', enum: ['1'] } }],
          responses: { 200: json('metadata object with optional media'), 400: json('invalid identity'), 404: json('agent not found'),
            429: json('per-IP rate limit'), 502: json('metadata-unavailable with source agent-metadata and retryable true, or a typed registry dependency failure'),
            503: json('typed registry dependency throttle') },
        },
      },
      '/api/registry/agents': {
        get: {
          summary: 'Browse or search indexed BSC registrations', operationId: 'registryAgents',
          description: 'Uses the server-held registry key and a shared 30-second cache. Includes placeholders and owner-declared inactive entries; neither their presence nor their registry score proves execution. Newest and score ordering come from the registry.',
          parameters: [...registryPaging,
            { name: 'search', in: 'query', schema: { type: 'string', maxLength: 200 } },
            { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['created_at', 'total_score'], default: 'created_at' } },
            { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
          ], responses: registryResponses,
        },
      },
      '/api/registry/search': {
        get: {
          summary: 'Semantic registry search on BSC', operationId: 'registrySearch',
          description: 'Registry matches, not evidence that an agent served a capability. Shares the registry read rate limit and 30-second cache.',
          parameters: [...registryPaging, { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } }],
          responses: registryResponses,
        },
      },
      '/api/registry/stats': {
        get: { summary: 'Registry inventory including per-chain counts', operationId: 'registryStats',
          description: 'Shared 60-second cache. Includes indexed placeholders; these counts are not FYA checks. No query parameters.', responses: registryResponses },
      },
      '/api/agents/{chainId}/{tokenId}': {
        get: {
          summary: 'Public registry detail for one agent',
          description: 'A fixed 8004scan lookup using the shared registry key, five-minute cache and in-flight request deduplication. Returns the public registry record, not an FYA verification verdict. Rate limited per IP; accepts no arbitrary URL.',
          operationId: 'agentDetail',
          parameters: [key('chainId'), key('tokenId')],
          responses: { 200: json('{data: public registry detail, source: "8004scan"}'),
            400: json('chainId and tokenId must be numeric'), 404: json('agent-not-found'),
            429: json('per-IP rate limit, with retry-after'), ...throttled,
            502: json('registry-unavailable | registry-invalid-response') },
        },
      },
      '/api/try/{chainId}/{tokenId}/interface': {
        get: {
          summary: 'Discover live tools and available reviewed task presets',
          description: 'Uses the current registry endpoint. For MCP, reads the live tool list and returns read-shaped names plus taskPresets with fixed public inputs, limitations and availability. A preset is usable only while its live tool/schema remains compatible. A2A returns kind:a2a and accepts arbitrary messages; FYA does not enforce read-only behavior for those messages. Shares the per-IP Try limit; no task tool is executed by this discovery route.',
          operationId: 'tryInterface',
          parameters: [key('chainId'), key('tokenId')],
          responses: {
            200: json('Live interface and reviewed task availability; not a guarantee the subsequent call succeeds.', schema('TryInterface')),
            400: apiError('chainId and tokenId must be numeric'), 409: apiError('Agent declares no callable endpoint'),
            429: rateLimited,
            502: json('Registry/discovery failure, or an unexpected interface error.', { anyOf: [schema('TryInterfaceFailure'), schema('ApiError')] }),
            503: json('Registry is throttling discovery; source/phase identify the dependency.', schema('TryInterfaceFailure')),
          },
        },
      },
      '/api/try/{chainId}/{tokenId}': {
        post: {
          summary: 'Run a reviewed task, MCP read-shaped tool, or A2A message',
          description: 'Relay to the registered third-party endpoint. presetId resolves a reviewed fixed-input MCP task and rechecks the live tool/schema; caller tool/arguments cannot override that fixture. Other MCP tool names pass a default-closed read-shaped filter, which cannot prove provider behavior. Arbitrary A2A messages have no equivalent read-only enforcement. Calls are not automatically resubmitted. HTTP 200 includes handled failures: inspect envelope.status, observation.outcome, captureComplete and observation.task.status. A 402 carries the provider payment challenge; signing and payment are separate user actions.',
          operationId: 'try',
          parameters: [key('chainId'), key('tokenId')],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schema('TryRequest'), examples: {
              reviewedTask: { summary: 'Only after interface discovery reports this preset available', value: { presetId: 'beefy-bsc-vaults' } },
              mcpRead: { summary: 'Use a name and arguments from the live interface', value: { tool: 'getVaultsWithChains', arguments: { chainNames: ['bsc'] } } },
              a2aMessage: { summary: 'Third-party message; not guaranteed read-only', value: { message: 'Describe your capabilities.' } },
            } } },
          },
          responses: {
            200: json('Relay envelope, including handled validation, availability and execution failures. Never interpret HTTP 200 alone as completion.', schema('TryResponse')),
            400: apiError('chainId and tokenId must be numeric; malformed request JSON may instead produce framework HTML'),
            402: json('Provider payment challenge in body; observation.outcome is payment_required. No automatic payment or retry.', schema('TryResponse')),
            429: rateLimited,
            502: apiError('Unexpected agent-timeout | try-failed outside the handled relay envelope'),
          },
        },
      },
      '/.well-known/agent-card.json': {
        get: { summary: 'This service\'s own agent card', operationId: 'agentCard', responses: { 200: json('card') } },
      },
      '/mcp': {
        post: {
          summary: 'MCP endpoint (streamable HTTP, JSON-RPC 2.0)',
          description: `Tools: ${tools.map((t) => t.name).join(', ')}. All read our own stored records without registry calls. This service serves MCP and HTTP, not A2A message/send. A fresh check uses /api/verify; reviewed task discovery and execution use /api/try.`,
          operationId: 'mcp',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: json('JSON-RPC result'), 405: json('GET is not supported: this server opens no server-to-client stream') },
        },
      },
    },
  };
}

/**
 * The MCP server. Stateless on purpose: it issues no session id, so a client
 * can initialize and call in any order without holding state, and a restart
 * mid-conversation cannot invalidate a session someone is using.
 */
export function handleMcp(body, tools, context = {}) {
  const id = body?.id ?? null;
  const method = body?.method;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    return ok({
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'findyouragent', version: '1' },
      instructions:
        'Read-only access to findyouragent\'s stored verdicts about ERC-8004 agents on BNB Chain. null means we did not check, never zero. Every verdict carries the time it was made and the formula version it was computed under.',
    });
  }
  // Notifications carry no id and expect no response body.
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = tools.find((t) => t.name === body?.params?.name);
    if (!tool) return fail(-32602, `unknown tool: ${body?.params?.name}`);
    try {
      const result = tool.run(body?.params?.arguments ?? {}, context);
      return ok({
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      });
    } catch (err) {
      // A tool error is reported inside the result, not as a JSON-RPC error:
      // the call reached us and we answered, and the caller's model should see
      // what went wrong rather than a transport failure.
      if (err instanceof SearchPolicyError) {
        const body = searchErrorBody(err);
        return ok({
          content: [{ type: 'text', text: JSON.stringify(body) }],
          structuredContent: body,
          isError: true,
        });
      }
      return ok({ content: [{ type: 'text', text: String(err.message || err) }], isError: true });
    }
  }
  return fail(-32601, `method not found: ${method}`);
}

/**
 * Mounts every machine-facing route. `base` is derived from the request rather
 * than configured, so the URLs in the card and the OpenAPI servers block are
 * always the host the caller actually reached — a configured base is one
 * deploy away from advertising an address that answers nothing.
 */
export function mountMachineRoutes(app, { store, searchControl = createSearchControl() }) {
  const tools = buildTools(store, { searchControl });
  const baseOf = (req) => `${req.protocol}://${req.get('host')}`;

  app.get('/openapi.json', (req, res) => {
    res.set('cache-control', 'public, max-age=300');
    res.json(openapi(baseOf(req), tools));
  });

  app.get('/.well-known/agent-card.json', (req, res) => {
    res.set('cache-control', 'public, max-age=300');
    res.json(agentCard(baseOf(req), tools));
  });

  app.post('/mcp', (req, res) => {
    const response = handleMcp(req.body, tools, { ip: req.ip || req.socket?.remoteAddress || 'unknown' });
    if (response === null) return res.status(202).end();
    res.json(response);
  });

  app.get('/mcp', (req, res) => {
    res.status(405).json({
      error: 'method-not-allowed',
      detail: 'This MCP server is stateless and opens no server-to-client stream. POST JSON-RPC here instead.',
    });
  });
}
