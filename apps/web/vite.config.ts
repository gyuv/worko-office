import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Relative base so the same build loads from file:// inside Electron.
  base: './',
  server: { port: 5173, proxy: { '/v1': 'http://localhost:3000' } },
  // Node's Request needs absolute URLs (browsers resolve '/v1' against the page).
  test: { environment: 'jsdom', setupFiles: ['src/test-setup.ts'], css: false, env: { VITE_API_URL: 'http://localhost/v1' } },
});
