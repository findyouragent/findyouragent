function retryDelay(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  const delay = seconds == null ? Date.parse(value) - now : seconds * 1000;
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}

async function readDetail(url, fetchImpl, timeoutMs, direct = false) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { headers: { accept: 'application/json' }, credentials: 'omit', signal: controller.signal });
        const raw = await response.text();
        let body;
        try { body = JSON.parse(raw); } catch { /* HTML errors still retain the HTTP status below. */ }
        if (!response.ok) {
          const notFound = body?.error === 'agent-not-found' || (direct && response.status === 404);
          const detail = typeof body?.detail === 'string' ? body.detail.slice(0, 1000) : null;
          const message = notFound ? 'This agent was not found in the registry.'
            : response.status === 429 || body?.error === 'registry-throttled'
              ? 'Agent lookups are briefly throttled. Please try again shortly.'
              : body?.error === 'registry-unavailable'
                ? 'FYA could not read this agent’s current details from 8004scan. Please try again.'
                : body?.error === 'registry-invalid-response'
                  ? '8004scan did not return a usable registry record. Please try again.'
                  : `The registry lookup failed (${response.status}). Please try again.`;
          const retryAfter = response.headers?.get?.('retry-after') ?? null;
          const error = Object.assign(new Error(detail || message), {
            notFound, status: response.status, code: body?.error ?? 'registry-lookup-failed', detail,
            source: body?.source ?? null, upstreamStatus: body?.upstreamStatus ?? null, retryable: body?.retryable ?? null,
            retryAfter, retryAfterMs: retryDelay(retryAfter),
            unsupportedRoute: [404, 405, 501].includes(response.status)
              && ['route-not-found', 'route-not-supported', 'unsupported-route'].includes(body?.error),
          });
          throw error;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.success === false || body.error != null) {
          throw new Error('The registry lookup returned an unreadable response. Please try again.');
        }
        // FYA wraps detail in {data}; the official 8004scan API returns the
        // agent itself. Do not read the retired website wrapper from a raw API.
        return direct ? body : body.data;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('The registry service is taking too long to respond. Please try again.'), {
            code: 'registry-timeout', timedOut: true,
          }));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof TypeError || error?.name === 'AbortError') {
      throw Object.assign(new Error(direct
        ? 'Your browser could not reach 8004scan. Please try again.'
        : 'Your browser could not reach the FYA API. Please check the connection and try again.'), {
        code: 'registry-network-error', cause: error,
      });
    }
    throw error;
  } finally { clearTimeout(timer); }
}

export async function fetchRegistryDetail({ serviceBase, scanBase, chainId, tokenId, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  if (!/^\d+$/.test(String(chainId)) || !/^\d+$/.test(String(tokenId))) throw new Error('Invalid agent identifier.');
  const validate = (detail) => {
    if (!detail || String(detail.chain_id) !== String(chainId) || String(detail.token_id) !== String(tokenId)) {
      throw new Error('The registry did not return the requested agent. Please try again.');
    }
    return detail;
  };
  let serviceError;
  if (serviceBase) {
    try {
      return validate(await readDetail(`${serviceBase.replace(/\/+$/, '')}/api/agents/${chainId}/${tokenId}`, fetchImpl, timeoutMs));
    } catch (error) {
      if (!error.unsupportedRoute) throw error;
      serviceError = error;
      // Only a clearly unsupported route permits legacy compatibility. An
      // outage, throttle, malformed reply or timeout remains the backend's
      // useful error; an unauthenticated browser request cannot repair it.
    }
  }
  if (typeof scanBase !== 'string' || !scanBase.trim()) {
    throw serviceError || new Error('The registry lookup is not configured.');
  }
  return validate(await readDetail(`${scanBase.replace(/\/+$/, '')}/agents/${chainId}/${tokenId}`, fetchImpl, Math.min(timeoutMs, 6000), true));
}
