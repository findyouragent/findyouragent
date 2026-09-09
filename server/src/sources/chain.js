import { config } from '../config.js';

let rpcId = 0;

async function rpc(method, params) {
  const res = await fetch(config.bscRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(config.probeTimeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export async function getWalletActivity(address) {
  if (!address) return { checked: false };
  try {
    const [txCountHex, balanceHex] = await Promise.all([
      rpc('eth_getTransactionCount', [address, 'latest']),
      rpc('eth_getBalance', [address, 'latest']),
    ]);
    return {
      checked: true,
      address,
      txCount: parseInt(txCountHex, 16),
      balanceWei: BigInt(balanceHex).toString(),
    };
  } catch {
    return { checked: false, address };
  }
}
