import { ERC8183, parseUBaseUnits } from './erc8183.js';

// This client supports x402 v1 EIP-3009 payments in BSC $U. Token decimals
// and signing domain belong to the supported token, not the seller's hints.
const TOKEN = { asset: ERC8183.uToken.toLowerCase(), decimals: 18, name: 'United Stables', version: '1' };
const NETWORKS = new Set(['eip155:56', 'bsc']);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isSupportedToken(accept) {
  return NETWORKS.has(accept?.network)
    && typeof accept?.asset === 'string' && accept.asset.toLowerCase() === TOKEN.asset;
}

export function paymentProblem(accept, x402Version = 1) {
  if (x402Version !== 1) return 'This checkout supports x402 version 1 only.';
  if (!accept || !['exact', 'eip3009'].includes(accept.scheme)) return 'This payment scheme is not supported.';
  if (!isSupportedToken(accept)) return 'This checkout supports $U on BNB Smart Chain only.';
  if (!ADDRESS.test(accept.payTo ?? '') || /^0x0{40}$/i.test(accept.payTo)) return 'The payment recipient is invalid.';
  const amount = parseUBaseUnits(accept.maxAmountRequired);
  if (amount === null || amount === '0') return 'The payment amount must be a positive exact amount in base units.';
  if (accept.amount != null && parseUBaseUnits(accept.amount) !== amount) return 'The payment request contains conflicting amounts.';
  if ((accept.extra?.name != null && accept.extra.name !== TOKEN.name)
    || (accept.extra?.version != null && accept.extra.version !== TOKEN.version)) {
    return 'The payment signing domain does not match the supported $U token.';
  }
  return null;
}

const BSC_ADD_PARAMS = {
  chainId: '0x38',
  chainName: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: ['https://bsc-dataseed1.binance.org'],
  blockExplorerUrls: ['https://bscscan.com'],
};

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function formatAmount(accept) {
  if (!isSupportedToken(accept)) return null;
  const raw = parseUBaseUnits(accept?.maxAmountRequired ?? accept?.amount);
  if (raw === null) return null;
  const padded = raw.padStart(TOKEN.decimals + 1, '0');
  const whole = padded.slice(0, -TOKEN.decimals);
  const fraction = padded.slice(-TOKEN.decimals).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} $U`;
}

export function canPay(accept, x402Version = 1) {
  return Boolean(
    !paymentProblem(accept, x402Version) && typeof window !== 'undefined' && window.ethereum
  );
}

export async function payChallenge(accept, x402Version = 1, { onSigned } = {}) {
  const problem = paymentProblem(accept, x402Version);
  if (problem) throw new Error(problem);
  // Freeze the validated terms before opening asynchronous wallet dialogs.
  const { payTo, scheme, network } = accept;
  const amount = parseUBaseUnits(accept.maxAmountRequired);
  const eth = typeof window !== 'undefined' ? window.ethereum : null;
  if (!eth) throw new Error('No wallet found. Install MetaMask to pay per call.');

  const [from] = await eth.request({ method: 'eth_requestAccounts' });
  if (!ADDRESS.test(from ?? '')) throw new Error('The wallet did not return a valid account.');
  const chainId = ERC8183.chainId;
  const chainHex = `0x${chainId.toString(16)}`;

  const current = await eth.request({ method: 'eth_chainId' });
  if (current !== chainHex) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
    } catch (err) {
      if (err?.code === 4902 && chainId === 56) {
        await eth.request({ method: 'wallet_addEthereumChain', params: [BSC_ADD_PARAMS] });
      } else {
        throw err;
      }
    }
  }
  if (await eth.request({ method: 'eth_chainId' }) !== chainHex) {
    throw new Error('Switch your wallet to BNB Smart Chain before paying.');
  }

  // validBefore must outlive the agent's answer time: sellers settle after a
  // successful response (charge-on-success), which can take tens of seconds.
  const authorization = {
    from,
    to: payTo,
    value: amount,
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: randomNonce(),
  };

  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    domain: {
      name: TOKEN.name,
      version: TOKEN.version,
      chainId,
      verifyingContract: ERC8183.uToken,
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  };

  const signature = await eth.request({
    method: 'eth_signTypedData_v4',
    params: [from, JSON.stringify(typedData)],
  });
  // This is the irreversible client boundary. Notify the lifecycle before any
  // encoding work or caller-side navigation check can fail.
  onSigned?.();

  const payment = {
    x402Version,
    scheme,
    network,
    payload: { authorization, signature },
  };
  return btoa(JSON.stringify(payment));
}
