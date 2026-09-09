import { config } from '../config.js';

// B402 Bazaar listings are settlement-verified: a merchant appears only because
// x402 payments actually settled through Binance's facilitator. That makes this
// the strongest "real usage" signal available without an API key.
export async function getBazaarUsage(payToAddress) {
  if (!payToAddress) return { listed: false, checked: false };
  try {
    const url = `${config.bazaarBase}/bazaar/merchant?payTo=${encodeURIComponent(payToAddress)}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': config.userAgent },
      signal: AbortSignal.timeout(config.probeTimeoutMs),
    });
    if (!res.ok) return { listed: false, checked: true };
    const body = await res.json();
    const resources = body?.data?.resources ?? body?.data ?? [];
    const list = Array.isArray(resources) ? resources : [resources].filter(Boolean);
    if (list.length === 0) return { listed: false, checked: true };
    const sum = (key) => list.reduce((acc, r) => acc + (Number(r?.[key]) || 0), 0);
    return {
      listed: true,
      checked: true,
      resourceCount: list.length,
      calls30d: sum('callVolume30d') || sum('call_volume_30d') || null,
      uniquePayers: sum('uniquePayers') || sum('unique_payers') || null,
    };
  } catch {
    return { listed: false, checked: false };
  }
}
