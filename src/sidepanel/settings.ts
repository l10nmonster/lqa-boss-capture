/**
 * Settings Management
 */

import type {
  QualityModelSeverity,
  QualityModelSubcategory,
  QualityModelCategory,
  QualityModel,
  Settings,
  ValidationResult
} from '../types/shared.js';

const DEFAULT_SETTINGS: Settings = {
  tmEndpointUrl: '',
  sourceLang: 'en',
  targetLang: 'es',
  pwaUrl: 'https://lqaboss.l10n.monster',
  qualityModel: null,
  jobName: ''
};

/**
 * Validate quality model against schema
 */
function validateQualityModel(model: any): ValidationResult {
  // Check if model is an object
  if (!model || typeof model !== 'object') {
    return { valid: false, error: 'Quality model must be an object' };
  }

  // Check required top-level fields
  const requiredFields = ['id', 'name', 'version', 'severities', 'errorCategories'];
  for (const field of requiredFields) {
    if (!(field in model)) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Validate field types
  if (typeof model.id !== 'string') {
    return { valid: false, error: 'Field "id" must be a string' };
  }
  if (typeof model.name !== 'string') {
    return { valid: false, error: 'Field "name" must be a string' };
  }
  if (typeof model.version !== 'string') {
    return { valid: false, error: 'Field "version" must be a string' };
  }

  // Validate severities array
  if (!Array.isArray(model.severities)) {
    return { valid: false, error: 'Field "severities" must be an array' };
  }
  for (let i = 0; i < model.severities.length; i++) {
    const severity = model.severities[i];
    if (!severity.id || typeof severity.id !== 'string') {
      return { valid: false, error: `Severity at index ${i} missing or invalid "id"` };
    }
    if (!severity.label || typeof severity.label !== 'string') {
      return { valid: false, error: `Severity at index ${i} missing or invalid "label"` };
    }
    if (typeof severity.weight !== 'number' || severity.weight < 0) {
      return { valid: false, error: `Severity at index ${i} has invalid "weight" (must be number >= 0)` };
    }
  }

  // Validate errorCategories array
  if (!Array.isArray(model.errorCategories)) {
    return { valid: false, error: 'Field "errorCategories" must be an array' };
  }
  for (let i = 0; i < model.errorCategories.length; i++) {
    const category = model.errorCategories[i];
    if (!category.id || typeof category.id !== 'string') {
      return { valid: false, error: `Error category at index ${i} missing or invalid "id"` };
    }
    if (!category.label || typeof category.label !== 'string') {
      return { valid: false, error: `Error category at index ${i} missing or invalid "label"` };
    }
    if (!category.description || typeof category.description !== 'string') {
      return { valid: false, error: `Error category at index ${i} missing or invalid "description"` };
    }

    // Validate subcategories if present
    if (category.subcategories) {
      if (!Array.isArray(category.subcategories)) {
        return { valid: false, error: `Error category "${category.id}" has invalid subcategories (must be array)` };
      }
      for (let j = 0; j < category.subcategories.length; j++) {
        const subcategory = category.subcategories[j];
        if (!subcategory.id || typeof subcategory.id !== 'string') {
          return { valid: false, error: `Subcategory at index ${j} of category "${category.id}" missing or invalid "id"` };
        }
        if (!subcategory.label || typeof subcategory.label !== 'string') {
          return { valid: false, error: `Subcategory at index ${j} of category "${category.id}" missing or invalid "label"` };
        }
        if (!subcategory.description || typeof subcategory.description !== 'string') {
          return { valid: false, error: `Subcategory at index ${j} of category "${category.id}" missing or invalid "description"` };
        }
      }
    }
  }

  return { valid: true };
}

class SettingsManager {
  private settings: Settings;

  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.init();
  }

  private async init(): Promise<void> {
    // Load settings from chrome.storage
    await this.load();

    // Populate form fields
    this.populateFields();

    // Setup auto-save event listeners
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Auto-save on input change
    document.getElementById('modal-tm-endpoint')?.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.settings.tmEndpointUrl = target.value.trim();
      this.save();
    });

    document.getElementById('source-lang')?.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.settings.sourceLang = target.value.trim();
      this.save();
    });

    document.getElementById('target-lang')?.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.settings.targetLang = target.value.trim();
      this.save();
    });

    document.getElementById('modal-pwa-url')?.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.settings.pwaUrl = target.value.trim();
      this.save();
    });

    document.getElementById('job-name')?.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.settings.jobName = target.value.trim();
      this.save();
    });

    // Quality model upload
    document.getElementById('upload-quality-model-btn')?.addEventListener('click', () => {
      document.getElementById('quality-model-upload')?.click();
    });

    document.getElementById('quality-model-upload')?.addEventListener('change', async (e) => {
      await this.handleQualityModelUpload(e as Event);
    });

    document.getElementById('clear-quality-model-btn')?.addEventListener('click', async () => {
      await this.clearQualityModel();
    });
  }

  public populateFields(): void {
    (document.getElementById('modal-tm-endpoint') as HTMLInputElement).value = this.settings.tmEndpointUrl;
    (document.getElementById('source-lang') as HTMLInputElement).value = this.settings.sourceLang;
    (document.getElementById('target-lang') as HTMLInputElement).value = this.settings.targetLang;
    (document.getElementById('modal-pwa-url') as HTMLInputElement).value = this.settings.pwaUrl;
    (document.getElementById('job-name') as HTMLInputElement).value = this.settings.jobName;
    this.updateQualityModelDisplay();
  }

  private async handleQualityModelUpload(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    // Hide previous error
    const errorDiv = document.getElementById('quality-model-error') as HTMLElement;
    errorDiv.style.display = 'none';

    try {
      const text = await file.text();
      const model = JSON.parse(text);

      // Validate model
      const validation = validateQualityModel(model);
      if (!validation.valid) {
        errorDiv.textContent = `Validation error: ${validation.error}`;
        errorDiv.style.display = 'block';
        return;
      }

      // Save model
      this.settings.qualityModel = model;
      await this.save();
      this.updateQualityModelDisplay();

      console.log('Quality model loaded:', model.name, model.version);
    } catch (error) {
      const err = error as Error;
      errorDiv.textContent = `Error loading file: ${err.message}`;
      errorDiv.style.display = 'block';
    } finally {
      // Reset file input
      target.value = '';
    }
  }

  private async clearQualityModel(): Promise<void> {
    this.settings.qualityModel = null;
    await this.save();
    this.updateQualityModelDisplay();
    console.log('Quality model cleared');
  }

  private updateQualityModelDisplay(): void {
    const statusSpan = document.getElementById('quality-model-status') as HTMLElement;
    const clearBtn = document.getElementById('clear-quality-model-btn') as HTMLButtonElement;

    if (this.settings.qualityModel) {
      const { name, version } = this.settings.qualityModel;
      statusSpan.textContent = `${name} v${version}`;
      statusSpan.style.color = 'var(--gray-900)';
      clearBtn.disabled = false;
    } else {
      statusSpan.textContent = 'none';
      statusSpan.style.color = 'var(--gray-500)';
      clearBtn.disabled = true;
    }
  }

  private async load(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get('lqaboss_settings');
      if (result.lqaboss_settings) {
        this.settings = { ...DEFAULT_SETTINGS, ...result.lqaboss_settings };
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  private async save(): Promise<void> {
    try {
      await chrome.storage.sync.set({ lqaboss_settings: this.settings });
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  }

  public getSettings(): Settings {
    return { ...this.settings };
  }
}

// Global settings instance
const settingsManager = new SettingsManager();
if (typeof window !== 'undefined') {
  (window as any).settingsManager = settingsManager;
}

export { validateQualityModel, SettingsManager, DEFAULT_SETTINGS };
export type { Settings, QualityModel, QualityModelCategory, QualityModelSeverity, QualityModelSubcategory };
