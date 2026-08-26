import eslint from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

export default [
  {
    ignores: ['bin/**', 'dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {fetch: 'readonly', process: 'readonly'},
      parser: tsparser,
    },
    plugins: {'@typescript-eslint': tseslint},
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-unused-vars': 'off',
    },
  },
]
