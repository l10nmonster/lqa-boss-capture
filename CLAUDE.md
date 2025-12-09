# CLAUDE.md - Chrome Extension

This file provides guidance for working with the LQA Boss Capture Chrome Extension.

## Common Commands

### Development
```bash
npm install          # Install dependencies
npm run setup        # Install dependencies and copy JSZip
npm run build        # Build extension from TypeScript to dist/
npm run build:dev    # Build with source maps for debugging
npm run package      # Build and create ZIP package
npm run clean        # Clean all build artifacts
npm test             # Run tests with Jest
npm run test:watch   # Run tests in watch mode
npm run lint         # Run ESLint
npm run semantic-release  # Manual semantic release (automated via GitHub Actions)
```

### Building the Extension
The extension is written in TypeScript and must be built before loading in Chrome:

1. **Development Build** (with source maps):
   ```bash
   npm run build:dev
   ```

2. **Production Build** (minified):
   ```bash
   npm run build
   ```

3. **Package for Distribution**:
   ```bash
   npm run package
   ```

The build process:
- Compiles TypeScript files from `src/` to JavaScript in `dist/`
- Bundles each entry point using esbuild
- Copies static assets (icons, HTML, CSS, JSZip)
- Creates a clean `dist/` folder ready to load as unpacked extension

**IMPORTANT**: Always load the `dist/` folder in Chrome, not the root project folder. The `dist/` folder is small (~2MB) compared to the root folder with `node_modules/` (~140MB).

### Semantic Versioning & Releases
This project follows semantic versioning with automated changelog generation:

- **Commit Format**: Use conventional commit format (configured via `.gitmessage` template)
  - `feat:` for new features (minor version bump)
  - `fix:` for bug fixes (patch version bump)
  - `BREAKING CHANGE:` in footer for breaking changes (major version bump)
  - `chore:`, `docs:`, `style:`, `refactor:`, `test:`, `ci:` for other changes (no version bump)

- **Automated Releases**: GitHub Actions workflow handles release and version bumping
  - **Test Job**: Runs lint and Jest tests
  - **Release Job**: Analyzes commits, bumps version in both `package.json` and `manifest.json`, generates changelog, creates GitHub release
  - Custom semantic-release plugin updates `manifest.json` version to match `package.json`
  - Version number is critical for Chrome Web Store submissions

### Testing
- **Unit Tests**: Jest tests in `tests/` directory
- **Linting**: ESLint with ES2022 configuration
- **Coverage**: Configured coverage thresholds (50% minimum)

## Architecture Overview

This is a Manifest V3 Chrome extension for capturing web pages with screenshots and translation metadata. It integrates seamlessly with the LQA Boss PWA via Chrome Extension Messaging API.

### Technology Stack

- **TypeScript**: Strict type-safe development (compiled to ES2022 JavaScript)
- **esbuild**: Fast TypeScript bundler and minifier
- **Chrome Extension APIs**: Manifest V3
- **JSZip**: For creating .lqaboss ZIP files
- **Chrome Debugger API**: For full-page screenshot capture
- **Chrome Extension Messaging API**: For PWA communication
- **Jest**: Testing framework
- **ESLint**: Code linting

### Core Components

**Source Code** (`src/` - TypeScript):

1. **Background Service Worker** (`src/background/service-worker.ts`)
   - Orchestrates capture process
   - Handles screenshot capture via Chrome Debugger API
   - Creates ZIP files with JSZip
   - Manages PWA communication via `chrome.runtime.onMessageExternal`
   - Stores pending flows temporarily in memory (5-minute expiration)

2. **Content Scripts**
   - `src/content/extractor.ts`: Extracts text segments with FE00-encoded metadata
   - `src/content/xray-overlay.ts`: X-Ray Vision overlay showing detected segments with click-to-inspect modal

