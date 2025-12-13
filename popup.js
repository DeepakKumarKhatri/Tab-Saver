document.addEventListener("DOMContentLoaded", () => {
  const saveTabButton = document.getElementById("saveTab");
  const saveAllTabsButton = document.getElementById("saveAllTabs");
  const openAllButton = document.getElementById("openAll");
  const settingsButton = document.getElementById("settingsButton");
  const searchInput = document.getElementById("search");
  const categorySelect = document.getElementById("category");
  const saveCategorySelect = document.getElementById("saveCategory");
  const sortBySelect = document.getElementById("sortBy");
  const collapseAllBtn = document.getElementById("collapseAllBtn");
  const noTabsMessage = document.getElementById("noTabsMessage");

  saveTabButton.addEventListener("click", saveCurrentTab);
  saveAllTabsButton.addEventListener("click", saveAllTabs);
  openAllButton.addEventListener("click", openAllTabs);
  settingsButton.addEventListener("click", openSettings);
  searchInput.addEventListener("input", searchTabs);
  sortBySelect.addEventListener("change", filterByCategory);
  collapseAllBtn.addEventListener("click", toggleCollapseAll);

  let categories = ["All"];
  let allSavedTabs = []; // Store all tabs for filtering
  let collapsedCategories = new Set(); // Track which categories are collapsed
  let selectedTabs = new Set(); // Track selected tabs by URL

  // Load categories and display saved tabs when the popup is opened
  chrome.storage.local.get({ categories: ["All"], savedTabs: [], collapsedCategories: [] }, (result) => {
    categories = result.categories;
    allSavedTabs = result.savedTabs;
    collapsedCategories = new Set(result.collapsedCategories || []);
    updateCategoryDropdown();
    categorySelect.value = "All"; // Set default to All
    displaySavedTabs(result.savedTabs);
    updateCollapseAllButton();
  });

  // Add category filter listener
  categorySelect.addEventListener("change", filterByCategory);

  function filterByCategory() {
    const selectedCategory = categorySelect.value;
    const query = searchInput.value.toLowerCase();
    const sortBy = sortBySelect.value;
    
    let filteredTabs = allSavedTabs;
    
    // Filter by category
    if (selectedCategory !== "All") {
      filteredTabs = filteredTabs.filter(tab => tab.category === selectedCategory);
    }
    
    // Filter by search query
    if (query) {
      filteredTabs = filteredTabs.filter(
        (tab) =>
          tab.title.toLowerCase().includes(query) ||
          tab.url.toLowerCase().includes(query)
      );
    }
    
    // Apply sorting
    filteredTabs = sortTabs(filteredTabs, sortBy);
    
    displaySavedTabs(filteredTabs);
    
    // Update collapse all button after display
    updateCollapseAllButton();
  }

  function sortTabs(tabs, sortBy) {
    const sorted = [...tabs]; // Create a copy to avoid mutating original
    
    switch (sortBy) {
      case 'date-desc': // Newest first
        sorted.sort((a, b) => new Date(b.date) - new Date(a.date));
        break;
      case 'date-asc': // Oldest first
        sorted.sort((a, b) => new Date(a.date) - new Date(b.date));
        break;
      case 'title-asc': // A-Z
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'title-desc': // Z-A
        sorted.sort((a, b) => b.title.localeCompare(a.title));
        break;
      default:
        sorted.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
    
    return sorted;
  }

  function updateCategoryDropdown() {
    // Update filter dropdown (includes "All")
    categorySelect.innerHTML = categories
      .map((cat) => `<option value="${cat}">${cat}</option>`)
      .join("");
    
    // Update save category dropdown (excludes "All" or shows it last)
    const saveCategories = categories.filter(cat => cat !== "All");
    if (saveCategories.length === 0) {
      saveCategories.push("All");
    }
    saveCategorySelect.innerHTML = saveCategories
      .map((cat) => `<option value="${cat}">${cat}</option>`)
      .join("");
  }

  function saveCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      saveTab(tab);
    });
  }

  function searchTabs() {
    filterByCategory();
  }

  function openSettings() {
    window.location.href = "settings.html";
  }

  async function saveAllTabs() {
    try {
      const windows = await chrome.windows.getAll({ populate: true });
      const allTabs = windows.flatMap((window) => window.tabs);

      // Get current saved tabs
      const { savedTabs: existingSavedTabs = [] } =
        await chrome.storage.local.get({ savedTabs: [] });
      const category = saveCategorySelect.value;

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
      allSavedTabs = mergedTabs;
      filterByCategory();
    } catch (error) {
      console.error("Error saving all tabs:", error);
    }
  }

  function saveTab(tab, callback) {
    // Get the category from the save category selector
    const category = saveCategorySelect.value;
    
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
        allSavedTabs = savedTabs;
        if (callback) {
          callback();
        } else {
          filterByCategory();
        }
      });
    });
  }

  function displaySavedTabs(tabs) {
    const tabList = document.getElementById("tabList");
    const selectedCategory = categorySelect.value;
    tabList.innerHTML = "";

    if (tabs.length === 0) {
      noTabsMessage.classList.remove("hidden");
    } else {
      noTabsMessage.classList.add("hidden");

      // If "All" is selected, group by category
      if (selectedCategory === "All") {
        displayGroupedTabs(tabs);
      } else {
        displayFlatTabs(tabs);
      }
    }
  }

  function displayGroupedTabs(tabs) {
    const tabList = document.getElementById("tabList");
    
    // Reload categories to ensure we have the latest
    chrome.storage.local.get({ categories: ["All"] }, (result) => {
      const latestCategories = result.categories || ["All"];
      categories = latestCategories;
      console.log("Categories loaded for grouped view:", latestCategories); // Debug log
      renderGroupedTabs(tabs, tabList, latestCategories);
    });
  }

  function renderGroupedTabs(tabs, tabList, availableCategories) {
    // Group tabs by category
    const groupedTabs = {};
    tabs.forEach(tab => {
      const category = tab.category || "All";
      if (!groupedTabs[category]) {
        groupedTabs[category] = [];
      }
      groupedTabs[category].push(tab);
    });

    // Count selected tabs per category
    const selectedCount = {};
    Object.keys(groupedTabs).forEach(category => {
      selectedCount[category] = groupedTabs[category].filter(tab => selectedTabs.has(tab.url)).length;
    });

    // Display each category group
    Object.keys(groupedTabs).sort().forEach(category => {
      const categoryTabs = groupedTabs[category];
      const isCollapsed = collapsedCategories.has(category);
      const categorySelectedCount = selectedCount[category];
      const allSelected = categorySelectedCount === categoryTabs.length;
      const someSelected = categorySelectedCount > 0 && !allSelected;
      
      // Create category header
      const categoryHeader = document.createElement("div");
      categoryHeader.className = "category-header";
      categoryHeader.innerHTML = `
        <div class="category-header-left">
          <button class="collapse-btn" data-category="${category}" title="${isCollapsed ? 'Expand' : 'Collapse'}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="collapse-icon ${isCollapsed ? 'collapsed' : ''}">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <input type="checkbox" class="select-all-checkbox" data-category="${category}" ${allSelected ? 'checked' : ''} ${someSelected ? 'data-indeterminate="true"' : ''} title="Select all in category">
          <h3>${category} <span class="tab-count">(${categoryTabs.length})</span></h3>
        </div>
        <div class="category-header-actions">
          ${categorySelectedCount > 0 ? `<button class="open-selected-category-btn" data-category="${category}" title="Open ${categorySelectedCount} selected tabs">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
            </svg>
            Open Selected (${categorySelectedCount})
          </button>` : ''}
          <button class="open-category-btn" data-category="${category}" title="Open all tabs in category">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
            </svg>
            Open All
          </button>
        </div>
      `;
      tabList.appendChild(categoryHeader);

      // Create tabs list for this category
      const categoryList = document.createElement("ul");
      categoryList.className = `category-tabs-list ${isCollapsed ? 'collapsed' : ''}`;
      categoryList.dataset.category = category;
      
      categoryTabs.forEach(tab => {
        const isSelected = selectedTabs.has(tab.url);
        const li = document.createElement("li");
        li.innerHTML = `
          <input type="checkbox" class="tab-checkbox" data-url="${tab.url}" ${isSelected ? 'checked' : ''} title="Select tab">
          <img src="${
            tab.favicon || "icons/default-favicon.png"
          }" alt="Favicon">
          <div class="tab-info">
            <a href="${tab.url}" target="_blank" title="${tab.title}">${
          tab.title
        }</a>
            <div class="metadata">
              <span>${formatDate(tab.date)}</span>
            </div>
          </div>
          <select class="change-category-select" data-url="${tab.url}" title="Change category">
            ${availableCategories.map(cat => 
              `<option value="${cat}" ${cat === tab.category ? 'selected' : ''}>${cat}</option>`
            ).join('')}
          </select>
          <button class="deleteButton" data-url="${tab.url}" title="Delete tab">Delete</button>
        `;
        categoryList.appendChild(li);
      });
      
      tabList.appendChild(categoryList);
    });

    // Set indeterminate state for checkboxes after DOM is ready
    document.querySelectorAll('.select-all-checkbox[data-indeterminate="true"]').forEach(checkbox => {
      checkbox.indeterminate = true;
    });

    // Add event listeners
    document.querySelectorAll(".deleteButton").forEach((button) => {
      button.addEventListener("click", deleteTab);
    });
    
    document.querySelectorAll(".open-category-btn").forEach((button) => {
      button.addEventListener("click", openCategoryTabs);
    });

    document.querySelectorAll(".open-selected-category-btn").forEach((button) => {
      button.addEventListener("click", openSelectedCategoryTabs);
    });

    document.querySelectorAll(".collapse-btn").forEach((button) => {
      button.addEventListener("click", toggleCategoryCollapse);
    });

    document.querySelectorAll(".tab-checkbox").forEach((checkbox) => {
      checkbox.addEventListener("change", handleTabCheckbox);
    });

    document.querySelectorAll(".select-all-checkbox").forEach((checkbox) => {
      checkbox.addEventListener("change", handleSelectAllCheckbox);
    });

    document.querySelectorAll(".change-category-select").forEach((select) => {
      select.addEventListener("change", handleCategoryChange);
    });
  }

  function displayFlatTabs(tabs) {
    const tabList = document.getElementById("tabList");
    
    // Reload categories to ensure we have the latest
    chrome.storage.local.get({ categories: ["All"] }, (result) => {
      const latestCategories = result.categories || ["All"];
      categories = latestCategories;
      console.log("Categories loaded for flat view:", latestCategories); // Debug log
      renderFlatTabs(tabs, tabList, latestCategories);
    });
  }

  function renderFlatTabs(tabs, tabList, availableCategories) {
    // Count selected tabs
    const selectedCount = tabs.filter(tab => selectedTabs.has(tab.url)).length;
    const allSelected = selectedCount === tabs.length && tabs.length > 0;
    const someSelected = selectedCount > 0 && !allSelected;
    
    // Add header with select all and open selected
    if (tabs.length > 0) {
      const header = document.createElement("div");
      header.className = "category-header";
      header.innerHTML = `
        <div class="category-header-left">
          <input type="checkbox" class="select-all-checkbox-flat" ${allSelected ? 'checked' : ''} ${someSelected ? 'data-indeterminate="true"' : ''} title="Select all tabs">
          <h3>Tabs <span class="tab-count">(${tabs.length})</span></h3>
        </div>
        <div class="category-header-actions">
          ${selectedCount > 0 ? `<button class="open-selected-flat-btn" title="Open ${selectedCount} selected tabs">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
            </svg>
            Open Selected (${selectedCount})
          </button>` : ''}
        </div>
      `;
      tabList.appendChild(header);
      
      // Set indeterminate state
      if (someSelected) {
        const checkbox = header.querySelector('.select-all-checkbox-flat');
        checkbox.indeterminate = true;
      }
    }
    
    const flatList = document.createElement("ul");
    flatList.className = "category-tabs-list";

    tabs.forEach(tab => {
      const isSelected = selectedTabs.has(tab.url);
      const li = document.createElement("li");
      li.innerHTML = `
        <input type="checkbox" class="tab-checkbox" data-url="${tab.url}" ${isSelected ? 'checked' : ''} title="Select tab">
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
        <select class="change-category-select" data-url="${tab.url}" title="Change category">
          ${availableCategories.map(cat => 
            `<option value="${cat}" ${cat === tab.category ? 'selected' : ''}>${cat}</option>`
          ).join('')}
        </select>
        <button class="deleteButton" data-url="${tab.url}" title="Delete tab">Delete</button>
      `;
      flatList.appendChild(li);
    });
    
    tabList.appendChild(flatList);

    document.querySelectorAll(".deleteButton").forEach((button) => {
      button.addEventListener("click", deleteTab);
    });
    
    document.querySelectorAll(".tab-checkbox").forEach((checkbox) => {
      checkbox.addEventListener("change", handleTabCheckbox);
    });
    
    document.querySelectorAll(".change-category-select").forEach((select) => {
      select.addEventListener("change", handleCategoryChange);
    });
    
    const selectAllCheckbox = document.querySelector(".select-all-checkbox-flat");
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener("change", handleSelectAllFlat);
    }
    
    const openSelectedBtn = document.querySelector(".open-selected-flat-btn");
    if (openSelectedBtn) {
      openSelectedBtn.addEventListener("click", openSelectedTabs);
    }
  }

  function openCategoryTabs(event) {
    const category = event.currentTarget.getAttribute("data-category");
    const categoryTabs = allSavedTabs.filter(tab => tab.category === category);
    
    if (categoryTabs.length === 0) return;
    
    // Open all tabs and collect their IDs
    const tabPromises = categoryTabs.map(tab => 
      chrome.tabs.create({ url: tab.url, active: false })
    );
    
    Promise.all(tabPromises).then(createdTabs => {
      const tabIds = createdTabs.map(tab => tab.id);
      
      // Create tab group
      chrome.tabs.group({ tabIds }, (groupId) => {
        // Set group title and color
        chrome.tabGroups.update(groupId, {
          title: category,
          color: getGroupColor(category),
          collapsed: false
        });
      });
    });
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
    const tabUrl = event.target.getAttribute("data-url");
    
    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      const savedTabs = result.savedTabs;
      const actualIndex = savedTabs.findIndex(tab => tab.url === tabUrl);
      
      if (actualIndex !== -1) {
        savedTabs.splice(actualIndex, 1);
        chrome.storage.local.set({ savedTabs }, () => {
          allSavedTabs = savedTabs;
          selectedTabs.delete(tabUrl); // Remove from selected if deleted
          filterByCategory();
        });
      }
    });
  }

  // Toggle category collapse/expand
  function toggleCategoryCollapse(event) {
    const category = event.currentTarget.getAttribute("data-category");
    
    if (collapsedCategories.has(category)) {
      collapsedCategories.delete(category);
    } else {
      collapsedCategories.add(category);
    }
    
    // Save collapsed state to storage
    chrome.storage.local.set({ collapsedCategories: Array.from(collapsedCategories) });
    
    // Toggle the UI without full re-render
    const categoryList = document.querySelector(`.category-tabs-list[data-category="${category}"]`);
    const collapseIcon = event.currentTarget.querySelector('.collapse-icon');
    
    if (categoryList) {
      categoryList.classList.toggle('collapsed');
    }
    
    if (collapseIcon) {
      collapseIcon.classList.toggle('collapsed');
    }
    
    // Update collapse all button state
    updateCollapseAllButton();
  }

  // Toggle collapse all categories
  function toggleCollapseAll() {
    const selectedCategory = categorySelect.value;
    
    // Only works in grouped view (when "All" is selected)
    if (selectedCategory !== "All") return;
    
    // Get all categories currently displayed
    const displayedCategories = [];
    document.querySelectorAll('.category-tabs-list[data-category]').forEach(list => {
      displayedCategories.push(list.dataset.category);
    });
    
    if (displayedCategories.length === 0) return;
    
    // Check if all are collapsed
    const allCollapsed = displayedCategories.every(cat => collapsedCategories.has(cat));
    
    if (allCollapsed) {
      // Expand all
      displayedCategories.forEach(cat => collapsedCategories.delete(cat));
    } else {
      // Collapse all
      displayedCategories.forEach(cat => collapsedCategories.add(cat));
    }
    
    // Save state
    chrome.storage.local.set({ collapsedCategories: Array.from(collapsedCategories) });
    
    // Update UI without re-render
    document.querySelectorAll('.category-tabs-list').forEach(list => {
      const category = list.dataset.category;
      if (category) {
        if (collapsedCategories.has(category)) {
          list.classList.add('collapsed');
        } else {
          list.classList.remove('collapsed');
        }
      }
    });
    
    // Update collapse icons
    document.querySelectorAll('.collapse-btn').forEach(btn => {
      const category = btn.getAttribute('data-category');
      const icon = btn.querySelector('.collapse-icon');
      if (icon && category) {
        if (collapsedCategories.has(category)) {
          icon.classList.add('collapsed');
        } else {
          icon.classList.remove('collapsed');
        }
      }
    });
    
    updateCollapseAllButton();
  }

  // Update collapse all button text and icon
  function updateCollapseAllButton() {
    const selectedCategory = categorySelect.value;
    const collapseAllText = document.getElementById('collapseAllText');
    
    // Hide button in flat view
    if (selectedCategory !== "All") {
      collapseAllBtn.style.display = 'none';
      return;
    }
    
    collapseAllBtn.style.display = 'flex';
    
    // Get all displayed categories
    const displayedCategories = [];
    document.querySelectorAll('.category-tabs-list[data-category]').forEach(list => {
      displayedCategories.push(list.dataset.category);
    });
    
    if (displayedCategories.length === 0) {
      collapseAllBtn.style.display = 'none';
      return;
    }
    
    // Check if all are collapsed
    const allCollapsed = displayedCategories.every(cat => collapsedCategories.has(cat));
    
    if (allCollapsed) {
      collapseAllText.textContent = 'Expand All';
      collapseAllBtn.classList.add('all-collapsed');
    } else {
      collapseAllText.textContent = 'Collapse All';
      collapseAllBtn.classList.remove('all-collapsed');
    }
  }

  // Handle individual tab checkbox
  function handleTabCheckbox(event) {
    const url = event.target.getAttribute("data-url");
    
    if (event.target.checked) {
      selectedTabs.add(url);
    } else {
      selectedTabs.delete(url);
    }
    
    updateSelectionUI(); // Update UI without full re-render
  }

  // Handle select all checkbox for a category
  function handleSelectAllCheckbox(event) {
    const category = event.currentTarget.getAttribute("data-category");
    const categoryTabs = allSavedTabs.filter(tab => tab.category === category);
    
    if (event.target.checked) {
      categoryTabs.forEach(tab => selectedTabs.add(tab.url));
    } else {
      categoryTabs.forEach(tab => selectedTabs.delete(tab.url));
    }
    
    updateSelectionUI(); // Update UI without full re-render
  }

  // Handle select all checkbox for flat view
  function handleSelectAllFlat(event) {
    const selectedCategory = categorySelect.value;
    let tabs = allSavedTabs;
    
    if (selectedCategory !== "All") {
      tabs = allSavedTabs.filter(tab => tab.category === selectedCategory);
    }
    
    // Apply search filter if active
    const query = searchInput.value.toLowerCase();
    if (query) {
      tabs = tabs.filter(
        (tab) =>
          tab.title.toLowerCase().includes(query) ||
          tab.url.toLowerCase().includes(query)
      );
    }
    
    if (event.target.checked) {
      tabs.forEach(tab => selectedTabs.add(tab.url));
    } else {
      tabs.forEach(tab => selectedTabs.delete(tab.url));
    }
    
    updateSelectionUI(); // Update UI without full re-render
  }

  // Open selected tabs in a specific category
  function openSelectedCategoryTabs(event) {
    const category = event.currentTarget.getAttribute("data-category");
    const categoryTabs = allSavedTabs.filter(tab => 
      tab.category === category && selectedTabs.has(tab.url)
    );
    
    if (categoryTabs.length === 0) return;
    
    // Open all tabs and collect their IDs
    const tabPromises = categoryTabs.map(tab => 
      chrome.tabs.create({ url: tab.url, active: false })
    );
    
    Promise.all(tabPromises).then(createdTabs => {
      const tabIds = createdTabs.map(tab => tab.id);
      
      // Create tab group
      chrome.tabs.group({ tabIds }, (groupId) => {
        chrome.tabGroups.update(groupId, {
          title: `${category} (Selected)`,
          color: getGroupColor(category),
          collapsed: false
        });
      });
    });
  }

  // Open selected tabs (flat view)
  function openSelectedTabs() {
    const tabsToOpen = allSavedTabs.filter(tab => selectedTabs.has(tab.url));
    
    if (tabsToOpen.length === 0) return;
    
    // Open all tabs and collect their IDs
    const tabPromises = tabsToOpen.map(tab => 
      chrome.tabs.create({ url: tab.url, active: false })
    );
    
    Promise.all(tabPromises).then(createdTabs => {
      const tabIds = createdTabs.map(tab => tab.id);
      
      // Create tab group
      chrome.tabs.group({ tabIds }, (groupId) => {
        const now = new Date();
        chrome.tabGroups.update(groupId, {
          title: `Selected (${now.toLocaleTimeString()})`,
          color: 'blue',
          collapsed: false
        });
      });
    });
  }

  // Handle category change for a tab
  function handleCategoryChange(event) {
    const url = event.target.getAttribute("data-url");
    const newCategory = event.target.value;
    
    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      const savedTabs = result.savedTabs;
      const tabIndex = savedTabs.findIndex(tab => tab.url === url);
      
      if (tabIndex !== -1) {
        savedTabs[tabIndex].category = newCategory;
        chrome.storage.local.set({ savedTabs }, () => {
          allSavedTabs = savedTabs;
          filterByCategory(); // Re-render to show in new category
        });
      }
    });
  }

  // Get color for tab group based on category name
  function getGroupColor(category) {
    const colors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    // Hash category name to get consistent color
    let hash = 0;
    for (let i = 0; i < category.length; i++) {
      hash = category.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  // Update selection UI without full re-render
  function updateSelectionUI() {
    // Update all individual checkboxes state
    document.querySelectorAll('.tab-checkbox').forEach(checkbox => {
      const url = checkbox.getAttribute('data-url');
      checkbox.checked = selectedTabs.has(url);
    });

    // Update select-all checkboxes for each category
    const selectedCategory = categorySelect.value;
    
    if (selectedCategory === "All") {
      // Grouped view - update each category's select-all checkbox
      document.querySelectorAll('.select-all-checkbox').forEach(checkbox => {
        const category = checkbox.getAttribute('data-category');
        const categoryTabs = allSavedTabs.filter(tab => tab.category === category);
        const selectedCount = categoryTabs.filter(tab => selectedTabs.has(tab.url)).length;
        
        checkbox.checked = selectedCount === categoryTabs.length && categoryTabs.length > 0;
        checkbox.indeterminate = selectedCount > 0 && selectedCount < categoryTabs.length;
        
        // Update "Open Selected" button visibility and count
        const header = checkbox.closest('.category-header');
        if (header) {
          const actionsDiv = header.querySelector('.category-header-actions');
          let openSelectedBtn = actionsDiv.querySelector('.open-selected-category-btn');
          
          if (selectedCount > 0) {
            if (!openSelectedBtn) {
              // Create button if it doesn't exist
              openSelectedBtn = document.createElement('button');
              openSelectedBtn.className = 'open-selected-category-btn';
              openSelectedBtn.setAttribute('data-category', category);
              openSelectedBtn.title = `Open ${selectedCount} selected tabs`;
              openSelectedBtn.addEventListener('click', openSelectedCategoryTabs);
              actionsDiv.insertBefore(openSelectedBtn, actionsDiv.firstChild);
            }
            openSelectedBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
              </svg>
              Open Selected (${selectedCount})
            `;
            openSelectedBtn.title = `Open ${selectedCount} selected tabs`;
          } else if (openSelectedBtn) {
            // Remove button if no selections
            openSelectedBtn.remove();
          }
        }
      });
    } else {
      // Flat view - update single select-all checkbox
      const selectAllCheckbox = document.querySelector('.select-all-checkbox-flat');
      if (selectAllCheckbox) {
        let tabs = allSavedTabs;
        if (selectedCategory !== "All") {
          tabs = allSavedTabs.filter(tab => tab.category === selectedCategory);
        }
        
        const query = searchInput.value.toLowerCase();
        if (query) {
          tabs = tabs.filter(tab =>
            tab.title.toLowerCase().includes(query) ||
            tab.url.toLowerCase().includes(query)
          );
        }
        
        const selectedCount = tabs.filter(tab => selectedTabs.has(tab.url)).length;
        selectAllCheckbox.checked = selectedCount === tabs.length && tabs.length > 0;
        selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < tabs.length;
        
        // Update "Open Selected" button
        const header = selectAllCheckbox.closest('.category-header');
        if (header) {
          const actionsDiv = header.querySelector('.category-header-actions');
          let openSelectedBtn = actionsDiv.querySelector('.open-selected-flat-btn');
          
          if (selectedCount > 0) {
            if (!openSelectedBtn) {
              openSelectedBtn = document.createElement('button');
              openSelectedBtn.className = 'open-selected-flat-btn';
              openSelectedBtn.title = `Open ${selectedCount} selected tabs`;
              openSelectedBtn.addEventListener('click', openSelectedTabs);
              actionsDiv.appendChild(openSelectedBtn);
            }
            openSelectedBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
              </svg>
              Open Selected (${selectedCount})
            `;
            openSelectedBtn.title = `Open ${selectedCount} selected tabs`;
          } else if (openSelectedBtn) {
            openSelectedBtn.remove();
          }
        }
      }
    }
  }
});
