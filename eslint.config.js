import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Fetch-on-mount effects legitimately set loading/error state; the React-compiler
      // heuristic below flags that common pattern, so it is disabled for this app.
      'react-hooks/set-state-in-effect': 'off',
      // Horizontally scrollable tables are made keyboard-reachable via tabIndex on a labelled region.
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['region', 'tabpanel'] }],
    },
  },
  {
    files: ['supabase/functions/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, Deno: 'readonly' } },
  },
  {
    files: ['*.config.{ts,js}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
