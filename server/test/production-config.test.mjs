import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertProductionConfig, productionConfigErrors } from '../src/production-config.js';

const validEnv = () => ({ NODE_ENV: 'production', DATA_DIR: path.resolve('production-fixture'), ALLOWED_ORIGIN: '*' });
const configUrl = new URL('../src/config.js', import.meta.url).href;
const cliPath = fileURLToPath(new URL('../src/production-config.js', import.meta.url));
const serverPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-production-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir: path.join(root, 'uncreated-data') };
}

// Isolated child environments never inherit dotenv loaders or credentials.
function run(file, env, cwd) {
  return spawnSync(process.execPath, [file], { env, cwd, encoding: 'utf8', timeout: 5000 });
}

test('production defaults remain valid after storage and CORS are explicitly chosen', () => {
  const env = Object.freeze(validEnv());
  assert.deepEqual(productionConfigErrors(env), []);
  assert.doesNotThrow(() => assertProductionConfig(env));
  for (const origin of ['*', '  *  ', 'https://example.test', 'http://localhost:5173', 'https://[::1]:8443',
    'https://findyouragent.xyz, https://findyouragent-seven.vercel.app']) {
    assert.deepEqual(productionConfigErrors({ ...env, ALLOWED_ORIGIN: origin }), []);
  }
});

test('production rejects absent, relative, blank and malformed storage paths', () => {
  for (const value of [undefined, '', ' ', '.', './data', '../data', 'C:data', `${path.resolve('data')}\0`]) {
    assert.match(productionConfigErrors({ ...validEnv(), DATA_DIR: value }).join('\n'), /DATA_DIR/);
  }
  assert.match(productionConfigErrors({ ...validEnv(), NODE_ENV: 'development' }).join('\n'), /NODE_ENV/);
});

test('a fixed CORS origin must match a browser Origin value exactly', () => {
  const invalid = [undefined, '', ' ', 'null', 'example.test', 'https://example.test/',
    'https://example.test/path', 'https://example.test?x=1', 'https://example.test#fragment',
    'https://example.test:443', 'https://EXAMPLE.test', 'https://example.test,,https://other.test',
    'https://example.test, *', '* ,https://other.test',
    'https://example.test\n', 'ftp://example.test', 'https://redacted:placeholder@example.test'];
  for (const origin of invalid) {
    assert.match(productionConfigErrors({ ...validEnv(), ALLOWED_ORIGIN: origin }).join('\n'), /ALLOWED_ORIGIN/);
  }
});

test('rate, cache and sweep knobs reject coercions, missing numbers and unsafe integers', () => {
  const names = ['PORT', 'VERDICT_TTL', 'VERIFY_RATE_MAX', 'TRY_RATE_MAX', 'ACTIVITY_RATE_MAX',
    'RATE_WINDOW_MS', 'SWEEP_INTERVAL_MS', 'SWEEP_PAGE_CYCLE', 'SWEEP_BASELINE_SAMPLE', 'SWEEP_PAGE_SIZE'];
  const invalid = ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '0x10', '1 ', '9007199254740992'];
  for (const name of names) {
    for (const value of invalid) {
      assert.ok(productionConfigErrors({ ...validEnv(), [name]: value }).some((error) => error.startsWith(`${name} `)), name);
    }
    assert.deepEqual(productionConfigErrors({ ...validEnv(), [name]: '1' }), []);
  }
});

test('production guards Node timer overflow, port and registry page bounds', () => {
  for (const [name, max] of [['PORT', 65535], ['RATE_WINDOW_MS', 2147483647],
    ['SWEEP_INTERVAL_MS', 2147483647], ['SWEEP_PAGE_SIZE', 100]]) {
    assert.deepEqual(productionConfigErrors({ ...validEnv(), [name]: String(max) }), []);
    assert.ok(productionConfigErrors({ ...validEnv(), [name]: String(max + 1) }).some((error) => error.startsWith(`${name} `)));
  }
});

test('sweep switch requires an exact boolean even when other sweep knobs are unused', () => {
  for (const value of ['true', 'false']) assert.deepEqual(productionConfigErrors({ ...validEnv(), SWEEP_ENABLED: value }), []);
  for (const value of ['', 'False', '0', 'yes']) {
    assert.match(productionConfigErrors({ ...validEnv(), SWEEP_ENABLED: value }).join('\n'), /SWEEP_ENABLED/);
  }
  assert.match(productionConfigErrors({ ...validEnv(), SWEEP_ENABLED: 'false', SWEEP_INTERVAL_MS: 'NaN' }).join('\n'), /SWEEP_INTERVAL_MS/);
});

test('invalid values are never included in validator errors', () => {
  assert.throws(() => assertProductionConfig({
    NODE_ENV: 'bad-mode-marker', DATA_DIR: 'bad-path-marker', ALLOWED_ORIGIN: 'bad-origin-marker',
    PORT: 'bad-port-marker', SWEEP_ENABLED: 'bad-switch-marker',
  }), (error) => {
    assert.equal(error.code, 'PRODUCTION_CONFIG');
    assert.doesNotMatch(error.message, /marker/);
    for (const name of ['NODE_ENV', 'DATA_DIR', 'ALLOWED_ORIGIN', 'PORT', 'SWEEP_ENABLED']) assert.ok(error.message.includes(name));
    return true;
  });
});

test('CLI checks only injected configuration and does not initialize its data directory', (t) => {
  const { root, dataDir } = fixture(t);
  const result = run(cliPath, { ...validEnv(), DATA_DIR: dataDir }, root);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /syntax is valid/);
  assert.equal(fs.existsSync(dataDir), false);
  const invalid = run(cliPath, {}, root);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /NODE_ENV/);
  assert.match(invalid.stderr, /DATA_DIR/);
  assert.match(invalid.stderr, /ALLOWED_ORIGIN/);
});

test('real production entrypoint fails before store creation for an invalid rate setting', (t) => {
  const { root, dataDir } = fixture(t);
  const result = run(serverPath, { ...validEnv(), DATA_DIR: dataDir, SWEEP_ENABLED: 'false', TRY_RATE_MAX: 'NaN' }, root);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PRODUCTION_CONFIG/);
  assert.match(result.stderr, /TRY_RATE_MAX/);
  assert.equal(fs.existsSync(dataDir), false, 'invalid production configuration must not create stores');
  assert.doesNotMatch(result.stdout, /verify service on/);
});

test('development config keeps defaults without production storage or CORS settings', () => {
  const source = `import { config } from ${JSON.stringify(configUrl)}; console.log(JSON.stringify({ port: config.port, dataDir: config.dataDir, allowedOrigin: config.allowedOrigin, sweepEnabled: config.sweepEnabled, rateWindowMs: config.rateWindowMs }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: {}, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { port: 8787, dataDir: null, allowedOrigin: '*', sweepEnabled: true, rateWindowMs: 60000 });
});
