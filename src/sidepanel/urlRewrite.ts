/**
 * URL Rewrite Configuration Manager
 */

import type {
  URLRewriteRule,
  RuntimeMessage
} from '../types/shared.js';

class URLRewriteManager {
  private rules: URLRewriteRule[] = [];
  private editingRuleId: string | null = null;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // Load existing rules from storage
    await this.loadRules();

    // Set up event listeners
    this.setupEventListeners();

    // Register rules with service worker
    await this.registerRulesWithServiceWorker();
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

    // Validate regex on input
    const regexInput = document.getElementById('rewrite-regex') as HTMLInputElement;
    regexInput?.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.validateRegex(target.value);
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

  private showModal(): void {
    document.getElementById('url-rewrite-modal')?.classList.remove('hidden');

    // Refresh settings fields
    if ((window as any).settingsManager) {
      (window as any).settingsManager.populateFields();
    }

    this.renderRules();
  }

  private hideModal(): void {
    document.getElementById('url-rewrite-modal')?.classList.add('hidden');
    this.clearForm();
  }

  private clearForm(): void {
    // Clear form
    (document.getElementById('rewrite-hostname') as HTMLInputElement).value = '';
    (document.getElementById('rewrite-regex') as HTMLInputElement).value = '';
    (document.getElementById('rewrite-suffix') as HTMLInputElement).value = '';
    const errorEl = document.getElementById('regex-error') as HTMLElement;
    errorEl.style.display = 'none';
    this.editingRuleId = null;

    // Reset button text
    const addButton = document.getElementById('add-rewrite-rule-btn') as HTMLButtonElement;
    addButton.textContent = 'Add Rule';
  }

  private validateRegex(pattern: string): boolean {
    const errorElement = document.getElementById('regex-error') as HTMLElement;

    if (!pattern) {
      errorElement.style.display = 'none';
      return true;
    }

    try {
      // Validate regex pattern (will throw if invalid)
      new RegExp(pattern);

      // Check if pattern has at least one capture group
      const captureGroupMatch = pattern.match(/\([^?].*?\)/);
      if (!captureGroupMatch) {
        errorElement.textContent = 'Pattern must include at least one capture group, e.g., (.*)';
        errorElement.style.display = 'block';
        return false;
      }

      errorElement.style.display = 'none';
      return true;
    } catch (e) {
      const error = e as Error;
      errorElement.textContent = 'Invalid regex pattern: ' + error.message;
      errorElement.style.display = 'block';
      return false;
    }
  }

  private async addRule(): Promise<void> {
    const hostname = (document.getElementById('rewrite-hostname') as HTMLInputElement).value.trim();
    const regex = (document.getElementById('rewrite-regex') as HTMLInputElement).value.trim();
    const suffix = (document.getElementById('rewrite-suffix') as HTMLInputElement).value.trim();

    // Validate inputs
    if (!hostname) {
      this.showStatus('Please enter a hostname', 'error');
      return;
    }

    if (!regex) {
      this.showStatus('Please enter a regex pattern', 'error');
      return;
    }

    if (!this.validateRegex(regex)) {
      return;
    }

    if (!suffix) {
      this.showStatus('Please enter a suffix', 'error');
      return;
    }

    if (this.editingRuleId) {
      // Update existing rule
      const rule = this.rules.find(r => r.id === this.editingRuleId);
      if (rule) {
        rule.hostname = hostname;
        rule.regex = regex;
        rule.suffix = suffix;
      }
    } else {
      // Create new rule
      const rule: URLRewriteRule = {
        id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        hostname,
        regex,
        suffix,
        enabled: true,
        createdAt: new Date().toISOString()
      };

      // Add to rules array
      this.rules.push(rule);
    }

    // Save to storage
    await this.saveRules();

    // Register with service worker
    await this.registerRulesWithServiceWorker();

    // Clear form
    this.clearForm();

    // Re-render rules list
    this.renderRules();
  }

  private editRule(ruleId: string): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return;

    // Populate form with rule data
    (document.getElementById('rewrite-hostname') as HTMLInputElement).value = rule.hostname;
    (document.getElementById('rewrite-regex') as HTMLInputElement).value = rule.regex;
    (document.getElementById('rewrite-suffix') as HTMLInputElement).value = rule.suffix;

    // Set editing state
    this.editingRuleId = ruleId;

    // Update button text
    const addButton = document.getElementById('add-rewrite-rule-btn') as HTMLButtonElement;
    addButton.textContent = 'Update Rule';

    // Scroll to form
    document.querySelector('.rewrite-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private async removeRule(ruleId: string): Promise<void> {
    this.rules = this.rules.filter(rule => rule.id !== ruleId);
    await this.saveRules();
    await this.registerRulesWithServiceWorker();
    this.renderRules();
  }

  private async toggleRule(ruleId: string): Promise<void> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = !rule.enabled;
      await this.saveRules();
      await this.registerRulesWithServiceWorker();
      this.renderRules();
    }
  }

  private renderRules(): void {
    const container = document.getElementById('rewrite-rules-container');
    if (!container) return;

    if (this.rules.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 20px; text-align: center; color: var(--gray-400);">
          No rewrite rules configured
        </div>
      `;
      return;
    }

    container.innerHTML = this.rules.map(rule => `
      <div class="rewrite-rule-item" style="padding: 12px; margin-bottom: 8px; background: var(--gray-50); border: 1px solid var(--gray-200); border-radius: 6px;">
        <div style="display: flex; align-items: start; justify-content: space-between; gap: 12px;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 500; margin-bottom: 4px; color: ${rule.enabled ? 'var(--gray-900)' : 'var(--gray-400)'};">
              ${this.escapeHtml(rule.hostname)}
            </div>
            <div style="font-size: 12px; color: var(--gray-600); font-family: monospace; margin-bottom: 2px; word-break: break-all;">
              Pattern: ${this.escapeHtml(rule.regex)}
            </div>
            <div style="font-size: 12px; color: var(--gray-600); font-family: monospace; word-break: break-all;">
              Suffix: ${this.escapeHtml(rule.suffix)}
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px; flex-shrink: 0;">
            <button class="btn-text" data-rule-id="${rule.id}" data-action="toggle" style="padding: 4px 8px; text-align: left; white-space: nowrap;">
              ${rule.enabled ? 'Disable' : 'Enable'}
            </button>
            <button class="btn-text" data-rule-id="${rule.id}" data-action="edit" style="padding: 4px 8px; text-align: left; white-space: nowrap;">
              Edit
            </button>
            <button class="btn-text" data-rule-id="${rule.id}" data-action="remove" style="color: var(--danger); padding: 4px 8px; text-align: left; white-space: nowrap;">
              Remove
            </button>
          </div>
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

  private async registerRulesWithServiceWorker(): Promise<void> {
    // Send rules to service worker
    try {
      const message: RuntimeMessage = {
        action: 'update-url-rewrite-rules',
        rules: this.rules.filter(r => r.enabled)
      };
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      console.error('Failed to register rules with service worker:', error);
    }
  }

  private showStatus(message: string, type: 'info' | 'error' | 'success' = 'info'): void {
    const status = document.getElementById('status') as HTMLElement;
    status.textContent = message;
    status.className = `status visible ${type}`;

    setTimeout(() => {
      status.classList.remove('visible');
    }, 3000);
  }
}

// Initialize URL Rewrite Manager (instance needed for side effects)
const _urlRewriteManager = new URLRewriteManager();
