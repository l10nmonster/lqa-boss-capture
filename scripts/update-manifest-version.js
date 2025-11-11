/**
 * Custom semantic-release plugin to update manifest.json version
 * This plugin runs during the prepare step to sync the version with package.json
 */

const fs = require('fs');
const path = require('path');

/**
 * Prepare step: Update manifest.json with the new version
 */
async function prepare(pluginConfig, context) {
  const { nextRelease, logger } = context;
  const manifestPath = path.resolve(process.cwd(), 'manifest.json');

  logger.log(`Updating manifest.json version to ${nextRelease.version}`);

  // Read manifest.json
  const manifestContent = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestContent);

  // Update version
  manifest.version = nextRelease.version;

  // Write back to manifest.json with pretty formatting
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  logger.log(`manifest.json version updated to ${nextRelease.version}`);
}

module.exports = { prepare };
