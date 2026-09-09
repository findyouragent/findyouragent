import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { test } from 'node:test';
import { pinnedLookup, safeFetch, safeFetchBytes, safeUrl } from '../src/net/safe-fetch.js';

async function withNetworkMocks({ lookup, fetch }, operation) {
  const originalLookup = dns.lookup;
  const originalFetch = globalThis.fetch;
  if (lookup) dns.lookup = lookup;
  if (fetch) globalThis.fetch = fetch;
  try {
    return await operation();
  } finally {
    dns.lookup = originalLookup;
    globalThis.fetch = originalFetch;
  }
}

function observeDispatcher(options, counts) {
  assert.ok(options.dispatcher, 'a resolved hostname must use a pinned dispatcher');
  counts.dispatcher = options.dispatcher;
}

test('HTTPS-only admission rejects cleartext while public read admission can retain HTTP', () => {
  assert.ok(safeUrl('https://example.test/path', { requireHttps: true }));
  assert.equal(safeUrl('http://example.test/path', { requireHttps: true }), null);
  assert.ok(safeUrl('http://example.test/public-media'));
});

test('pinned lookup supports single and all address callback shapes', async () => {
  const lookupV4 = pinnedLookup({ address: '8.8.8.8', family: 4 });
  const single = await new Promise((resolve, reject) => {
    lookupV4('ignored.test', { all: false }, (error, address, family) => {
      if (error) reject(error); else resolve({ address, family });
    });
  });
  assert.deepEqual(single, { address: '8.8.8.8', family: 4 });

  const lookupV6 = pinnedLookup({ address: '2606:4700:4700::1111', family: 6 });
  const all = await new Promise((resolve, reject) => {
    lookupV6('ignored.test', { all: true }, (error, addresses) => {
      if (error) reject(error); else resolve(addresses);
    });
  });
  assert.deepEqual(all, [{ address: '2606:4700:4700::1111', family: 6 }]);
  assert.throws(() => pinnedLookup({ address: '127.0.0.1', family: 4 }), /cannot pin an unapproved address/);
});

test('resolved fetch binds a dispatcher and destroys it after a consumed response', async () => {
  const counts = { lookup: 0, fetch: 0, dispatcher: null };
  await withNetworkMocks({
    lookup: async (hostname, options) => {
      counts.lookup += 1;
      assert.equal(hostname, 'public.example.test');
      assert.equal(options.all, true);
      return [{ address: '8.8.8.8', family: 4 }];
    },
    fetch: async (_url, options) => {
      counts.fetch += 1;
      observeDispatcher(options, counts);
      return new Response('bounded reply');
    },
  }, async () => {
    const result = await safeFetch('https://public.example.test/data', {}, { requireHttps: true });
    assert.equal(result.text, 'bounded reply');
  });
  assert.equal(counts.lookup, 1);
  assert.equal(counts.fetch, 1);
  assert.equal(counts.dispatcher.destroyed, true);
});

test('resolved fetch destroys its dispatcher when fetch rejects', async () => {
  const counts = { dispatcher: null };
  await withNetworkMocks({
    lookup: async () => [{ address: '8.8.4.4', family: 4 }],
    fetch: async (_url, options) => {
      observeDispatcher(options, counts);
      throw new TypeError('offline transport failure');
    },
  }, async () => {
    await assert.rejects(
      safeFetch('https://failure.example.test/data', {}, { requireHttps: true }),
      /offline transport failure/,
    );
  });
  assert.equal(counts.dispatcher.destroyed, true);
});

test('each redirected hostname hop destroys its pinned dispatcher', async () => {
  const dispatchers = [];
  let calls = 0;
  await withNetworkMocks({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async (_url, options) => {
      calls += 1;
      dispatchers.push(options.dispatcher);
      return calls === 1
        ? new Response('', { status: 302, headers: { location: 'https://redirect.example.test/next' } })
        : new Response('done');
    },
  }, async () => {
    const result = await safeFetch('https://origin.example.test/start', {}, { requireHttps: true });
    assert.equal(result.text, 'done');
  });
  assert.equal(dispatchers.length, 2);
  assert.ok(dispatchers.every((dispatcher) => dispatcher?.destroyed === true));
});

