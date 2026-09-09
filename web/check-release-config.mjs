import { BlockList, isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

// Check literal addresses only. A release build must not depend on DNS or on
// the API being reachable from the build runner.
const nonPublicAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) nonPublicAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) nonPublicAddresses.addSubnet(address, prefix, 'ipv6');

/** Validate configuration shape; this does not establish service availability. */
export function validateReleaseApiBase(value) {
  const base = typeof value === 'string' ? value.trim() : '';
  if (!base) return { ok: false, reason: 'VITE_VERIFY_API is required for a public release.' };
  if (!/^https:\/\//i.test(base) || /[\s\\]/.test(base)) {
    return { ok: false, reason: 'VITE_VERIFY_API must be an absolute HTTPS URL without whitespace or backslashes.' };
  }

  let url;
  try { url = new URL(base); } catch {
    return { ok: false, reason: 'VITE_VERIFY_API must be a valid absolute HTTPS URL.' };
  }
  const authority = base.slice(base.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (authority.includes('@') || url.username || url.password || base.includes('?') || base.includes('#')) {
    return { ok: false, reason: 'VITE_VERIFY_API must not contain credentials, a query string, or a fragment.' };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const ipVersion = isIP(host);
  if (ipVersion) {
    if (nonPublicAddresses.check(host, `ipv${ipVersion}`)) {
      return { ok: false, reason: 'VITE_VERIFY_API must use a public host, not a loopback, private, or reserved address.' };
    }
  } else if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan)$/.test(host)) {
    return { ok: false, reason: 'VITE_VERIFY_API must use a public hostname, not a local or internal name.' };
  }
  return { ok: true };
}

export function checkReleaseConfig(cwd = process.cwd()) {
  // Keep the mode, directory and prefix identical to vite.config.js for the
  // `vite build` command. Vite also gives existing process variables priority.
  const env = loadEnv('production', cwd, 'VITE_');
  return validateReleaseApiBase(env.VITE_VERIFY_API);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try { result = checkReleaseConfig(); } catch {
    result = { ok: false, reason: 'The production Vite environment could not be loaded.' };
  }
  if (!result.ok) {
    console.error(`Release configuration failed: ${result.reason}`);
    console.error('Set VITE_VERIFY_API to the deployed HTTPS verification API in the production build environment, then rebuild. Use npm run build for a local preview.');
    process.exitCode = 1;
  } else {
    console.log('Release configuration passed: a public HTTPS verification API is configured. Availability is not checked.');
  }
}
