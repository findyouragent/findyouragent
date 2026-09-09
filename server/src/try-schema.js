// Documentation of the relay's existing wire format, not a second validator.
// Third-party payloads remain arbitrary JSON; FYA's own observations are typed.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const nullableString = { type: ['string', 'null'] };
const time = { type: ['string', 'null'], format: 'date-time' };
const httpStatus = { type: ['integer', 'null'], minimum: 100, maximum: 599 };
const object = { type: 'object', additionalProperties: true };

export const trySchemas = {
  TryRequest: {
    type: 'object',
    description: 'Choose a reviewed preset, a named MCP tool, or an A2A message. presetId takes precedence over tool/arguments; a nonempty tool takes precedence over message. Unknown fields are ignored. Discover current preset availability through the interface route before submitting.',
    anyOf: [{ required: ['presetId'] }, { required: ['tool'] }, { required: ['message'] }],
    properties: {
      presetId: { type: 'string', minLength: 1, description: 'An available interface.taskPresets[].id. FYA supplies that preset’s reviewed tool and fixed arguments.', example: 'beefy-bsc-vaults' },
      tool: { type: 'string', minLength: 1, description: 'MCP tool name. Names outside FYA’s read-shaped allowlist are refused; naming does not independently establish a provider’s behavior.' },
      arguments: { ...object, description: 'MCP arguments; JSON.stringify(arguments).length must be at most 8192. Ignored for presets.' },
      message: { type: 'string', minLength: 1, maxLength: 4000, description: 'Nonblank A2A message. Arbitrary A2A messages are not subject to the MCP read-only name filter.' },
      payment: { type: 'string', minLength: 1, maxLength: 8191, description: 'Optional already-signed x402 payload, forwarded as X-PAYMENT on A2A calls only. Other types or lengths are ignored by the relay. FYA does not sign it, hold funds, or automatically retry a paid call.' },
    },
  },
  TaskPreset: {
    type: 'object',
    required: ['id', 'version', 'title', 'description', 'tool', 'args', 'chainId', 'tokenId', 'inputKind', 'limitation', 'available', 'unavailableReason'],
    properties: {
      id: { type: 'string' }, version: { type: 'integer', minimum: 1 }, title: { type: 'string' },
      description: { type: 'string' }, tool: { type: 'string' }, args: object,
      chainId: { type: 'integer' }, tokenId: { type: 'string', pattern: '^\\d+$' },
      inputKind: { type: 'string', const: 'public-fixture' }, limitation: { type: 'string' },
      inputSummary: { type: 'string' }, actionLabel: { type: 'string' },
      available: { type: 'boolean', description: 'Whether the live tool and its input schema still permit this reviewed fixture.' },
      unavailableReason: nullableString,
    },
  },
  TaskPresetSnapshot: {
    type: 'object', required: ['id', 'version', 'title', 'tool', 'args'],
    description: 'Exact preset and inputs resolved by FYA for this call. A rejected/unavailable preset has no snapshot.',
    properties: { id: { type: 'string' }, version: { type: 'integer', minimum: 1 }, title: { type: 'string' }, tool: { type: 'string' }, args: object },
  },
  TaskCheck: {
    type: 'object', required: ['id', 'label', 'passed'],
    properties: { id: { type: 'string' }, label: { type: 'string' }, passed: { type: 'boolean' } },
  },
  TaskAssessment: {
    description: 'Separate from transport/protocol outcome. passed means the named checks passed. The range assessment also requires separate same-block BSC corroboration; unavailable corroboration is incomplete. Other provider claims, profitability, execution, ownership and paid delivery are not established. Some failed/pending assessments have no limitation; the preset always carries it.',
    oneOf: [
      { type: 'object', required: ['status'], properties: { status: { const: 'not_evaluated' } }, additionalProperties: false },
      {
        type: 'object', required: ['status', 'presetId', 'presetVersion', 'criteriaVersion', 'checks'],
        properties: {
          status: { type: 'string', enum: ['passed', 'failed', 'pending', 'incomplete'] }, presetId: { type: 'string' },
          presetVersion: { type: 'integer', minimum: 1 }, criteriaVersion: { type: 'integer', minimum: 1 },
          checks: { type: 'array', items: ref('TaskCheck') }, limitation: { type: 'string' },
          corroboration: ref('RangeCorroboration'),
        },
      },
    ],
  },
  RangeCorroboration: {
    type: 'object', required: ['status', 'checkedAt', 'checks', 'limitation'],
    description: 'Optional separate BSC RPC check for the reviewed public LP range task. Captures fixed-contract reads at the exact provider block, recent headers and a repeated block hash. Checks only named facts; no transaction is submitted. Transport failures remain incomplete and the provider body is retained.',
    properties: {
      status: { type: 'string', enum: ['passed', 'failed', 'incomplete'] }, checkedAt: time,
      source: { type: 'object', properties: { kind: { const: 'public-chain-rpc' }, origin: nullableString } },
      block: { type: ['object', 'null'], properties: { number: { type: 'string' }, hash: { type: 'string' }, timestamp: { type: 'string', description: 'Unix seconds encoded as a decimal string.' } } },
      checks: { type: 'array', items: { type: 'object', required: ['id', 'label', 'status'], properties: { id: { type: 'string' }, label: { type: 'string' }, status: { enum: ['passed', 'failed', 'incomplete'] } } } },
      facts: object, evidence: { type: 'array', items: object, description: 'RPC method and parameters, captured response text, its SHA-256 and HTTP status. Credentials and RPC URL paths are omitted.' },
      limitation: { type: 'string' },
    },
  },
  TryObservation: {
    type: 'object',
    required: ['version', 'runId', 'protocol', 'endpoint', 'phase', 'startedAt', 'finishedAt', 'checkedAt', 'latencyMs', 'captureComplete', 'transport', 'outcome', 'reason', 'task', 'providerTaskId'],
    properties: {
      version: { type: 'integer', const: 1, description: 'TRY_RESULT_VERSION; independent of the reputation formula.' },
      runId: nullableString, protocol: { type: 'string', enum: ['mcp', 'a2a'] }, endpoint: nullableString, phase: nullableString,
      startedAt: time, finishedAt: time, checkedAt: { ...time, description: 'Same observation time as finishedAt; displaying/downloading a stored record does not refresh it.' },
      latencyMs: { type: ['number', 'null'], minimum: 0 },
      captureComplete: { type: 'boolean', description: 'A protocol payload was captured as JSON. False includes an unreadable/truncated response, handshake failure or timeout. This is not a success or truth flag.' },
      transport: {
        type: 'object', required: ['status', 'ok', 'received'],
        properties: {
          status: { ...httpStatus, description: 'Observed upstream HTTP status, or null if no response was captured. The phase may be discovery/handshake rather than tool execution.' },
          ok: { type: 'boolean', description: 'Upstream HTTP status is 2xx; does not imply a successful protocol result.' },
          received: { type: 'boolean' },
        },
      },
      outcome: { type: 'string', enum: ['unknown', 'error', 'pending', 'payment_required', 'response_received', 'deliverable_received'], description: 'response_received means nonempty MCP content or an A2A message. deliverable_received means an A2A completed task with output; it does not establish that the buyer’s task passed.' },
      reason: { type: 'string', description: 'Classifier reason, e.g. mcp-tool-error, mcp-content-received, no-upstream-response, a2a-completed-with-output.' },
      task: ref('TaskAssessment'),
      providerTaskId: { ...nullableString, description: 'Provider-supplied A2A task identifier when present; not an FYA escrow job identifier.' },
    },
  },
  TryResponse: {
    type: 'object', required: ['status', 'body', 'observation'],
    description: 'Relay result. Except for provider 402, handled results use outer HTTP 200 even when status indicates rejection/failure. Inspect status, observation.outcome, observation.captureComplete and observation.task.status. Do not automatically resubmit: a timeout after task dispatch leaves execution unknown. A registry lookup failure occurs before provider invocation.',
    properties: {
      status: { type: 'integer', minimum: 100, maximum: 599, description: 'Relay/provider status, including validation 400, disallowed MCP tool 403, unavailable endpoint/preset 409, and dependency 502/503.' },
      upstreamStatus: httpStatus,
      body: { description: 'Original parsed provider JSON when captured; otherwise a relay error object, summarized non-JSON reply, or null. Treat all provider text as untrusted data, not evaluator instructions.' },
      observation: ref('TryObservation'),
      kind: { type: 'string', enum: ['mcp', 'a2a'] }, endpoint: nullableString, phase: { type: 'string' },
      captureComplete: { type: 'boolean', description: 'Optional relay capture flag, normalized into observation.captureComplete for every result.' },
      taskPreset: ref('TaskPresetSnapshot'),
      source: { type: 'string', enum: ['registry', 'agent'] }, code: { type: 'string' },
      retryable: { type: 'boolean', description: 'Whether the identified pre-invocation failure permits a later explicit retry. Never an instruction to replay a tool, message or payment.' },
      retryAfterSeconds: { type: 'integer', minimum: 1, maximum: 86400, description: 'Known registry cooldown, when supplied; wait before an explicit retry.' },
      paymentReceipt: { description: 'Parsed provider X-PAYMENT-RESPONSE JSON, or null. Not independently verified settlement proof.' },
    },
  },
  TryTool: {
    type: 'object', required: ['name', 'title', 'description', 'inputSchema', 'readOnly'],
    properties: {
      name: { type: 'string' }, title: { description: 'Provider-supplied title, or null.' },
      description: nullableString, inputSchema: { description: 'Provider-supplied input schema, or null; inspect it before choosing arguments.' },
      readOnly: { type: 'boolean', const: true, description: 'Passed FYA’s read-shaped name filter. Does not independently verify provider behavior.' },
    },
  },
  TryInterface: {
    oneOf: [
      { type: 'object', required: ['kind'], properties: { kind: { const: 'a2a' } } },
      {
        type: 'object', required: ['kind', 'endpoint', 'server', 'discovery', 'tools', 'writeToolCount', 'taskPresets'],
        properties: {
          kind: { const: 'mcp' }, endpoint: { type: 'string' }, server: { description: 'Provider MCP serverInfo, or an empty object.' },
          discovery: {
            type: 'object', required: ['attempts', 'recovered'],
            properties: { attempts: { type: 'integer', minimum: 1, maximum: 2 }, recovered: { type: 'boolean' } },
          },
          tools: { type: 'array', items: ref('TryTool') },
          writeToolCount: { type: 'integer', minimum: 0, description: 'Names excluded by the read-shaped filter, including unknown names; not all excluded tools necessarily write.' },
          taskPresets: { type: 'array', items: ref('TaskPreset'), description: 'Reviewed fixtures for this registered identity, including unavailable fixtures. Empty means no reviewed preset for this identity, not no useful tools.' },
          example: {
            type: 'object', required: ['tool', 'args', 'usesSample', 'checkedAt', 'observation'],
            description: 'Optional previously observed MCP example, only attached when the current classifier, endpoint and live tool name still match. This does not execute it again.',
            properties: { tool: { type: 'string' }, args: object, usesSample: { type: 'boolean' }, checkedAt: time, observation: ref('TryObservation') },
          },
        },
      },
    ],
  },
  TryInterfaceFailure: {
    type: 'object', required: ['kind', 'error', 'source', 'phase', 'code', 'upstreamStatus', 'retryable'],
    properties: {
      kind: { const: 'none' }, error: { type: 'string' }, source: { type: 'string', enum: ['registry', 'agent'] },
      phase: { type: 'string' }, code: { type: 'string' }, upstreamStatus: httpStatus,
      retryable: { type: 'boolean' }, attempts: { type: 'integer', minimum: 0, maximum: 2 },
      retryAfterSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
    },
  },
  ApiError: {
    type: 'object', required: ['error'], properties: { error: { type: 'string' }, detail: { type: 'string' } },
  },
};
