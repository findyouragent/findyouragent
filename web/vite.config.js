import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { machineReadable } from './machine-readable.js';
import { docs } from './docs.js';
import { resolveApiBase } from './api-base.js';

// loadEnv rather than import.meta.env: this runs in the config, before the
// client bundle exists, and llms.txt has to carry the same service URL the app
// was built against or it sends readers to an address that answers nothing.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // loadEnv reads .env in production too, so a stray local value would be
  // published as the documented API by both plugins below. Resolved once, here,
  // so llms.txt and the docs corpus cannot disagree with the app about where
  // this service lives.
  const apiBase = resolveApiBase(env.VITE_VERIFY_API, mode === 'production');
  return {
    plugins: [react(), machineReadable(apiBase), docs(apiBase)],
  };
});
