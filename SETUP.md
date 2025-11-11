# Setup Guide

Quick setup instructions for the LQA Boss Chrome Extension.

## Step 1: Install Dependencies

```bash
cd chrome-extension
npm run setup
```

This will:
- Install JSZip from npm
- Copy `jszip.min.js` to the `lib/` folder

## Step 2: Create Icons

The extension requires icons in the following sizes:
- 16x16 px
- 32x32 px
- 48x48 px
- 128x128 px

### Option A: Create Your Own Icons

Place PNG files in the `icons/` folder:
```
icons/
├── icon16.png
├── icon32.png
├── icon48.png
└── icon128.png
```

### Option B: Use Placeholder Script

You can create simple placeholder icons using ImageMagick (if installed):

```bash
# Install ImageMagick first (macOS)
brew install imagemagick

# Run this script
cd icons
convert -size 128x128 xc:#7c3aed -gravity center -pointsize 64 -fill white -annotate +0+0 'LQA' icon128.png
convert icon128.png -resize 48x48 icon48.png
convert icon128.png -resize 32x32 icon32.png
convert icon128.png -resize 16x16 icon16.png
```

### Option C: Use Online Tool

Use an online icon generator like:
- https://realfavicongenerator.net/
- https://www.favicon-generator.org/

Upload a square image and download all sizes.

## Step 3: Load Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `chrome-extension` folder
5. Extension should appear in your extensions list

## Step 4: Pin Extension

1. Click the puzzle icon (🧩) in Chrome toolbar
2. Find "LQA Boss Capture"
3. Click the pin icon to keep it visible in toolbar

## Step 5: Configure Settings (Optional)

1. Click the LQA Boss icon to open side panel
2. Click settings (⚙️) icon
3. Configure:
   - TM Endpoint URL (if you have a TM service)
   - TM API Key (if required)
   - Source/Target languages
   - PWA URL (where flows should open)
4. Click "Save Settings"

## Verification

Test the extension:

1. Navigate to a page with LQA metadata
2. Open LQA Boss side panel
3. Click "📸 Capture Page"
4. Should see page added to cart
5. Try "X-Ray Vision" toggle to see segments
6. Click "🚀 Send to PWA" or "💾 Download ZIP"

## Troubleshooting

### "Service worker registration failed"
- Check browser console for errors
- Ensure all files are in correct locations
- Try removing and re-loading extension

### "Failed to fetch JSZip"
- Make sure you ran `npm run setup`
- Verify `lib/jszip.min.js` exists
- Check file permissions

### "Debugger attach failed"
- Ensure you're not already debugging the tab
- Close DevTools on the target page
- Try refreshing the page

### "No segments found"
- Page may not have LQA metadata markers
- Check original page source for Unicode markers (U+200B, U+200C, U+FE00-FE0F)
- Verify page is using L10n Monster for localization

## Development Mode

For development with auto-reload:

1. Install extension reloader:
   - [Extensions Reloader](https://chrome.google.com/webstore/detail/extensions-reloader/fimgfedafeadlieiabdeeaodndnlbhid)

2. Make changes to code

3. Click reload icon in Extensions Reloader

## Next Steps

- Read the full [README.md](./README.md) for detailed documentation
- Configure your PWA to receive flows
- Set up TM endpoint integration
- Customize settings for your workflow

## Questions?

Check the main L10n Monster documentation or review the `helpers-lqaboss` package for reference implementation.
