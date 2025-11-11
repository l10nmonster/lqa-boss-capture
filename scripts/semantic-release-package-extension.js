/**
 * Custom semantic-release plugin to package the extension from dist/ folder
 */
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

async function packageExtension(version) {
  const distDir = path.join(__dirname, '..', 'dist');
  const outputPath = path.join(__dirname, '..', `lqa-boss-capture-v${version}.zip`);

  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ directory not found. Build must run before packaging.');
  }

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    output.on('close', () => {
      const size = (archive.pointer() / 1024 / 1024).toFixed(2);
      console.log(`✓ Extension packaged: ${outputPath} (${size} MB)`);
      resolve({ path: outputPath, size });
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);
    archive.directory(distDir, false);
    archive.finalize();
  });
}

module.exports = {
  prepare: async (pluginConfig, context) => {
    const { nextRelease, logger } = context;
    logger.log('Packaging extension from dist/ folder...');

    await packageExtension(nextRelease.version);

    logger.log('Extension package created successfully');
  }
};
