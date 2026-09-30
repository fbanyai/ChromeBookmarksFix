import {
  TRASH_TITLE,
  collectBookmarks,
  findTrash,
  getRoot,
  indexTree,
  isInside,
  moveToTrash,
  otherBookmarksOf,
  pathOf,
  undoMoves,
} from './lib/bookmarks.js';
import { NetTracker, checkAll, skipReason } from './lib/checker.js';
import { countStatuses, downloadJson, getRun, listRuns, pendingUndo, saveRun } from './lib/logger.js';
import { backupToFile } from './lib/backup.js';
import { loadSettings, saveSettings } from './lib/settings.js';
import { debounce, esc, stamp } from './lib/util.js';

const $ = (sel) => document.querySelector(sel);
const LABEL = { failed: 'Failed', uncertain: 'Uncertain', ok: 'Working', skipped: 'Skipped' };
const SELECTABLE = new Set(['failed', 'uncertain']);
const RENDER_CAP = 1000;

const ICON_FOLDER =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z"/></svg>';

const state = {
  root: null,
  byId: new Map(),
  trash: null,
  expanded: new Set(),
  activeFolderId: null,
  settings: null,
  run: null, // log of the current or reopened run; its `results` drive the table
  running: null, // { controller, total, done } while a check is in progress
  busy: false,
  tab: 'failed',
  filter: '',
  selected: new Set(),
};

init();

async function init() {
  state.settings = await loadSettings();
  await refreshTree();
  for (const child of state.root.children) state.expanded.add(child.id);
  renderTree();
  bindEvents();
  render();

  const onBookmarksChanged = debounce(refreshTree, 400);
  for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
    chrome.bookmarks[ev].addListener(onBookmarksChanged);
  }
}

/* ---------- Folder tree ---------- */

async function refreshTree() {
  state.root = await getRoot();
  state.byId = indexTree(state.root);
  state.trash = findTrash(state.root);
  if (state.activeFolderId && !state.byId.has(state.activeFolderId)) state.activeFolderId = null;
  renderTree();
}

function renderTree() {
  const counts = new Map();
  (function count(node) {
    let n = 0;
    for (const child of node.children ?? []) n += child.url ? 1 : count(child);
    counts.set(node.id, n);
    return n;
  })(state.root);

  $('#tree').replaceChildren(...state.root.children.map((node) => folderItem(node, counts, 0)));
  $('#btnVerifyFolder').disabled = !state.activeFolderId || !!state.running;
  $('#btnVerifyAll').disabled = !!state.running;
}

function folderItem(node, counts, depth) {
  const li = document.createElement('li');
  const subfolders = (node.children ?? []).filter((c) => !c.url);
  const open = state.expanded.has(node.id);
  const isTrash = node.id === state.trash?.id;

  const row = document.createElement('div');
  row.className = `tree-row${node.id === state.activeFolderId ? ' active' : ''}${isTrash ? ' trash' : ''}`;
  row.dataset.id = node.id;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.innerHTML =
    `<span class="caret">${subfolders.length ? (open ? '▾' : '▸') : ''}</span>` +
    `${isTrash ? ICON_TRASH : ICON_FOLDER}<span class="name">${esc(node.title || '(untitled)')}</span>` +
    `<span class="count">${counts.get(node.id)}</span>`;
  li.append(row);

  if (subfolders.length && open) {
    const ul = document.createElement('ul');
    ul.append(...subfolders.map((c) => folderItem(c, counts, depth + 1)));
    li.append(ul);
  }
  return li;
}

