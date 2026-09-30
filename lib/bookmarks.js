export const TRASH_TITLE = 'Trash';

export async function getRoot() {
  const [root] = await chrome.bookmarks.getTree();
  return root;
}

export function indexTree(root) {
  const byId = new Map();
  (function walk(node) {
    byId.set(node.id, node);
    node.children?.forEach(walk);
  })(root);
  return byId;
}

// Folder titles from the top-level folder down to `id` (inclusive). The invisible root is excluded.
export function pathOf(byId, id) {
  const segments = [];
  let node = byId.get(id);
  while (node && node.parentId !== undefined) {
    segments.unshift(node.title);
    node = byId.get(node.parentId);
  }
  return segments;
}

export function isInside(byId, id, ancestorId) {
  for (let node = byId.get(id); node; node = byId.get(node.parentId)) {
    if (node.id === ancestorId) return true;
  }
  return false;
}

// Root titles are localized, so resolve them by folderType (Chrome 134+) and fall back to position.
export function otherBookmarksOf(root) {
  return root.children.find((c) => c.folderType === 'other') ?? root.children[1];
}

export function findTrash(root) {
  return otherBookmarksOf(root).children?.find((c) => !c.url && c.title === TRASH_TITLE) ?? null;
}

export async function ensureTrash() {
  const root = await getRoot();
  const existing = findTrash(root);
  if (existing) return existing;
  return chrome.bookmarks.create({ parentId: otherBookmarksOf(root).id, title: TRASH_TITLE });
}

export async function ensureFolderPath(parentId, segments) {
  for (const title of segments) {
    const children = await chrome.bookmarks.getChildren(parentId);
    const folder =
      children.find((c) => !c.url && c.title === title) ??
      (await chrome.bookmarks.create({ parentId, title }));
    parentId = folder.id;
  }
  return parentId;
}

// All bookmarks below `folder`, each with the folder path it lives in.
export function collectBookmarks(folder, byId, excludeId = null) {
  const out = [];
  (function walk(node, path) {
    if (node.id === excludeId) return;
    for (const child of node.children ?? []) {
      if (child.url) {
        out.push({ id: child.id, title: child.title, url: child.url, parentId: child.parentId, path });
      } else {
        walk(child, [...path, child.title]);
      }
    }
  })(folder, pathOf(byId, folder.id));
  return out;
}

// Moves bookmarks into Trash/<original path>. Returns one record per moved bookmark so the move can be undone.
export async function moveToTrash(ids) {
  const trash = await ensureTrash();
  const byId = indexTree(await getRoot());
  const nodes = ids.map((id) => byId.get(id)).filter((n) => n?.url && !isInside(byId, n.id, trash.id));
  const missing = ids.filter((id) => !byId.has(id));

  // Highest index first within each parent, so the recorded indices stay the original ones.
  nodes.sort((a, b) => (a.parentId === b.parentId ? b.index - a.index : a.parentId.localeCompare(b.parentId)));

  const folderCache = new Map();
  const moved = [];
  for (const node of nodes) {
    const fromPath = pathOf(byId, node.parentId);
    const key = fromPath.join('\u0000');
    if (!folderCache.has(key)) folderCache.set(key, await ensureFolderPath(trash.id, fromPath));
    const toParentId = folderCache.get(key);
    await chrome.bookmarks.move(node.id, { parentId: toParentId });
    moved.push({
      id: node.id,
      title: node.title,
      url: node.url,
      fromParentId: node.parentId,
      fromIndex: node.index,
      fromPath,
      toParentId,
    });
  }
  return { moved, missing };
}

async function exists(id) {
  try {
    await chrome.bookmarks.get(id);
    return true;
  } catch {
    return false;
  }
}

async function ensurePathFromRoot(segments) {
  const root = await getRoot();
  const top = root.children.find((c) => c.title === segments[0]);
  if (top) return ensureFolderPath(top.id, segments.slice(1));
  return ensureFolderPath(otherBookmarksOf(root).id, segments);
}

// Puts moved bookmarks back where they were. Recreates the original folder path if it was deleted.
export async function undoMoves(records) {
  const restored = [];
  const missing = [];
  for (const rec of [...records].sort((a, b) => a.fromIndex - b.fromIndex)) {
    if (!(await exists(rec.id))) {
      missing.push(rec);
      continue;
    }
    const parentId = (await exists(rec.fromParentId)) ? rec.fromParentId : await ensurePathFromRoot(rec.fromPath);
    const siblings = await chrome.bookmarks.getChildren(parentId);
    await chrome.bookmarks.move(rec.id, { parentId, index: Math.min(rec.fromIndex, siblings.length) });
    restored.push(rec);
  }
  await pruneEmptyTrashFolders();
  return { restored, missing };
}

// Removes folders inside Trash that became empty (Trash itself is kept).
export async function pruneEmptyTrashFolders() {
  const trash = findTrash(await getRoot());
  if (!trash) return;
  const [subtree] = await chrome.bookmarks.getSubTree(trash.id);
  async function prune(node) {
    for (const child of node.children ?? []) {
      if (child.url) continue;
      await prune(child);
      if (!child.children?.length) await chrome.bookmarks.remove(child.id);
    }
    node.children = node.children?.filter((c) => c.url || c.children?.length);
  }
  await prune(subtree);
}
