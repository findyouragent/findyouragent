import { parseAllowedOrigins } from './production-config.js';

const ALLOW_HEADERS = 'content-type, mcp-session-id, mcp-protocol-version';
const ALLOW_METHODS = 'GET,POST,OPTIONS';

/**
 * Express middleware for exact-origin CORS.
 *
 * Wildcard mode is constant. In allowlist mode the response reflects only an
 * exact Origin member and varies caches by Origin, including when no member is
 * allowed. Invalid settings fail during startup rather than creating a policy
 * that could accidentally echo a caller-controlled value.
 */
export function createCorsMiddleware(allowedOrigin) {
  const parsed = parseAllowedOrigins(allowedOrigin);
  if (!parsed.ok) throw new Error(parsed.error);
  const { wildcard, origins } = parsed;
  const allowed = new Set(origins);

  return (req, res, next) => {
    res.set('access-control-allow-headers', ALLOW_HEADERS);
    res.set('access-control-allow-methods', ALLOW_METHODS);
    if (wildcard) {
      res.set('access-control-allow-origin', '*');
    } else {
      res.vary('Origin');
      const requestOrigin = req.get('Origin');
      if (typeof requestOrigin === 'string' && allowed.has(requestOrigin)) {
        res.set('access-control-allow-origin', requestOrigin);
      }
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  };
}
