# Type Consolidation Summary

## Overview

Consolidated duplicate type definitions across the extension and aligned field names with PWA for better compatibility.

## Changes Made

### 1. Created Shared Types File

**New file:** `src/types/shared.ts`

Consolidated all duplicate type definitions into a single source of truth:

- `Segment` - Was defined in 3 files (service-worker, cart, xray-overlay)
- `CapturedPage` - Was defined in 2 files (service-worker, cart)
- `Settings` - Was defined in 2 files (service-worker, settings)
- `QualityModel` and related types - Consolidated from settings.ts
- `URLRewriteRule` - Consolidated from multiple files
- `RuntimeMessage` / `RuntimeResponse` - Base types for Chrome messaging
- `TranslationUnit` - Consolidated definition

### 2. Field Name Alignment with PWA

**Breaking changes for PWA compatibility:**

| Old Field | New Field | Type | Reason |
|-----------|-----------|------|--------|
| `page.id` | `page.pageId` | `CapturedPage` | Matches `lqa-boss/src/types/index.ts:Page` |
| `page.url` | `page.originalUrl` | `CapturedPage` | Matches `lqa-boss/src/types/index.ts:Page` |

**Files affected:**
- `src/background/service-worker.ts` (create, read, ZIP generation)
- `src/sidepanel/cart.ts` (display, removal)

**Impact:** The extension now creates flow_metadata.json files with field names that exactly match what the PWA expects.

### 3. Type Hierarchy

**Base types** (in `src/types/shared.ts`):
```typescript
interface Segment { x, y, width, height, text, [key: string]: any }
interface CapturedPage { pageId, originalUrl, title, timestamp, ... }
interface RuntimeMessage { action, [key: string]: any }
interface RuntimeResponse { success, [key: string]: any }
```

**Extended types** (in consuming files):
```typescript
// In service-worker.ts and cart.ts
interface ExtendedCapturedPage extends CapturedPage {
  matchedTUs: TranslationUnit[];
  matchedCount: number;
  favicon?: string;
  warnings: string[];
}
```

This pattern allows:
- Base types to match PWA expectations
- Extension-specific fields to be added via extension
- Type safety throughout the codebase

### 4. Files Updated

**Type imports added:**

1. **src/background/service-worker.ts**
   - Imports: `URLRewriteRule`, `Segment`, `TranslationUnit`, `CapturedPage`, `Settings`, `CaptureState`, `PendingFlow`, `RuntimeMessage`, `RuntimeResponse`, `TMServiceResponse`
   - Extends: `ExtendedCapturedPage` for internal use
   - Changed: `page.id` → `page.pageId`, `page.url` → `page.originalUrl`

2. **src/sidepanel/cart.ts**
   - Imports: `Segment`, `CapturedPage`, `RuntimeMessage`, `RuntimeResponse`
   - Extends: `ExtendedCapturedPage` for display
   - Changed: `page.id` → `page.pageId`, `page.url` → `page.originalUrl`

3. **src/sidepanel/settings.ts**
   - Imports: `QualityModelSeverity`, `QualityModelSubcategory`, `QualityModelCategory`, `QualityModel`, `Settings`, `ValidationResult`
   - No field changes (settings interface already compatible)

4. **src/sidepanel/urlRewrite.ts**
   - Imports: `URLRewriteRule`, `RuntimeMessage`
   - No field changes

5. **src/content/xray-overlay.ts**
   - Imports: `Segment`, `RuntimeMessage`, `RuntimeResponse`
   - Extends types for X-Ray specific needs
   - No field changes

6. **src/content/extractor.ts**
   - No changes (uses extractor-specific types: `TextElement`, `ExtractionResult`, `ActiveSegment`)
   - These types are not shared as they're internal to the extraction logic

### 5. PWA Compatibility

**Aligned types:**

✅ `Segment` - Exact match with PWA
✅ `CapturedPage` - Field names match PWA's `Page` interface
✅ Field naming: `pageId` and `originalUrl` match PWA expectations

**Intentional differences documented:**

⚠️ `TranslationUnit`:
- PWA: `nsrc: NormalizedItem[]`, `ntgt: NormalizedItem[]`, `ts: number`
- Extension: `source: string`, `target: string`, `ts: string`
- Reason: Extension receives simple strings from TM service, PWA needs normalized arrays for placeholder management

⚠️ `CapturedPage` extensions:
- Extension adds: `screenshotBase64`, `matchedTUs`, `matchedCount`, `favicon`, `warnings`
- These are temporary fields during capture, not persisted to flow_metadata.json

## Type Duplication Strategy

**Chosen approach:** Documented duplication (Option 3 from TYPE_SHARING_ANALYSIS.md)

### Why Not Import from PWA?

1. **Build independence** - Extension can build without PWA repo
2. **Deployment simplicity** - No path dependencies between repos
3. **Small API surface** - Only ~5 shared types
4. **Different lifecycles** - Extension and PWA can evolve separately

### Maintenance Guidelines

**Added to `src/types/shared.ts`:**

```typescript
/**
 * ⚠️  IMPORTANT: TYPE DUPLICATION WITH PWA
 *
 * These types are intentionally duplicated from lqa-boss/src/types/index.ts
 * to keep the extension self-contained and buildable without the PWA repo.
 *
 * 📋 MAINTENANCE GUIDELINES:
 * - Review these types when PWA types change (lqa-boss/src/types/index.ts)
 * - Document any intentional differences
 * - Keep field names matching PWA expectations (e.g., pageId, originalUrl)
 * - Use [key: string]: any for forward compatibility
 */
```

## Benefits

### Type Safety
✅ No duplicate definitions to keep in sync
✅ Single import point for shared types
✅ TypeScript catches field name mismatches

### PWA Compatibility
✅ Field names match PWA expectations (`pageId`, `originalUrl`)
✅ Documented differences for intentional divergence
✅ Forward compatible via `[key: string]: any`

### Maintainability
✅ Clear documentation of type duplication
✅ Maintenance guidelines in code comments
✅ Known differences explicitly listed

## Testing

**Build:** ✅ Passes
```bash
npm run build
✓ Build complete!
Total extension size: 0.19 MB
```

**Tests:** ✅ All passing
```bash
npm test
Test Suites: 4 passed, 4 total
Tests:       28 passed, 28 total
```

## Migration Impact

**For developers:**
- Update field access: `page.id` → `page.pageId`, `page.url` → `page.originalUrl`
- Import types from `../types/shared.js` instead of local definitions
- No functional changes, only type organization

**For users:**
- No impact - same functionality
- Better PWA compatibility for flow files

**For PWA integration:**
- Field names now match PWA expectations
- Less mapping needed when loading .lqaboss files
- Future type changes will be documented in shared.ts

## Future Recommendations

1. **Type drift monitoring** - Review types during code reviews when PWA changes
2. **Automated checks** - Consider adding a script to compare types with PWA
3. **Shared package** - If API surface grows significantly, consider shared types package

## Related Files

- `TYPE_SHARING_ANALYSIS.md` - Detailed analysis of type overlap
- `src/types/shared.ts` - Consolidated type definitions
- `lqa-boss/src/types/index.ts` - PWA type definitions (sibling repo)
