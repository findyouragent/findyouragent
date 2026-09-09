import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';
import { externalWorkAdmission } from '../work-admission.js';

/**
 * The SSRF boundary for a service whose entire job is fetching URLs that the
 * party being assessed wrote. Every agent record from the registry embeds
 * attacker-authored endpoint strings, because anyone can mint an agent, so a
 * declared endpoint is hostile input the moment it is read.
 *
 * The old guard checked only the hostname STRING against a regex. That let
 * through, all confirmed against `new URL()`:
 *   - 169.254.169.254 (cloud metadata) and the whole 169.254/16 link-local range
 *   - [::ffff:127.0.0.1] (IPv4-mapped loopback) and IPv6 ULA/link-local (fc00::/7, fe80::/10)
 *   - [::] and ::1
 *   - a plain DNS name whose A record points at 127.0.0.1 or a private IP,
 *     because the string was never resolved
 * and it followed redirects, so a public host could 302 to an internal one
 * after the check had already passed.
 *
 * This module closes all of those: literal IPs are range-classified (URL
 * normalises every decimal/hex/octal encoding to canonical form first), names
 * are RESOLVED and every returned address classified, redirects are followed
 * MANUALLY with the same checks re-run on each hop, and the body is read under
 * a hard byte cap during transfer rather than buffered whole and sliced.
 */

// IPv4 ranges that must never be a fetch destination. Loopback, private,
// link-local (incl. 169.254.169.254 metadata), CGNAT, unspecified, benchmark,
// and TEST-NET blocks: none belong to a public agent endpoint.
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → refuse
  const [a, b, c] = p;
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF 192.0.0/24, TEST-NET-1 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113/24
  if (a >= 224) return true; // multicast + reserved 224.0.0.0/3
  return false;
}

// Strip an IPv4-mapped or -embedded prefix and hand the tail to the v4 check;
// otherwise classify the v6 address by prefix. Refuses anything it cannot
// positively call public.
function isPrivateIPv6(raw) {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip === '::1' || ip === '::') return true; // loopback, unspecified
  // IPv4-mapped/-compatible/-translated: ::ffff:a.b.c.d, ::ffff:0:a.b.c.d,
  // 64:ff9b::a.b.c.d, or the hex forms ::ffff:7f00:1.
  const mappedDotted = ip.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mappedDotted && /(^::(ffff:)?(0:)?)|(^64:ff9b::)/.test(ip)) {
    return isPrivateIPv4(mappedDotted[1]);
  }
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const head = parseInt(ip.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (ip.startsWith('2002:')) return true; // 6to4 embeds v4 we cannot cheaply vet
  return false;
}

// Classify a resolved or literal address. Anything not recognisably a public
// unicast address is refused: default-closed, because a missed range is a
// hole and a false refusal only costs one unreachable agent its picture.
export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

/**
 * Synchronous shape check: protocol allowlist, and if the host is a LITERAL
 * ip, range-classify it now. `new URL()` normalises decimal/hex/octal IPv4
 * (2130706433, 0x7f000001, 0177...) and bracketed IPv6 to canonical form, so
 * this catches every encoding of a literal address. A host that is a NAME is
 * left for the async resolve step (`assertResolvesPublic`, done in safeFetch).
 *
 * @returns {{ url: URL, needsResolve: boolean } | null}
 */
