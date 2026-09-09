import { ExternalLink } from 'lucide-react';
import { translate, useI18n } from '../i18n/index.jsx';
import { anchoredMemoryCount, memorySourceHref } from '../lib/memory-evidence.js';
import { logicActivityTimestamp } from '../lib/logic-activity.js';
import '../styles/memory-evidence.css';

export function memorySummary(record) {
  if (!record) return { text: translate('Checking memory anchor…') };
  if (record.status === 'anchored') return { text: translate('Memory sources anchored: {count}', { count: anchoredMemoryCount(record.sources) }) };
  if (record.status === 'not-anchored') return { text: translate('No memory fingerprint recorded') };
  if (record.status === 'wrong-identity') return { text: translate('Memory source not attributed') };
  if (record.status === 'unsupported') return { text: translate('Memory registry unsupported') };
  return { text: translate('Memory anchor unavailable') };
}

export default function MemoryEvidence({ record, onRetry }) {
  const { t } = useI18n();
  if (!record) return <p className="evidence-sub" role="status">{t('Checking the on-chain memory source…')}</p>;
  if (record.status === 'unavailable') return (
    <div className="memory-evidence">
      <p className="evidence-sub" role="status">{t('The memory registry could not be read. This does not establish that the agent has no anchored memory.')}</p>
      <button type="button" className="memory-retry" onClick={onRetry}>{t('Retry memory check')}</button>
    </div>
  );
  if (record.status === 'wrong-identity') return <p className="evidence-sub">{t('The claimed token could not be attributed to this agent. Its memory records are not shown.')}</p>;
  if (record.status === 'unsupported') return <p className="evidence-sub">{t('No supported memory registry is configured for this token collection.')}</p>;
  return (
    <div className="memory-evidence">
      {record.status === 'anchored' && <p className="evidence-sub">{t('An on-chain fingerprint of the linked memory record. FYA has not downloaded or verified its contents.')}</p>}
      <p className="memory-provenance">
        {t('BAP-578 token {tokenId}', { tokenId: record.bapTokenId })} ·{' '}
        <a href={`https://bscscan.com/block/${record.blockNumber}`} target="_blank" rel="noopener noreferrer">
          {t('Block {block}', { block: record.blockNumber })}
        </a>{' '}· <time dateTime={record.checkedAt}>{record.checkedAt}</time>
      </p>
      {record.status === 'not-anchored' && <p className="evidence-sub">{t('No active memory source with a nonzero fingerprint was recorded at this block.')}</p>}
      {record.sources.map(source => {
        const href = memorySourceHref(source.uri);
        const stamp = logicActivityTimestamp(source.updatedAt);
        const tx = /^0x[0-9a-f]{64}$/i.test(source.anchorTx || '') ? source.anchorTx : null;
        return (
          <div className="memory-source" key={source.sourceId}>
            <h4>{t('Memory source #{sourceId}', { sourceId: source.sourceId })}</h4>
            <dl>
              <dt>{t('Recorded content hash')}</dt><dd className="mono">{source.contentHash}</dd>
              <dt>{t('Memory record URI')}</dt><dd className="mono">{source.uri || t('Not recorded')}</dd>
              {stamp.status === 'recorded' && <><dt>{t('Source timestamp')}</dt><dd><time dateTime={stamp.iso}>{stamp.iso}</time></dd></>}
              {source.active === false && <><dt>{t('Source status')}</dt><dd>{t('Inactive')}</dd></>}
            </dl>
            <div className="memory-links">
              {href && <a href={href} target="_blank" rel="noopener noreferrer">{t('Open memory record')}<ExternalLink size={12} aria-hidden="true" /></a>}
              {tx && <a href={`https://bscscan.com/tx/${tx}`} target="_blank" rel="noopener noreferrer">{t('Anchor transaction')}<ExternalLink size={12} aria-hidden="true" /></a>}
            </div>
          </div>
        );
      })}
      <a className="memory-registry-link" href={`https://bscscan.com/address/${record.registryAddress}#readProxyContract`} target="_blank" rel="noopener noreferrer">
        {t('Inspect memory registry')}<ExternalLink size={12} aria-hidden="true" />
      </a>
    </div>
  );
}