3. **Side Panel** (`src/sidepanel/`)
   - `index.html`: Cart UI
   - `cart.ts`: Cart management and capture orchestration
   - `settings.ts`: Settings persistence (TM endpoint, languages)
   - `urlRewrite.ts`: URL rewrite rule management
   - `styles.css`: Pure CSS styling (no Tailwind)

4. **Utilities** (`src/lib/`)
   - `fe00-decoder.ts`: Unicode metadata decoder for LQA markers

**Build Output** (`dist/` - JavaScript):
- Compiled and bundled JavaScript from TypeScript sources
- Static assets (icons, HTML, CSS)
- `jszip.min.js`: External library for ZIP file generation
- `manifest.json`: Extension manifest (copied from root)

## PWA Integration Architecture

### Communication Method: Chrome Extension Messaging API

**Why this approach:**
- Cross-origin communication between `chrome-extension://` and `https://` origins
- No same-origin requirements (unlike IndexedDB/BroadcastChannel)
- Secure with `externally_connectable` restrictions
- Bidirectional messaging support

### Configuration Requirements

1. **Extension Side** (`manifest.json`):
   ```json
   {
     "externally_connectable": {
       "matches": [
         "http://localhost:*/*",
         "https://lqaboss.l10n.monster/*"
       ]
     }
   }
   ```

2. **PWA Side** (`src/plugins/ChromeExtensionPlugin.ts:14`):
   ```typescript
   const EXTENSION_ID = 'kikdgalghgdmaabcjbbkdbjchmnonlhb'
   ```
   - Update with actual extension ID from `chrome://extensions`
   - ID changes when extension is reloaded in development
   - ID is stable for published extensions

### Message Protocol

**Messages FROM PWA (External Messages)**:

1. `ping`: Health check to verify extension is installed
   ```javascript
   Request: { action: 'ping' }
   Response: { success: true }
   ```

2. `requestFlow`: Request pending flow data
   ```javascript
   Request: { action: 'requestFlow' }
   Response: {
     success: true,
     data: { zipData: [1,2,3,...], fileName: 'flow.lqaboss' }
   }
   // OR
   Response: { success: false, error: 'No flow available' }
   ```

**Messages TO PWA** (via opening PWA with URL):
- Extension opens: `https://pwa-url/?plugin=extension`
- PWA detects parameter and sends `requestFlow` message back

### Flow Storage

**Temporary In-Memory Storage**:
- Flows stored in `pendingFlow` variable in service worker
- Automatically expires after 5 minutes
- Cleared after successful retrieval
- No persistence to storage APIs

**Why temporary:**
- Simple implementation
- No storage quota concerns
- Encourages immediate transfer to PWA
- Security: data not left in storage

### PWA Launch Behavior