function checkUrl(raw, { requireHttps = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (requireHttps && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    return isBlockedAddress(host) ? null : { url, needsResolve: false };
  }
  // A bare "localhost" (and friends) never resolves to anything public.
  if (/^(localhost|.*\.localhost)$/i.test(host)) return null;
  return { url, needsResolve: true };
}

/**
 * The drop-in replacement for the old guard: a URL when the address is a
 * permitted public http(s) endpoint, null otherwise. Same URL|null contract
 * the callers already expect, now with full literal-IP and IPv6 coverage.
 *
 * This is the SYNCHRONOUS layer. A hostname that resolves to a private IP
 * still passes here (its string is innocent); the DNS-resolution check that
 * closes that hole lives in safeFetch and runs at fetch time.
 */
export function safeUrl(raw, options) {
  return checkUrl(raw, options)?.url ?? null;
}

// Resolve a hostname and refuse if ANY returned address is private. A domain
// with a single static A record pointing at 127.0.0.1 is the confirmed
// exploit, and this closes it; re-resolving at fetch time also shrinks the
// rebinding window to near zero for these short-lived requests.
async function assertResolvesPublic(hostname) {
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('ssrf-guard: host does not resolve');
  }
  if (!addrs.length) throw new Error('ssrf-guard: host does not resolve');
  for (const { address } of addrs) {
    if (isBlockedAddress(address)) throw new Error('ssrf-guard: host resolves to a blocked address');
  }
  // Hand back the vetted address so the CONNECTION uses the same one we
  // checked. Vetting a name and then handing the name to fetch lets undici
  // resolve again, and a nameserver answering public-then-private across those
  // two lookups is exactly the rebinding this guard is for.
  return addrs[0];
}