function showContextMenu(x, y, folderId) {
  const menu = $('#ctxMenu');
  menu.dataset.id = folderId;
  menu.querySelector('[data-action="verify"]').disabled = !!state.running;
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - height - 8)}px`;
}

function hideMenus() {
  $('#ctxMenu').hidden = true;
  $('#backupMenu').hidden = true;
}

/* ---------- Checking ---------- */

async function startRun(folderId) {
  if (state.running || state.busy) return;
  await refreshTree();
  const folder = state.byId.get(folderId);
  if (!folder) return;

  const isAll = folderId === state.root.id;
  const trashId = state.trash?.id;
  const excludeId = state.settings.excludeTrash && trashId && !isInside(state.byId, folderId, trashId) ? trashId : null;
  const items = collectBookmarks(folder, state.byId, excludeId);
  if (!items.length) {
    toast('This folder has no bookmarks to check.');
    return;
  }

  const startedAt = new Date();
  const id = stamp(startedAt);
  const log = {
    id,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    cancelled: false,
    scope: { folderId, path: isAll ? 'All bookmarks' : pathOf(state.byId, folderId).join(' / ') },
    settings: { ...state.settings },
    counts: {},
    results: [],
    actions: [],
  };

  // Check each distinct URL once, then fan the result out to every bookmark that has it.
  const groups = new Map();
  for (const item of items) {
    const reason = skipReason(item.url);
    if (reason) log.results.push({ ...item, status: 'skipped', cause: reason });
    else groups.set(item.url, [...(groups.get(item.url) ?? []), item]);
  }

  const controller = new AbortController();
  Object.assign(state, {
    run: log,
    running: { controller, total: groups.size, done: 0 },
    selected: new Set(),
    tab: 'failed',
    filter: '',
  });
  $('#filter').value = '';
  switchView('check');
  renderTree();
  render();

  const tracker = new NetTracker(location.origin);
  tracker.start();
  try {
    await checkAll([...groups.keys()], {
      concurrency: state.settings.concurrency,
      timeoutMs: state.settings.timeoutSec * 1000,
      signal: controller.signal,
      tracker,
      onResult(url, result) {
        for (const item of groups.get(url)) {
          log.results.push({ ...item, ...result });
          if (result.status === 'failed') state.selected.add(item.id);
        }
        state.running.done++;
        scheduleRender();
      },
    });
  } finally {
    tracker.stop();
  }

  log.cancelled = controller.signal.aborted;
  log.finishedAt = new Date().toISOString();
  state.running = null;
  await persistLog(log);
  renderTree();
  render();
  const c = log.counts;
  toast(`${log.cancelled ? 'Cancelled' : 'Done'}: ${c.ok} working, ${c.failed} failed, ${c.uncertain} uncertain. Saved to History.`);
}

async function persistLog(log) {
  log.counts = countStatuses(log.results);
  try {
    await saveRun(log);
  } catch (err) {
    toast(`Could not save the log: ${err.message}`, true);
  }
}

/* ---------- Trash / undo ---------- */

function trashLabel() {
  return `${otherBookmarksOf(state.root).title} / ${TRASH_TITLE}`;
}

async function moveSelected() {
  const log = state.run;
  const pending = new Set(log.results.filter((r) => !r.moved).map((r) => r.id));
  const ids = [...state.selected].filter((id) => pending.has(id));
  if (!ids.length) return;
  if (!confirm(`Move ${ids.length} bookmark(s) to "${trashLabel()}"?\n\nTheir original folder path is recreated inside Trash, and you can undo this later.`)) return;

  setBusy(true);
  try {
    const { moved, missing } = await moveToTrash(ids);
    const movedIds = new Set(moved.map((m) => m.id));
    for (const r of log.results) if (movedIds.has(r.id)) r.moved = true;
    for (const id of ids) state.selected.delete(id);
    log.actions.push({ type: 'move-to-trash', at: new Date().toISOString(), items: moved });
    await persistLog(log);
    toast(`Moved ${moved.length} bookmark(s) to Trash.${missing.length ? ` ${missing.length} no longer existed.` : ''}`);
  } catch (err) {
    toast(`Move failed: ${err.message}`, true);
  } finally {
    setBusy(false);
    await refreshTree();
    render();
  }
}

async function undoRun(log) {
  const actions = log.actions.filter((a) => !a.undoneAt).reverse();
  const count = pendingUndo(log);
  if (!count) return;
  if (!confirm(`Move ${count} bookmark(s) from Trash back to their original folders?`)) return;

  setBusy(true);
  try {
    let restoredTotal = 0;
    let missingTotal = 0;
    for (const action of actions) {
      const { restored, missing } = await undoMoves(action.items);
      const ids = new Set(restored.map((r) => r.id));
      for (const r of log.results) if (ids.has(r.id)) r.moved = false;
      Object.assign(action, { undoneAt: new Date().toISOString(), restored: restored.length, missing: missing.length });
      restoredTotal += restored.length;
      missingTotal += missing.length;
    }
    if (state.run?.id === log.id) state.run = log;
    await persistLog(log);
    toast(`Restored ${restoredTotal} bookmark(s).${missingTotal ? ` ${missingTotal} had been deleted.` : ''}`);
  } catch (err) {
    toast(`Undo failed: ${err.message}`, true);
  } finally {
    setBusy(false);
    await refreshTree();
    render();
    if (!$('#viewHistory').hidden) renderHistory();
  }
}

function setBusy(busy) {
  state.busy = busy;
  render();
}

/* ---------- Backups ---------- */

async function doBackup(format, folderId = null) {
  try {
    const filename = await backupToFile({ format, folderId });
    toast(`Backup saved (${filename}).`);
  } catch (err) {
    if (!/cancel/i.test(err.message)) toast(`Backup failed: ${err.message}`, true);
  }
}

/* ---------- Rendering ---------- */

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 250);
}

function render() {
  renderRunPanel();
  renderResults();
}

function renderRunPanel() {
  const panel = $('#runPanel');
  const log = state.run;

  if (state.running) {
    const { total, done } = state.running;
    const pct = total ? Math.round((done / total) * 100) : 100;
    panel.innerHTML = `
      <div class="run-head">
        <div><div class="eyebrow">Checking</div><h2>${esc(log.scope.path)}</h2></div>
        <button class="btn" data-action="cancel">Cancel</button>
      </div>
      <div class="progress"><div class="bar" style="transform:scaleX(${pct / 100})"></div></div>
      <div class="run-meta">${done} of ${total} links checked (${pct}%)</div>`;
    return;
  }

  if (!log) {
    panel.innerHTML = `
      <div class="empty">
        <h2>Check your bookmarks</h2>
        <p>Right-click a folder on the left and choose <b>Verify this folder</b>, or check everything at once.</p>
        <button class="btn primary" data-action="verify-all">Verify all bookmarks</button>
      </div>`;
    return;
  }

  const undoCount = pendingUndo(log);
  panel.innerHTML = `
    <div class="run-head">
      <div>
        <div class="eyebrow">${log.cancelled ? 'Cancelled run' : 'Run'} · ${esc(fmtDate(log.startedAt))}</div>
        <h2>${esc(log.scope.path)}</h2>
      </div>
      ${undoCount ? `<button class="btn" data-action="undo" ${state.busy ? 'disabled' : ''}>Undo ${undoCount} move(s)</button>` : ''}
    </div>`;
}

function visibleRows() {
  const needle = state.filter.toLowerCase();
  return state.run.results
    .filter((r) => r.status === state.tab)
    .filter((r) => !needle || `${r.title} ${r.url} ${r.path.join('/')} ${r.cause}`.toLowerCase().includes(needle))
    .sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')) || a.title.localeCompare(b.title));
}

function renderResults() {
  const wrap = $('#results');
  if (!state.run) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const counts = countStatuses(state.run.results);
  $('#tabs').innerHTML = ['failed', 'uncertain', 'ok', 'skipped']
    .map(
      (s) =>
        `<button data-tab="${s}" class="${s === state.tab ? 'active' : ''}">${LABEL[s]}<span class="n ${s}">${counts[s]}</span></button>`,
    )
    .join('');

  const rows = visibleRows();
  const shown = rows.slice(0, RENDER_CAP);
  $('#rows').innerHTML = shown.length
    ? shown.map(rowHtml).join('')
    : `<tr><td></td><td colspan="3" class="muted">${state.running ? 'Nothing here yet…' : 'Nothing here.'}</td></tr>`;
  const capNote = $('#capNote');
  capNote.hidden = rows.length <= RENDER_CAP;
  capNote.textContent = `Showing the first ${RENDER_CAP} of ${rows.length}. Use the filter to narrow the list.`;

  const selectable = SELECTABLE.has(state.tab);
  $('#selAll').disabled = $('#selNone').disabled = !selectable;
  const pending = new Set(state.run.results.filter((r) => !r.moved).map((r) => r.id));
  const n = [...state.selected].filter((id) => pending.has(id)).length;
  const btn = $('#btnMove');
  btn.textContent = n ? `Move ${n} selected to Trash` : 'Move selected to Trash';
  btn.disabled = !n || !!state.running || state.busy;
}

function rowHtml(r) {
  const selectable = SELECTABLE.has(r.status) && !r.moved;
  const isWeb = r.status !== 'skipped';
  const url = isWeb
    ? `<a class="bm-url" href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.url)}</a>`
    : `<span class="bm-url">${esc(r.url)}</span>`;
  const final = r.finalUrl
    ? `<div class="final">→ <a href="${esc(r.finalUrl)}" target="_blank" rel="noreferrer">${esc(r.finalUrl)}</a></div>`
    : '';
  return `<tr class="${r.moved ? 'moved' : ''}">
    <td class="c-check">${selectable ? `<input type="checkbox" data-id="${esc(r.id)}" ${state.selected.has(r.id) ? 'checked' : ''}>` : ''}</td>
    <td><div class="bm-title">${esc(r.title || '(untitled)')}</div>${url}</td>
    <td class="c-path">${esc(r.path.join(' / '))}</td>
    <td><span class="badge ${r.status}">${LABEL[r.status]}</span>${r.moved ? '<span class="badge moved">In Trash</span>' : ''}
      <div class="cause">${esc(r.cause)}</div>${final}</td>
  </tr>`;
}

async function renderHistory() {
  const runs = await listRuns();
  $('#historyRows').innerHTML = runs.length
    ? runs
        .map((s) => {
          const c = s.counts;
          return `<tr>
            <td>${esc(fmtDate(s.startedAt))}${s.cancelled ? ' <span class="badge skipped">cancelled</span>' : ''}</td>
            <td>${esc(s.scope)}</td>
            <td><span class="badge ok">${c.ok}</span><span class="badge failed">${c.failed}</span><span class="badge uncertain">${c.uncertain}</span><span class="badge skipped">${c.skipped}</span></td>
            <td>${c.moved}</td>
            <td><div class="row-actions">
              <button class="btn sm" data-act="open" data-id="${esc(s.id)}">Open</button>
              <button class="btn sm" data-act="download" data-id="${esc(s.id)}">Download</button>
              ${s.pendingUndo ? `<button class="btn sm" data-act="undo" data-id="${esc(s.id)}" ${state.busy ? 'disabled' : ''}>Undo moves</button>` : ''}
            </div></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="muted">No runs yet.</td></tr>';
}

