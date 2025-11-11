# Type Sharing Analysis: lqa-boss-capture ↔ lqa-boss

## Overview

This document analyzes type definitions that are duplicated or could be shared between the Chrome extension (`lqa-boss-capture`) and the PWA (`lqa-boss`).

## Current Type Overlap

### 1. `Segment` Interface

**PWA (`lqa-boss/src/types/index.ts:1-8`):**
```typescript
export interface Segment {
  x: number
  y: number
  width: number
  height: number
  text: string
  [key: string]: any
}
```

**Extension (multiple files):**
```typescript
interface Segment {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  g?: string;           // Additional: GUID from metadata
  sid?: string;         // Additional: String ID from metadata
  matched?: boolean;    // Additional: TM match status
  [key: string]: any;
}
```

**Analysis:**
- ✅ **Compatible** - Extension version is a superset of PWA version
- The `[key: string]: any` in PWA makes them structurally compatible
- Extension adds metadata fields (`g`, `sid`, `matched`) that PWA can accept
- **Recommendation**: Use PWA version, but document common additional fields

---

### 2. `Page` vs `CapturedPage`

**PWA (`lqa-boss/src/types/index.ts:10-15`):**
```typescript
export interface Page {
  pageId: string
  originalUrl?: string
  imageFile: string
  segments: Segment[]
}
```

**Extension (`src/background/service-worker.ts:43-54`):**
```typescript
interface CapturedPage {
  id: string;              // vs pageId
  url: string;             // vs originalUrl (but required)
  title: string;           // Not in PWA version
  timestamp: string;       // Not in PWA version
  screenshotBase64: string; // vs imageFile (different format)
  segments: Segment[];
}
```

**Analysis:**
- ⚠️ **Different purposes** - Not directly compatible
- `CapturedPage` is internal extension state during capture
- PWA's `Page` represents finalized page data in flow_metadata.json
- Field mapping:
  - `id` → `pageId` (naming difference)
  - `url` → `originalUrl` (naming difference, optionality)
  - `screenshotBase64` → `imageFile` (format difference: base64 vs filename)
  - `title`, `timestamp` are extension-only during capture

**Recommendation**: Keep separate - they serve different purposes in the data pipeline

---

### 3. `TranslationUnit`

**PWA (`lqa-boss/src/types/index.ts:63-81`):**
```typescript
export interface TranslationUnit {
  jobGuid: string
  guid: string
  rid: string
  sid: string
  nsrc: NormalizedItem[]    // Normalized source with placeholders
  ntgt: NormalizedItem[]    // Normalized target with placeholders
  q: number
  ts: number
  reviewedTs?: number
  translationProvider?: string
  notes?: {
    ph?: { [key: string]: PlaceholderDescription }
    desc?: string
  } | string
  qa?: QualityAssessment
  candidates?: NormalizedItem[][]
  candidateSelected?: boolean
}
```

**Extension (`src/background/service-worker.ts:34-41`):**
```typescript
interface TranslationUnit {
  guid: string;
  sid?: string;
  source: string;      // vs nsrc: NormalizedItem[]
  target: string;      // vs ntgt: NormalizedItem[]
  q: number;
  ts: string;          // vs ts: number (type mismatch!)
}
```

**Analysis:**
- ❌ **Incompatible** - Different structures and purposes
- PWA version is comprehensive, for full job management
- Extension version is simplified, from TM lookup service response
- Extension's `source`/`target` are plain strings, PWA uses normalized arrays
- Extension has `ts: string`, PWA has `ts: number` (timestamp format mismatch)

**Recommendation**: Keep separate - these represent different stages of translation data

---

### 4. `JobData`

**PWA (`lqa-boss/src/types/index.ts:83-92`):**
```typescript
export interface JobData {
  jobGuid: string
  updatedAt?: string
  sourceLang: string
  targetLang: string
  tus: TranslationUnit[]
  instructions?: string
  status?: string
  translationProvider?: string
}
```

**Extension:** Not defined (creates job.json structure inline)

**Analysis:**
- Extension creates job.json but doesn't have a typed interface for it
- PWA's `JobData` could be useful for type safety when creating job.json

**Recommendation**: Extension could import/reuse this type

---

### 5. Quality Model Types

**PWA:** Not found in `/src/types/index.ts`

**Extension (`src/sidepanel/settings.ts:5-30`):**
```typescript
interface QualityModelSeverity { id, label, weight }
interface QualityModelSubcategory { id, label, description }
interface QualityModelCategory { id, label, description, subcategories? }
interface QualityModel { id, name, version, severities, errorCategories }
```

