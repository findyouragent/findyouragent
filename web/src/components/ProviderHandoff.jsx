import { ArrowUpRight } from 'lucide-react';
import { providerHandoff } from '../data/provider-handoffs.js';
import '../styles/provider-handoff.css';
import { useI18n } from '../i18n/index.jsx';

export default function ProviderHandoff({ agent }) {
  const { t } = useI18n();
  const provider = providerHandoff(agent);
  if (!provider) return null;
  return <section className="provider-handoff" aria-labelledby="provider-setup-title">
    <div className="provider-handoff-main">
      <p className="micro-label">{provider.category} · {t('external provider')}</p>
      <h2 id="provider-setup-title">{t('Continue with {name}', { name: provider.name })}</h2>
      <p>{t('Review the provider’s setup for a dedicated account, funded inventory and a revocable trading permission. Setup opens on agripinaa.vercel.app.')}</p>
      <a className="provider-setup-link" href={provider.setupUrl} target="_blank" rel="noopener noreferrer">{t('Review provider setup')} <ArrowUpRight size={16} aria-hidden="true" /></a>
      <p className="provider-handoff-note">{t('Total activation and trading costs are not yet quoted. This link does not start a job or grant permission. Completion is not tracked by FYA.')}</p>
      {provider.relatedTask && <a className="provider-related-task" href={provider.relatedTask.href}>{provider.relatedTask.label} →</a>}
    </div>
    <div className="provider-handoff-evidence">
      <h3>{provider.evidenceLabel}</h3>
      <p>{provider.evidence}</p>
      <p className="provider-handoff-note">{provider.limitation} {t('This is not a job completed through FYA.')}</p>
      <div className="provider-source-links"><a href={provider.evidenceUrl} target="_blank" rel="noopener noreferrer">{t('Provider record')} ↗</a><a href={`https://bscscan.com/tx/${provider.transaction}`} target="_blank" rel="noopener noreferrer">{t('Transaction')} ↗</a></div>
      <p className="provider-handoff-note">{t('Sources checked')} <time dateTime={provider.checkedAt}>{t('7 September 2026 UTC')}</time>. {t('Availability can change.')}</p>
    </div>
  </section>;
}
