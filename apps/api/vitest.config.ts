import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
// SWC emits decorator metadata, which Nest DI needs (esbuild does not).
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 20_000, hookTimeout: 60_000,
    // Set before modules load: @Throttle limits are read at decoration time.
    env: { NODE_ENV: 'test', AUTH_RATE_LIMIT: '10000', SIGNUP_RATE_LIMIT: '10000' },
  },
});
