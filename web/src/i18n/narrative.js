import { getLocale, translateMessage } from './core.js';
import catalog from './narrative.zh-CN.js';

// Only used by the deterministic evidence composer. Its interpolation values
// are guarded IDs, measured numbers, or locally authored phrases, never names
// or descriptions supplied by an agent.
export function narrativeTranslate(source, values = {}) {
  const locale = getLocale();
  const localized = locale === 'zh-CN'
    ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
      typeof value === 'string' && Object.hasOwn(catalog, value) ? catalog[value] : value]))
    : values;
  return translateMessage(catalog, locale, source, localized);
}

export function narrativePlural(count, one, many) {
  return getLocale() === 'zh-CN'
    ? `${count} ${['tool', 'skill'].includes(one) ? '项' : ''}${narrativeTranslate(one)}`
    : `${count} ${count === 1 ? one : many}`;
}
