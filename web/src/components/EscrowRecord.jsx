import { ERC8183 } from '../lib/erc8183.js';
import { describeRecord } from '../lib/escrow-record.js';
import { useI18n } from '../i18n/index.jsx';

function localizedPart(part, t) {
  const match = String(part).match(/^(\d+) (escrow released|expired|rejected|in flight|past expiry)$/);
  return match ? t('{count} {state}', { count: match[1], state: t(match[2]) }) : part;
}

function localizedCoverage(coverage, t) {
  if (!coverage) return t('the range we scanned');
  return String(coverage)
    .replace(/^all ([\d,]+) jobs on the kernel/, (_, count) => t('all {count} jobs on the kernel', { count }))
    .replace(/^the newest ([\d,]+) jobs/, (_, count) => t('the newest {count} jobs', { count }))
    .replace(' · read ', t(' · read '));
}

/*
  What this agent's wallet actually did on the ERC-8183 escrow.

  A hire menu is a claim about future work. This is the other side of it, read
  from the kernel's own job records: how many jobs were opened against this
  provider address and how each one ended. It exists because the marketplaces
  that publish a track record publish their OWN bookkeeping — a venue can only
  count the jobs it brokered, so an agent that worked elsewhere reads as new
  and an agent that failed elsewhere reads as clean. The kernel has no such
  blind spot, and it is not ours to edit.

  The three refusals — no percentage, "released" rather than "success", and an
  unseen address rendered as absent from a stated range rather than as a zero —
  live in `lib/escrow-record.js`, where they are tested. This file draws what
  that returns and invents no sentence of its own.
*/
export default function EscrowRecord({ result, address, source = 'menu' }) {
  const { t } = useI18n();
  if (!result) return null;
  const view = describeRecord(result);

  const kernelLink = (
    <a href={`https://bscscan.com/address/${ERC8183.kernel}`} target="_blank" rel="noreferrer">
      {t('the escrow contract')}
    </a>
  );

  if (view.kind !== 'present') {
    if (view.kind === 'absent') {
      const read = String(view.note).match(/, read ([^.]+)\./)?.[1];
      return <p className="escrow-record is-muted">{t('No jobs against this wallet in {scope}{read}. Absent from the range is not the same as never hired — it is the whole of what we looked at.', {
        scope: localizedCoverage(view.coverage?.split(' · read ')[0], t),
        read: read ? t(', read {date}', { date: read }) : '',
      })}</p>;
    }
    return <p className="escrow-record is-muted">{t(view.note)}</p>;
  }

  return (
    <p className="escrow-record">
      <span className="escrow-record-line">
        {/* One job read "1 ERC-8183 jobs". Chinese does not inflect, so both
            keys carry the same translation. */}
        {t('Observed as provider in')} <strong>{view.jobs}</strong>{' '}
        {view.jobs === 1 ? t('ERC-8183 job') : t('ERC-8183 jobs')}
        {view.parts.length ? <> · {view.parts.map((part) => localizedPart(part, t)).join(' · ')}</> : null}
        {view.earned ? (
          <>
            {' · '}
            <strong>{view.earned}</strong> {t('released to it')}
          </>
        ) : null}
      </span>
      <span className="escrow-record-basis">
        {t('Read from')} {kernelLink} {t('across')} {localizedCoverage(view.coverage, t)}
        {view.unread ? t(' · {count} job ids we could not read, so these are floors', { count: view.unread }) : ''}
        {' · '}
        {source === 'menu'
          ? t('the payout wallet this agent’s hire menu names')
          : t('the wallet this agent’s registration names')}
        {address ? (
          <>
            {' ('}
            <a href={`https://bscscan.com/address/${address}`} target="_blank" rel="noreferrer">
              {address.slice(0, 6)}…{address.slice(-4)}
            </a>
            {')'}
          </>
        ) : null}
        . {t('Released means the escrow paid out, which the contract also does on its own once the dispute window closes — it is not a rating.')}
      </span>
    </p>
  );
}