**Analysis:**
- These are extension-specific for quality model configuration
- PWA has quality assessment (`QualityAssessment`) but not the model schema
- Extension owns this domain

**Recommendation**: Keep in extension, potentially share if PWA needs them

---

## Recommendations

### Option 1: Shared Types Package (Ideal for Future)

Create a shared types package that both repos can import:

```
@lqaboss/shared-types/
├── package.json
├── src/
│   ├── segment.ts        # Shared Segment interface
│   ├── flow.ts           # Shared flow metadata types
│   ├── translation.ts    # Shared TU types
│   └── index.ts
```

**Pros:**
- Single source of truth
- Ensures consistency
- Easier to maintain

**Cons:**
- Adds complexity (new package to publish/manage)
- Requires build step for both repos
- Overkill for current project size

---

### Option 2: Type Re-export from PWA (Recommended)

Extension imports specific types from the PWA repository:

**In `lqa-boss-capture/tsconfig.json`:**
```json
{
  "compilerOptions": {
    "paths": {
      "@lqaboss/types": ["../lqa-boss/src/types"]
    }
  }
}
```

**In extension code:**
```typescript
import type { Segment, Page, JobData } from '@lqaboss/types';
```

**Pros:**
- PWA is source of truth (makes sense - it's the data consumer)
- No extra packages needed
- Simple path mapping

**Cons:**
- Requires both repos to be cloned side-by-side
- Build dependency on PWA repo structure

---

### Option 3: Copy Types with Documentation (Current - Acceptable)

Keep types duplicated but document which ones should match:

**Add to both repos:**
```typescript
/**
 * SHARED TYPE: Must match lqa-boss/src/types/index.ts:Segment
 *
 * This type is shared between the Chrome extension and PWA.
 * Changes here must be coordinated with the other repository.
 */
export interface Segment {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  [key: string]: any;
}
```

**Pros:**
- Simple, no build dependencies
- Each repo is self-contained
- Works well for small API surface

**Cons:**
- Manual synchronization required
- Risk of drift over time
- Duplication

---

## Immediate Action Items

### 1. Align `Segment` Type (Low Risk)

**Change in extension:** Use PWA's simpler base type, document common extensions

```typescript
// src/types/shared.ts (new file)
/**
 * SHARED TYPE: Matches lqa-boss/src/types/index.ts:Segment
 *
 * Common extensions (not required by PWA):
 * - g: string - GUID from FE00 metadata
 * - sid: string - String ID from FE00 metadata
 * - matched: boolean - TM match status
 */
export interface Segment {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  [key: string]: any;
}
```

Update all files to import from `src/types/shared.ts` instead of defining locally.

### 2. Consider Using PWA's `JobData` (Medium Priority)

**In extension:** When creating job.json, use PWA type for validation

```typescript
import type { JobData } from '@lqaboss/types'; // if using Option 2
// OR
// Define locally with comment: "SHARED TYPE: Matches lqa-boss/src/types"
```

### 3. Document Type Contracts (High Priority)

Create `TYPE_CONTRACT.md` in both repos documenting:
- Which types are shared
- Which types must remain compatible
- How changes should be coordinated

---

## Type Compatibility Matrix

| Type | PWA | Extension | Compatible? | Action |
|------|-----|-----------|-------------|--------|
| `Segment` | ✓ | ✓ (extended) | ✅ Yes | Align to PWA base |
| `Page` | ✓ | `CapturedPage` | ⚠️ Different | Keep separate |
| `TranslationUnit` | ✓ (full) | ✓ (simple) | ❌ No | Keep separate |
| `JobData` | ✓ | - | N/A | Extension could use |
| `FlowData` | ✓ | - | N/A | Extension could use |
| `QualityModel` | - | ✓ | N/A | Extension-only |
| `Settings` | - | ✓ | N/A | Extension-only |

---

## Conclusion

**Recommended Approach:** Start with **Option 3** (documented duplication) and evolve to **Option 2** (path mapping) if the API surface grows.

**Immediate Steps:**
1. Create `src/types/shared.ts` in extension
2. Consolidate duplicate `Segment` definitions
3. Add JSDoc comments marking shared types
4. Document type contract in both repos

**Future Consideration:**
- If the data contract grows significantly, consider shared types package
- Monitor for type drift during code reviews
- Establish process for coordinating breaking changes
