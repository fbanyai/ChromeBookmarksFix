import { downloadText } from './logger.js';
import { esc, slug, stamp } from './util.js';

const secs = (ms) => (ms ? Math.floor(ms / 1000) : 0);

// Netscape bookmark file: the format Chrome, Edge and Firefox import and export.
export function toNetscapeHtml(node) {
  const out = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  function write(n, depth) {
    const pad = '    '.repeat(depth);
    if (n.url) {
      out.push(`${pad}<DT><A HREF="${esc(n.url)}" ADD_DATE="${secs(n.dateAdded)}">${esc(n.title)}</A>`);
      return;
    }
    const isBar = n.folderType === 'bookmarks-bar' || (n.parentId === '0' && n.index === 0);
    out.push(
      `${pad}<DT><H3 ADD_DATE="${secs(n.dateAdded)}" LAST_MODIFIED="${secs(n.dateGroupModified)}"` +
        `${isBar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''}>${esc(n.title)}</H3>`,
    );
    out.push(`${pad}<DL><p>`);
    for (const child of n.children ?? []) write(child, depth + 1);
    out.push(`${pad}</DL><p>`);
  }

  const tops = node.parentId === undefined ? (node.children ?? []) : [node];
  for (const top of tops) write(top, 1);
  out.push('</DL><p>', '');
  return out.join('\n');
}

export async function backupToFile({ format = 'html', folderId = null } = {}) {
  const [node] = folderId ? await chrome.bookmarks.getSubTree(folderId) : await chrome.bookmarks.getTree();
  const now = new Date();
  const ext = format === 'html' ? 'html' : 'json';
  const label = folderId ? slug(node.title) : 'all';
  const filename = `bookmarks-${label}-${stamp(now)}.${ext}`;

  const body =
    format === 'html'
      ? toNetscapeHtml(node)
      : JSON.stringify({ source: 'BookmarkFix', exportedAt: now.toISOString(), tree: node }, null, 2);
  await downloadText(body, format === 'html' ? 'text/html' : 'application/json', filename);
  return filename;
}
