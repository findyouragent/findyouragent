// Shared by the app, docs and machine-readable files. Production builds suppress
// loopback API bases; development builds retain them for the local service.
export const LOOPBACK_API = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;

/**
 * The configured API base, or '' when production would publish a loopback URL.
 *
 * @param {string} value          VITE_VERIFY_API as configured
 * @param {boolean} isProduction  whether this is a production build
 */
export function resolveApiBase(value, isProduction) {
  const base = String(value ?? '').trim();
  return isProduction && LOOPBACK_API.test(base) ? '' : base;
}
