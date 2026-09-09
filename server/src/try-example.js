import { isReadOnlyTool } from './mcp.js';

/**
 * Derive ONE safe example call for an agent's MCP surface — the "first
 * question" the Try panel can run for a visitor who will never compose JSON.
 *
 * Honesty rules:
 *   - Read-only tools only, decided by the same default-closed rule the relay
 *     enforces. No derivable example is a normal outcome, never forced.
 *   - Arguments come from the tool's OWN schema first (examples, default,
 *     enum). Only address/token-shaped required params fall back to a labeled
 *     public sample: a well-known exchange hot wallet and the canonical WBNB
 *     contract — values whose lookups return real public data and touch
 *     nobody's private state. Anything we cannot honestly derive (objects,
 *     arrays, opaque strings) disqualifies the tool rather than guessing.
 */
export const SAMPLE = {
  // BscScan-labeled "Binance 51" public exchange hot wallet: busy, public,
  // nobody's personal account.
  address: '0x8894E0a0c962CB723c1976a4421c95949bE2D4E3',
  // Canonical WBNB.
  token: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
};

function schemaValue(schema) {
  if (Array.isArray(schema?.examples) && schema.examples.length) return schema.examples[0];
  if (schema?.default !== undefined) return schema.default;
  if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
  return undefined;
}

function sampleValue(key, schema) {
  const own = schemaValue(schema);
  if (own !== undefined) return { value: own, sample: false };
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (type === 'number' || type === 'integer') {
    return { value: schema?.minimum ?? 1, sample: false };
  }
  if (type === 'boolean') return { value: false, sample: false };
  if (type && type !== 'string') return null; // object/array: never guess
  const hint = `${key} ${schema?.description ?? ''}`.toLowerCase();
  if (/token|contract|\bca\b|mint/.test(hint)) return { value: SAMPLE.token, sample: true };
  if (/wallet|address|account|holder|owner|user/.test(hint)) return { value: SAMPLE.address, sample: true };
  if (/symbol|ticker/.test(hint)) return { value: 'BNB', sample: false };
  if (/chain|network/.test(hint)) return { value: 'bsc', sample: false };
  return null;
}

/**
 * @param tools raw tools/list entries ({name, description, inputSchema}).
 * @returns {tool, args, usesSample} or null when nothing safe is derivable.
 */
export function deriveTryExample(tools) {
  const candidates = (Array.isArray(tools) ? tools : [])
    .filter((t) => typeof t?.name === 'string' && t.name && isReadOnlyTool(t.name));

  // Best case: a read-only tool that needs nothing at all.
  const zeroArg = candidates.find((t) => !(t?.inputSchema?.required?.length));
  if (zeroArg) return { tool: zeroArg.name, args: {}, usesSample: false };

  // Else: the first tool whose EVERY required argument derives honestly.
  for (const t of candidates) {
    const required = t.inputSchema.required;
    const props = t.inputSchema?.properties ?? {};
    const args = {};
    let usesSample = false;
    let ok = true;
    for (const key of required) {
      const derived = sampleValue(key, props[key]);
      if (!derived) { ok = false; break; }
      args[key] = derived.value;
      usesSample = usesSample || derived.sample;
    }
    if (ok) return { tool: t.name, args, usesSample };
  }
  return null;
}
