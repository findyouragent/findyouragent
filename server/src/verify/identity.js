export const IDENTITY_UNAVAILABLE = 'identity-unavailable';
export const IDENTITY_UNAVAILABLE_MESSAGE = 'The agent identity file could not be read. The previous completed check is unchanged.';

export class IdentityReadError extends Error {
  constructor() {
    super(IDENTITY_UNAVAILABLE_MESSAGE);
    this.code = IDENTITY_UNAVAILABLE;
    this.source = 'agent-identity';
    this.retryable = true;
  }
}

// Transport failure cannot establish that a token has no identity document.
// Only the reader's explicit, successfully observed absence may say that.
export function identityObservation(result) {
  if (result?.status === 'unavailable') throw new IdentityReadError();
  const object = result?.meta !== null && typeof result?.meta === 'object' && !Array.isArray(result.meta);
  if (object && (!result.status || result.status === 'available')) return { status: 'available', card: result.meta };
  if (['absent', 'invalid', 'unsupported'].includes(result?.status)) return { status: result.status, card: null };
  throw new IdentityReadError();
}
