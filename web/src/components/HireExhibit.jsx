import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { ethers } from 'ethers';
import { readJob } from '../lib/erc8183.js';
import { EXHIBIT } from '../data/exhibit.js';
import { timeAgo } from '../utils/format.js';
import { useI18n } from '../i18n/index.jsx';

/** Third-party escrow history, with a fresh kernel read when the panel opens. */
export default function HireExhibit() {
  const { t } = useI18n();
  const [job, setJob] = useState(null);
  const [readFailed, setReadFailed] = useState(false);

  useEffect(() => {
    if (!EXHIBIT) return undefined;
    let live = true;
    readJob(EXHIBIT.jobId)
      .then((j) => { if (live) setJob(j); })
      .catch(() => { if (live) setReadFailed(true); });
    return () => { live = false; };
  }, []);

  if (!EXHIBIT) return null;

  return (
    <section className="try-panel exhibit">
      <h2 className="micro-label">{t('a third-party escrow job')}</h2>
      <p className="try-sub">
        {t('Job #{id} was created by a third party on the public escrow contract. It was disputed and later released. Every step links to its transaction. This is contract history, not evidence of a completed hire through findyouragent.', { id: EXHIBIT.jobId })}
      </p>

      <div className="exhibit-live mono">
        {job ? (
          <>
            {t('job #{id} · read from the kernel just now:', { id: EXHIBIT.jobId })} <strong>{t(job.status)}</strong>
            {job.budgetWei ? t(' · budget {amount} $U', { amount: ethers.utils.formatUnits(job.budgetWei, 18) }) : ''}
          </>
        ) : readFailed ? (
          <>{t('job #{id} · we could not re-read the kernel just now — the transactions below stand on their own', { id: EXHIBIT.jobId })}</>
        ) : (
          <>{t('job #{id} · reading current state from the kernel…', { id: EXHIBIT.jobId })}</>
        )}
      </div>

      <div className="exhibit-steps">
        {EXHIBIT.timeline.map((step) => (
          <div key={step.tx} className="exhibit-step mono">
            <span className="exhibit-when">{timeAgo(step.ts)}</span>
            <span className="exhibit-label">{t(step.label)}</span>
            <a href={`https://bscscan.com/tx/${step.tx}`} target="_blank" rel="noreferrer" aria-label={t('{label} transaction on BscScan', { label: t(step.label) })}>
              {step.tx.slice(0, 10)}… <ExternalLink size={10} strokeWidth={2} aria-hidden="true" />
            </a>
          </div>
        ))}
      </div>

      <p className="try-sub">
        {t('Release means the contract paid out; it does not establish that the buyer accepted the work or that the deliverable was correct. Job state, dispute policy and contract rules determine release and refund actions. Review those terms before funding a job.')}
      </p>
    </section>
  );
}
