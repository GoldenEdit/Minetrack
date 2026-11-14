const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  { ignores: ['dist/**', '.parcel-cache/**'] },
  js.configs.recommended,
  {
    files: ['assets/js/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser }
  },
  {
    files: ['lib/**/*.js', 'test/**/*.js', 'main.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  }
]
