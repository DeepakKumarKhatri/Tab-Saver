document.addEventListener("DOMContentLoaded", () => {
  const saveTabButton = document.getElementById("saveTab");
  const saveAllTabsButton = document.getElementById("saveAllTabs");
  const openAllButton = document.getElementById("openAll");
  const addCategoryButton = document.getElementById("addCategory");
  const searchInput = document.getElementById("search");
  const categorySelect = document.getElementById("category");
  const newCategoryInput = document.getElementById("newCategory");
  const noTabsMessage = document.getElementById("noTabsMessage");

  saveTabButton.addEventListener("click", saveCurrentTab);
  saveAllTabsButton.addEventListener("click", saveAllTabs);
  openAllButton.addEventListener("click", openAllTabs);
  addCategoryButton.addEventListener("click", addCategory);
  searchInput.addEventListener("input", searchTabs);

  let categories = ["All"];

  // Load categories and display saved tabs when the popup is opened
  chrome.storage.local.get({ categories: ["All"], savedTabs: [] }, (result) => {
    categories = result.categories;
    updateCategoryDropdown();
    displaySavedTabs(result.savedTabs);
  });

  function searchTabs() {
    const query = searchInput.value.toLowerCase();
    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      const filteredTabs = result.savedTabs.filter(
        (tab) =>
          tab.title.toLowerCase().includes(query) ||
          tab.url.toLowerCase().includes(query)
      );
      displaySavedTabs(filteredTabs);
    });
  }

  function addCategory() {
    const newCategory = newCategoryInput.value.trim();
    if (newCategory && !categories.includes(newCategory)) {
      categories.push(newCategory);
      chrome.storage.local.set({ categories }, () => {
        updateCategoryDropdown();
        newCategoryInput.value = "";
      });
    }
  }

  function updateCategoryDropdown() {
    categorySelect.innerHTML = categories
      .map((cat) => `<option value="${cat}">${cat}</option>`)
      .join("");
  }

  function saveCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      saveTab(tab);
    });
  }

  async function saveAllTabs() {
    try {
      const windows = await chrome.windows.getAll({ populate: true });
      const allTabs = windows.flatMap((window) => window.tabs);

      // Get current saved tabs
      const { savedTabs: existingSavedTabs = [] } =
        await chrome.storage.local.get({ savedTabs: [] });
      const category = categorySelect.value;

      // Prepare all new tab data
      const newTabsData = allTabs.map((tab) => ({
        url: tab.url,
        title: tab.title,
        favicon: tab.favIconUrl,
        date: new Date().toISOString(),
        category: category,
      }));

      // Create a Map of existing tabs by URL for quick lookup
      const existingTabsMap = new Map(
        existingSavedTabs.map((tab) => [tab.url, tab])
      );

      // Merge new tabs with existing ones, replacing duplicates
      const mergedTabs = [...existingSavedTabs];

      newTabsData.forEach((newTab) => {
        const existingIndex = mergedTabs.findIndex(
          (tab) => tab.url === newTab.url
        );
        if (existingIndex !== -1) {
          mergedTabs[existingIndex] = newTab;
        } else {
          mergedTabs.push(newTab);
        }
      });

      // Save all tabs at once
      await chrome.storage.local.set({ savedTabs: mergedTabs });
      displaySavedTabs(mergedTabs);
    } catch (error) {
      console.error("Error saving all tabs:", error);
    }
  }

  function saveTab(tab, callback) {
    const category = categorySelect.value;
    const tabData = {
      url: tab.url,
      title: tab.title,
      favicon: tab.favIconUrl,
      date: new Date().toISOString(),
      category: category,
    };

    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      const savedTabs = result.savedTabs;
      const existingTabIndex = savedTabs.findIndex(
        (savedTab) => savedTab.url === tabData.url
      );

      if (existingTabIndex !== -1) {
        savedTabs[existingTabIndex] = tabData;
      } else {
        savedTabs.push(tabData);
      }

      chrome.storage.local.set({ savedTabs }, () => {
        if (callback) {
          callback();
        } else {
          displaySavedTabs(savedTabs);
        }
      });
    });
  }

  function displaySavedTabs(tabs) {
    const tabList = document.getElementById("tabList");
    tabList.innerHTML = "";

    if (tabs.length === 0) {
      noTabsMessage.classList.remove("hidden");
    } else {
      noTabsMessage.classList.add("hidden");

      tabs.forEach((tab, index) => {
        const li = document.createElement("li");
        li.innerHTML = `
          <img src="${
            tab.favicon || "icons/default-favicon.png"
          }" alt="Favicon">
          <div class="tab-info">
            <a href="${tab.url}" target="_blank" title="${tab.title}">${
          tab.title
        }</a>
            <div class="metadata">
              <span>${tab.category}</span> • 
              <span>${formatDate(tab.date)}</span>
            </div>
          </div>
          <button class="deleteButton" data-index="${index}">Delete</button>
        `;
        tabList.appendChild(li);
      });

      document.querySelectorAll(".deleteButton").forEach((button) => {
        button.addEventListener("click", deleteTab);
      });
    }
  }

  function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);

    if (diffInSeconds < 60) return `${diffInSeconds}s ago`;
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400)
      return `${Math.floor(diffInSeconds / 3600)}h ago`;
    if (diffInSeconds < 2592000)
      return `${Math.floor(diffInSeconds / 86400)}d ago`;
    if (diffInSeconds < 31536000)
      return `${Math.floor(diffInSeconds / 2592000)}mo ago`;
    return `${Math.floor(diffInSeconds / 31536000)}y ago`;
  }

  function openAllTabs() {
    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      result.savedTabs.forEach((tab) => {
        chrome.tabs.create({ url: tab.url });
      });
    });
  }

  function deleteTab(event) {
    const index = event.target.getAttribute("data-index");
    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      const savedTabs = result.savedTabs;
      savedTabs.splice(index, 1);
      chrome.storage.local.set({ savedTabs }, () => {
        displaySavedTabs(savedTabs);
      });
    });
  }
});
