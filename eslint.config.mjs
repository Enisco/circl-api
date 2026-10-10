import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * The admin API and the member API are kept apart so either could be lifted into its own service.
 *
 * A folder convention decays the first time somebody is in a hurry, so the boundary is a lint
 * error rather than a note in a document. Two halves:
 *
 *  - Nothing member-facing may import from `modules/admin`. This is the half that matters: the
 *    moment member code depends on admin code, the admin API cannot be deployed separately at all.
 *  - `modules/admin` may reach into a member module only through its public barrel
 *    (`modules/platform/<name>`), never a file inside it. The barrel is the seam — the list of
 *    things that would have to keep working if the reach became an HTTP call instead of an import.
 *
 * `src/common`, `src/infrastructure` and `src/config` are shared by both and stay shared: in a
 * split they are the library both services depend on.
 */
const MEMBER_CANNOT_IMPORT_ADMIN = {
  files: ['src/modules/core/**/*.ts', 'src/modules/platform/**/*.ts', 'src/modules/infrastructure/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/modules/admin', '**/modules/admin/**', '../admin/**', '../../admin/**'],
            message:
              'Member-facing code must not depend on the admin API — that is what would stop the ' +
              'admin surface being deployed separately. If admin needs to be told about ' +
              'something, have admin call you, or emit an event.',
          },
        ],
      },
    ],
  },
};

const ADMIN_CROSSES_ONLY_AT_BARRELS = {
  files: ['src/modules/admin/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            // `@/modules/platform/messaging` is allowed; `.../messaging/services/x` is not.
            group: [
              '@/modules/platform/*/*',
              '@/modules/core/*/*',
              '../platform/*/*',
              '../../platform/*/*',
            ],
            message:
              'Reach into a member module through its public barrel (@/modules/platform/<name>), ' +
              'not a file inside it. The barrel is the seam this boundary is built on.',
          },
        ],
      },
    ],
  },
};

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, prettier, {
  ignores: [
    'dist/**/*',
    'node_modules/**/*',
    'coverage/**/*',
    '.eslintrc.js',
    'eslint.config.mjs',
    '**/*.d.ts',
  ],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: import.meta.dirname,
      sourceType: 'module',
      ecmaVersion: 'latest',
    },
    globals: {
      ...globals.node,
      ...globals.jest,
      ...globals.es2021,
    },
  },
  plugins: {
    '@typescript-eslint': tseslint.plugin,
  },
  rules: {
    // TypeScript specific rules
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/no-empty-interface': [
      'error',
      {
        allowSingleExtends: true,
      },
    ],

    // General rules
    'no-console': ['warn', { allow: ['info', 'warn', 'error'] }],
    'no-duplicate-imports': 'error',
    'no-unused-vars': 'off', // Handled by @typescript-eslint/no-unused-vars
    'prefer-const': 'error',
    'no-var': 'error',
    eqeqeq: ['error', 'always'],
    'no-multiple-empty-lines': ['error', { max: 1 }],
    'padding-line-between-statements': [
      'error',
      { blankLine: 'always', prev: '*', next: 'return' },
      { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
      {
        blankLine: 'any',
        prev: ['const', 'let', 'var'],
        next: ['const', 'let', 'var'],
      },
    ],
  },
},
  MEMBER_CANNOT_IMPORT_ADMIN,
  ADMIN_CROSSES_ONLY_AT_BARRELS,
);
