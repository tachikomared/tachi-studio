// @ts-check
//
// Flat ESLint config for the Tachi Studio monorepo.
//
// Goal (audit M2): a PRAGMATIC baseline that PASSES green on the current,
// never-before-linted code. We build on @eslint/js recommended +
// typescript-eslint recommended, then downgrade noisy / stylistic rules so
// existing code is not buried under errors. Only high-signal *correctness*
// rules stay as errors. Tighten incrementally over time.
//
// Linting is scoped to first-party source only:
//   - apps/desktop/electron  (Electron main / preload / services — Node)
//   - apps/desktop/src        (renderer / React — browser)
//   - packages/core/src       (shared library — isomorphic)
//
// Run with: pnpm lint   (see root package.json "lint" script)

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

const FIRST_PARTY = [
  'apps/desktop/electron/**/*.{ts,tsx}',
  'apps/desktop/src/**/*.{ts,tsx}',
  'packages/core/src/**/*.{ts,tsx}',
];

export default tseslint.config(
  // 1. Global ignores. A config object with ONLY `ignores` applies repo-wide.
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/dist-rel/**',
      '**/dist-release/**',
      '**/release-build/**',
      '**/build/**',
      '**/.research-tmp/**',
      '**/resources/sidecars/**', // vendored third-party sidecar sources (fetched at build) — not ours to lint
      'claude-design/**',
      '**/*.d.ts',
    ],
  },

  // 2. Everything below is SCOPED to first-party source only. By attaching the
  //    base presets via `extends` on a `files`-scoped block, the recommended
  //    rules apply ONLY to these globs — out-of-scope TS/TSX (tests, *.config.ts,
  //    e2e drivers, scripts, claude-design, ...) is left completely unlinted.
  //
  //    Non-type-checked presets (plain `recommended`, not `recommendedTypeChecked`):
  //    no parserOptions.project needed, so the run is fast and does not depend on
  //    a clean tsconfig graph — see the react@18/@19 type-resolution note in
  //    apps/desktop/tsconfig.json.
  {
    files: [
      'apps/desktop/electron/**/*.{ts,tsx}',
      'apps/desktop/src/**/*.{ts,tsx}',
      'packages/core/src/**/*.{ts,tsx}',
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Renderer is browser; main/services/core are Node. Union of both is
        // intentional and harmless — typescript-eslint disables core no-undef,
        // so this only matters for the few non-TS-checked global references.
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // --- Downgraded: stylistic / pre-existing-code noise (task-mandated) ---
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          // Allow intentional throwaways: `_unused`, leading-underscore args,
          // and rest-sibling destructuring omits.
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // --- Off: patterns this codebase deliberately uses ---
      // Lazy/native `require()` in Electron main (node-pty, electron, fs, ...).
      '@typescript-eslint/no-require-imports': 'off',
      // Ambient/`namespace` declarations in ipc-router + graph-tools.
      '@typescript-eslint/no-namespace': 'off',
      // Empty interfaces / `{}` object types used as extension points.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-wrapper-object-types': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',

      // --- Warn: real-but-low-priority code smells (keep visible, not fatal) ---
      'no-empty': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'warn',
      'no-case-declarations': 'warn',
      'no-fallthrough': 'warn',
      'prefer-const': 'warn',
      'no-extra-boolean-cast': 'off',

      // --- Kept as ERRORS: high-signal correctness (default-error in the
      //     recommended presets; listed here as documentation of intent).
      //     no-debugger, no-dupe-keys, no-dupe-args, no-dupe-class-members,
      //     no-unreachable, no-cond-assign, no-self-assign, use-isnan,
      //     valid-typeof, no-const-assign, getter-return, no-unsafe-negation,
      //     no-async-promise-executor, @typescript-eslint/no-misused-new, ...
    },
  },

  // 3. React renderer: wire react-hooks + react-refresh (the renderer had stale
  //    eslint-disable comments referencing these rules; without the plugins they
  //    were "rule not found" errors). rules-of-hooks stays an error (real bug
  //    shape); exhaustive-deps + fast-refresh are warnings.
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // 4. Final downgrade block — a trailing config object wins over the presets
  //    regardless of extends-merge ordering. These ESLint-v10 recommended rules
  //    are pedantic/stylistic on this never-linted codebase; keep the build green
  //    (warnings stay visible, errors do not block).
  {
    files: FIRST_PARTY,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'preserve-caught-error': 'off',      // Error-cause chaining is nice-to-have, not enforced
      'no-control-regex': 'off',           // control chars in regex are intentional (sanitizers)
      'no-useless-assignment': 'warn',
      'no-irregular-whitespace': 'warn',
      'no-useless-catch': 'warn',
    },
  },
);
