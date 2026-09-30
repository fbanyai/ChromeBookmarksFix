const INDEX_KEY = 'runIndex';
const MAX_RUNS = 50;
const runKey = (id) => `run:${id}`;

export function countStatuses(results) {
  const counts = { ok: 0, failed: 0, uncertain: 0, skipped: 0, moved: 0 };
  for (const r of results) {
    counts[r.status]++;
    if (r.moved) counts.moved++;
  }
  return counts;
}

export function pendingUndo(log) {
  return log.actions.filter((a) => !a.undoneAt).reduce((sum, a) => sum + a.items.length, 0);
}

function summarize(log) {
  return {
    id: log.id,
    startedAt: log.startedAt,
    scope: log.scope.path,
    cancelled: log.cancelled,
    counts: log.counts,
    pendingUndo: pendingUndo(log),
  };
}

export async function saveRun(log) {
  const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);
  const next = [summarize(log), ...index.filter((s) => s.id !== log.id)];
  const dropped = next.splice(MAX_RUNS);
  await chrome.storage.local.set({ [INDEX_KEY]: next, [runKey(log.id)]: log });
  if (dropped.length) await chrome.storage.local.remove(dropped.map((s) => runKey(s.id)));
}

export async function listRuns() {
  const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);
  return index;
}

export async function getRun(id) {
  const { [runKey(id)]: log } = await chrome.storage.local.get(runKey(id));
  return log ?? null;
}

// Opens the OS save dialog, with `filename` as the suggested name.
export async function downloadText(text, mime, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  try {
    return await chrome.downloads.download({
      url,
      filename,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function downloadJson(data, filename) {
  return downloadText(JSON.stringify(data, null, 2), 'application/json', filename);
}
