![Tab Saver Logo](/icons/icon128.png)

# Tab Saver

Save tabs you want to come back to, keep them in groups, and find any of them in a second, even with thousands saved.

## How it works

Click the Tab Saver icon and it opens in Chrome's **side panel**, which stays open while you browse. Click a saved tab and it opens next to you while your list stays where it was. When you're finished with it, mark it **Done** so it leaves your list (it stays searchable in Done).

Need more room? The expand button opens the same app in a full tab.

## Features

- **Save quickly**: the "Save to ..." button in the side panel, `Alt+Shift+S` on any page, or right-click any page or link and choose **Save to Tab Saver** (pick the group right there). Saved links get their real title, for example the YouTube video name.
- **Save open tabs**: save every tab in the window into a new or existing group, and optionally close them.
- **Find anything**: instant search over titles and links, with matches highlighted. Searching also tells you about matches in Done.
- **Groups**: create, rename, recolor, reorder (drag in the sidebar) and delete groups. Drag saved tabs onto a group to move them. "Open all" reopens a group as a Chrome tab group.
- **Group the list your way**: by group, by date saved (Today, Last 7 days, then by month), or by website.
- **Done instead of clutter**: press `E` or click the check mark when you've finished with something. Optionally move tabs to Done automatically when you open them (Settings).
- **No duplicates**: saving a page you already have moves it instead of adding a copy. YouTube links count as the same video however they were shared.
- **Private groups**: hide a group's titles and keep it out of "All saved".
- **Sessions** (optional): when Chrome restarts, the tabs you had open last time are filed under Sessions.
- **Undo** for every change (`Ctrl+Z` or the Undo button), **keyboard control** for everything, dark mode, and backup export/import (including backups from older versions).
- **Fast at any size**: only the rows on screen are drawn, favicons come from Chrome's own cache, and all windows stay in sync.

## Keyboard

| Key | Action |
| --- | --- |
| `Alt+Shift+S` | Save the current tab (anywhere in Chrome) |
| `Alt+Shift+L` | Open Tab Saver (anywhere in Chrome) |
| `/` or `Ctrl+K` | Search |
| `↑` `↓` | Move through the list |
| `Enter` / `Ctrl+Enter` | Open / open in a background tab |
| `E` | Done with it (or restore) |
| `X`, `Shift+X`, `Ctrl+A` | Select, select a range, select all |
| `M` / `R` / `C` / `Delete` | Move / rename / copy link / delete |
| `Ctrl+Z` | Undo |
| `?` | Show all shortcuts |

Change the global shortcuts at `chrome://extensions/shortcuts`.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder. (Already installed? Click the reload icon on the Tab Saver card instead.)
3. Pin Tab Saver to the toolbar and click it.

Requires Chrome 116 or newer.

## Upgrading from version 3

Your saved tabs and categories are converted automatically the first time version 4 runs:

- Categories become groups, in the same order. Tabs that were in "All" go to **Unsorted**.
- Hidden categories become private groups; auto-saved categories become dated **Sessions**.
- The old data is left untouched in storage as a backup.

## Development

No build step: plain HTML, CSS and JavaScript modules.

- `app.html`, `app/`: the app (the same page runs in the side panel and as a full tab)
- `lib/db.js`: storage, migration and every change to saved data (all writes are locked, so open windows never overwrite each other)
- `background.js`: toolbar icon, shortcuts, right-click menus and sessions
- `dev/`: a test harness that runs the app in any browser with a fake `chrome` API and sample data

```bash
node dev/serve.mjs
```

Then open http://localhost:5179/app.html?mode=page (add `&seed=legacy5000` for 5,000 saved tabs, or make the window narrow to see the side panel layout).

```bash
node dev/test-db.mjs
```

```bash
node dev/test-background.mjs
```

## License

MIT, see [LICENSE](LICENSE).
