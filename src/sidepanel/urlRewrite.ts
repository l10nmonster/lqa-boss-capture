/**
 * URL Rewrite Configuration Manager - Simplified
 */

import type {
  URLRewriteRule,
  RuntimeMessage
} from '../types/shared.js';

class URLRewriteManager {
  private rules: URLRewriteRule[] = [];
  private editingRuleId: string | null = null;
  private currentTabUrl: string | null = null;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    await this.loadRules();
    await this.updateCurrentTabUrl();
    this.setupEventListeners();
    await this.registerRulesWithServiceWorker();
  }

  private async updateCurrentTabUrl(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        this.currentTabUrl = tab.url;
      }
    } catch (error) {
      console.error('Failed to get current tab URL:', error);
    }
  }

  private setupEventListeners(): void {
    // Open modal button
    document.getElementById('url-rewrite-settings-btn')?.addEventListener('click', () => {
      this.showModal();
    });

    // Close modal button
    document.getElementById('close-rewrite-modal-btn')?.addEventListener('click', () => {
      this.hideModal();
    });

    // Close on overlay click
    document.querySelector('#url-rewrite-modal .modal-overlay')?.addEventListener('click', () => {
      this.hideModal();
    });

    // Add rule button
    document.getElementById('add-rewrite-rule-btn')?.addEventListener('click', () => {
      this.addRule();
    });

    // Validate on input
    const urlRegexInput = document.getElementById('rewrite-url-regex') as HTMLInputElement;
    const suffixInput = document.getElementById('rewrite-suffix') as HTMLInputElement;

    urlRegexInput?.addEventListener('input', () => {
      this.validateAndPreview();
    });

    suffixInput?.addEventListener('input', () => {
      this.validateAndPreview();
    });

    // Event delegation for rule action buttons
    document.getElementById('rewrite-rules-container')?.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!button) return;

      const ruleId = button.dataset.ruleId;
      const action = button.dataset.action;

      if (!ruleId || !action) return;

      switch (action) {
        case 'toggle':
          this.toggleRule(ruleId);
          break;
        case 'edit':
          this.editRule(ruleId);
          break;
        case 'remove':
          this.removeRule(ruleId);
          break;
      }
    });
  }

  private async showModal(): Promise<void> {
    document.getElementById('url-rewrite-modal')?.classList.remove('hidden');

    if ((window as any).settingsManager) {
      (window as any).settingsManager.populateFields();
    }

    await this.updateCurrentTabUrl();
    this.renderRules();
    this.validateAndPreview();
  }

  private hideModal(): void {
    document.getElementById('url-rewrite-modal')?.classList.add('hidden');
    this.clearForm();
  }

  private clearForm(): void {
    (document.getElementById('rewrite-url-regex') as HTMLInputElement).value = '';
    (document.getElementById('rewrite-suffix') as HTMLInputElement).value = '';
    document.getElementById('regex-validation')!.style.display = 'none';
    document.getElementById('url-preview-container')!.style.display = 'none';
    (document.getElementById('add-rewrite-rule-btn') as HTMLButtonElement).disabled = true;
    (document.getElementById('add-rewrite-rule-btn') as HTMLButtonElement).textContent = 'Add Rule';
    this.editingRuleId = null;
  }

  private validateAndPreview(): void {
    const urlRegexInput = document.getElementById('rewrite-url-regex') as HTMLInputElement;
    const suffixInput = document.getElementById('rewrite-suffix') as HTMLInputElement;
    const validationEl = document.getElementById('regex-validation')!;
    const previewEl = document.getElementById('url-preview-container')!;
    const addButton = document.getElementById('add-rewrite-rule-btn') as HTMLButtonElement;

    const urlRegex = urlRegexInput.value.trim();
    const suffix = suffixInput.value.trim();

    if (!urlRegex || !suffix) {
      validationEl.style.display = 'none';
      previewEl.style.display = 'none';
      addButton.disabled = true;
      return;
    }

    // Validate regex
    let regexObj: RegExp;
    try {
      regexObj = new RegExp(urlRegex);
    } catch (e) {
      validationEl.textContent = `❌ Invalid regex: ${(e as Error).message}`;
      validationEl.style.color = 'var(--danger)';
      validationEl.style.display = 'block';
      previewEl.style.display = 'none';
      addButton.disabled = true;
      return;
    }

    // Check for capture group
    const captureGroupMatch = urlRegex.match(/\([^?].*?\)/);
    if (!captureGroupMatch) {
      validationEl.textContent = '❌ Must have at least one capture group: (...)';
      validationEl.style.color = 'var(--danger)';
      validationEl.style.display = 'block';
      previewEl.style.display = 'none';
      addButton.disabled = true;
      return;
    }

    // Check for non-ASCII characters (Chrome's declarativeNetRequest requirement)
    // eslint-disable-next-line no-control-regex
    if (!/^[\x00-\x7F]*$/.test(urlRegex)) {
      validationEl.textContent = '❌ Pattern cannot contain non-ASCII characters';
      validationEl.style.color = 'var(--danger)';
      validationEl.style.display = 'block';
      previewEl.style.display = 'none';
      addButton.disabled = true;
      return;
    }

    // Check for RE2 unsupported features
    if (urlRegex.includes('(?<!') || urlRegex.includes('(?<=')) {
      validationEl.textContent = '❌ Lookbehind not supported by Chrome';
      validationEl.style.color = 'var(--danger)';
      validationEl.style.display = 'block';
      previewEl.style.display = 'none';
      addButton.disabled = true;
      return;
    }

    if (/\\[1-9]/.test(urlRegex)) {
      validationEl.textContent = '❌ Backreferences not supported by Chrome';
      validationEl.style.color = 'var(--danger)';
      validationEl.style.display = 'block';
      previewEl.style.display = 'none';
      addButton.disabled = true;
      return;
    }

    // Test against current URL and check for recursion
    if (this.currentTabUrl) {
      const match = this.currentTabUrl.match(regexObj);
      if (match && match[1]) {
        // Build rewritten URL
        const rewrittenUrl = this.currentTabUrl.replace(regexObj, (fullMatch, group1, ...args) => {
          return fullMatch.replace(group1, group1 + suffix);
        });

        // Check for recursion: does the rewritten URL match the pattern?
        const recursionMatch = rewrittenUrl.match(regexObj);
        if (recursionMatch && recursionMatch[1]) {
          validationEl.textContent = '⚠️ Warning: Causes infinite redirect loop';
          validationEl.style.color = 'var(--warning, #d97706)';
          validationEl.style.display = 'block';
          previewEl.style.display = 'none';
          addButton.disabled = true;
          return;
        }

        // Show preview
        validationEl.textContent = '✓ Valid';
        validationEl.style.color = 'var(--success)';
        validationEl.style.display = 'block';

        previewEl.innerHTML = `<strong>Preview:</strong><br><code style="word-break: break-all;">${this.escapeHtml(this.currentTabUrl)}</code><br>→<br><code style="word-break: break-all;">${this.escapeHtml(rewrittenUrl)}</code>`;
        previewEl.style.background = 'var(--success-bg)';
        previewEl.style.border = '1px solid var(--success-border)';
        previewEl.style.display = 'block';

        addButton.disabled = false;
      } else {
        validationEl.textContent = '✓ Valid (doesn\'t match current URL)';
        validationEl.style.color = 'var(--gray-600)';
        validationEl.style.display = 'block';
        previewEl.style.display = 'none';
        addButton.disabled = false;
      }
    } else {
      validationEl.textContent = '✓ Valid';
      validationEl.style.color = 'var(--success)';
      validationEl.style.display = 'block';
      previewEl.style.display = 'none';
      addButton.disabled = false;
    }
  }

  private async addRule(): Promise<void> {
    const urlRegex = (document.getElementById('rewrite-url-regex') as HTMLInputElement).value.trim();
    const suffix = (document.getElementById('rewrite-suffix') as HTMLInputElement).value.trim();

    // Save previous state in case we need to revert
    const previousRules = JSON.parse(JSON.stringify(this.rules));
    let isNewRule = false;
    let editedRuleId: string | null = null;

    if (this.editingRuleId) {
      // Editing existing rule
      const rule = this.rules.find(r => r.id === this.editingRuleId);
      if (rule) {
        editedRuleId = rule.id;
        rule.urlRegex = urlRegex;
        rule.suffix = suffix;
      }
    } else {
      // Adding new rule
      isNewRule = true;
      const rule: URLRewriteRule = {
        id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        urlRegex,
        suffix,
        enabled: true,
        createdAt: new Date().toISOString()
      };
      this.rules.push(rule);
    }

    // Try to register with service worker first
    const result = await this.registerRulesWithServiceWorker();

    if (!result.success) {
      // Registration failed - revert changes
      this.rules = previousRules;
      await this.saveRules();

      // Show error to user
      const validationEl = document.getElementById('regex-validation')!;
      validationEl.textContent = `❌ Failed to register rule: ${result.error}`;
      validationEl.style.color = 'var(--danger)';
      validationEl.style.display = 'block';

      // Don't clear form or render - let user see the error and fix it
      return;
    }

    // Registration succeeded - save to storage
    await this.saveRules();
    this.clearForm();
    this.renderRules();
  }

  private editRule(ruleId: string): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return;

    (document.getElementById('rewrite-url-regex') as HTMLInputElement).value = rule.urlRegex;
    (document.getElementById('rewrite-suffix') as HTMLInputElement).value = rule.suffix;

    this.editingRuleId = ruleId;
    (document.getElementById('add-rewrite-rule-btn') as HTMLButtonElement).textContent = 'Update Rule';

    this.validateAndPreview();
    document.querySelector('.rewrite-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private async removeRule(ruleId: string): Promise<void> {
    const previousRules = JSON.parse(JSON.stringify(this.rules));
    this.rules = this.rules.filter(rule => rule.id !== ruleId);

    const result = await this.registerRulesWithServiceWorker();
    if (!result.success) {
      // Revert on error
      this.rules = previousRules;
      alert(`Failed to remove rule: ${result.error}`);
      return;
    }

    await this.saveRules();
    this.renderRules();
  }

  private async toggleRule(ruleId: string): Promise<void> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return;

    const previousRules = JSON.parse(JSON.stringify(this.rules));
    rule.enabled = !rule.enabled;

    const result = await this.registerRulesWithServiceWorker();
    if (!result.success) {
      // Revert on error
      this.rules = previousRules;
      alert(`Failed to toggle rule: ${result.error}`);
      this.renderRules();
      return;
    }

    await this.saveRules();
    this.renderRules();
  }

  private renderRules(): void {
    const container = document.getElementById('rewrite-rules-container');
    if (!container) return;

    if (this.rules.length === 0) {
      container.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--gray-400); font-size: 12px;">No rules</div>';
      return;
    }

    container.innerHTML = this.rules.map(rule => `
      <div style="padding: 10px; margin-bottom: 8px; background: var(--gray-50); border: 1px solid var(--gray-200); border-radius: 4px; opacity: ${rule.enabled ? '1' : '0.5'};">
        <div style="font-size: 11px; font-family: monospace; word-break: break-all; margin-bottom: 8px;">
          ${this.escapeHtml(rule.urlRegex)}
        </div>
        <div style="display: flex; gap: 4px; justify-content: flex-end;">
          <button class="btn-text" data-rule-id="${rule.id}" data-action="toggle" style="padding: 2px 6px; font-size: 11px;">
            ${rule.enabled ? 'Disable' : 'Enable'}
          </button>
          <button class="btn-text" data-rule-id="${rule.id}" data-action="edit" style="padding: 2px 6px; font-size: 11px;">Edit</button>
          <button class="btn-text" data-rule-id="${rule.id}" data-action="remove" style="color: var(--danger); padding: 2px 6px; font-size: 11px;">Remove</button>
        </div>
      </div>
    `).join('');
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private async loadRules(): Promise<void> {
    const result = await chrome.storage.local.get('url_rewrite_rules');
    this.rules = result.url_rewrite_rules || [];
  }

  private async saveRules(): Promise<void> {
    await chrome.storage.local.set({ url_rewrite_rules: this.rules });
  }

  private async registerRulesWithServiceWorker(): Promise<{ success: boolean; error?: string }> {
    try {
      const message: RuntimeMessage = {
        action: 'update-url-rewrite-rules',
        rules: this.rules.filter(r => r.enabled)
      };
      const response = await chrome.runtime.sendMessage(message);
      if (response && response.success) {
        return { success: true };
      } else {
        return { success: false, error: response?.error || 'Unknown error' };
      }
    } catch (error) {
      console.error('Failed to register rules with service worker:', error);
      return { success: false, error: (error as Error).message };
    }
  }
}

// Initialize
const _urlRewriteManager = new URLRewriteManager();
