export const LOCALE_STORAGE_KEY = 'fya:locale:v1';
export const SUPPORTED_LOCALES = ['en', 'zh-CN'];

export function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  const tag = value.replaceAll('_', '-').toLowerCase();
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-sg' || tag.startsWith('zh-hans')) return 'zh-CN';
  return null;
}

export function initialLocale(storage, languages = []) {
  try {
    const saved = normalizeLocale(storage?.getItem(LOCALE_STORAGE_KEY));
    if (saved) return saved;
  } catch { /* Language switching also works with blocked browser storage. */ }
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return 'en';
}

export function interpolate(message, values = {}) {
  // Substitute once: provider text containing braces is never interpreted again.
  return message.replace(/\{([a-zA-Z][\w]*)\}/g, (token, key) =>
    Object.hasOwn(values, key) ? String(values[key] ?? '') : token);
}

// Keep app-authored notices as keys so language changes can update them.
export function uiMessage(source, values = {}) {
  return { type: 'fya-ui-message', source, values };
}

export function translateMessage(catalog, locale, source, values = {}) {
  if (source?.type === 'fya-ui-message' && typeof source.source === 'string') {
    const parameters = Object.fromEntries(Object.entries(source.values ?? {}).map(([key, value]) => [key,
      value?.type === 'fya-ui-message' ? translateMessage(catalog, locale, value) : value]));
    return translateMessage(catalog, locale, source.source, parameters);
  }
  if (typeof source !== 'string') return source;
  const translated = locale === 'zh-CN' && Object.hasOwn(catalog, source) ? catalog[source] : source;
  return interpolate(translated, values);
}

let storage;
try { storage = globalThis.localStorage; } catch { /* Optional browser storage. */ }
let currentLocale = initialLocale(storage, globalThis.navigator?.languages ?? []);
const listeners = new Set();

export function getLocale() { return currentLocale; }
export function subscribeLocale(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLocale(value) {
  const next = normalizeLocale(value);
  if (!next) return;
  try { storage?.setItem(LOCALE_STORAGE_KEY, next); } catch { /* Session choice still applies. */ }
  if (next === currentLocale) return;
  currentLocale = next;
  for (const listener of listeners) listener();
}

export function localeNumber(value, options) {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}

export function localeDate(value, options) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(getLocale(), options).format(date) : '—';
}
