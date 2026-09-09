import assert from 'node:assert';
import { deriveTryExample, SAMPLE } from '../src/try-example.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

const tool = (name, schema) => ({ name, inputSchema: schema });

test('prefers a read-only tool that needs no arguments', () => {
  const ex = deriveTryExample([
    tool('getPrice', { required: ['token'], properties: { token: { type: 'string' } } }),
    tool('listMarkets', {}),
  ]);
  assert.deepStrictEqual(ex, { tool: 'listMarkets', args: {}, usesSample: false });
});

test('write tools are never candidates, whatever their schema', () => {
  const ex = deriveTryExample([
    tool('swapTokens', {}),
    tool('createPosition', {}),
  ]);
  assert.strictEqual(ex, null);
});

test("arguments come from the tool's own schema first (enum/default/examples)", () => {
  const ex = deriveTryExample([
    tool('getMarket', {
      required: ['market', 'depth'],
      properties: {
        market: { type: 'string', enum: ['BNB-USDT', 'ETH-USDT'] },
        depth: { type: 'integer', default: 5 },
      },
    }),
  ]);
  assert.deepStrictEqual(ex.args, { market: 'BNB-USDT', depth: 5 });
  assert.strictEqual(ex.usesSample, false);
});

test('address-shaped required params fall back to the labeled public sample', () => {
  const ex = deriveTryExample([
    tool('getUserHealth', {
      required: ['walletAddress'],
      properties: { walletAddress: { type: 'string', description: 'the account to inspect' } },
    }),
  ]);
  assert.strictEqual(ex.args.walletAddress, SAMPLE.address);
  assert.strictEqual(ex.usesSample, true);
});

test('token-shaped params get the canonical token, not the wallet sample', () => {
  const ex = deriveTryExample([
    tool('getTokenInfo', {
      required: ['tokenAddress'],
      properties: { tokenAddress: { type: 'string' } },
    }),
  ]);
  assert.strictEqual(ex.args.tokenAddress, SAMPLE.token);
});

test('an underivable required arg disqualifies the tool rather than guessing', () => {
  const ex = deriveTryExample([
    tool('getQuote', {
      required: ['params'],
      properties: { params: { type: 'object' } },
    }),
  ]);
  assert.strictEqual(ex, null);
});

test('a disqualified tool does not block a later derivable one', () => {
  const ex = deriveTryExample([
    tool('getQuote', { required: ['params'], properties: { params: { type: 'object' } } }),
    tool('getBalance', { required: ['address'], properties: { address: { type: 'string' } } }),
  ]);
  assert.strictEqual(ex.tool, 'getBalance');
});

test('empty and malformed lists return null quietly', () => {
  assert.strictEqual(deriveTryExample([]), null);
  assert.strictEqual(deriveTryExample(null), null);
  assert.strictEqual(deriveTryExample([{ notATool: true }]), null);
});

console.log(`${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