// An undici dispatcher whose DNS lookup is hard-wired to the address we already
// approved. This is what makes resolve-and-recheck actually binding.
export function pinnedLookup(pinned) {
  const address = String(pinned?.address ?? '');
  const family = Number(pinned?.family) || net.isIP(address);
  if (!address || ![4, 6].includes(family) || isBlockedAddress(address)) {
    throw new Error('ssrf-guard: cannot pin an unapproved address');
  }
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function pinnedDispatcher(pinned) {
  return new Agent({
    connect: {
      lookup: pinnedLookup(pinned),
    },
  });
}

async function destroyDispatcher(dispatcher) {
  if (!dispatcher) return;
  try {
    await dispatcher.destroy();
  } catch {
    try { await dispatcher.close(); } catch { /* cleanup cannot replace the request result */ }
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-payment', 'mcp-session-id',
]);

function requestMethod(opts) {
  return String(opts?.method ?? 'GET').toUpperCase();
}

function hasSensitiveHeaders(headers) {
  if (!headers) return false;
  try {
    for (const [name] of new Headers(headers)) {
      if (SENSITIVE_HEADERS.has(name.toLowerCase())) return true;
    }
  } catch {
    // Let fetch report malformed headers. Treat them as sensitive until then.
    return true;
  }
  return false;
}

function protectedRequest(opts) {
  return !SAFE_METHODS.has(requestMethod(opts)) || opts?.body != null || hasSensitiveHeaders(opts?.headers);
}

async function cancelBody(res) {
  try { await res.body?.cancel?.(); } catch { /* cleanup must not mask the policy error */ }
}

/**
 * Fetch a URL that came from untrusted metadata, with the full guard applied
 * on the original AND on every redirect hop, and the body read under a byte
 * cap during transfer.
 *
 * @param {string|URL} rawUrl
 * @param {object} [opts]  passed to fetch (method, headers, body, signal)
 * @param {number} [maxBytes]  hard cap on the body read (default 256KB)
 * @param {number} [maxRedirects]  hops followed manually (default 3)
 * @returns {Promise<{ res: Response, text: string, url: string }>}
 */
async function safeFetchImpl(rawUrl, opts = {}, {
  maxBytes = 256 * 1024, maxRedirects = 3, requireHttps = false,
} = {}) {
  let current = typeof rawUrl === 'string' ? rawUrl : String(rawUrl);
  const protectedHop = protectedRequest(opts);
  const httpsOnly = requireHttps || protectedHop;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const checked = checkUrl(current, { requireHttps: httpsOnly });
    if (!checked) throw new Error('ssrf-guard: url is not a permitted public http(s) address');
    const pinned = checked.needsResolve ? await assertResolvesPublic(checked.url.hostname) : null;
    const dispatcher = pinned ? pinnedDispatcher(pinned) : null;

    // manual, so a 3xx cannot carry us to a private host the guard never saw;
    // pinned, so the connection goes to the address we actually vetted.
    let res;
    try {
      res = await fetch(checked.url, {
        ...opts,
        redirect: 'manual',
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      await destroyDispatcher(dispatcher);
      throw error;
    }

    const location = res.headers.get('location');
    if (REDIRECT_STATUSES.has(res.status) && location) {
      await cancelBody(res);
      await destroyDispatcher(dispatcher);
      if (hop === maxRedirects) throw new Error('ssrf-guard: too many redirects');
      const next = new URL(location, checked.url);
      if (httpsOnly && next.protocol !== 'https:') throw new Error('ssrf-guard: https downgrade is not permitted');
      if (protectedHop && next.origin !== checked.url.origin) {
        throw new Error('ssrf-guard: protected request cannot cross origins');
      }
      if (!SAFE_METHODS.has(requestMethod(opts)) && [301, 302, 303].includes(res.status)) {
        throw new Error('ssrf-guard: unsafe request cannot change method on redirect');
      }
      current = next.toString();
      continue;
    }
    try {
      const text = await readCapped(res, maxBytes);
      return { res, text, url: String(checked.url) };
    } finally {
      await destroyDispatcher(dispatcher);
    }
  }
  throw new Error('ssrf-guard: too many redirects');
}

export function safeFetch(rawUrl, opts, policy) {
  return externalWorkAdmission.run(() => safeFetchImpl(rawUrl, opts, policy));
}

/**
 * Guarded fetch that returns just the first `n` bytes, for magic-number
 * classification. The sniffer needs raw bytes, not utf8 text, and it used to
 * fetch its (attacker-controlled) url with no SSRF guard at all.
 *
 * @returns {Promise<Uint8Array>}
 */
async function safeFetchBytesImpl(rawUrl, n = 16, opts = {}) {
  if (protectedRequest(opts)) {
    throw new Error('ssrf-guard: byte fetch permits only credential-free GET or HEAD requests');
  }
  let current = typeof rawUrl === 'string' ? rawUrl : String(rawUrl);
  for (let hop = 0; hop <= 3; hop += 1) {
    const checked = checkUrl(current);
    if (!checked) throw new Error('ssrf-guard: url is not a permitted public http(s) address');
    const pinned = checked.needsResolve ? await assertResolvesPublic(checked.url.hostname) : null;
    const dispatcher = pinned ? pinnedDispatcher(pinned) : null;
    let res;
    try {
      res = await fetch(checked.url, {
        ...opts,
        redirect: 'manual',
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      await destroyDispatcher(dispatcher);
      throw error;
    }
    const location = res.headers.get('location');
    if (REDIRECT_STATUSES.has(res.status) && location) {
      await cancelBody(res);
      await destroyDispatcher(dispatcher);
      if (hop === 3) throw new Error('ssrf-guard: too many redirects');
      current = new URL(location, checked.url).toString();
      continue;
    }
    try {
      if (!res.ok || !res.body) {
        await cancelBody(res);
        return new Uint8Array();
      }
      const reader = res.body.getReader();
      const { value } = await reader.read();
      await reader.cancel().catch(() => {});
      return (value ?? new Uint8Array()).slice(0, n);
    } finally {
      await destroyDispatcher(dispatcher);
    }
  }
  return new Uint8Array();
}

export function safeFetchBytes(rawUrl, n, opts) {
  return externalWorkAdmission.run(() => safeFetchBytesImpl(rawUrl, n, opts));
}

/**
 * Read a response body up to `maxBytes`, aborting the stream once the cap is
 * passed. The old code called res.text() and THEN sliced, which buffered the
 * whole attacker payload first: the cap was decorative and the memory was
 * already spent. This bounds the transfer itself.
 */
export async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const cap = maxBytes ?? 256 * 1024;
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        reader.cancel().catch(() => {});
        chunks.push(value.slice(0, value.byteLength - (total - cap)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
