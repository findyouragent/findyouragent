import { config } from '../config.js';

// Registry state is keyed by bare BAP tokenId. Only this collection is known
// to be served by this registry; a card cannot choose its own evidence source.
export const MEMORY_COLLECTION = '0x15b15df2ffff6653c21c11b93fb8a7718ce854ce';
export const MEMORY_REGISTRY = '0xb8E808f7916a53c595a0740E656c8bF05388E29a';
const MINT_GATE = '0x97e8f3B4BFfC1982B2791B21609c3B2542c5eB50';
const MAPPING_SELECTOR = '0x97eaea47'; // bap578To8004(uint256)
const GET_KNOWLEDGE_SOURCES = '0x321607af'; // getKnowledgeSources(uint256)
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SOURCES = 128;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_CONCURRENT_READS = 4;
const MAX_CACHE_ENTRIES = 128;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEADLINE_MS = 15_000;
let rpcId = 17000;

function uint(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('unsafe numeric uint256');
  if (!/^(0|[1-9]\d{0,77})$/.test(String(value))) throw new Error('invalid uint256');
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw new Error('uint256 overflow');
  return parsed;
}

const encodedUint = (value) => uint(value).toString(16).padStart(64, '0');

function hexPayload(raw, maxBytes = MAX_RESPONSE_BYTES) {
  if (typeof raw !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(raw)
      || raw.length > 2 + maxBytes * 2) throw new Error('malformed ABI response');
  return raw.slice(2);
}

function readWord(hex, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset % 32 !== 0
      || byteOffset * 2 + 64 > hex.length) throw new Error('ABI word out of bounds');
  return hex.slice(byteOffset * 2, byteOffset * 2 + 64);
}

function readUint(hex, byteOffset) { return BigInt(`0x${readWord(hex, byteOffset)}`); }

function readNumber(hex, byteOffset, max = Number.MAX_SAFE_INTEGER) {
  const value = readUint(hex, byteOffset);
  if (value > BigInt(max)) throw new Error('ABI number out of bounds');
  return Number(value);
}

function readString(hex, tupleStart, fieldOffset, tupleEnd, headBytes) {
  const offset = readNumber(hex, tupleStart + fieldOffset, hex.length / 2);
  if (offset < headBytes || offset % 32 !== 0) throw new Error('ABI string offset out of bounds');
  const start = tupleStart + offset;
  const length = readNumber(hex, start, MAX_STRING_BYTES);
  const end = start + 32 + Math.ceil(length / 32) * 32;
  if (end > tupleEnd) throw new Error('ABI string exceeds tuple');
  // A malformed UTF-8 string is not a source we can faithfully display.
  const bytes = Buffer.from(hex.slice((start + 32) * 2, (start + 32 + length) * 2), 'hex');
  if (/[^0]/.test(hex.slice((start + 32 + length) * 2, end * 2))) throw new Error('nonzero ABI string padding');
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { value, start, end };
}

export function decodeMemorySources(raw) {
  const hex = hexPayload(raw);
  if (hex.length < 128 || hex.length % 64 !== 0 || readUint(hex, 0) !== 32n) throw new Error('invalid source array');
  const count = readNumber(hex, 32, MAX_SOURCES);
  if (count === 0) {
    if (hex.length !== 128) throw new Error('unexpected empty-array payload');
    return [];
  }
  // getKnowledgeSources(uint256) -> KnowledgeSource[]:
  // (uint256 id, string uri, uint8 sourceType, uint256 version,
  //  uint256 priority, bool active, uint256 addedAt, uint256 lastUpdated,
  //  string description, bytes32 contentHash). MEMORY is enum value 2.
  // Confirmed against production V2 at blocks 120724751/120724752 (2026-09-08),
  // including the original successful registry events and add-source calldata.
  // Raw read provenance: output/fya-bort-check-2026-09-08/memory-live-check.json.
  // The array's dynamic element offsets are relative to its first offset word,
  // not to its count word. Enforce canonical, nonoverlapping tuple/string
  // boundaries so malformed bytes can never turn into a plausible root.
  const arrayStart = 64;
  const starts = Array.from({ length: count }, (_, index) => {
    const offset = readNumber(hex, arrayStart + index * 32, hex.length / 2);
    if (offset < count * 32 || offset % 32 !== 0) throw new Error('invalid tuple offset');
    return arrayStart + offset;
  });
  if (starts[0] !== arrayStart + count * 32) throw new Error('invalid first tuple');
  const seen = new Set();
  const sources = [];
  for (let index = 0; index < count; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? hex.length / 2;
    if (end - start < 384) throw new Error('truncated or overlapping tuple');
    const sourceId = readUint(hex, start).toString();
    if (seen.has(sourceId)) throw new Error('duplicate source ID');
    seen.add(sourceId);
    const uri = readString(hex, start, 32, end, 320);
    const description = readString(hex, start, 256, end, 320);
    if (uri.start !== start + 320 || description.start !== uri.end || description.end !== end) throw new Error('noncanonical source strings');
    const sourceType = readNumber(hex, start + 64, 255);
    const active = readNumber(hex, start + 160, 1) === 1;
    const updatedAt = readNumber(hex, start + 224) || null;
    if (sourceType === 2) sources.push({
      sourceId, uri: uri.value, contentHash: `0x${readWord(hex, start + 288).toLowerCase()}`,
      description: description.value, active, updatedAt, anchorTx: null,
    });
  }
  return sources;
}