test('byte sniff cancels its reader and destroys the pinned dispatcher', async () => {
  const state = { canceled: 0, dispatcher: null };
  await withNetworkMocks({
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
    fetch: async (_url, options) => {
      state.dispatcher = options.dispatcher;
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4, 5])); },
        cancel() { state.canceled += 1; },
      });
      return new Response(body);
    },
  }, async () => {
    const bytes = await safeFetchBytes('https://media.example.test/file', 3);
    assert.deepEqual([...bytes], [1, 2, 3]);
  });
  assert.equal(state.canceled, 1);
  assert.equal(state.dispatcher.destroyed, true);
});

test('byte sniff rejects protected options and cancels non-success literal response bodies', async () => {
  await assert.rejects(
    safeFetchBytes('https://1.1.1.1/file', 16, { headers: { authorization: 'redacted-fixture' } }),
    /byte fetch permits only credential-free GET or HEAD requests/,
  );

  let canceled = 0;
  await withNetworkMocks({
    fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([9, 9, 9])); },
      cancel() { canceled += 1; },
    }), { status: 404 }),
  }, async () => {
    const bytes = await safeFetchBytes('http://1.1.1.1/missing');
    assert.equal(bytes.byteLength, 0);
  });
  assert.equal(canceled, 1);
});

test('protected POST rejects a cross-origin redirect before replaying body or credentials', async () => {
  const calls = [];
  await withNetworkMocks({
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response('', { status: 307, headers: { location: 'https://8.8.8.8/collect' } });
    },
  }, async () => {
    await assert.rejects(safeFetch('https://1.1.1.1/start', {
      method: 'POST', headers: { 'X-PAYMENT': 'redacted-fixture' }, body: '{}',
    }), /protected request cannot cross origins/);
  });
  assert.equal(calls.length, 1);
});

test('HTTPS-only fetch rejects downgrade redirects before the cleartext hop', async () => {
  let calls = 0;
  await withNetworkMocks({
    fetch: async () => {
      calls += 1;
      return new Response('', { status: 302, headers: { location: 'http://8.8.8.8/next' } });
    },
  }, async () => {
    await assert.rejects(
      safeFetch('https://1.1.1.1/start', {}, { requireHttps: true }),
      /https downgrade is not permitted/,
    );
  });
  assert.equal(calls, 1);
});

test('unsafe POST rejects method-changing redirects but permits same-origin 307', async () => {
  let calls = 0;
  await withNetworkMocks({
    fetch: async () => {
      calls += 1;
      return new Response('', { status: 303, headers: { location: '/result' } });
    },
  }, async () => {
    await assert.rejects(
      safeFetch('https://1.1.1.1/start', { method: 'POST', body: '{}' }),
      /unsafe request cannot change method on redirect/,
    );
  });
  assert.equal(calls, 1);

  const seen = [];
  await withNetworkMocks({
    fetch: async (url, options) => {
      seen.push({ url: String(url), method: options.method, body: options.body });
      return seen.length === 1
        ? new Response('', { status: 307, headers: { location: '/moved' } })
        : new Response('{}');
    },
  }, async () => {
    await safeFetch('https://1.1.1.1/start', { method: 'POST', body: '{}' });
  });
  assert.deepEqual(seen, [
    { url: 'https://1.1.1.1/start', method: 'POST', body: '{}' },
    { url: 'https://1.1.1.1/moved', method: 'POST', body: '{}' },
  ]);
});

test('bodyless public GET may follow a cross-origin redirect', async () => {
  const seen = [];
  await withNetworkMocks({
    fetch: async (url) => {
      seen.push(String(url));
      return seen.length === 1
        ? new Response('', { status: 302, headers: { location: 'http://8.8.8.8/media' } })
        : new Response('media');
    },
  }, async () => {
    const result = await safeFetch('http://1.1.1.1/start');
    assert.equal(result.text, 'media');
  });
  assert.deepEqual(seen, ['http://1.1.1.1/start', 'http://8.8.8.8/media']);
});
