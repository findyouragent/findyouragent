import assert from 'node:assert';
import { explainNonJsonReply } from '../src/try.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

const PAGE = '<!DOCTYPE html>\n<html lang="en">\n<head><title>ClipX - Tip Anyone on X with BNB</title></head>';

test('an HTML page is reported as a finding, not dumped as source', () => {
  const out = explainNonJsonReply(200, PAGE);
  assert.ok(out.error.includes('serves a web page'));
  assert.ok(out.error.includes('ClipX - Tip Anyone on X with BNB'));
  assert.ok(out.error.includes('finding about the registration'));
  assert.strictEqual(out.raw, undefined, 'the page source must not be returned');
});

test('a page with no title still reports the finding', () => {
  const out = explainNonJsonReply(200, '<html><body>hi</body></html>');
  assert.ok(out.error.includes('serves a web page'));
  assert.ok(!out.error.includes('titled'));
});

test('titles are the agent-authored text, so they are stripped and capped', () => {
  const ctl = String.fromCharCode(7) + String.fromCharCode(127);
  const nasty = `<html><head><title>${'A'.repeat(120)}${ctl}</title></head>`;
  const out = explainNonJsonReply(200, nasty);
  const quoted = out.error.match(/titled "([^"]*)"/)[1];
  assert.ok(quoted.length <= 80, `title capped, got ${quoted.length}`);
  assert.ok([...quoted].every((c) => c >= ' ' && c !== String.fromCharCode(127)),
    'control characters stripped');
});

test('an absurdly long title is dropped entirely rather than quoted', () => {
  // The extractor only looks 200 characters into a title; past that the page
  // is still reported, just without naming itself. Fails closed.
  const out = explainNonJsonReply(200, `<html><head><title>${'A'.repeat(400)}</title></head>`);
  assert.ok(out.error.includes('serves a web page'));
  assert.ok(!out.error.includes('titled'));
});

test('404/405 keeps the misconfigured-card finding', () => {
  for (const status of [404, 405]) {
    const out = explainNonJsonReply(status, PAGE);
    assert.ok(out.error.includes('rejects A2A message/send'));
  }
});

test('a non-HTML, non-JSON body is passed through capped, not explained away', () => {
  const out = explainNonJsonReply(200, 'plain text answer');
  assert.strictEqual(out.raw, 'plain text answer');
  assert.strictEqual(out.error, undefined);
  assert.strictEqual(explainNonJsonReply(200, 'x'.repeat(5000)).raw.length, 2000);
});

test('leading whitespace before the doctype is still HTML', () => {
  assert.ok(explainNonJsonReply(200, '\n   <!doctype html><html>').error.includes('serves a web page'));
});

console.log(`${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
