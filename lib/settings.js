export const DEFAULT_SETTINGS = {
  timeoutSec: 15,
  concurrency: 8,
  excludeTrash: true,
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
