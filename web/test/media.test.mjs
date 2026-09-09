import assert from 'node:assert';
import { modelUrl, imageUrl, alternateGateway } from '../src/lib/media.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

// The dual-gateway split is not a preference, it is two independent outages:
// ipfs.io blocks binary GLB payloads, and Pinata mangled JSON when it was
// used for everything. Each helper is pinned to the gateway that works for
// its payload type, and this test exists so nobody "simplifies" them back
// into one.
test('models resolve through Pinata, images through ipfs.io', () => {
  assert.strictEqual(modelUrl('ipfs://QmModel'), 'https://gateway.pinata.cloud/ipfs/QmModel');
  assert.strictEqual(imageUrl('ipfs://QmPoster'), 'https://ipfs.io/ipfs/QmPoster');
});

test('https passes through, everything else is dropped', () => {
  assert.strictEqual(modelUrl('https://example.com/a.glb'), 'https://example.com/a.glb');
  for (const bad of ['javascript:alert(1)', 'http://example.com/a.glb', 'data:text/html,x', 'file:///c/x.glb', '', null, undefined, 42]) {
    assert.strictEqual(modelUrl(bad), null, `modelUrl must drop: ${String(bad)}`);
    assert.strictEqual(imageUrl(bad), null, `imageUrl must drop: ${String(bad)}`);
  }
});

test('an ipfs path with subdirectories survives conversion', () => {
  assert.strictEqual(modelUrl('ipfs://QmDir/model.glb'), 'https://gateway.pinata.cloud/ipfs/QmDir/model.glb');
});

// An agent with a real image was rendering a fallback because ONE gateway
// hiccupped. On <img> error we step to the next public gateway for the same
// CID; only when the chain is exhausted does the fallback show.
test('a failed gateway steps to the next one, then gives up', () => {
  assert.strictEqual(alternateGateway('https://ipfs.io/ipfs/QmX'), 'https://dweb.link/ipfs/QmX');
  assert.strictEqual(alternateGateway('https://dweb.link/ipfs/QmX'), 'https://gateway.pinata.cloud/ipfs/QmX');
  assert.strictEqual(alternateGateway('https://gateway.pinata.cloud/ipfs/QmX'), null, 'last gateway: give up');
});

test('non-IPFS urls have no alternate gateway', () => {
  for (const u of ['https://example.com/a.png', 'https://evil.com/ipfs/QmX', 'ipfs://QmX', '', null, undefined]) {
    assert.strictEqual(alternateGateway(u), null, `no alternate for: ${String(u)}`);
  }
});

test('a CID path with subdirectories survives the gateway step', () => {
  assert.strictEqual(alternateGateway('https://ipfs.io/ipfs/QmDir/poster.jpg'), 'https://dweb.link/ipfs/QmDir/poster.jpg');
});

console.log(`${passed} passed, ${process.exitCode ? 'some' : 0} failed`);
