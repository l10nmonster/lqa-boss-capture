module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'lib/fe00-decoder.js',
    'sidepanel/settings.js',
    'content/extractor.js',
    '!lib/jszip.min.js', // Exclude minified library
    '!**/node_modules/**'
  ],
  coverageThreshold: {
    global: {
      branches: 44,
      functions: 43,
      lines: 39,
      statements: 40
    },
    './lib/fe00-decoder.js': {
      branches: 83,
      functions: 100,
      lines: 93,
      statements: 94
    },
    './sidepanel/settings.js': {
      branches: 71,
      functions: 38,
      lines: 54,
      statements: 54
    },
    './content/extractor.js': {
      branches: 19,
      functions: 50,
      lines: 17,
      statements: 18
    }
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js']
};
