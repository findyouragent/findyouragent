import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { getLocale, setLocale, subscribeLocale, translateMessage } from './core.js';
import core from './core.zh-CN.js';
import pages from './pages.zh-CN.js';
import actions from './actions.zh-CN.js';
import components from './components.zh-CN.js';
import glossary from './glossary.zh-CN.js';
import narrative from './narrative.zh-CN.js';

export { uiMessage } from './core.js';

export const catalog = { ...narrative, ...pages, ...actions, ...components, ...glossary, ...core };
export function translate(source, values) {
  return translateMessage(catalog, getLocale(), source, values);
}

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'en');
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = locale === 'zh-CN'
      ? 'findyouragent · 发现、核查与雇用 AI 智能体'
      : 'findyouragent · live agents on BNB Chain';
  }, [locale]);
  // The component tree is never remounted on language changes: input, evidence,
  // wallet state and pending requests belong to the user, regardless of language.
  const value = useMemo(() => ({ locale, t: translate, setLocale }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n requires I18nProvider');
  return context;
}
