import {
  TokenBNB, TokenUSDT, TokenUSDC, TokenU, TokenCAKE, TokenETH, TokenBTC, TokenWBTC,
  TokenDAI, TokenFDUSD, TokenTUSD, TokenXRP, TokenDOGE, TokenADA, TokenSOL, TokenLINK,
  TokenUNI, TokenDOT, TokenTRX, TokenLTC, TokenSHIB, TokenPEPE, TokenTWT, TokenXVS, TokenALPACA,
} from '@web3icons/react';

/**
 * A real token mark for an asset symbol, from web3icons (MIT).
 *
 * NAMED imports on purpose, every one verified against the package's exports.
 * A namespace import (`import * as w3`) plus a dynamic `w3[`Token${sym}`]`
 * lookup defeats tree-shaking and ships all 2,183 icons — measured: the main
 * bundle went from 571 KB to 12.6 MB. This explicit map ships only the tokens
 * that actually move on BNB Chain; anything else falls back to no mark, never
 * to a wrong or invented logo.
 *
 * Mono variant by default so the mark takes the surrounding text colour and
 * sits in the palette instead of shouting its own brand colours; `branded` is
 * for where a real colour is the point (a payment token).
 *
 * The symbol comes from chain data the agent's counterparties author, so it is
 * an opaque lookup key only: it is never interpolated into markup.
 */
const MARKS = {
  BNB: TokenBNB,
  WBNB: TokenBNB, // wrapped BNB wears the BNB mark
  USDT: TokenUSDT,
  USDC: TokenUSDC,
  U: TokenU,
  CAKE: TokenCAKE,
  ETH: TokenETH,
  WETH: TokenETH,
  BTC: TokenBTC,
  BTCB: TokenBTC, // Binance-pegged BTC wears the BTC mark
  WBTC: TokenWBTC,
  DAI: TokenDAI,
  FDUSD: TokenFDUSD,
  TUSD: TokenTUSD,
  XRP: TokenXRP,
  DOGE: TokenDOGE,
  ADA: TokenADA,
  SOL: TokenSOL,
  LINK: TokenLINK,
  UNI: TokenUNI,
  DOT: TokenDOT,
  TRX: TokenTRX,
  LTC: TokenLTC,
  SHIB: TokenSHIB,
  PEPE: TokenPEPE,
  TWT: TokenTWT,
  XVS: TokenXVS,
  ALPACA: TokenALPACA,
};

function resolve(symbol) {
  if (typeof symbol !== 'string') return null;
  return MARKS[symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')] ?? null;
}

export default function TokenMark({ symbol, size = 13, variant = 'mono', className = '' }) {
  const Mark = resolve(symbol);
  if (!Mark) return null;
  return (
    <Mark
      size={size}
      variant={variant}
      color="currentColor"
      className={`token-mark ${className}`}
      aria-hidden="true"
    />
  );
}

// x402 is a fact about the agent, exactly like "MCP" or "Web" beside it, so it
// is written the same way. A neutral brand mark
// inside a metadata chip reads as a sponsor badge, and made the one chip that
// says least about the agent the loudest thing in the identity panel. The
// settlement asset is in the title, where a reader who wants it will look.
export function X402Badge({ className = '' }) {
  return (
    <span className={`proto proto-x402 mono ${className}`} title="accepts x402 payments, settled in $U">
      x402
    </span>
  );
}
