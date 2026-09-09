import { useI18n } from '../i18n/index.jsx';

function payloadFrom(record) {
  const result = record.response?.body?.result;
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const part of Array.isArray(result?.content) ? result.content : []) {
    if (part?.type !== 'text') continue;
    try { return JSON.parse(part.text); } catch { /* Original reply remains downloadable. */ }
  }
  return null;
}

export default function RangeAssessmentResult({ record }) {
  const { t } = useI18n();
  const payload = payloadFrom(record);
  const task = record.observation?.task;
  const checks = Array.isArray(task?.checks) ? task.checks : [];
  const factsConsistent = checks.length > 0 && checks.every(check => check.passed === true);
  const corroboration = task?.corroboration;
  const status = ['passed', 'failed'].includes(corroboration?.status) ? corroboration.status : 'incomplete';
  const block = String(corroboration?.block?.number ?? payload?.blockNumber ?? '');
  const blockLink = /^\d{1,16}$/.test(block) ? `https://bscscan.com/block/${block}` : null;
  const action = payload?.decision?.action;
  const position = payload?.facts?.position;
  const labels = {
    passed: 'The checked facts match BSC at the recorded block.',
    failed: 'The provider facts did not match the BSC check. Inspect the differences before relying on this result.',
    incomplete: 'The BSC check is incomplete. This provider assessment has not been confirmed against chain state.',
  };
  return <div className="position-task-result">
    <h3>{t('Public LP position · range assessment')}</h3>
    <p className="try-sub">{t('PancakeSwap V3 · BSC · public position #7337249. This is an example position, not your connected wallet.')}</p>
    {factsConsistent ? <>
      <dl className="position-task-values">
        <div><dt>{t('Provider reported decision')}</dt><dd>{action === 'hold' ? t('Hold') : action === 'rebalance' ? t('Review a rebalance') : t('Not established')}</dd></div>
        <div><dt>{t('Reported range state')}</dt><dd>{payload.decision.inRange ? t('In range') : t('Out of range')}</dd></div>
        <div><dt>{t('Current tick · provider')}</dt><dd>{payload.facts.pool.tick}</dd></div>
        <div><dt>{t('Position ticks · lower to upper')}</dt><dd>{position.tickLower} → {position.tickUpper}</dd></div>
      </dl>
      <p className="try-sub">{t('The task uses zero edge tolerance: an in-range position does not trigger a proactive range change. This checks the stated rule, not whether the strategy is optimal.')}</p>
    </> : <p className="try-sub">{t('The provider response did not pass the task’s consistency checks. The original reply is available in Download result.')}</p>}
    <h3>{t('BSC fact check')}</h3>
    <p className="try-sub" role="status">{t(!factsConsistent ? 'BSC corroboration was not run because the provider response did not pass consistency checks.' : labels[status])}</p>
    {blockLink && <p className="try-sub"><a href={blockLink} target="_blank" rel="noreferrer">{t('Source block {block}', { block })}</a></p>}
    {corroboration?.checkedAt && <p className="try-sub">{t('Checked at {time}', { time: corroboration.checkedAt })}</p>}
    {Array.isArray(corroboration?.checks) && corroboration.checks.length > 0 && <details className="run-details">
      <summary>{t('Inspect BSC fact checks')}</summary>
      <ul className="run-checks">{corroboration.checks.map((check, i) => <li key={check.id ?? i}><strong>{t(check.status === 'passed' ? 'Passed' : check.status === 'failed' ? 'Failed' : 'Unknown')}</strong>{check.label}</li>)}</ul>
    </details>}
    <p className="try-sub">{t('Analysis only. No position was changed, no payment was made and no monitoring was started. Costs, profitability and approvals are not verified by these checks.')}</p>
  </div>;
}
