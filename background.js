// Background service worker for Tab Saver
// Handles auto-save functionality when browser is closing

// Listen for when all windows are being closed
chrome.windows.onRemoved.addListener(async (windowId) => {
  // Check if auto-save is enabled
  const { autoSaveEnabled = false } = await chrome.storage.local.get('autoSaveEnabled');
  
  if (!autoSaveEnabled) return;
  
  // Get all remaining windows
  const windows = await chrome.windows.getAll();
  
  // If this was the last window, trigger auto-save
  if (windows.length === 0) {
    // Get all tabs from the closing window before it's gone
    await promptAutoSave();
  }
});

// Track when windows are being closed to capture tabs
let closingWindowTabs = {};

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { autoSaveEnabled = false } = await chrome.storage.local.get('autoSaveEnabled');
  
  if (!autoSaveEnabled) return;
  
  // Get remaining windows
  const windows = await chrome.windows.getAll({ populate: true });
  
  // If all windows are closed (or only popup windows remain), save tabs
  const normalWindows = windows.filter(w => w.type === 'normal');
  
  if (normalWindows.length === 0 && closingWindowTabs[windowId]) {
    await autoSaveTabs(closingWindowTabs[windowId]);
    delete closingWindowTabs[windowId];
  }
});

// Capture tabs before window closes
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (removeInfo.isWindowClosing) {
    const { autoSaveEnabled = false } = await chrome.storage.local.get('autoSaveEnabled');
    
    if (!autoSaveEnabled) return;
    
    try {
      // Get all tabs in the closing window
      const tabs = await chrome.tabs.query({ windowId: removeInfo.windowId });
      
      if (tabs.length > 0) {
        closingWindowTabs[removeInfo.windowId] = tabs;
        
        // Check if all windows are closing
        setTimeout(async () => {
          const windows = await chrome.windows.getAll({ populate: true });
          const normalWindows = windows.filter(w => w.type === 'normal');
          
          if (normalWindows.length === 0) {
            await autoSaveTabs(closingWindowTabs[removeInfo.windowId]);
            delete closingWindowTabs[removeInfo.windowId];
          }
        }, 100);
      }
    } catch (error) {
      console.error('Error capturing closing tabs:', error);
    }
  }
});

// Auto-save tabs with timestamped category
async function autoSaveTabs(tabs) {
  if (!tabs || tabs.length === 0) return;
  
  try {
    // Generate category name: Auto-YYYY-MM-DD-HHmmss
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, ''); // HHmmss
    const categoryName = `Auto-${dateStr}-${timeStr}`;
    
    // Get existing data
    const { savedTabs = [], categories = ["All"] } = await chrome.storage.local.get(['savedTabs', 'categories']);
    
    // Add new category if it doesn't exist
    if (!categories.includes(categoryName)) {
      categories.push(categoryName);
    }
    
    // Prepare tab data
    const newTabs = tabs.map(tab => ({
      url: tab.url,
      title: tab.title,
      favicon: tab.favIconUrl,
      date: now.toISOString(),
      category: categoryName
    })).filter(tab => !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://'));
    
    // Merge with existing tabs (avoid duplicates)
    const existingUrls = new Set(savedTabs.map(t => t.url));
    const tabsToAdd = newTabs.filter(t => !existingUrls.has(t.url));
    
    const updatedTabs = [...savedTabs, ...tabsToAdd];
    
    // Save to storage
    await chrome.storage.local.set({
      savedTabs: updatedTabs,
      categories: categories
    });
    
    // Show notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Tab Saver',
      message: `Auto-saved ${tabsToAdd.length} tabs to category: ${categoryName}`,
      priority: 2
    });
    
  } catch (error) {
    console.error('Error auto-saving tabs:', error);
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkAutoSave') {
    chrome.storage.local.get('autoSaveEnabled', (result) => {
      sendResponse({ enabled: result.autoSaveEnabled || false });
    });
    return true;
  }
});
