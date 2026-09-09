const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO_HASH = /^0x0{64}$/i;
const ZERO_ADDRESS = /^0x0{40}$/i;
const STATES = new Set(['anchored', 'not-anchored', 'unsupported', 'unavailable', 'wrong-identity']);

// A registry-listed address is not the proven ERC-6551 account. Never use the
// owner or registry wallet as a fallback under the token-controlled label.
export function provenTokenAccount(verdict) {
  const b = verdict?.bap578;
  const address = b?.transferable?.tba;
  return b?.ownershipVerified === true && b.transferable?.checked === true
    && typeof address === 'string' && ADDRESS.test(address) && !ZERO_ADDRESS.test(address)
    ? address : null;
}

export function anchoredMemoryCount(sources = []) {
  return sources.filter(source => source?.active === true
    && HASH.test(source.contentHash || '') && !ZERO_HASH.test(source.contentHash)).length;
}

// Link only; no provider-selected content is fetched or executed by FYA.
export function memorySourceHref(uri) {
  if (typeof uri !== 'string' || uri.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(uri)) return null;
  const ipfs = uri.match(/^ipfs:\/\/(?:ipfs\/)?(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{30,120})(\/[^?#]*)?$/);
  if (ipfs) {
    const segments = (ipfs[2] || '').split('/').slice(1);
    try {
      if (segments.some(segment => ['.', '..'].includes(decodeURIComponent(segment)))) return null;
      return `https://ipfs.io/ipfs/${ipfs[1]}${segments.length ? '/' + segments.map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/') : ''}`;
    } catch { return null; }
  }
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export async function fetchMemoryEvidence({ serviceBase, chainId, tokenId, fetchImpl = fetch, timeoutMs = 20000 }) {
  const key = `${chainId}:${tokenId}`;
  const unavailable = { key, status: 'unavailable', sources: [] };
  if (!serviceBase || !/^\d+$/.test(String(chainId)) || !/^\d+$/.test(String(tokenId))) return unavailable;
  const controller = new AbortController();
  let timer;
  const expired = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(unavailable); }, timeoutMs);
  });
  const read = (async () => {
    try {
      const res = await fetchImpl(`${serviceBase.replace(/\/$/, '')}/api/memory/${chainId}/${tokenId}`, {
        headers: { accept: 'application/json' }, credentials: 'omit', signal: controller.signal,
      });
      if (!res.ok) return unavailable;
      const body = await res.json();
      if (body?.key !== key || !STATES.has(body.status) || !Array.isArray(body.sources)) return unavailable;
      if (body.status === 'anchored' || body.status === 'not-anchored') {
        if (!Number.isSafeInteger(body.blockNumber) || body.blockNumber < 0
          || !ADDRESS.test(body.registryAddress || '') || !ADDRESS.test(body.collection || '')
          || !/^\d+$/.test(String(body.bapTokenId)) || !Number.isFinite(Date.parse(body.checkedAt))) return unavailable;
        if (body.sources.some(s => !s || !/^\d+$/.test(s.sourceId) || typeof s.uri !== 'string'
          || !HASH.test(s.contentHash || '') || typeof s.active !== 'boolean')) return unavailable;
        if ((body.status === 'anchored') !== (anchoredMemoryCount(body.sources) > 0)) return unavailable;
      }
      return body;
    } catch { return unavailable; }
  })();
  try { return await Promise.race([read, expired]); }
  finally { clearTimeout(timer); }
}
