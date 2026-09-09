import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkReleaseConfig, validateReleaseApiBase } from '../check-release-config.mjs';

for (const value of [
  undefined, null, '', '  ', 42,
  'http://api.example.com', '/api', 'api.example.com',
  'https://', 'https://api.example.com:bad',
  'https://user:secret@api.example.com', 'https://@api.example.com',
  'https://api.example.com?key=secret', 'https://api.example.com?',
  'https://api.example.com/#secret', 'https://api.example.com#',
  'https://api.exa\nmple.com', 'https://api.example.com\\path',
  'https://localhost:8787', 'https://LOCALHOST.', 'https://app.localhost',
  'https://api', 'https://api.local', 'https://api.internal', 'https://api.lan',
  'https://0.0.0.0', 'https://127.3.2.1', 'https://127.0.0.1.',
  'https://127.1', 'https://2130706433', 'https://0x7f000001',
  'https://10.2.3.4', 'https://172.16.0.1', 'https://172.31.255.255',
  'https://192.168.2.1', 'https://169.254.169.254', 'https://100.64.0.1',
  'https://224.0.0.1', 'https://255.255.255.255',
  'https://[::]', 'https://[::1]', 'https://[fc00::1]', 'https://[fdab::1]',
  'https://[fe80::1]', 'https://[febf::1]', 'https://[ff02::1]',
  'https://[::ffff:127.0.0.1]', 'https://[::ffff:c0a8:101]',
]) assert.equal(validateReleaseApiBase(value).ok, false, `Rejected fixture: ${String(value)}`);

for (const value of [
  'https://api.example.com', ' https://api.example.com/ ',
  'https://api.example.com/v1', 'https://api.example.com:8443/api/',
  'HTTPS://API.EXAMPLE.COM', 'https://api.example.com.',
  'https://8.8.8.8', 'https://172.15.255.255', 'https://172.32.0.1',
  'https://[2606:4700:4700::1111]', 'https://[::ffff:8.8.8.8]',
]) assert.deepEqual(validateReleaseApiBase(value), { ok: true }, `Accepted fixture: ${value}`);

const fixtureDir = mkdtempSync(join(tmpdir(), 'fya-release-config-'));
const savedApiBase = process.env.VITE_VERIFY_API;
try {
  delete process.env.VITE_VERIFY_API;
  assert.equal(checkReleaseConfig(fixtureDir).ok, false, 'Missing production config fails');
  writeFileSync(join(fixtureDir, '.env'), 'VITE_VERIFY_API=http://localhost:8787\n');
  writeFileSync(join(fixtureDir, '.env.local'), 'VITE_VERIFY_API=http://localhost:8788\n');
  writeFileSync(join(fixtureDir, '.env.production'), 'VITE_VERIFY_API=https://api.example.com\n');
  assert.equal(checkReleaseConfig(fixtureDir).ok, true, 'Production overrides local development files');
  writeFileSync(join(fixtureDir, '.env.production.local'), 'VITE_VERIFY_API=https://localhost\n');
  assert.equal(checkReleaseConfig(fixtureDir).ok, false, 'Production local overrides production');
  process.env.VITE_VERIFY_API = 'https://api.example.com';
  assert.equal(checkReleaseConfig(fixtureDir).ok, true, 'Process configuration has Vite priority');

  const script = fileURLToPath(new URL('../check-release-config.mjs', import.meta.url));
  const secret = 'test-only-secret-should-not-appear';
  const rejected = spawnSync(process.execPath, [script], {
    cwd: fixtureDir, encoding: 'utf8',
    env: { ...process.env, VITE_VERIFY_API: `https://user:${secret}@api.example.com` },
  });
  assert.equal(rejected.status, 1, rejected.error?.message);
  assert.match(rejected.stderr, /VITE_VERIFY_API/);
  assert.match(rejected.stderr, /credentials/);
  assert.ok(!`${rejected.stdout}${rejected.stderr}`.includes(secret), 'CLI never prints configured credentials');
  assert.ok(!`${rejected.stdout}${rejected.stderr}`.includes('api.example.com'), 'CLI never prints the raw configured URL');
  const accepted = spawnSync(process.execPath, [script], {
    cwd: fixtureDir, encoding: 'utf8',
    env: { ...process.env, VITE_VERIFY_API: 'https://api.example.com' },
  });
  assert.equal(accepted.status, 0, accepted.error?.message);
  assert.match(accepted.stdout, /Availability is not checked/);
} finally {
  if (savedApiBase === undefined) delete process.env.VITE_VERIFY_API;
  else process.env.VITE_VERIFY_API = savedApiBase;
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    rmSync(join(fixtureDir, name), { force: true });
  }
  rmdirSync(fixtureDir);
}

console.log('release-config: URL validation, Vite production precedence and redacted CLI checks passed');
