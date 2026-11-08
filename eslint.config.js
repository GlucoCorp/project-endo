// Shared ESLint flat config (ADR-0004). Security lint rules are required CI checks (spec 18.2, 23).
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.turbo/**'],
  },
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Spec 23: no eval, no console.log in services, no raw SQL concatenation.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Spec 12.2: dangerouslySetInnerHTML is banned in every frontend.
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned (spec 12.2). Render text, never HTML.',
        },
        {
          // Spec 23: no raw SQL built from string templates. Use Kysely's typed builder or `sql` tag.
          selector:
            'TemplateLiteral[expressions.length>0] > TemplateElement[value.raw=/\\b(SELECT|INSERT|UPDATE|DELETE)\\b/i]',
          message: 'Do not build SQL with template strings (spec 23). Use the typed query builder.',
        },
        {
          // Spec 11.2: never implement crypto primitives; Math.random is never acceptable for IDs or tokens.
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'Math.random is banned. Use node:crypto or WebCrypto.',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Test files may use non-null assertions on fixtures they control.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'security/detect-object-injection': 'off',
      // Tests create temp files and fixtures at generated paths.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    files: ['tools/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Tools are CLI scripts; console output is their interface.
      'no-console': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
);
