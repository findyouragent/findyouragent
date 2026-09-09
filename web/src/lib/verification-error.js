const nonemptyString = (value) => typeof value === 'string' && value.trim() ? value : undefined;

/** Normalize typed JSON failures and terminal SSE error frames consistently. */
export function verificationError(payload, { status } = {}) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const code = nonemptyString(body.code) || nonemptyString(body.error);
  const source = nonemptyString(body.source);
  const identityUnavailable = code === 'identity-unavailable';
  // A 503 is an unavailable service, not by itself evidence of rate limiting.
  const throttled = !identityUnavailable && (code === 'registry-throttled' || body.throttled === true || status === 429);
  const fallback = identityUnavailable
    ? 'The agent identity file could not be read. The previous completed check is unchanged.'
    : throttled ? 'Checks are briefly throttled. Try again shortly.'
      : Number.isInteger(status) ? `Verification is unavailable (HTTP ${status}).` : 'Verification is unavailable.';
  const error = new Error(nonemptyString(body.detail) || nonemptyString(body.message) || fallback);
  error.code = code;
  error.source = source;
  error.retryable = typeof body.retryable === 'boolean' ? body.retryable : undefined;
  error.identityUnavailable = identityUnavailable;
  error.throttled = throttled;
  if (Number.isInteger(status)) error.status = status;
  return error;
}
