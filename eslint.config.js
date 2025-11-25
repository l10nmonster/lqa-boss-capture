const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        chrome: 'readonly',
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Promise: 'readonly',
        JSZip: 'readonly',
        // Service worker globals
        importScripts: 'readonly',
        // Browser APIs
        indexedDB: 'readonly',
        BroadcastChannel: 'readonly',
        NodeFilter: 'readonly',
        confirm: 'readonly',
        alert: 'readonly',
        // Global script variables
        settingsManager: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      'no-console': 'off', // Allow console in extension code
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }]
    }
  },
  {
    files: ['__tests__/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        global: 'readonly',
        Buffer: 'readonly'
      }
    }
  },
  {
    // CommonJS modules (can be used in both browser and node contexts)
    files: ['content/**/*.js', 'lib/fe00-decoder.js', 'sidepanel/settings.js', 'sidepanel/urlRewrite.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
        exports: 'readonly'
      }
    }
  },
  {
    files: ['scripts/**/*.js', 'jest.config.js', 'eslint.config.js', 'esbuild.config.js', 'esbuild.test.config.js'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        process: 'readonly'
      }
    }
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'test-dist/**',
      'lib/jszip.min.js',
      '.claude/**',
      'coverage/**'
    ]
  }
];
