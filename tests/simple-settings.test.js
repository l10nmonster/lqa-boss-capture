/**
 * Simple tests for settings that will measure coverage
 */

// Mock DOM elements
document.body.innerHTML = `
  <input id="modal-tm-endpoint" value="" />
  <input id="source-lang" value="" />
  <input id="target-lang" value="" />
  <input id="modal-pwa-url" value="" />
  <input id="job-name" value="" />
  <input id="screenshot-quality" value="" />
  <input id="screenshot-max-height" value="" />
  <button id="upload-quality-model-btn"></button>
  <input type="file" id="quality-model-upload" />
  <button id="clear-quality-model-btn"></button>
  <span id="quality-model-status"></span>
  <div id="quality-model-error" style="display: none;"></div>
`;

// Import the module for coverage tracking
const { validateQualityModel, DEFAULT_SETTINGS } = require('../test-dist/sidepanel/settings.js');

describe('Settings Module Coverage', () => {
  describe('validateQualityModel', () => {
    test('should accept valid quality model', () => {
      const validModel = {
        id: 'test',
        name: 'Test',
        version: '1.0',
        severities: [],
        errorCategories: []
      };

      const result = validateQualityModel(validModel);
      expect(result.valid).toBe(true);
    });

    test('should reject null input', () => {
      const result = validateQualityModel(null);
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test('should reject missing required fields', () => {
      const invalidModel = { id: 'test' };
      const result = validateQualityModel(invalidModel);
      expect(result.valid).toBe(false);
    });

    test('should validate severity array', () => {
      const invalidModel = {
        id: 'test',
        name: 'Test',
        version: '1.0',
        severities: 'not-array',
        errorCategories: []
      };

      const result = validateQualityModel(invalidModel);
      expect(result.valid).toBe(false);
    });

    test('should validate severity structure', () => {
      const invalidModel = {
        id: 'test',
        name: 'Test',
        version: '1.0',
        severities: [{ id: 'sev1', label: 'Severity 1', weight: -1 }],
        errorCategories: []
      };

      const result = validateQualityModel(invalidModel);
      expect(result.valid).toBe(false);
    });

    test('should validate error category structure', () => {
      const invalidModel = {
        id: 'test',
        name: 'Test',
        version: '1.0',
        severities: [],
        errorCategories: [{ id: 'cat1' }] // Missing label and description
      };

      const result = validateQualityModel(invalidModel);
      expect(result.valid).toBe(false);
    });

    test('should validate subcategories if present', () => {
      const invalidModel = {
        id: 'test',
        name: 'Test',
        version: '1.0',
        severities: [],
        errorCategories: [{
          id: 'cat1',
          label: 'Category 1',
          description: 'Description',
          subcategories: 'not-array'
        }]
      };

      const result = validateQualityModel(invalidModel);
      expect(result.valid).toBe(false);
    });

    test('should accept valid model with subcategories', () => {
      const validModel = {
        id: 'test',
        name: 'Test',
        version: '1.0',
        severities: [{ id: 'sev1', label: 'Severity 1', weight: 5 }],
        errorCategories: [{
          id: 'cat1',
          label: 'Category 1',
          description: 'Description',
          subcategories: [{
            id: 'subcat1',
            label: 'Subcategory 1',
            description: 'Sub description'
          }]
        }]
      };

      const result = validateQualityModel(validModel);
      expect(result.valid).toBe(true);
    });
  });

  describe('DEFAULT_SETTINGS', () => {
    test('should have default values', () => {
      expect(DEFAULT_SETTINGS).toBeDefined();
      expect(DEFAULT_SETTINGS.sourceLang).toBe('en');
      expect(DEFAULT_SETTINGS.targetLang).toBe('es');
      expect(DEFAULT_SETTINGS.pwaUrl).toBe('https://lqaboss.l10n.monster');
    });
  });
});
