import assert from 'node:assert';
import { safeUrl, isBlockedAddress, readCapped } from '../src/net/safe-fetch.js';

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; } catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
};

const blocked = (u) => assert.strictEqual(safeUrl(u), null, `must block: ${u}`);
const allowed = (u) => assert.ok(safeUrl(u), `must allow: ${u}`);

// Cover literal private and reserved IP forms that URL parsers can normalize.
test('literal private and reserved IPs are blocked in all encodings', () => {
  for (const u of [
    'http://169.254.169.254/latest/meta-data/',   // cloud metadata, the headline miss
    'http://2852039166/',                           // 169.254.169.254 in decimal
    'http://127.0.0.1/', 'http://localhost/',
    'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', // 127.0.0.1 encodings
    'http://[::1]/', 'http://[::]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',          // IPv4-mapped loopback
    'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[fec0::1]/',    // ULA / link-local
    'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://172.31.255.255/',
    'http://0.0.0.0/', 'http://100.64.0.1/',                          // unspecified, CGNAT
  ]) blocked(u);
});

test('the 172.16-31 boundary is exact', () => {
  blocked('http://172.16.0.1/');
  blocked('http://172.31.0.1/');
  allowed('http://172.15.0.1/');
  allowed('http://172.32.0.1/');
});

test('non-http(s) schemes are refused', () => {
  for (const u of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://x/', 'data:text/html,x', 'javascript:alert(1)']) blocked(u);
});

test('public hosts pass, returning a URL (the caller contract)', () => {
  for (const u of ['https://ipfs.io/ipfs/Qm', 'https://gateway.pinata.cloud/ipfs/Qm', 'https://api.bortagent.xyz/x', 'http://1.1.1.1/']) {
    const out = safeUrl(u);
    assert.ok(out instanceof URL, `must return a URL: ${u}`);
  }
});

test('isBlockedAddress classifies resolved addresses, default-closed on garbage', () => {
  assert.strictEqual(isBlockedAddress('8.8.8.8'), false);
  assert.strictEqual(isBlockedAddress('169.254.169.254'), true);
  assert.strictEqual(isBlockedAddress('::ffff:10.0.0.1'), true);
  assert.strictEqual(isBlockedAddress('not-an-ip'), true, 'unparseable → refuse');
  assert.strictEqual(isBlockedAddress('2606:4700::1111'), false, 'public v6 allowed');
});

await test('readCapped stops at the byte cap during transfer', async () => {
  // A body larger than the cap must come back truncated, not whole.
  const big = 'x'.repeat(10_000);
  const res = new Response(big);
  const out = await readCapped(res, 1000);
  assert.ok(out.length <= 1000, `expected <=1000, got ${out.length}`);
  const small = await readCapped(new Response('hello'), 1000);
  assert.strictEqual(small, 'hello');
});

console.log(`${passed} passed, ${process.exitCode ? 'some' : 0} failed`);
