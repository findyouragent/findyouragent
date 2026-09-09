import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createCorsMiddleware } from '../src/cors.js';
import { productionConfigErrors } from '../src/production-config.js';

const PRIMARY = 'https://findyouragent.xyz';
const VERCEL = 'https://findyouragent-seven.vercel.app';

function mockResponse() {
  const headers = new Map();
  return {
    headers,
    statusCode: 200,
    ended: false,
    set(name, value) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    vary(name) {
      const key = 'vary';
      const current = headers.get(key);
      const fields = current ? current.split(',').map((field) => field.trim().toLowerCase()) : [];
      if (!fields.includes(name.toLowerCase())) fields.push(name.toLowerCase());
      headers.set(key, fields.join(', '));
      return this;
    },
    sendStatus(status) {
      this.statusCode = status;
      this.ended = true;
      return this;
    },
  };
}

function mockRequest(method = 'GET', origin) {
  return {
    method,
    get(name) {
      return name.toLowerCase() === 'origin' ? origin : undefined;
    },
  };
}

function runMiddleware(allowedOrigin, method = 'GET', requestOrigin) {
  const middleware = createCorsMiddleware(allowedOrigin);
  const req = mockRequest(method, requestOrigin);
  const res = mockResponse();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('allowlist reflects either configured site exactly and varies by Origin', () => {
  for (const origin of [PRIMARY, VERCEL]) {
    const { res, nextCalled } = runMiddleware(`${PRIMARY},  ${VERCEL}`, 'GET', origin);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('vary'), 'origin');
    assert.equal(res.headers.get('access-control-allow-headers'), 'content-type, mcp-session-id, mcp-protocol-version');
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET,POST,OPTIONS');
    assert.equal(nextCalled, true);
  }
});

test('allowlist does not reflect disallowed, suffix-spoofed, or absent origins', () => {
  for (const origin of [
    'https://evil.test',
    'https://findyouragent.xyz.evil.test',
    undefined,
  ]) {
    const { res, nextCalled } = runMiddleware(`${PRIMARY},${VERCEL}`, 'GET', origin);
    assert.equal(res.headers.has('access-control-allow-origin'), false);
    assert.equal(res.headers.get('vary'), 'origin');
    assert.equal(nextCalled, true);
  }
});

test('allowlist OPTIONS remains a compatible preflight and never grants a disallowed origin', () => {
  const allowed = runMiddleware(`${PRIMARY},${VERCEL}`, 'OPTIONS', VERCEL);
  assert.equal(allowed.res.statusCode, 204);
  assert.equal(allowed.res.ended, true);
  assert.equal(allowed.res.headers.get('access-control-allow-origin'), VERCEL);
  assert.equal(allowed.nextCalled, false);

  const denied = runMiddleware(`${PRIMARY},${VERCEL}`, 'OPTIONS', 'https://evil.test');
  assert.equal(denied.res.statusCode, 204);
  assert.equal(denied.res.headers.has('access-control-allow-origin'), false);
  assert.equal(denied.nextCalled, false);
});

test('wildcard mode remains explicit and does not need Origin variance', () => {
  const { res, nextCalled } = runMiddleware('*', 'GET', 'https://anywhere.test');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.has('vary'), false);
  assert.equal(nextCalled, true);
});

test('production validator rejects malformed allowlists without echoing values', () => {
  const base = { NODE_ENV: 'production', DATA_DIR: path.resolve('production-fixture') };
  const invalid = [
    undefined,
    '',
    ' ',
    ',',
    `${PRIMARY},`,
    `${PRIMARY},,${VERCEL}`,
    `*,${VERCEL}`,
    `${PRIMARY}, *`,
    `${PRIMARY}/path`,
    `${PRIMARY}?query=1`,
    'https://user:password@example.test',
    'ftp://example.test',
    'findyouragent.xyz',
  ];
  for (const value of invalid) {
    const errors = productionConfigErrors({ ...base, ALLOWED_ORIGIN: value }).join('\n');
    assert.match(errors, /ALLOWED_ORIGIN/);
    assert.doesNotMatch(errors, /findyouragent|vercel|password|example\.test|query/);
  }
});
