/**
 * Shared Type Definitions
 *
 * ⚠️  IMPORTANT: TYPE DUPLICATION WITH PWA
 *
 * These types are intentionally duplicated from lqa-boss/src/types/index.ts
 * to keep the extension self-contained and buildable without the PWA repo.
 *
 * However, field names and structures MUST remain compatible with the PWA
 * to ensure seamless data exchange via the .lqaboss file format.
 *
 * 📋 MAINTENANCE GUIDELINES:
 * - Review these types when PWA types change (lqa-boss/src/types/index.ts)
 * - Document any intentional differences below
 * - Keep field names matching PWA expectations (e.g., pageId, originalUrl)
 * - Use [key: string]: any for forward compatibility
 *
 * 🔄 KNOWN DIFFERENCES:
 * - TranslationUnit: PWA uses nsrc/ntgt (NormalizedItem[]), extension uses source/target (string)
 * - TranslationUnit: PWA has ts as number (Unix timestamp), extension has ts as string (ISO)
 * - CapturedPage: Extension has additional temporary fields (screenshotBase64) during capture
 * - Extension-specific types: URLRewriteRule, Settings, QualityModel (not in PWA)
 */

/**
 * SHARED TYPE: Matches lqa-boss/src/types/index.ts:Segment
 *
 * Represents a text segment on a captured page with position coordinates.
 *
 * Common extension-specific fields (not required by PWA):
 * - g: string - GUID from FE00 metadata
 * - sid: string - String ID from FE00 metadata
 * - matched: boolean - Whether TM match was found
 * - decodingError: string - Error message if metadata decoding failed
 */
export interface Segment {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  [key: string]: any;
}

/**
 * SHARED TYPE: Similar to lqa-boss/src/types/index.ts:Page
 *
 * Represents a captured page with segments.
 *
 * PWA expects:
 * - pageId: string
 * - originalUrl?: string
 * - imageFile: string (filename like "page_1_abc123.png")
 * - segments: Segment[]
 *
 * Extension adds during capture:
 * - title: string
 * - timestamp: string
 */
export interface CapturedPage {
  pageId: string;      // Renamed from 'id' for PWA compatibility
  originalUrl: string; // Renamed from 'url' for PWA compatibility
  title: string;       // Extension-only: page title
  timestamp: string;   // Extension-only: capture time
  imageFile?: string;  // Set when creating flow metadata (filename)
  screenshotBase64?: string; // Temporary during capture (base64 data)
  segments: Segment[];
  // Coordinate system info for proper overlay positioning
  viewportWidth?: number;   // CSS viewport width used for coordinate calculation
  documentHeight?: number;  // CSS document height (full page)
  screenshotScale?: number; // Ratio: screenshot pixels / CSS pixels
}

/**
 * SHARED TYPE: Simplified version of lqa-boss/src/types/index.ts:TranslationUnit
 *
 * Represents a translation unit from TM service.
 *
 * PWA's TranslationUnit is more comprehensive (has nsrc, ntgt, qa, etc.).
 * This is the simplified structure returned by TM lookup services.
 */
export interface TranslationUnit {
  guid: string;
  sid?: string;
  source: string;  // PWA uses nsrc: NormalizedItem[] for placeholder support
  target: string;  // PWA uses ntgt: NormalizedItem[] for placeholder support
  q: number;       // Quality score 0-100
  ts: string;      // ISO timestamp (PWA uses number for Unix timestamp)
}

/**
 * Extension-specific: Settings stored in chrome.storage
 */
export interface Settings {
  tmEndpointUrl: string;
  sourceLang: string;
  targetLang: string;
  pwaUrl: string;
  qualityModel: QualityModel | null;
  jobName: string;
}

/**
 * Extension-specific: Quality model schema for LQA
 */
export interface QualityModel {
  id: string;
  name: string;
  version: string;
  severities: QualityModelSeverity[];
  errorCategories: QualityModelCategory[];
}

export interface QualityModelSeverity {
  id: string;
  label: string;
  weight: number;
}

export interface QualityModelSubcategory {
  id: string;
  label: string;
  description: string;
}

export interface QualityModelCategory {
  id: string;
  label: string;
  description: string;
  subcategories?: QualityModelSubcategory[];
}

/**
 * Extension-specific: URL rewrite rule configuration
 */
export interface URLRewriteRule {
  id: string;
  urlRegex: string;  // Full URL regex pattern (must have one capture group)
  suffix: string;    // Suffix to add to first capture group
  enabled: boolean;
  createdAt: string;
}

/**
 * Extension-specific: Chrome runtime message types
 */
export interface RuntimeMessage {
  action: string;
  [key: string]: any;
}

export interface RuntimeResponse {
  success: boolean;
  [key: string]: any;
}

/**
 * Extension-specific: TM service response format
 */
export interface TMResponse {
  guid: string;
  sid?: string;
  source: string;
  target: string;
  q: number;
  ts: string;
}

export interface TMServiceResponse {
  results: TMResponse[];
  warnings?: string[];
}

/**
 * Extension-specific: Validation result for settings
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Extension-specific: Capture state management
 */
export interface CaptureState {
  isCapturing: boolean;
  currentTabId: number | null;
}

/**
 * Extension-specific: Pending flow for PWA transfer
 */
export interface PendingFlow {
  zipData: number[];
  fileName: string;
  createdAt: number;
}
