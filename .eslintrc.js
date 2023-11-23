module.exports = {
  'env': {
    'node': true,
    'commonjs': true,
    'es2022': true,
    mocha: true,
  },
  'extends': [
    'eslint:recommended',
  ],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'benchmarks/',
  ],
  'rules': {
    'indent': ['error', 2],
    'eol-last': ['error', 'always'],
    'linebreak-style': ['error', 'unix'],
    'quotes': ['error', 'single'],
    'semi': ['error', 'always'],
    'no-unused-vars': ['error', {
      'argsIgnorePattern': '^_',
      'varsIgnorePattern': '^_',
      'caughtErrorsIgnorePattern': '^_',
    }],
    'brace-style': ['error', '1tbs'],
    'space-before-function-paren': ['error', {
      anonymous: 'never',
      named: 'never',
      asyncArrow: 'never',
    }],
    'keyword-spacing': ['error', { before: true, after: true }],
    'no-promise-executor-return': 'error',
    'no-extra-parens': ['error', 'all', {
      ternaryOperandBinaryExpressions: false,
      nestedBinaryExpressions: false,
    }],
    'comma-dangle': ['error', 'always-multiline'],
    'no-inner-declarations': 'off',
  },
  'overrides': [
    {
      env: {node: true},
      files: ['**/*.mjs'],
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022,
      },
    },
    {
      'env': { 'node': true },
      'files': ['**/*.ts'],
      'extends': [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
      ],
      'parser': '@typescript-eslint/parser',
      'parserOptions': {
        'ecmaVersion': 'es2021',
        'sourceType': 'module',
      },
      'plugins': ['@typescript-eslint'],
      rules: {
        '@typescript-eslint/no-unused-vars': ['error', {
          'argsIgnorePattern': '^_',
          'varsIgnorePattern': '^_',
          'caughtErrorsIgnorePattern': '^_',
        }],
        '@typescript-eslint/no-explicit-any': ['off', {
          ignoreRestArgs: true,
        }],
        '@typescript-eslint/no-var-requires': ['off'],
        '@typescript-eslint/ban-ts-comment': ['error', {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': 'allow-with-description',
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 3,
        }],
        'no-inner-declarations': 'off',
      },
    },
  ],
};
