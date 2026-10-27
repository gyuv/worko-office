// @ts-check
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', 'packages/api-client/src/schema.ts', 'apps/web/public/sw.js', '**/*.config.{js,ts}', 'eslint.config.js'] },
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  // Nest resolves constructor parameters by their runtime class, so those imports must stay value imports.
  { files: ['apps/api/src/**/*.ts'], rules: { '@typescript-eslint/consistent-type-imports': 'off' } },
  { files: ['**/*.test.{ts,tsx}', '**/test/**/*.ts'], rules: { '@typescript-eslint/no-non-null-assertion': 'off', 'no-console': 'off' } },
  { files: ['**/scripts/**', 'apps/api/src/db/seed-demo.ts', 'apps/api/src/db/migrate.ts'], rules: { 'no-console': 'off' } },
);
