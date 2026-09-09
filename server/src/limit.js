/**
 * Per-IP rate limiting for the expensive routes.
 *
 * This service relays requests to third-party agent endpoints and spends a
 * shared registry budget. Both are someone else's resources. Without a bound,
 * a single client can drain the registry budget for every visitor at once, or point the relay at an agent's server
 * repeatedly and make this host the source of that traffic.
 *
 * Deliberately in-memory and per-process. It is a courtesy bound, not a
 * security control: anything stronger needs shared state this service does not
 * have, and pretending otherwise would be the kind of overclaim this project
 * exists to argue against.
 */
export function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map();

  // Sweep expired buckets rather than letting the map grow with every IP that
  // ever visits. Unref'd so it never holds the process open.
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, bucket] of hits) {
      if (bucket.start < cutoff) hits.delete(key);
    }
  }, windowMs);
  if (typeof timer.unref === 'function') timer.unref();

  return function limit(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.set('x-ratelimit-limit', String(max));
    res.set('x-ratelimit-remaining', String(remaining));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.set('retry-after', String(Math.max(1, retryAfter)));
      return res.status(429).json({
        error: 'rate-limited',
        detail: `Too many ${name} requests from this address. This service relays to third-party agents and shares one registry budget across all visitors, so the limit is ${max} per ${Math.round(windowMs / 1000)}s. Try again shortly.`,
      });
    }
    return next();
  };
}
