/**
 * Tests for manifest.json validation
 */

const fs = require('fs');
const path = require('path');

describe('manifest.json', () => {
  let manifest;

  beforeAll(() => {
    const manifestPath = path.join(__dirname, '..', 'manifest.json');
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(manifestContent);
  });

  test('should have manifest_version 3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  test('should have required fields', () => {
    expect(manifest.name).toBeDefined();
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
  });

  test('should have valid version format', () => {
    // Chrome extension version must be 1-4 dot-separated integers
    const versionRegex = /^\d+(\.\d+){0,3}$/;
    expect(manifest.version).toMatch(versionRegex);
  });

  test('should have required permissions', () => {
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).toContain('scripting');
    expect(manifest.permissions).toContain('sidePanel');
    expect(manifest.permissions).toContain('storage');
  });

  test('should have background service worker', () => {
    expect(manifest.background).toBeDefined();
    expect(manifest.background.service_worker).toBeDefined();
  });

  test('should have side panel configuration', () => {
    expect(manifest.side_panel).toBeDefined();
    expect(manifest.side_panel.default_path).toBe('sidepanel/index.html');
  });

  test('should have externally_connectable configuration', () => {
    expect(manifest.externally_connectable).toBeDefined();
    expect(manifest.externally_connectable.matches).toBeInstanceOf(Array);
    expect(manifest.externally_connectable.matches.length).toBeGreaterThan(0);
  });

  test('should have valid icon references', () => {
    expect(manifest.icons).toBeDefined();
    expect(manifest.icons['16']).toBeDefined();
    expect(manifest.icons['48']).toBeDefined();
    expect(manifest.icons['128']).toBeDefined();
  });
});
