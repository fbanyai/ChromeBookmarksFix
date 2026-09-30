# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BookmarkFix is a Chrome MV3 extension written in plain ES modules. It has no build step, no dependencies and no package.json. It checks bookmark links, moves dead ones to `Other bookmarks/Trash/<original path>`, logs every run, and exports backups. The user-facing behaviour is described in `README.md`.

## Commands

- **Run:** open `chrome://extensions`, turn on Developer mode, then **Load unpacked** this folder. After editing, click the reload icon on the extension card. Reopen the dashboard tab for changes to `dashboard.*` and `lib/*`.
- **Syntax check:** `for f in lib/*.js dashboard.js; do node --check --input-type=module < "$f"; done; node --check background.js`
- **Tests:** there is no test suite. The logic in `lib/bookmarks.js`, `lib/backup.js` and `lib/checker.js` can be exercised from Node:
  - Mock `globalThis.chrome.bookmarks` with an in-memory tree, then `import()` the module.
  - `checkUrl` runs in Node against real URLs if you pass a stub tracker `{ take: () => null }`.
  - The specific `net::ERR_*` causes only appear inside Chrome, because they come from `webRequest`.

## Architecture

- **The work happens in the dashboard tab.** `background.js` only opens or focuses `dashboard.html`, using `chrome.runtime.getContexts`. Checking, moving, logging and backups all run in `dashboard.js`, for two reasons:
  - An extension page has `URL.createObjectURL`, which `chrome.downloads` needs for blob downloads.
  - A page can host the `webRequest` listeners.

  As a result, closing the tab cancels a run. Keep it this way unless you add an offscreen document or a service-worker port.

- **Link checking** (`lib/checker.js`):
  - Each URL is requested with `HEAD`. If that fails at the network level or returns 400 or above, it is retried with `GET`.
  - `fetch` only reports "Failed to fetch". `NetTracker` fills in the real error by listening to `webRequest.onErrorOccurred` and `onBeforeRedirect`. It filters those events by `initiator === location.origin` and follows the redirect chain to match the error to the requested URL.
  - Results are grouped into `ok`, `failed`, `uncertain` and `skipped`. The codes that count as uncertain are listed in `UNCERTAIN_CODES`. The dashboard checks each distinct URL once and copies the result to every bookmark that shares it.
- **Moving to Trash and undoing it** (`lib/bookmarks.js`):
  - Root folder titles are localized, so the code finds them by `folderType` and falls back to their position (`otherBookmarksOf`). Never match root folders by title.
  - `moveToTrash` moves bookmarks with the highest index first within each parent. That keeps each recorded `fromIndex` equal to the original position.
  - `undoMoves` puts bookmarks back in ascending `fromIndex` order, so the original order is restored exactly. It recreates `fromPath` if the original parent is gone, then prunes Trash subfolders left empty.
- **The run log is the single source of truth** (`lib/logger.js`):
  - A run's log object (`state.run`) holds `results[]` and `actions[]`.
  - Each move appends to `actions` and sets `moved` on the affected results. Each undo sets `undoneAt` on the actions it reverses.
  - `persistLog` writes the whole log to `chrome.storage.local`, under the key `run:<id>` plus a summary entry in `runIndex` (only the last 50 runs are kept). No log file is written to disk automatically; the History tab can download a run on demand.
  - Call `persistLog` after every change to a log.
- **Downloads:** nothing is written automatically. Every download goes through `downloadText`, which always opens the Save dialog (`saveAs: true`).