function switchView(view) {
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('active', b.dataset.view === view);
  $('#viewCheck').hidden = view !== 'check';
  $('#viewHistory').hidden = view !== 'history';
  if (view === 'history') renderHistory();
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString();
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 8000 : 4500);
}

/* ---------- Events ---------- */

function bindEvents() {
  const tree = $('#tree');
  tree.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.caret')) {
      if (!state.expanded.delete(id)) state.expanded.add(id);
    } else {
      state.activeFolderId = id;
    }
    renderTree();
  });
  tree.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    e.preventDefault();
    state.activeFolderId = row.dataset.id;
    renderTree();
    showContextMenu(e.clientX, e.clientY, row.dataset.id);
  });

  $('#ctxMenu').addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    const id = $('#ctxMenu').dataset.id;
    hideMenus();
    if (action === 'verify') startRun(id);
    else if (action === 'backup-html') doBackup('html', id);
    else if (action === 'backup-json') doBackup('json', id);
  });

  $('#btnBackup').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#backupMenu');
    const wasHidden = menu.hidden;
    hideMenus();
    menu.hidden = !wasHidden;
  });
  $('#backupMenu').addEventListener('click', (e) => {
    const format = e.target.closest('button')?.dataset.format;
    hideMenus();
    if (format) doBackup(format);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) hideMenus();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hideMenus());
  addEventListener('blur', hideMenus);
  addEventListener('resize', hideMenus);

  $('#btnVerifyAll').addEventListener('click', () => startRun(state.root.id));
  $('#btnVerifyFolder').addEventListener('click', () => state.activeFolderId && startRun(state.activeFolderId));

  $('#views').addEventListener('click', (e) => {
    const view = e.target.closest('button')?.dataset.view;
    if (view) switchView(view);
  });

  $('#runPanel').addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'cancel') state.running?.controller.abort();
    else if (action === 'verify-all') startRun(state.root.id);
    else if (action === 'undo') undoRun(state.run);
  });

  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('button')?.dataset.tab;
    if (tab) {
      state.tab = tab;
      renderResults();
    }
  });

  $('#filter').addEventListener(
    'input',
    debounce((e) => {
      state.filter = e.target.value.trim();
      renderResults();
    }, 150),
  );

  $('#rows').addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    if (e.target.checked) state.selected.add(id);
    else state.selected.delete(id);
    renderResults();
  });

  $('#selAll').addEventListener('click', () => {
    for (const r of visibleRows()) if (!r.moved) state.selected.add(r.id);
    renderResults();
  });
  $('#selNone').addEventListener('click', () => {
    for (const r of visibleRows()) state.selected.delete(r.id);
    renderResults();
  });

  $('#btnMove').addEventListener('click', moveSelected);

  $('#historyRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (state.running) {
      toast('Wait for the current check to finish.');
      return;
    }
    const log = await getRun(btn.dataset.id);
    if (!log) {
      toast('That run is no longer stored.', true);
      return;
    }
    if (btn.dataset.act === 'open') {
      Object.assign(state, { run: log, selected: new Set(), tab: 'failed', filter: '' });
      $('#filter').value = '';
      switchView('check');
      render();
    } else if (btn.dataset.act === 'download') {
      downloadJson(log, `bookmarkfix-run-${log.id}.json`).catch(() => {});
    } else if (btn.dataset.act === 'undo') {
      undoRun(log);
    }
  });

  const dlg = $('#dlgSettings');
  const form = $('#settingsForm');
  $('#btnSettings').addEventListener('click', () => {
    const s = state.settings;
    form.timeoutSec.value = s.timeoutSec;
    form.concurrency.value = s.concurrency;
    form.excludeTrash.checked = s.excludeTrash;
    dlg.showModal();
  });
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'save') return;
    const clamp = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v)) || min));
    state.settings = {
      timeoutSec: clamp(form.timeoutSec.value, 3, 120),
      concurrency: clamp(form.concurrency.value, 1, 32),
      excludeTrash: form.excludeTrash.checked,
    };
    await saveSettings(state.settings);
    toast('Settings saved.');
  });

  addEventListener('beforeunload', (e) => {
    if (state.running || state.busy) e.preventDefault();
  });
}
