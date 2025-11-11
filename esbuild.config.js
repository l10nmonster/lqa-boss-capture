const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isDev = process.argv.includes('--dev');

// Clean dist directory
if (fs.existsSync('dist')) {
  fs.rmSync('dist', { recursive: true });
}
fs.mkdirSync('dist', { recursive: true });

// Copy static assets
const copyRecursive = (src, dest) => {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
};

console.log('Copying static assets...');

// Create directories
fs.mkdirSync('dist/sidepanel', { recursive: true });
fs.mkdirSync('dist/lib', { recursive: true });

// Copy files and directories
copyRecursive('icons', 'dist/icons');
fs.copyFileSync('sidepanel/index.html', 'dist/sidepanel/index.html');
fs.copyFileSync('sidepanel/styles.css', 'dist/sidepanel/styles.css');
fs.copyFileSync('lib/jszip.min.js', 'dist/lib/jszip.min.js');
fs.copyFileSync('manifest.json', 'dist/manifest.json');

console.log('Building TypeScript files...');

// Build configuration for all entry points
const buildConfig = {
  entryPoints: [
    'src/background/service-worker.ts',
    'src/content/extractor.ts',
    'src/content/xray-overlay.ts',
    'src/sidepanel/cart.ts',
    'src/sidepanel/settings.ts',
    'src/sidepanel/urlRewrite.ts',
    'src/lib/fe00-decoder.ts',
  ],
  bundle: true,
  outdir: 'dist',
  format: 'iife',  // Changed from 'esm' to 'iife' for Chrome extension compatibility
  platform: 'browser',
  target: 'es2022',
  sourcemap: isDev,
  minify: !isDev,
  logLevel: 'info',
  outbase: 'src',
};

esbuild
  .build(buildConfig)
  .then(() => {
    console.log('\n✓ Build complete!');
    const totalSize = getSize('dist');
    console.log(`Total extension size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  })
  .catch(() => process.exit(1));

function getSize(dir) {
  let size = 0;
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    if (file.isDirectory()) {
      size += getSize(filePath);
    } else {
      size += fs.statSync(filePath).size;
    }
  }
  return size;
}
