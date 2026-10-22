import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'data/**', 'config/**', 'vault/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  { languageOptions: { globals: globals.node } },

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Type-aware rules (floating promises and the like) need the compiler's view of each file.
        projectService: { allowDefaultProject: ['packages/gcal-sync/scripts/*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The point of the typed notes: nothing is "any".
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // A promise nobody awaits is an error nobody sees.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Services log through logger.ts (structured, token-safe); the CLI script below is the exception.
      'no-console': 'error',
    },
  },

  {
    // node:test registers a test by calling test(...), which returns a promise nobody needs to await.
    files: ['**/__tests__/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },

  {
    files: ['packages/gcal-sync/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // Last: switches off every rule that would argue with Prettier about layout.
  prettier,
);
