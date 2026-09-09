import { config } from '../config.js';
import { safeUrl, safeFetch, safeFetchBytes } from '../net/safe-fetch.js';

const TOKEN_URI_SELECTOR = '0xc87b56dd'; // tokenURI(uint256)
const META_MAX = 200 * 1024;
const URI_MAX = 2 * META_MAX;
const MAX_METADATA_IN_FLIGHT = 256;

let rpcId = 1000;

function rpcFailure(message, retryable = false) {
  return Object.assign(new Error(message), { retryable });
}

async function ethCall(to, data, { signal }) {
  const res = await fetch(config.bscRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal,
  });
  if (!res.ok) {
    const error = rpcFailure('metadata RPC HTTP failure', transientHttp(res.status));
    error.retryAfter = res.headers?.get('retry-after');
    await res.body?.cancel?.().catch(() => {});
    throw error;
  }
  // tokenURI can inline a whole document. Bound the RPC body before decoding
  // its JSON, then separately bound and validate the ABI string.
  const reader = res.body?.getReader();
  if (!reader) throw rpcFailure('metadata RPC has no body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > URI_MAX * 2 + 2048) throw rpcFailure('metadata RPC body exceeds limit');
      chunks.push(Buffer.from(next.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw rpcFailure('metadata RPC returned invalid JSON'); }
  if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'result') || body.error) {
    const error = body?.error;
    throw rpcFailure('metadata RPC did not return a result', error?.code === -32005
      || /rate.?limit|too many|capacity|timeout|try again/i.test(String(error?.message ?? '')));
  }
  return body.result;
}

function decodeString(hex) {
  if (typeof hex !== 'string' || !/^0x(?:[a-fA-F0-9]{64})+$/.test(hex)
      || hex.length > 2 + (URI_MAX + 64) * 2) throw new Error('invalid tokenURI ABI');
  const data = hex.slice(2);
  if (data.length < 128 || BigInt(`0x${data.slice(0, 64)}`) !== 32n) throw new Error('invalid string offset');
  const size = BigInt(`0x${data.slice(64, 128)}`);
  if (size > BigInt(URI_MAX)) throw new Error('tokenURI exceeds limit');
  const length = Number(size);
  if (data.length !== 128 + Math.ceil(length / 32) * 64
      || /[^0]/.test(data.slice(128 + length * 2))) throw new Error('truncated or noncanonical string');
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(data.slice(128, 128 + length * 2), 'hex'));
}

function ipfsToHttp(uri) {
  const rest = uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
  if (rest.includes('..') || rest.startsWith('/')) return null;
  return `https://ipfs.io/ipfs/${rest}`;
}

const transientHttp = (status) => [408, 425, 429].includes(status) || status >= 500;
const objectDocument = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const blockedFetch = (error) => /ssrf-guard: (?:url is not a permitted|host resolves to a blocked)/.test(String(error?.message));

// Waiting is deliberately bounded by the same overall budget. A server asking
// us to back off is left retryable for the next check rather than retried early.
function requiresBackoff(value, now) {
  if (!value) return false;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds > 0 : Date.parse(value) > now;
}

