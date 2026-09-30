const DASHBOARD_URL = chrome.runtime.getURL('dashboard.html');

// The toolbar icon opens the dashboard, or focuses it if it's already open.
chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.runtime.getContexts({
    contextTypes: ['TAB'],
    documentUrls: [DASHBOARD_URL],
  });
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: DASHBOARD_URL });
});
