import { isReadOnlyTool } from '../src/mcp.js';

/**
 * Which MCP tools a stranger may invoke from the Try panel.
 *
 * These servers publish no `annotations.readOnlyHint`, and their tool lists
 * genuinely mix reads with writes: Venus serves `getBorrowBalance` next to
 * `borrow`, `repay` and `mintToken`. So the decision is made by name, it is
 * default-closed, and it is tested, because it is the only thing standing
 * between a public button and an agent doing something on someone's behalf.
 *
 * The first implementation lowercased before splitting on camelCase, found no
 * word boundaries, and classified all 16 Venus tools as writes. It failed
 * closed, which is why it was merely useless rather than dangerous, but the
 * same slip in the other direction would not have been.
 *
 *   node test/readonly.test.mjs
 */

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${message}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${message}`);
  }
};

// Real Venus tools, verbatim from its live tools/list.
const VENUS_READS = ['getVenusBalance', 'getBorrowBalance', 'getBorrowAPR', 'getSupplyAPR',
  'getAccountLiquidity', 'getEnabledCollateral', 'getDescriptionVenus', 'getSupportedTokens',
  'getSupportedChains'];
const VENUS_WRITES = ['borrow', 'repay', 'mintToken', 'redeemUnderlying', 'enterMarkets',
  'exitMarket', 'updateToken'];

for (const name of VENUS_READS) {
  ok(isReadOnlyTool(name), `${name} is offered`);
}
for (const name of VENUS_WRITES) {
  ok(!isReadOnlyTool(name), `${name} is refused`);
}

// Both naming conventions must classify the same. camelCase is what broke.
ok(isReadOnlyTool('get_borrow_balance') && isReadOnlyTool('getBorrowBalance'),
  'snake_case and camelCase agree');

// Money-moving verbs, whatever the casing.
for (const name of ['swapEvm', 'transfer', 'approve', 'send_transaction', 'executeTrade',
  'deleteAll', 'withdraw', 'stakeCLM', 'deposit']) {
  ok(!isReadOnlyTool(name), `${name} is refused`);
}

// Unknown verbs are refused rather than guessed at.
ok(!isReadOnlyTool('frobnicate'), 'an unrecognised verb is refused');
ok(!isReadOnlyTool(''), 'an empty name is refused');
ok(!isReadOnlyTool(null), 'a missing name is refused');
ok(!isReadOnlyTool(undefined), 'undefined is refused');

// A write must not sneak through by wearing a read prefix in the middle.
ok(!isReadOnlyTool('force_get_rich'), 'a read verb anywhere but the front does not qualify');
ok(isReadOnlyTool('list_positions'), 'a leading read verb does qualify');

// A read verb can open a compound name whose connective introduces a real
// second, state-changing action. These must be
// refused, while a write verb used as a noun modifier (getBorrowBalance) stays
// a read.
for (const name of ['getOrCreateAssociatedTokenAccount', 'getAndSwap', 'checkThenExecute',
  'fetchAndSettle', 'get_or_create_account', 'listAndRevoke']) {
  ok(!isReadOnlyTool(name), `${name} (compound action) is refused`);
}
for (const name of ['getBorrowAPR', 'getTransferHistory', 'getSwapQuote', 'estimateGas']) {
  ok(isReadOnlyTool(name), `${name} (write word as noun) stays a read`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
