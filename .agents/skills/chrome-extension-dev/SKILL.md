---
name: chrome-extension-dev
description: Skill for developing Chrome extensions with Manifest V3, including service workers, content scripts, popup UI, and Chrome APIs (downloads, storage, scripting, tabs).
---

# Chrome Extension Development (Manifest V3)

## Architecture

This project follows the Chrome Extension Manifest V3 architecture:

- **Service Worker** (`background.js`): Runs in the background, handles downloads and inter-component messaging. No DOM access.
- **Content Script** (`content.js`): Injected into web pages (sri.gob.ec). Has DOM access to the host page but limited Chrome API access.
- **Popup** (`popup.html`, `popup.js`, `popup.css`): The extension's UI. Runs in its own context.
- **Modules** (`icons.js`, `utils.js`, `excel_export.js`): ES Modules imported by the popup.

## Key Patterns

### Messaging

Communication between components uses `chrome.runtime.sendMessage()` and `chrome.tabs.sendMessage()`:

```
popup.js  --sendMessage-->  content.js   (extractInvoices, downloadSingleXML)
content.js --sendMessage-->  background.js (downloadFile, expectDownload)
background.js --onMessage-->  handles downloads
```

### Content Script Injection

Two strategies are used for robustness:

1. **Pre-injected**: Via `content_scripts` in `manifest.json` (loads on every sri.gob.ec page).
2. **Fallback injection**: Via `chrome.scripting.executeScript()` from `popup.js` if messaging fails.

### Download Queue

Downloads use a queue-based approach (`filenameQueue` Map in `background.js`):

1. Content script sends `expectDownload` with desired filename.
2. Background enqueues filename with key "pending".
3. `onDeterminingFilename` listener consumes the entry and assigns the custom name.

### Icon System

All icons are SVG strings stored in `icons.js` ICONS object. They are injected into the DOM via `data-icon` attributes by `injectIcons()`.

## Permissions

Only request the minimum necessary permissions:

- `activeTab` - Access to the current tab
- `downloads` - File download management
- `storage` - Persist user settings
- `scripting` - Fallback content script injection
- `host_permissions`: Only `*://*.sri.gob.ec/*`

## Important Constraints

- Content scripts cannot use ES Module imports at runtime (they run in the page context).
- Service workers have no DOM access.
- `chrome.downloads.onDeterminingFilename` is the only way to rename downloads after they start.
- The popup closes when the user clicks away, so long operations must be delegated to content scripts or background.
