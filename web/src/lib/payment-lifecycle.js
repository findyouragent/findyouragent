import {
  consumePaymentChallenge,
  lockPaymentChallenge,
  paymentChallengeState,
  rememberTryHistory,
  releasePaymentChallenge,
} from './try-session.js';

export function newPaymentChallengeId() {
  return globalThis.crypto.randomUUID();
}

export { paymentChallengeState };

export function paymentResponseOutcome(result) {
  return result?.error || result?.observation?.outcome === 'unknown'
    || result?.observation?.captureComplete === false
    ? 'submitted-unknown'
    : 'response-received';
}

// Used inside TryAgent's React functional state updater. Keeping this here lets
// lifecycle tests reproduce delayed updater ordering without a DOM or wallet.
function updatePaymentHistory(agentKey, challengeId, paymentChallenge, entries) {
  const next = entries.map((entry) => entry.paymentChallengeId === challengeId
    ? { ...entry, ...(paymentChallenge.state === 'available' ? { paymentChallenge: undefined } : { paymentChallenge }) }
    : entry);
  rememberTryHistory(agentKey, next);
  return next;
}

export function paymentHistoryUpdater(agentKey, challengeId, paymentChallenge, isCurrent) {
  return (entries) => isCurrent()
    ? updatePaymentHistory(agentKey, challengeId, paymentChallenge, entries)
    : entries;
}

// The component supplies the real signer and relay call. This function owns
// their ordering so a challenge is locked before the wallet opens and retired
// synchronously as soon as a signature-bearing payment payload exists.
export async function runPaymentAttempt({
  agentKey,
  challengeId,
  sign,
  submit,
  isCurrent = () => true,
  responseOutcome = () => 'response-received',
  onStateChange,
}) {
  if (!lockPaymentChallenge(challengeId)) {
    return { kind: 'blocked', paymentChallenge: paymentChallengeState(challengeId) };
  }
  onStateChange?.({ state: 'prompting', outcome: null });

  let payment;
  let signed = false;
  let state;
  const markSigned = () => {
    if (signed) return state;
    signed = true;
    state = consumePaymentChallenge(agentKey, challengeId, 'signed-not-submitted');
    onStateChange?.(state);
    return state;
  };
  try {
    payment = await sign(markSigned);
    // Signers should call markSigned at the exact wallet boundary. Retire here
    // as a safe fallback for callers that can only return a finished payload.
    markSigned();
  } catch (error) {
    if (!signed) {
      releasePaymentChallenge(agentKey, challengeId);
      onStateChange?.({ state: 'available', outcome: null });
      return { kind: 'sign-error', error };
    }
    return { kind: 'post-sign-error', error, paymentChallenge: state };
  }

  // From this point onward the challenge cannot create another authorization,
  // even if the component unmounts or the relay response is lost.
  if (!isCurrent()) return { kind: 'retired', paymentChallenge: state };

  state = consumePaymentChallenge(agentKey, challengeId, 'submitted-unknown');
  onStateChange?.(state);
  try {
    const result = await submit(payment);
    const outcome = responseOutcome(result) === 'submitted-unknown'
      ? 'submitted-unknown'
      : 'response-received';
    state = consumePaymentChallenge(agentKey, challengeId, outcome);
    onStateChange?.(state);
    return { kind: 'response', result, paymentChallenge: state };
  } catch (error) {
    // The request may have reached the relay/provider. Retire the challenge and
    // preserve uncertainty instead of inviting another authorization.
    return { kind: 'submit-error', error, paymentChallenge: state };
  }
}
