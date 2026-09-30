# Chrome Bookmarks Fix

A Chrome extension (Manifest V3) that checks your bookmarks, moves dead links to a Trash folder that mirrors their original path, logs every run, and makes full backups.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the Chrome Bookmarks Fix toolbar icon to open the dashboard.

## Use

- **Check links**: right-click a folder in the dashboard sidebar and choose **Verify this folder** (subfolders are included), or click **Verify all**.
  - Chrome doesn't let extensions add items to the native bookmark right-click menu, so the folder tree in the dashboard provides it instead.
- **Results**: results are split into four tabs:
  - **Failed**: 404/410, other 4xx, 5xx, domain not found, connection refused, SSL errors, timeouts
  - **Uncertain**: 401/403/429 and Cloudflare challenges, which are often bot protection rather than a dead site
  - **Working**
  - **Skipped**: non-web links like `javascript:` or `chrome://`
- **Move to Trash**: failed links are pre-selected and uncertain ones are not. **Move selected to Trash** moves them to `Other bookmarks/Trash/<original path>`, for example `Trash/Bookmarks bar/Dev/Tools`.
- **Undo**: available on the run panel and in **History**. It puts bookmarks back in their original folder and position, recreates the folder if it was deleted, and removes Trash subfolders that end up empty.

## Files it writes

Nothing is written to disk automatically. **Full backup**, **Back up this folder** and **Download** in History open a Save dialog so you choose where the file goes.

The last 50 runs are stored inside the extension (**History** tab), where you can reopen them, undo their moves, or **Download** one as JSON.

HTML backups use the standard Netscape bookmark format. To restore one, go to `chrome://bookmarks` → ⋮ → **Import bookmarks**, or use any browser's import feature. JSON backups contain the full tree with ids and dates.

## Settings

Timeout per link (15 s), parallel checks (8), skip the Trash folder when verifying (on).

## How checking works

Each distinct URL is requested once with `HEAD`. If that fails, it is retried with `GET`, because many servers mishandle `HEAD`. Redirects are followed and the final URL is shown. The exact network error (`net::ERR_NAME_NOT_RESOLVED`, `ERR_CERT_*`, …) is read through `chrome.webRequest`, so the cause is specific rather than just "failed to fetch". Keep the dashboard tab open while a check runs, because closing it cancels the run.
