document.addEventListener("DOMContentLoaded", () => {
  const saveTabButton = document.getElementById("saveTab");
  const openAllButton = document.getElementById("openAll");
  const addCategoryButton = document.getElementById("addCategory");
  const searchInput = document.getElementById("search");
  const categorySelect = document.getElementById("category");
  const newCategoryInput = document.getElementById("newCategory");
  const noTabsMessage = document.getElementById("noTabsMessage");

  saveTabButton.addEventListener("click", saveCurrentTab);
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
          // Replace the existing tab data
          savedTabs[existingTabIndex] = tabData;
        } else {
          // Add new tab data
          savedTabs.push(tabData);
        }

        chrome.storage.local.set({ savedTabs }, () => {
          displaySavedTabs(savedTabs);
        });
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
