# LQA Boss Capture

A Chrome extension for capturing web pages with screenshots for Language Quality Assurance (LQA) review. Works seamlessly with [LQA Boss](https://github.com/l10nmonster/lqa-boss).

## What It Does

LQA Boss Capture helps you review translated websites by:
- Taking full-page screenshots of localized web pages
- Detecting translation segments using [Invisicode](https://github.com/nicodealmern/invisicode) markers (such as those injected by [L10n Monster](https://github.com/nicodealmern/l10nmonster))
- Highlighting segments with X-Ray Vision
- Bundling everything into a review package for LQA Boss

---

## Installation

### From GitHub Releases (Recommended)

1. Go to the [Releases page](https://github.com/l10nmonster/lqa-boss-capture/releases)
2. Download the latest `.zip` file
3. Unzip the file to a folder on your computer
4. Open Chrome and go to `chrome://extensions/`
5. Enable **Developer mode** (toggle in top right)
6. Click **Load unpacked**
7. Select the unzipped folder
8. Pin the extension by clicking the puzzle icon in Chrome toolbar and clicking the pin next to "LQA Boss Capture"

### From Source (For Development)

1. Clone this repository
2. Run `npm install && npm run build`
3. Open Chrome and go to `chrome://extensions/`
4. Enable **Developer mode**
5. Click **Load unpacked**
6. Select the `dist/` folder

---

## Quick Start

### 1. Configure the Extension

Before capturing, you need to configure the extension:

1. Click the LQA Boss icon to open the side panel
2. Set your **Source Language** and **Target Language** at the top of the panel
3. Click the gear icon to open Settings
4. Enter your **TM Lookup URL** (required) - the API endpoint for fetching translation data
5. Close settings

### 2. Capture Pages

1. Navigate to a page you want to review
2. Open the LQA Boss side panel
3. Click **Capture Page**
4. The page screenshot and translation data will be added to your cart
5. Repeat for additional pages

### 3. Review with X-Ray Vision

- The **X-Ray** checkbox enables/disables the segment overlay
- Hover over highlighted segments to see translation metadata
- Click a segment to copy its GUID
- Use **Alt+X** to quickly toggle X-Ray on/off

### 4. Send to LQA Boss

When you've captured all the pages you need:

1. Optionally enter a **Job Name** and **Instructions**
2. Click **Send to LQA Boss** to open the review in the LQA Boss app
3. Or click **Download .lqaboss file** to save locally

---

## Features

### Full-Page Screenshots
Captures the entire page, including content below the fold. Works with mobile device emulation in Chrome DevTools.

### X-Ray Vision
Visual overlay that highlights detected translation segments on the page. Color coding:
- **Gray dashed**: Segment detected, not yet matched
- **Green**: Segment matched in Translation Memory
- **Red**: Segment not found in Translation Memory

### Preview Screenshots
Hover over the eye icon next to any captured page in the cart to preview its screenshot.

### Translation Memory Integration
Connects to your TM service to fetch source text, translations, and quality scores for each segment.

### URL Rewrite Rules
Advanced feature for modifying URLs during navigation. Useful when Invisicode injection requires a special locale suffix in the URL (e.g., adding `-x-invis` to the locale code).

---

## Keyboard Shortcuts

| Shortcut (Windows/Linux) | Shortcut (Mac) | Action |
|--------------------------|----------------|--------|
| **Alt+A** | **Option+A** | Open/close the side panel |
| **Alt+X** | **Option+X** | Toggle X-Ray Vision on/off |

You can customize these shortcuts at `chrome://extensions/shortcuts`.

---

## Settings

### Main Panel

| Setting | Description |
|---------|-------------|
| **Source Language** | Source language code (e.g., `en`) |
| **Target Language** | Target language code (e.g., `es`, `fr`, `de`) |
| **Job Name** | Optional name for the output file |
| **Instructions** | Optional instructions included in the review package |

### Settings Modal (gear icon)

| Setting | Description |
|---------|-------------|
| **LQA Boss URL** | URL of your LQA Boss application |
| **TM Lookup URL** | API endpoint for Translation Memory lookups (required for capture) |
| **Quality Model** | Optional JSON file defining quality scoring rules |
| **URL Rewrite Rules** | Rules for adding locale suffixes to URLs for Invisicode injection |

---

## Troubleshooting

### "No segments detected on this page"
- The page must have Invisicode markers injected (e.g., via L10n Monster Invisicode provider)
- If using URL-based Invisicode injection, configure URL Rewrite Rules to add the required locale suffix
- Try refreshing the page

### Capture button is disabled
- Make sure TM Lookup URL is configured in settings
- At least one segment must be detected on the page

### X-Ray not showing segments
- Check that the X-Ray checkbox is enabled
- Try toggling it off and on to re-extract segments
- Some page elements (iframes, canvas) may not be detected

### Screenshots look wrong
- For mobile views, use Chrome DevTools device emulation
- Ensure the page is fully loaded before capturing
- Try scrolling to the top of the page first

### "No TUs matched" error
- Check your TM Lookup URL is correct
- Verify your source/target language settings
- The TM service may not have entries for this content

---

## File Format

Captured flows are saved as `.lqaboss` ZIP files containing:

```
my-review.lqaboss
├── page_1_xxx.png          # Screenshot images
├── page_2_xxx.png
├── flow_metadata.json      # Page and segment data
└── job.json                # Translation Memory entries
```

---

## Privacy & Permissions

This extension requires the following permissions:

| Permission | Why It's Needed |
|------------|-----------------|
| **Active Tab** | To capture screenshots and extract text from the current page |
| **Scripting** | To inject the X-Ray overlay and text extraction scripts |
| **Storage** | To save your settings and captured pages |
| **Debugger** | To capture full-page screenshots (you'll see a "Debugger attached" banner during capture) |

**Your data stays local.** Screenshots and translation data are only sent to the LQA Boss app or downloaded to your computer.

---

---

# Developer Guide

The following sections are for developers who want to contribute to or customize the extension.

## Technology Stack

- **TypeScript** with strict mode
- **esbuild** for fast bundling
- **Chrome Extension Manifest V3**
- **Jest** for testing
- **ESLint** for linting

## Development Setup

### Prerequisites

- Chrome 114+ (for Side Panel API)
- Node.js 18+

### Getting Started

```bash
# Clone the repository
git clone https://github.com/l10nmonster/lqa-boss-capture.git
cd lqa-boss-capture

# Install dependencies
npm install

# Build the extension
npm run build

# Or build with source maps for debugging
npm run build:dev
```

### Load in Chrome

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/` folder (not the root folder)

### Development Commands

```bash
npm run build        # Production build
npm run build:dev    # Development build with source maps
npm run package      # Build and create ZIP for distribution
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
npm run lint         # Run ESLint
npm run clean        # Clean build artifacts
```

## Project Structure

```
lqa-boss-capture/
├── src/
│   ├── background/
│   │   └── service-worker.ts    # Background orchestration
│   ├── content/
│   │   ├── extractor.ts         # Text/metadata extraction
│   │   └── xray-overlay.ts      # X-Ray Vision overlay
│   ├── sidepanel/
│   │   ├── cart.ts              # Cart management
│   │   ├── settings.ts          # Settings management
│   │   └── urlRewrite.ts        # URL rewrite rules
│   ├── lib/
│   │   └── fe00-decoder.ts      # Unicode metadata decoder
│   └── types/
│       └── shared.ts            # Shared TypeScript types
├── sidepanel/
│   ├── index.html               # Side panel UI
│   └── styles.css               # Styles
├── dist/                        # Built extension (load this in Chrome)
├── manifest.json                # Extension manifest
└── esbuild.config.js            # Build configuration
```

## Architecture

### Background Service Worker
Orchestrates the capture process, handles the Chrome Debugger API for screenshots, creates ZIP files, and manages communication with the PWA.

### Content Scripts
- **extractor.ts**: Scans the page for text elements with FE00-encoded metadata, calculates bounding boxes
- **xray-overlay.ts**: Creates the visual overlay showing detected segments

### Side Panel
The main UI for the extension. Manages the cart of captured pages, settings, and actions.

## PWA Integration

The extension communicates with LQA Boss PWA via Chrome Extension Messaging API.

### Configuration

**Extension** (`manifest.json`):
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

**PWA** (`ChromeExtensionPlugin.ts`):
```typescript
const EXTENSION_ID = 'your-extension-id-here';
```

### Message Flow

1. User clicks "Send to LQA Boss"
2. Extension creates ZIP and stores temporarily
3. Extension opens PWA with `?plugin=extension` parameter
4. PWA sends `requestFlow` message to extension
5. Extension responds with ZIP data
6. PWA loads the flow

## Debugging

### Background Script
`chrome://extensions/` → Click "Service Worker" link

### Side Panel
Right-click in side panel → "Inspect"

### Content Scripts
Open DevTools on the target page → Console tab

## Releases

This project uses [semantic-release](https://semantic-release.gitbook.io/) for automated versioning.

**Commit message format:**
```
feat: Add new feature        → Minor version bump (1.2.0 → 1.3.0)
fix: Fix a bug               → Patch version bump (1.2.0 → 1.2.1)
BREAKING CHANGE: ...         → Major version bump (1.2.0 → 2.0.0)
```

Releases are automated via GitHub Actions on push to `main`.

---

## Contributing

Contributions are welcome! Please:

1. Use conventional commit messages
2. Run `npm test && npm run lint` before submitting
3. Update documentation as needed

## Support

- [GitHub Issues](https://github.com/l10nmonster/lqa-boss-capture/issues)
- [LQA Boss Documentation](https://github.com/l10nmonster/lqa-boss)

## License

Part of the [L10n Monster](https://github.com/l10nmonster/l10nmonster) project.
