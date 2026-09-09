import { getLocale } from '../i18n/core.js';

export function timeAgo(iso) {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (getLocale() === 'zh-CN') {
    const units = [[60, 1, 'second'], [3600, 60, 'minute'], [86400, 3600, 'hour'], [2592000, 86400, 'day'], [31104000, 2592000, 'month'], [Infinity, 31104000, 'year']];
    const [, divisor, unit] = units.find(([limit]) => seconds < limit);
    return new Intl.RelativeTimeFormat('zh-CN', { numeric: 'always' }).format(-Math.floor(seconds / divisor), unit);
  }
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}
