/**
 * Minimal lint config with one job: catch identifiers that do not exist.
 *
 * Vite transpiles identifiers without checking that they are declared.
 * This check catches missing imports before they become render failures.
 *
 *   npx eslint src
 */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  localStorage: 'readonly',
  AbortSignal: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  crypto: 'readonly',
  BigInt: 'readonly',
  navigator: 'readonly',
  IntersectionObserver: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  performance: 'readonly',
  Float32Array: 'readonly',
  MutationObserver: 'readonly',
  getComputedStyle: 'readonly',
  alert: 'readonly',
  btoa: 'readonly',
  atob: 'readonly',
  Buffer: 'readonly',
  process: 'readonly',
};

export default [
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: browserGlobals,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