async function bounded(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(rpcFailure('metadata operation timed out', true));
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Fetch a fresh identity document. An RPC outage never establishes absence:
 * only the canonical ABI encoding of an empty tokenURI earns `absent`.
 * Sharing is limited to concurrent reads; mutable HTTPS documents are never
 * replayed from an earlier successful check. Dependencies are injectable for
 * deterministic recovery/deadline tests without weakening default safeFetch.
 */
export function createAgentMetadataReader({
  rpcCall = ethCall, fetchDocument = safeFetch, validateUrl = safeUrl,
  now = () => Date.now(), deadlineMs = 12_000,
  rpcTimeoutMs = Math.min(config.probeTimeoutMs, 3000), documentTimeoutMs = config.probeTimeoutMs,
} = {}) {
  const inFlight = new Map();
  const totalBudget = Math.max(1, Math.min(12_000, deadlineMs));

  return function readMetadata(registryAddress, tokenId) {
    let token;
    const initial = (reason) => ({ status: 'unavailable', uri: null, meta: null, reason,
      checkedAt: new Date(now()).toISOString(), attempts: { rpc: 0, document: 0 } });
    try {
      if (typeof registryAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(registryAddress)
          || !/^(0|[1-9]\d{0,77})$/.test(String(tokenId))
          || (typeof tokenId === 'number' && !Number.isSafeInteger(tokenId))) throw new Error('invalid identity');
      token = BigInt(tokenId);
      if (token >= 1n << 256n) throw new Error('token overflow');
    } catch { return Promise.resolve(initial('invalid-identity')); }
    const key = `${registryAddress.toLowerCase()}:${token}`;
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= MAX_METADATA_IN_FLIGHT) return Promise.resolve(initial('busy'));

    const work = (async () => {
      const deadline = now() + totalBudget;
      const attempts = { rpc: 0, document: 0 };
      const finish = (status, uri = null, meta = null, reason = null) => ({
        status, uri, meta, reason, checkedAt: new Date(now()).toISOString(), attempts: { ...attempts },
      });
      let raw;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const remaining = deadline - now();
        if (remaining <= 0) return finish('unavailable', null, null, 'deadline-exceeded');
        attempts.rpc += 1;
        try {
          raw = await bounded((signal) => rpcCall(registryAddress, TOKEN_URI_SELECTOR + token.toString(16).padStart(64, '0'), { signal }), Math.min(remaining, rpcTimeoutMs));
          break;
        } catch (error) {
          if (attempt === 1 || error?.retryable === false || requiresBackoff(error?.retryAfter, now())) return finish('unavailable', null, null, 'rpc-unavailable');
        }
      }
      let decoded;
      try { decoded = decodeString(raw); }
      catch { return finish('unavailable', null, null, 'token-uri-unreadable'); }
      if (decoded === '') return finish('absent', null, null, 'empty-token-uri');
      const uri = decoded.trim();
      if (!uri) return finish('invalid', decoded, null, 'empty-uri');

      if (uri.startsWith('data:application/json;base64,')) {
        try {
          const encoded = uri.slice('data:application/json;base64,'.length);
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('invalid base64');
          const bytes = Buffer.from(encoded, 'base64');
          if (bytes.length > META_MAX) return finish('invalid', 'data:…', null, 'document-too-large');
          const meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          return objectDocument(meta) ? finish('available', 'data:…', meta)
            : finish('invalid', 'data:…', null, 'invalid-document-shape');
        } catch { return finish('invalid', 'data:…', null, 'invalid-json'); }
      }

      const isIpfs = uri.startsWith('ipfs://');
      if (!isIpfs && !/^https?:\/\//i.test(uri)) return finish('unsupported', uri, null, 'unsupported-uri');
      const primary = isIpfs ? ipfsToHttp(uri) : uri;
      const candidates = isIpfs
        ? [primary, primary?.replace('https://ipfs.io/', 'https://gateway.pinata.cloud/')]
        : [uri, uri];
      let lastStatus = 'unavailable';
      let lastReason = 'document-unavailable';
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (!validateUrl(candidate || '')) return finish('unsupported', uri, null, 'unsafe-uri');
        const remaining = deadline - now();
        if (remaining <= 0) return finish('unavailable', uri, null, 'deadline-exceeded');
        attempts.document += 1;
        let fetched;
        try {
          fetched = await bounded((signal) => fetchDocument(candidate, {
            headers: { accept: 'application/json', 'user-agent': config.userAgent }, signal,
          // safeFetch's capped reader returns a prefix. Ask for one sentinel
          // byte so an oversized document cannot look like complete JSON.
          }, { maxBytes: META_MAX + 1 }), Math.min(remaining, documentTimeoutMs));
        } catch (error) {
          if (blockedFetch(error)) return finish('unsupported', uri, null, 'unsafe-uri');
          lastStatus = 'unavailable'; lastReason = 'document-unavailable';
          if (!isIpfs && error?.retryable === false) break;
          continue;
        }
        if (!fetched?.res?.ok) {
          lastStatus = 'unavailable'; lastReason = 'document-unavailable';
          // Retry-After applies to this gateway. IPFS fallback uses a different
          // host and never retries the throttled primary; HTTPS retries do.
          if (!isIpfs && requiresBackoff(fetched?.res?.headers?.get?.('retry-after'), now())) break;
          if (!isIpfs && !transientHttp(fetched?.res?.status)) break;
          continue;
        }
        const contentType = String(fetched.res.headers?.get?.('content-type') ?? '').split(';')[0].trim();
        const declaredJson = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i.test(contentType);
        const looksHtml = /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(String(fetched.text));
        // A gateway's 200 HTML/error output is not the requested CID's
        // document. Without checking that CID's content hash, even malformed
        // JSON from both gateways cannot establish invalid identity content.
        // For HTTPS, only a complete response declared as JSON may support an
        // invalid-document observation; interstitials remain failed reads.
        const canAttributeInvalid = !isIpfs && declaredJson && !looksHtml;
        try {
          if (typeof fetched.text !== 'string' || Buffer.byteLength(fetched.text, 'utf8') > META_MAX) {
            lastStatus = 'unavailable'; lastReason = 'document-too-large';
          } else {
            const meta = JSON.parse(fetched.text);
            if (objectDocument(meta)) return finish('available', uri, meta);
            lastStatus = canAttributeInvalid ? 'invalid' : 'unavailable';
            lastReason = canAttributeInvalid ? 'invalid-document-shape' : 'document-unavailable';
          }
        } catch {
          lastStatus = canAttributeInvalid ? 'invalid' : 'unavailable';
          lastReason = canAttributeInvalid ? 'invalid-json' : 'document-unavailable';
        }
        if (!isIpfs && (lastStatus === 'invalid'
            || requiresBackoff(fetched.res.headers?.get?.('retry-after'), now()))) break;
      }
      return finish(lastStatus, uri, null, lastReason);
    })();
    inFlight.set(key, work);
    work.finally(() => { inFlight.delete(key); }).catch(() => {});
    return work;
  };
}

