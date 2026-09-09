/**
 * Gateway resolution for token media:
 *
 *   - GLB binaries go through the Pinata gateway. ipfs.io serves JSON and
 *     images fine and BLOCKS binary payloads, which reads as a broken model.
 *   - JSON and images stay on ipfs.io. Pinata mangled metadata fetches when
 *     it was used for everything, which is why this is a dual strategy and
 *     not a preference.
 *   - Allowlist, not blocklist: anything that is not ipfs:// or https: is
 *     dropped. The url comes out of third-party token metadata, and an
 *     allowlist cannot be extended by an attacker inventing a scheme.
 */

const IPFS = /^ipfs:\/\/(.+)$/;

function httpsOrNull(url) {
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// Binary model files: Pinata, the gateway that actually serves them.
export function modelUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(IPFS);
  if (m) return `https://gateway.pinata.cloud/ipfs/${m[1]}`;
  return httpsOrNull(url);
}

// Posters and images: ipfs.io, same as the rest of the site's metadata.
export function imageUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(IPFS);
  if (m) return `https://ipfs.io/ipfs/${m[1]}`;
  return httpsOrNull(url);
}

// ipfs.io is unreliable from many regions, and an agent that HAS a real image
// was rendering a fallback because one gateway hiccupped. On an <img> error,
// step to the next public gateway for the same CID before giving up; null
// when the chain is exhausted (or the url is not an IPFS gateway url at all).
const GATEWAYS = ['ipfs.io', 'dweb.link', 'gateway.pinata.cloud'];
const GATEWAY_PATH = /^https:\/\/([^/]+)\/ipfs\/(.+)$/;

export function alternateGateway(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(GATEWAY_PATH);
  if (!m) return null;
  const idx = GATEWAYS.indexOf(m[1]);
  if (idx === -1 || idx === GATEWAYS.length - 1) return null;
  return `https://${GATEWAYS[idx + 1]}/ipfs/${m[2]}`;
}

/*
  A portrait for an agent that publishes none.

  The hue is derived from the token id, so it is stable for an agent across
  sessions, machines and — the reason this lives here rather than beside the
  table — across pages. A listing row and the agent's own page showed the same
  agent two different faces while this was local to the table.

  Saturation stays low: these are identity marks on an instrument, not a
  palette.
*/
// Four anchors taken from the page's own palette — BNB gold, the up-green,
// a slate, and a warm rust — rather than the full hue circle. An unconstrained
// hash put 34 cyan and violet gradients on the page, which is the exact
// signature this palette was chosen to avoid; a portrait is an identity mark,
// and it can be distinctive without leaving the system it sits in.
const AVATAR_HUES = [45, 150, 222, 18];

export function avatarGradient(seed) {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 4096;
  // An anchor, then a small drift either side of it, so two agents in the same
  // family are still told apart.
  const base = AVATAR_HUES[h % AVATAR_HUES.length];
  // Plus or minus 8, not 12: the wider drift pushed the green band up to 162
  // and the slate band down to 210, both nearer teal than anything else here.
  const hue = (base + ((h >> 2) % 17) - 8 + 360) % 360;
  // Use two lightness stops to keep the status gradient legible.
  return `linear-gradient(145deg, hsl(${hue} 34% 33%), hsl(${hue} 30% 17%))`;
}
