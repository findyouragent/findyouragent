import { useI18n } from '../i18n/index.jsx';

// Display the captured decimals without rounding or inventing adapter units.
export default function PositionTaskResult({ record }) {
  const { t } = useI18n();
  let payload = record.response.body?.result?.structuredContent;
  if (!payload) {
    for (const part of record.response.body?.result?.content ?? []) {
      if (part.type !== 'text') continue;
      try { payload = JSON.parse(part.text); break; } catch { /* next part */ }
    }
  }
  if (record.request.presetId === 'pancake-bsc-range-preview') {
    const range = payload?.data;
    if (!range) return null;
    return <div className="position-task-result">
      <h3>{t('USDT / WBNB · range preview')}</h3>
      <p className="try-sub">{t('Provider range: 5% below and above its reference price. Prices are WBNB per USDT, not dollar prices.')}</p>
      <dl className="position-task-values">
        <div><dt>{t('Lower bound · WBNB per USDT')}</dt><dd>{String(range.lowerPrice)}</dd></div>
        <div><dt>{t('Upper bound · WBNB per USDT')}</dt><dd>{String(range.upperPrice)}</dd></div>
      </dl>
      <p className="try-sub">{t('Analysis only. No position was opened or rebalanced. Tick alignment and transaction execution have not been checked.')}</p>
    </div>;
  }
  if (record.request.presetId === 'venus-bsc-account-liquidity') {
    const account = payload?.data?.[0];
    if (!account) return null;
    return <div className="position-task-result">
      <h3>{t('Venus CORE account observation')}</h3>
      <p className="try-sub">{t('Public example account')} <span className="position-task-address mono">{record.request.arguments.userAddress}</span></p>
      <dl className="position-task-values">
        <div><dt>{t('Borrow limit · provider value')}</dt><dd>{String(account.borrowLimit)}</dd></div>
        <div><dt>{t('Shortfall · provider value')}</dt><dd>{String(account.shortfall)}</dd></div>
      </dl>
      <p className="try-sub">{t('Units are not confirmed for this adapter. A zero shortfall alone does not establish a safe position or a health factor. This is a single observation, with no ongoing monitoring.')}</p>
    </div>;
  }
  const position = payload?.data?.positions?.[0];
  if (!position) return null;
  const symbol0 = String(position.token0.symbol).toUpperCase();
  const symbol1 = String(position.token1.symbol).toUpperCase();
  return <div className="position-task-result">
    <h3>{t('{pair} · position #{id}', { pair: `${symbol0} / ${symbol1}`, id: position.positionId })}</h3>
    <p className="try-sub">{t('{protocol} on BSC · fee {fee}. Values below are reported by the provider.', { protocol: position.protocol, fee: position.fee })}</p>
    <dl className="position-task-values">
      <div><dt>{t('{symbol} amount', { symbol: symbol0 })}</dt><dd>{String(position.amount0)}</dd></div>
      <div><dt>{t('{symbol} amount', { symbol: symbol1 })}</dt><dd>{String(position.amount1)}</dd></div>
      <div><dt>{t('Lower price · raw')}</dt><dd>{String(position.lowerPrice)}</dd></div>
      <div><dt>{t('Current price · raw')}</dt><dd>{String(position.currentPrice)}</dd></div>
      <div><dt>{t('Upper price · raw')}</dt><dd>{String(position.upperPrice)}</dd></div>
      <div><dt>{t('Liquidity · raw')}</dt><dd>{String(position.liquidity)}</dd></div>
    </dl>
    <p className="try-sub">{t('Price direction and units have not been independently checked. This read does not rebalance the position. The complete reply, including reported pending fees, is in Download result.')}</p>
  </div>;
}