const readAgentMetadata = createAgentMetadataReader();
export function getAgentMetadata(registryAddress, tokenId) {
  return readAgentMetadata(registryAddress, tokenId);
}

/**
 * What the first bytes of a file say it is. The magic numbers, not the url:
 * the CZ Apex fleet references its GLB as image, icon AND animation_url under
 * one extensionless CID, so any name-based rule misreads it three ways.
 *
 * glTF-binary opens with the ASCII bytes "glTF". The image formats are the
 * standard signatures. Anything unrecognised returns null and is treated as
 * neither: an <img> pointing at a model renders a broken icon, and a viewer
 * pointing at a video renders a broken scene, so guessing costs more than
 * abstaining.
 */
export function kindFromMagic(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const b = bytes;
  if (b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46) return 'model'; // glTF
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image'; // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image'; // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image'; // GIF8
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image'; // RIFF..WEBP
  if (b[0] === 0x3c) return 'image'; // '<' - svg/xml
  return null;
}

// One sniff per url per process. The same CID backs an entire 150-edition
// fleet, and re-reading its first bytes for every member is pure waste.
const sniffCache = new Map();

/**
 * Fetch just enough of a file to classify it. A range request first; if the
 * gateway ignores ranges (some do), read one chunk off the stream and cancel,
 * so a 20MB model never rides along with a metadata call.
 */
export async function sniffUrlKind(url) {
  if (!url) return null;
  if (sniffCache.has(url)) return sniffCache.get(url);
  let kind = null;
  try {
    // Guarded: the sniff url is attacker-controlled (a token's own metadata)
    // and used to be fetched with no SSRF check at all. safeFetchBytes runs
    // the full resolve + redirect guard and returns only the first bytes.
    const head = await safeFetchBytes(url, 16, {
      headers: { range: 'bytes=0-15', 'user-agent': config.userAgent },
      signal: AbortSignal.timeout(config.probeTimeoutMs),
    });
    kind = kindFromMagic(head);
  } catch {
    kind = null;
  }
  // Only a real classification is memoised. Caching the null cached the
  // OUTAGE: one gateway hiccup withheld an agent's avatar for the life of the
  // process, and a picture is not worth a permanent wrong answer.
  if (kind) {
    sniffCache.set(url, kind);
    if (sniffCache.size > 500) sniffCache.delete(sniffCache.keys().next().value);
  }
  return kind;
}