**Production URL (https://lqaboss.l10n.monster)**:
- Extension opens URL in a new browser tab
- Chrome recognizes the URL belongs to the installed PWA
- Shows "Open in app" button in address bar
- User clicks button to open in PWA window
- Extension shows message: "Click 'Open in app' button..."

**Note**: Chrome Extensions cannot directly launch installed PWAs. The browser tab → PWA transition is a one-click user action.

**Localhost Development**:
- Opens directly in browser tab
- No PWA detection (localhost not in scope)
- Works normally for testing

## Development Workflow

### Setup

1. **Install dependencies and build**:
   ```bash
   npm install
   npm run build
   ```

2. **Load in Chrome**:
   - Navigate to `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the **`dist/`** directory (NOT the root directory)
   - Note the Extension ID

3. **Configure PWA** (in the lqa-boss repository):
   - Copy Extension ID
   - Update `src/plugins/ChromeExtensionPlugin.ts:14` in the lqa-boss repository
   - Rebuild PWA: `npm run build`

**Development Workflow**:
- Edit TypeScript files in `src/`
- Run `npm run build:dev` to rebuild
- Click "Reload" button in `chrome://extensions` to reload the extension
- Test your changes

### Testing Communication

**Test Extension → PWA:**
1. Open extension side panel
2. Capture some pages
3. Click "Send to LQA Boss"
4. PWA should open and load the flow automatically

**Test PWA → Extension:**
1. Open PWA in Chrome
2. File menu → "New From Extension"
3. Should load pending flow (if available within 5 minutes)

### Debugging

**Background Service Worker:**
- `chrome://extensions` → Click "Service Worker" link
- Opens DevTools for background script
- Console shows all background logs

**Side Panel:**
- Open side panel → Right-click → "Inspect"
- Full DevTools for side panel

**Content Scripts:**
- Regular page DevTools shows content script logs
- Check Console tab

**PWA Communication:**
- Open PWA DevTools → Console
- Look for "Requesting flow from Chrome extension..." messages
- Check Network tab for extension ID errors

## Key Files to Modify

### Adding New Features

**New capture metadata:**
- Edit `src/content/extractor.ts` → `extractTextElements()` function
- Update interfaces in `src/background/service-worker.ts`
- Update `flow_metadata.json` structure in `src/background/service-worker.ts` → `createFlowZIP()`

**New PWA messages:**
- Add message types to `RuntimeMessage` interface in `src/background/service-worker.ts`
- Add handler in `src/background/service-worker.ts` → `chrome.runtime.onMessageExternal.addListener()`
- Update PWA's `ChromeExtensionPlugin.ts` to send new message

**New settings:**
- Add fields to `Settings` interface in `src/sidepanel/settings.ts`
- Add UI in `sidepanel/index.html`
- Add persistence in `src/sidepanel/settings.ts`
- Access via `settingsManager.getSettings()` in other files

### Common Modifications

**Change PWA URL detection:**
- Edit `src/sidepanel/cart.ts` (pwaUrl determination)

**Adjust flow expiration time:**
- Edit `src/background/service-worker.ts` (currently 5 minutes)

**Add new external message handlers:**
- Edit `src/background/service-worker.ts` (onMessageExternal listener)

**After making changes:**
```bash
npm run build      # Rebuild the extension
# Then reload in chrome://extensions
```

## File Format Specification

### .lqaboss ZIP Structure

```
lqa-flow-YYYY-MM-DDTHH-MM-SS.lqaboss
├── page_1_<id>.png           # Screenshot (PNG format)
├── page_2_<id>.png
├── flow_metadata.json         # Required: Flow and segment metadata
└── job.json                   # Optional: TM entries (if TM endpoint configured)
```

### flow_metadata.json Schema

```json
{
  "createdAt": "ISO8601 timestamp",
  "pages": [
    {
      "pageId": "string",
      "originalUrl": "string",
      "title": "string",
      "timestamp": "ISO8601 timestamp",
      "imageFile": "string (filename)",
      "segments": [
        {
          "text": "string (displayed text)",
          "x": "number (pixels from left)",
          "y": "number (pixels from top)",
          "width": "number (pixels)",
          "height": "number (pixels)",
          "g": "string (GUID from metadata)",
          "sid": "string (optional string ID)",
          "matched": "boolean (true if TM match found)"
        }
      ]
    }
  ]
}
```

### job.json Schema (Optional)

```json
{
  "sourceLang": "string (e.g., 'en')",
  "targetLang": "string (e.g., 'es')",
  "instructions": "string (optional instructions for the translation job)",
  "tus": [
    {
      "guid": "string",
      "sid": "string (optional)",
      "source": "string (source text)",
      "target": "string (translated text)",
      "q": "number (quality score 0-100)",
      "ts": "ISO8601 timestamp"
    }
  ]
}
```

## X-Ray Vision Overlay

### Segment Interaction

When X-Ray Vision is enabled, segments are highlighted on the page with color-coded borders:
- **Gray (dashed)**: Segment not yet looked up (before capture)
- **Green (dashed)**: Segment matched in TM lookup
- **Red (dashed)**: Segment not matched in TM lookup

**Click on a segment** to open a modal with two sections:

1. **Invisicode Metadata**: Shows decoded FE00 metadata (GUID, SID, etc.)
2. **TM Lookup**: Shows translation data (source, target, quality, timestamp, provider, notes)

If no TM data is available, a **Lookup** button allows fetching TM data for that specific segment. On successful lookup, the segment turns green.

### Segment Data Flow

1. `extractor.ts` extracts segments with FE00-decoded metadata
2. Segments are passed to `xray-overlay.ts` for rendering
3. After capture, `matchedTUs` from TM lookup are also passed
4. The overlay stores TUs in a `Map<guid, TranslationUnit>` for modal display
5. Clicking Lookup sends `lookup-single-segment` message to service worker

## Translation Memory Integration

### TM Endpoint Configuration

**Main Panel** (`sidepanel/index.html:24-45`):
- Source Language
- Target Language

**Settings Modal** (`sidepanel/index.html:148-155`):
- TM Lookup URL

**Request Format** (POST to TM endpoint):
```json
{
  "sourceLang": "en",
  "targetLang": "es",
  "segments": [
    {
      "g": "guid-from-metadata",
      "sid": "string-id-if-available"
      // ... other decoded metadata fields
    }
  ]
}
```

**Expected Response**:
```json
{
  "results": [
    {
      "rid": "path/to/resource.json",
      "sid": "footer.copyright",
      "guid": "6_Q1fFZPe-wAgsjCy54e47rdFEXdpfaNetaeYkh_Tmw",
      "nsrc": [
        "© ",
        { "t": "x", "v": "{{year}}", "s": "2025" },
        " ",
        { "t": "x", "v": "{{companyName}}", "s": "Commerce Portal" },
        ". All rights reserved."
      ],
      "ntgt": [
        "© ",
        { "t": "x", "v": "{{year}}", "s": "2025" },
        " ",
        { "t": "x", "v": "{{companyName}}", "s": "Commerce Portal" },
        ". Todos los derechos reservados."
      ],
      "translationProvider": "firstParty_gemini",
      "ts": 1764086761531,
      "q": 70,
      "notes": {
        "ph": {
          "{{companyName}}": { "sample": "Commerce Portal", "desc": "The name of the company" },
          "{{year}}": { "sample": "2025", "desc": "The current year" }
        },
        "desc": "Copyright text for the footer"
      }
    }
  ],
  "warnings": [
    "Optional warning messages"
  ]
}
```

**Response Fields**:
- `rid`: Resource ID (file path)
- `sid`: String ID within the resource
- `guid`: Unique identifier for the translation unit
- `nsrc`: Normalized source - array of strings and placeholder objects
- `ntgt`: Normalized target - array of strings and placeholder objects
- `translationProvider`: Provider that created the translation
- `ts`: Timestamp (Unix milliseconds)
- `q`: Quality score (0-100)
- `notes`: Object with `ph` (placeholder descriptions) and `desc` (segment description)

**Placeholder Object Format** (in nsrc/ntgt):
```json
{
  "t": "x",           // Type: "x" (standalone), "bx" (begin tag), "ex" (end tag)
  "v": "{{year}}",    // Placeholder code (always displayed in UI)
  "s": "2025",        // Sample value
  "v1": "a_x_year"    // Optional alternate identifier
}
```

### TM Fetch Process

1. **Metadata Extraction** (`src/content/extractor.ts`):
   - Detects FE00-encoded Unicode markers
   - Decodes metadata (GUID, string ID, etc.)
   - Returns array of segments with coordinates
   - Note: `matched` field is stripped from decoded metadata to prevent false positives

2. **TM Lookup** (`src/background/service-worker.ts`):
   - Sends POST request with decoded metadata
   - Matches returned TUs to segments by GUID
   - Marks segments as `matched: true/false`
   - Collects unique TUs for `job.json`

3. **ZIP Creation** (`src/background/service-worker.ts`):
   - Screenshots saved as PNG files
   - `flow_metadata.json` includes all segments with match status
   - `job.json` includes unique TUs (if any matched)

### Single-Segment Lookup

The X-Ray overlay modal has a "Lookup" button for individual segment TM lookup:

**Message**: `lookup-single-segment`
```javascript
// Request (from xray-overlay.ts)
chrome.runtime.sendMessage({
  action: 'lookup-single-segment',
  segment: { g: 'guid-here', sid: 'string-id', ... }
});

// Response
{ success: true, tu: { ... TranslationUnit ... } }
// OR
{ success: false, error: 'No TM match found' }
```

**Handler** (`src/background/service-worker.ts`):
- Reuses `fetchTUsForSegments()` with single-segment array
- Returns matching TU or error message
- Requires TM endpoint to be configured in settings

## Common Issues & Solutions

### Extension ID Changes

**Problem**: Extension ID changes after reloading unpacked extension

**Solution**:
- Copy new ID from `chrome://extensions`
- Update `src/plugins/ChromeExtensionPlugin.ts:14`
- Rebuild PWA

### "No flow available" Error

**Problem**: PWA can't retrieve flow from extension

**Causes**:
1. No flow has been sent from extension
2. Flow expired (> 5 minutes old)
3. Extension ID mismatch

**Solution**:
- Send flow from extension again
- Check extension ID matches
- Reduce time between send and retrieve

### PWA Menu Item Grayed Out

**Problem**: "New From Extension" menu item is disabled

**Causes**:
1. Extension not installed
2. Extension ID incorrect
3. `externally_connectable` not configured
4. Using non-Chrome browser

**Solution**:
- Verify extension is loaded at `chrome://extensions`
- Check extension ID in ChromeExtensionPlugin.ts
- Verify manifest.json has PWA origin in matches array
- Use Chrome or Edge browser

### X-Ray Vision Not Working

**Problem**: X-Ray overlay doesn't show segments

**Causes**:
1. Page has no FE00-encoded metadata
2. Content script injection failed
3. Page CSP blocks scripts

**Solution**:
- Verify page has LQA metadata markers
- Check browser console for errors
- Try refreshing page after opening side panel

## Best Practices

### When Adding Features

1. **Test both communication directions**:
   - Extension → PWA (Send to LQA Boss)
   - PWA → Extension (New From Extension)

2. **Handle errors gracefully**:
   - User-friendly error messages
   - Don't crash on missing data
   - Validate before sending to PWA

3. **Update both sides**:
   - Extension code
   - PWA ChromeExtensionPlugin
   - Both CLAUDE.md files
   - README.md files

4. **Always rebuild after changes**:
   ```bash
   npm run build:dev  # Development build with source maps
   ```

### Code Style

- Use **TypeScript** with strict mode
- Add proper type annotations to all functions
- Create interfaces for complex data structures
- Use Chrome extension types from `@types/chrome`
- Comment complex logic
- Use async/await for Chrome APIs
- Handle promise rejections
- Log useful debug info to console
- Use ES2022 features (modern JavaScript)

### TypeScript Guidelines

- **Prefer interfaces over types** for object shapes
- **Export interfaces** that are used across multiple files
- **Avoid `any`** - use proper types or `unknown` if necessary
- **Use union types** for string literals (e.g., `'info' | 'error' | 'success'`)
- **Type DOM elements** explicitly (e.g., `as HTMLInputElement`)
- **Use optional properties** (`?`) instead of `| undefined` where appropriate

### Security Considerations

- Only allow trusted origins in `externally_connectable`
- Validate all incoming messages
- Don't store sensitive data
- Clear temporary data after use
- Use Chrome's permission model correctly

## Related Files

**In lqa-boss PWA repository** (separate repository):
- `src/plugins/ChromeExtensionPlugin.ts`: PWA side of integration
- `src/plugins/types.ts`: Plugin interface definitions
- `src/components/headers/UnifiedHeader.tsx`: Menu integration

**Documentation**:
- `README.md`: User-facing documentation for this extension
- lqa-boss repository `CLAUDE.md`: PWA architecture documentation
- lqa-boss repository `V2_REFACTOR_SUMMARY.md`: Plugin system refactor notes
