#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const distDir = path.join(__dirname, '..', 'dist');
const packageJson = require('../package.json');
const outputPath = path.join(__dirname, '..', `lqa-boss-capture-v${packageJson.version}.zip`);

if (!fs.existsSync(distDir)) {
  console.error('Error: dist/ directory not found. Run "npm run build" first.');
  process.exit(1);
}

// Create a write stream
const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', {
  zlib: { level: 9 } // Maximum compression
});

output.on('close', () => {
  console.log(`\n✓ Extension packaged successfully!`);
  console.log(`  File: ${outputPath}`);
  console.log(`  Size: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
});

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);

// Add all files from dist/ directory
archive.directory(distDir, false);

archive.finalize();