const ipfsToPinata = (u) => (typeof u === 'string' && u.startsWith('ipfs://')
  ? `https://gateway.pinata.cloud/ipfs/${u.slice(7)}`
  : (typeof u === 'string' ? u : null));

// The same asset hides behind different spellings: ipfs://CID and any
// gateway's /ipfs/CID are one file. Comparing raw strings called them
// different, which handed the model to the <img> poster slot as its own
// "poster" - a GLB fed to an image tag, the broken icon this code exists to
// prevent.
function assetId(u) {
  if (typeof u !== 'string' || !u) return null;
  if (u.startsWith('ipfs://')) return u.slice(7);
  const m = u.match(/\/ipfs\/(.+)$/);
  return m ? m[1] : u;
}

/**
 * The displayable media a REGISTRATION's own metadata names.
 *
 * Self-authored: this is the image or model the registrant chose for their
 * own entry, the same trust class as the image_url the page already renders,
 * so the caller may show it without the token-ownership gate. Extension and
 * flag decide first; where the url is mute (the CZ Apex case), the bytes do.
 *
 * @returns {Promise<object|null>}
 */
export async function mediaFromRegistration(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const anim = typeof meta.animation_url === 'string' ? meta.animation_url.trim() : '';
  const img = typeof meta.image === 'string' && meta.image.trim()
    ? meta.image.trim()
    : (typeof meta.iconUrl === 'string' ? meta.iconUrl.trim() : '');

  if (anim) {
    const flagged = meta.properties?.has_3d_model === true;
    const byExt = /[.](glb|gltf|usdz)([?#]|$)/i.test(anim);
    const poster = img && assetId(img) !== assetId(anim) ? img : null;
    if (flagged || byExt) {
      return { kind: '3d', source: 'registration', animationUrl: anim, image: poster };
    }
    // No extension, no flag: ask the file itself.
    const sniffed = await sniffUrlKind(ipfsToPinata(anim));
    if (sniffed === 'model') {
      return { kind: '3d', source: 'registration', animationUrl: anim, image: poster };
    }
  }
  if (img) {
    // The image field can lie the other way too: a GLB filed as image renders
    // a broken icon. Only sniff when the url gives no answer.
    if (/[.](png|jpe?g|gif|webp|svg)([?#]|$)/i.test(img)) return { kind: 'image', source: 'registration', url: img };
    const sniffed = await sniffUrlKind(ipfsToPinata(img));
    if (sniffed === 'image') return { kind: 'image', source: 'registration', url: img };
    if (sniffed === 'model') return { kind: '3d', source: 'registration', animationUrl: img, image: null };
  }
  return null;
}

/**
 * The displayable 3D asset a token's metadata names, if any.
 *
 * Detection mirrors the pattern proven on BORT's own dapp: the animation_url
 * field is 3D only when the metadata SAYS so (properties.has_3d_model) or the
 * url carries a model extension. animation_url is also the standard field for
 * VIDEO, and without this rule a video renders as a broken 3D scene.
 *
 * Decoration, never evidence: nothing here reaches a verdict, and a failure
 * to read it must cost nothing but the picture.
 */
export function mediaFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const anim = typeof meta.animation_url === 'string' ? meta.animation_url.trim() : '';
  if (!anim) return null;
  const flagged = meta.properties?.has_3d_model === true;
  const modelExt = /\.(glb|gltf|usdz)([?#]|$)/i.test(anim);
  if (!flagged && !modelExt) return null;
  return {
    kind: '3d',
    source: 'token',
    animationUrl: anim,
    image: typeof meta.image === 'string' ? meta.image : null,
  };
}
