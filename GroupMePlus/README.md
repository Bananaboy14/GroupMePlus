# GroupMe Ultimate Extension

The ultimate all-in-one GroupMe extension that combines font customization, message caching, and message counting features.

## Features

### 🎨 Font Picker
- Choose from a variety of font categories (Sans-Serif, Monospace, Display, Retro, Handwritten, Fantasy)
- Live preview fonts as you hover
- Save your favorite fonts
- Search through available fonts
- Persistent font selection across sessions

### 📦 Message Caching
- Automatically caches all GroupMe messages to IndexedDB
- Supports both group messages and direct messages
- Compressed storage using LZ-String
- Export cached messages to CSV format
- Check cache status and message counts

### 📊 Message Counter
- Real-time message counting for the current group
- Visual counter display in top-right corner
- Automatic group detection from URLs
- Debug functions for troubleshooting
- Persistent counter across page refreshes

## Installation

1. Clone or download this extension
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the `GroupMeUltimate` folder
5. Navigate to [GroupMe Web](https://web.groupme.com) and enjoy!

## Usage

### Font Picker
- Look for the font button (T icon) in the GroupMe tray
- Click to open the font picker panel
- Search, preview, and select fonts
- Star your favorites for quick access
- Use the trash icon to reset to default font

### Message Caching
- Automatic - messages are cached as you browse
- Use the "📦 Check Cache" button to see cache status
- Use the "⬇️ Export CSV" button to download your messages

### Message Counter
- Automatic - displays in the top-right corner when in a group
- Shows current group ID, message count, and timestamp
- Debug with browser console functions:
  - `debugGroupCounter()` - Show current status
  - `setGroupId(id)` - Manually set group ID
  - `resetCounter()` - Reset message count

## Technical Details

- **Manifest Version**: 3
- **Permissions**: storage
- **Host Permissions**: GroupMe Web, GroupMe API, Google Fonts
- **Storage**: Uses Chrome storage API and IndexedDB
- **Compression**: Messages are compressed using LZ-String

## Files

- `manifest.json` - Extension configuration
- `groupme-ultimate.js` - Main content script
- `page-inject.js` - Page context script for API interception
- `lz-string.min.js` - Compression library
- Icons and assets

## Version History

- **v2.0** - Combined all features into one ultimate extension
- **v1.x** - Individual extensions (GroupMe Fonts, MessageCacher, MessageCounter)

## Support

If you encounter any issues, check the browser console for error messages and debugging information.
