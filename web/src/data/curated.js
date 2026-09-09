// Curated entries require observed served capabilities in their category.
// Project-operated agents are excluded from these editorial placements.
// A placement is not a guarantee of task quality or current availability.
export const CURATED = {
  rebalancing: [
    { chainId: 56, tokenId: '45650', note: 'serves increaseLiquidity, decreaseLiquidity and price-range tools' },
  ],
  // No reviewed grid provider is currently pinned.
  grid: [],
  yield: [
    { chainId: 56, tokenId: '45422', note: 'serves vault deposit, withdraw and staking tools' },
  ],
  health: [
    { chainId: 56, tokenId: '45381', note: 'serves collateral and borrow-balance reads' },
    { chainId: 56, tokenId: '43129', note: 'serves account-liquidity and collateral reads' },
  ],
  trading: [
    { chainId: 56, tokenId: '45564', note: 'serves swap execution across EVM chains' },
  ],
  research: [
    { chainId: 56, tokenId: '49637', note: 'serves market monitoring and settlement-queue tools' },
  ],
};
