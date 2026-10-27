import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
// SWC emits decorator metadata, which Nest DI needs (esbuild does not).
export default defineConfig({ plugins: [swc.vite()] });
