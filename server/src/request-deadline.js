import { externalWorkAdmission } from './work-admission.js';

// One deadline covers a whole operation, including discovery and body reads.
// Abort the underlying work and stop waiting even if a resolver ignores abort.
export async function withDeadline(timeoutMs, operation, parentSignal, admission = externalWorkAdmission) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Request deadline exceeded', 'TimeoutError')), timeoutMs);
  const signal = controller.signal;
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const running = admission.run(() => {
      signal.throwIfAborted();
      return operation(signal);
    });
    return await Promise.race([stopped, running]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}