async function defaultRpc(method, params, { signal }) {
  const res = await fetch(config.bscRpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.probeTimeoutMs)]),
  });
  if (!res.ok) throw new Error('memory RPC HTTP failure');
  const reader = res.body?.getReader();
  if (!reader) throw new Error('memory RPC has no body');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('memory RPC response too large');
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || body.error || !Object.hasOwn(body, 'result')) throw new Error('memory RPC failed');
  return body.result;
}

const COMMITMENT_NOTE = 'The registry records a memory URI and content-hash commitment for this token. The linked export, Merkle root and truth of its contents have not been validated by FYA.';

function empty(key, checkedAt, status, gate, note, identity = {}) {
  return {
    key, status, gate, checkedAt, blockNumber: null, collection: null,
    bapTokenId: null, registryAddress: null, sources: [],
    contentValidation: 'not-performed', note, ...identity,
  };
}

/** Read-only evidence, independent of the frozen verdict formula and store. */
export function createMemoryAnchorHandler({ store, rpc = defaultRpc, now = () => Date.now() } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  return async (req, res) => {
    let chainId, agentId;
    try {
      chainId = uint(req.params.chainId).toString();
      agentId = uint(req.params.tokenId).toString();
    } catch { return res.status(400).json({ error: 'chainId and tokenId must be canonical uint256 decimal integers' }); }
    const key = `${chainId}:${agentId}`;
    const checkedAt = new Date(now()).toISOString();
    if (chainId !== '56') return res.json(empty(key, checkedAt, 'unsupported', 'unsupported-chain', 'Memory-anchor reading is supported on BNB Chain (56).'));
    const last = store.lastCheck(key);
    if (!last) return res.json(empty(key, checkedAt, 'unavailable', 'no-verdict', 'Verify this agent before reading its memory anchors.'));
    const bap = last.bap578;
    if (bap?.ownershipVerified !== true) {
      const rejected = bap?.ownershipVerified === false;
      return res.json(empty(key, checkedAt, rejected ? 'wrong-identity' : 'unavailable', rejected ? 'wrong-identity' : 'no-attributed-token', rejected
        ? 'The claimed BAP token is not attributed to this agent.' : 'There is no attributed BAP token to attach memory evidence to.'));
    }
    if (String(bap.collection).toLowerCase() !== MEMORY_COLLECTION) {
      return res.json(empty(key, checkedAt, 'unsupported', 'unsupported-collection', 'FYA has no supported memory registry for this collection.'));
    }
    let bapTokenId;
    try {
      if (bap.chainId != null && String(bap.chainId) !== '56') throw new Error('wrong chain');
      bapTokenId = uint(bap.tokenId).toString();
    } catch { return res.json(empty(key, checkedAt, 'unavailable', 'malformed-identity', 'The stored BAP identity cannot be read safely.')); }
    const identity = { collection: MEMORY_COLLECTION, bapTokenId, registryAddress: MEMORY_REGISTRY };
    // Include the attributed token in the key, and gate before cache lookup so
    // a changed/rejected claim cannot receive a previous token's cached roots.
    const cacheKey = `${key}:${bapTokenId}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > now()) return res.json({ ...cached.value, cached: true });
    if (cached) cache.delete(cacheKey);
    if (inFlight.has(cacheKey)) return res.json(await inFlight.get(cacheKey));
    if (inFlight.size >= MAX_CONCURRENT_READS) return res.json(empty(key, checkedAt, 'unavailable', 'busy', 'Memory reads are busy; retry shortly.', identity));

    const work = (async () => {
      const signal = AbortSignal.timeout(DEADLINE_MS);
      let blockNumber = null;
      try {
        const block = await rpc('eth_blockNumber', [], { signal });
        if (typeof block !== 'string' || !/^0x(?:0|[1-9a-fA-F][a-fA-F0-9]*)$/.test(block)
            || BigInt(block) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid block');
        blockNumber = Number(BigInt(block));
        const mapping = hexPayload(await rpc('eth_call', [{ to: MINT_GATE, data: MAPPING_SELECTOR + encodedUint(bapTokenId) }, block], { signal }), 32);
        if (mapping.length !== 64) throw new Error('invalid identity mapping');
        const mappedAgentId = readUint(mapping, 0);
        if (mappedAgentId === 0n || mappedAgentId !== BigInt(agentId)) {
          return empty(key, checkedAt, 'wrong-identity', 'wrong-identity', 'The registrar does not map this BAP token to this agent at the checked block.', { ...identity, blockNumber });
        }
        const raw = await rpc('eth_call', [{ to: MEMORY_REGISTRY, data: GET_KNOWLEDGE_SOURCES + encodedUint(bapTokenId) }, block], { signal });
        const sources = decodeMemorySources(raw);
        const anchored = sources.some((source) => source.active && !/^0x0{64}$/.test(source.contentHash));
        const result = empty(key, checkedAt, anchored ? 'anchored' : 'not-anchored', 'verified', anchored ? COMMITMENT_NOTE
          : 'No active MEMORY source with a nonzero content hash is recorded for this token in the supported registry at the checked block.', { ...identity, blockNumber, sources });
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { value: result, expires: now() + CACHE_TTL_MS });
        return result;
      } catch {
        // Reverts, malformed ABI, missing historical state and quota failures
        // all mean unavailable. None establish that a memory anchor is absent.
        return empty(key, checkedAt, 'unavailable', 'read-failed', 'FYA could not read the complete memory registry state. This is a failed check, not evidence that memory is absent.', { ...identity, blockNumber });
      }
    })();
    inFlight.set(cacheKey, work);
    try { return res.json(await work); }
    finally { inFlight.delete(cacheKey); }
  };
}
