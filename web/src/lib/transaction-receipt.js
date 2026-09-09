function sameHex(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

function sameIntent(original, replacement) {
  if (!replacement || !sameHex(original.to, replacement.to)
    || !sameHex(original.from, replacement.from)
    || !sameHex(original.data, replacement.data)
    || original.nonce !== replacement.nonce || original.chainId !== replacement.chainId) return false;
  try {
    return BigInt(original.value.toString()) === BigInt(replacement.value.toString());
  } catch {
    return false;
  }
}

// ethers v5 rejects wait() after a wallet speed-up even when the original call
// succeeded. Only accept a mined, successful replacement with identical intent.
export async function waitForSuccessfulReceipt(transaction) {
  const tx = await transaction;
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (error) {
    if (error?.code !== 'TRANSACTION_REPLACED' || error.cancelled !== false
      || error.reason !== 'repriced' || !sameIntent(tx, error.replacement)
      || error.receipt?.status !== 1
      || !sameHex(error.receipt.transactionHash, error.replacement.hash)) throw error;
    receipt = error.receipt;
  }
  if (receipt?.status !== 1) throw new Error('The transaction did not complete successfully. Check its receipt before retrying.');
  return receipt;
}
