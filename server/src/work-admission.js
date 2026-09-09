import { AsyncLocalStorage } from 'node:async_hooks';

export const EXTERNAL_WORK_MAX_ACTIVE = 8;

export class WorkCapacityError extends Error {
  constructor(name, maxActive) {
    super(`${name} is at its process-wide active-work limit (${maxActive})`);
    this.name = 'WorkCapacityError';
    this.code = 'work-capacity-limited';
    this.status = 503;
    this.retryAfterSeconds = 1;
  }
}

/**
 * A no-queue process-wide admission gate. Async-local ownership lets a workflow
 * call another admitted dependency without trying to take a second permit.
 */
export function createWorkAdmission({
  maxActive = EXTERNAL_WORK_MAX_ACTIVE,
  name = 'external work',
} = {}) {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new TypeError('maxActive must be a positive safe integer');
  }
  const context = new AsyncLocalStorage();
  const owner = Object.freeze({});
  let active = 0;

  function finishTracked(scope, lease) {
    lease.open = false;
    scope.pending -= 1;
    if (scope.rootSettled && scope.pending === 0 && !scope.released) {
      scope.released = true;
      active -= 1;
    }
  }

  function track(scope, operation) {
    scope.pending += 1;
    const lease = { owner, scope, open: true };
    const promise = context.run(lease, () => Promise.resolve().then(operation));
    return promise.then(
      (value) => { finishTracked(scope, lease); return value; },
      (error) => { finishTracked(scope, lease); throw error; },
    );
  }

  async function run(operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const held = context.getStore();
    if (held?.owner === owner && held.open && !held.scope.released) {
      return track(held.scope, operation);
    }
    if (active >= maxActive) throw new WorkCapacityError(name, maxActive);
    active += 1;
    const scope = { rootSettled: false, pending: 0, released: false };
    try {
      return await track(scope, operation);
    } finally {
      // A detached callback inherits the root lease, which track() closes when
      // the root settles. Existing tracked children have their own open leases
      // and can still call admitted dependencies without reacquiring.
      scope.rootSettled = true;
      if (scope.pending === 0 && !scope.released) {
        scope.released = true;
        active -= 1;
      }
    }
  }

  return {
    run,
    stats: () => ({ active, maxActive, queued: 0 }),
  };
}

export const externalWorkAdmission = createWorkAdmission();

export function capacityResponse(res, error) {
  res.set('retry-after', String(error.retryAfterSeconds));
  return res.status(error.status).json({
    error: error.code,
    retryable: true,
    detail: 'The service is at its active external-work limit. Retry shortly; no new work was started.',
  });
}

/** Hold a permit until the handler promise settles, even if the client closes. */
export function admittedHandler(handler, admission = externalWorkAdmission) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  return async function admitted(req, res, next) {
    try {
      return await admission.run(() => handler(req, res, next));
    } catch (error) {
      if (error instanceof WorkCapacityError && !res.headersSent && !res.writableEnded && !res.destroyed) {
        return capacityResponse(res, error);
      }
      if (typeof next === 'function') return next(error);
      throw error;
    }
  };
}

/** Stop writing an SSE stream once the response reports a disconnect. */
export function createSseSender(res) {
  let open = true;
  res.once('close', () => { open = false; });
  return function send(event) {
    if (!open || res.writableEnded || res.destroyed) return false;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  };
}
