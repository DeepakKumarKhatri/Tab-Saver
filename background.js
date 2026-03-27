// Background service worker for Tab Saver
// Handles auto-save functionality when browser is closing

let tabSnapshot = [];

// Keep a running snapshot of all open tabs
async function updateTabSnapshot() {
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    tabSnapshot = windows
      .filter((w) => w.type === "normal")
      .flatMap((w) => w.tabs)
      .filter(
        (t) =>
          t.url &&
          !t.url.startsWith("chrome://") &&
          !t.url.startsWith("chrome-extension://")
      )
      .map((t) => ({
        url: t.url,
        title: t.title,
        favicon: t.favIconUrl,
      }));
  } catch (e) {
    // Ignore errors during shutdown
  }
}

// Update snapshot on tab changes
chrome.tabs.onCreated.addListener(updateTabSnapshot);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    updateTabSnapshot();
  }
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (!removeInfo.isWindowClosing) {
    updateTabSnapshot();
  }
});

// Initial snapshot when service worker starts
updateTabSnapshot();

// When a window is removed, check if it was the last normal window
chrome.windows.onRemoved.addListener(async () => {
  try {
    const { autoSaveEnabled = false } =
      await chrome.storage.local.get("autoSaveEnabled");
    if (!autoSaveEnabled) return;

    const windows = await chrome.windows.getAll();
    const normalWindows = windows.filter((w) => w.type === "normal");

    if (normalWindows.length === 0 && tabSnapshot.length > 0) {
      await autoSaveTabs(tabSnapshot);
      tabSnapshot = [];
    }
  } catch (e) {
    console.error("Error in onRemoved handler:", e);
  }
});

// Auto-save tabs with timestamped category
async function autoSaveTabs(tabs) {
  if (!tabs || tabs.length === 0) return;

  try {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toTimeString().split(" ")[0].replace(/:/g, "");
    const categoryName = `Auto-${dateStr}-${timeStr}`;

    const { savedTabs = [], categories = ["All"] } =
      await chrome.storage.local.get(["savedTabs", "categories"]);

    if (!categories.includes(categoryName)) {
      categories.push(categoryName);
    }

    const newTabs = tabs.map((tab) => ({
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      date: now.toISOString(),
      category: categoryName,
    }));

    const existingUrls = new Set(savedTabs.map((t) => t.url));
    const tabsToAdd = newTabs.filter((t) => !existingUrls.has(t.url));
    const updatedTabs = [...savedTabs, ...tabsToAdd];

    await chrome.storage.local.set({
      savedTabs: updatedTabs,
      categories: categories,
    });

    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Tab Saver",
      message: `Auto-saved ${tabsToAdd.length} tabs to category: ${categoryName}`,
      priority: 2,
    });
  } catch (error) {
    console.error("Error auto-saving tabs:", error);
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkAutoSave") {
    chrome.storage.local.get("autoSaveEnabled", (result) => {
      sendResponse({ enabled: result.autoSaveEnabled || false });
    });
    return true;
  }
});
