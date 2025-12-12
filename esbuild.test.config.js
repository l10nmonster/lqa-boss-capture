const esbuild = require('esbuild');
const fs = require('fs');

// Clean test-dist directory
if (fs.existsSync('test-dist')) {
  fs.rmSync('test-dist', { recursive: true });
}
fs.mkdirSync('test-dist', { recursive: true });

console.log('Building for tests (CommonJS format)...');

// Build configuration for tests - using CommonJS format for node imports
const buildConfig = {
  entryPoints: [
    'src/content/extractor.ts',
    'src/sidepanel/settings.ts',
    'src/lib/fe00-decoder.ts',
    'src/lib/chunking.ts',
  ],
  bundle: true,
  outdir: 'test-dist',
  format: 'cjs',  // CommonJS for Node.js require()
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  outbase: 'src',
  external: [], // Bundle everything for testing
};

esbuild
  .build(buildConfig)
  .then(() => {
    console.log('\n✓ Test build complete!');
  })
  .catch(() => process.exit(1));
