document.addEventListener("DOMContentLoaded", () => {
  // --- DOM Elements ---
  const saveTabButton = document.getElementById("saveTab");
  const saveAllTabsButton = document.getElementById("saveAllTabs");
  const settingsButton = document.getElementById("settingsButton");
  const searchInput = document.getElementById("search");
  const categorySelect = document.getElementById("category");
  const saveCategorySelect = document.getElementById("saveCategory");
  const sortBySelect = document.getElementById("sortBy");
  const dateFilterSelect = document.getElementById("dateFilter");
  const collapseAllBtn = document.getElementById("collapseAllBtn");
  const noTabsMessage = document.getElementById("noTabsMessage");
  const tabList = document.getElementById("tabList");
  const floatingOpenSelected = document.getElementById("floatingOpenSelected");
  const openSelectedBtn = document.getElementById("openSelectedBtn");
  const openSelectedCount = document.getElementById("openSelectedCount");
  const toast = document.getElementById("toast");

  // --- Event Listeners ---
  saveTabButton.addEventListener("click", saveCurrentTab);
  saveAllTabsButton.addEventListener("click", saveAllTabs);
  settingsButton.addEventListener("click", () => {
    document.body.classList.add("page-exit");
    setTimeout(() => (window.location.href = "settings.html"), 100);
  });
  searchInput.addEventListener("input", debounce(applyFilters, 150));
  sortBySelect.addEventListener("change", applyFilters);
  dateFilterSelect.addEventListener("change", applyFilters);
  categorySelect.addEventListener("change", applyFilters);
  collapseAllBtn.addEventListener("click", toggleCollapseAll);
  openSelectedBtn.addEventListener("click", openAllSelectedTabs);

  // --- State ---
  let categories = ["All"];
  let allSavedTabs = [];
  let collapsedCategories = new Set();
  let selectedTabs = new Set();
  let hiddenCategories = new Set();
  let categoryOrder = [];
  let categoryLastOpened = {};
  let draggedCategory = null;

  // --- Prevent popup from closing when clicking tab links ---
  tabList.addEventListener("click", (e) => {
    const link = e.target.closest("a");
    if (link && link.href) {
      e.preventDefault();
      chrome.tabs.create({ url: link.href, active: false });
    }
  });

  // --- Dynamic tooltip for Save All Tabs ---
  function updateSaveAllTooltip() {
    const cat = saveCategorySelect.value || "All";
    saveAllTabsButton.title = `Save all currently open tabs to "${cat}" category`;
  }
  saveCategorySelect.addEventListener("change", updateSaveAllTooltip);

  // --- Initial Data Load ---
  chrome.storage.local.get(
    {
      categories: ["All"],
      savedTabs: [],
      collapsedCategories: [],
      hiddenCategories: [],
      categoryOrder: [],
      categoryLastOpened: {},
    },
    (result) => {
      categories = result.categories;
      allSavedTabs = result.savedTabs;
      collapsedCategories = new Set(result.collapsedCategories || []);
      hiddenCategories = new Set(result.hiddenCategories || []);
      categoryOrder = result.categoryOrder || [];
      categoryLastOpened = result.categoryLastOpened || {};
      updateCategoryDropdown();
      updateDateFilterOptions();
      categorySelect.value = "All";
      updateSaveAllTooltip();
      [sortBySelect, dateFilterSelect, saveCategorySelect, categorySelect].forEach(upgradeSelect);
      applyFilters();
    }
  );

  // ===================== UTILITIES =====================

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function showToast(message, duration = 2000) {
    toast.textContent = message;
    toast.classList.remove("hidden");
    toast.classList.add("show");
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.classList.add("hidden"), 300);
    }, duration);
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return (text || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
    return `${Math.floor(diff / 31536000)}y ago`;
  }

  function getGroupColor(category) {
    const colors = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
    let hash = 0;
    for (let i = 0; i < category.length; i++) {
      hash = category.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  // ===================== CUSTOM DROPDOWN =====================

  function upgradeSelect(selectEl) {
    const wrapper = document.createElement("div");
    wrapper.className = "custom-dropdown";
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(selectEl);

    const trigger = document.createElement("div");
    trigger.className = "custom-dropdown-trigger";
    wrapper.appendChild(trigger);

    const panel = document.createElement("div");
    panel.className = "custom-dropdown-options";
    wrapper.appendChild(panel);

    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    Object.defineProperty(selectEl, "value", {
      get() { return proto.get.call(this); },
      set(v) {
        proto.set.call(this, v);
        syncTrigger();
      },
    });

    function syncTrigger() {
      const opt = selectEl.options[selectEl.selectedIndex];
      trigger.textContent = opt ? opt.textContent : "";
    }

    function buildOptions() {
      panel.innerHTML = "";
      const current = proto.get.call(selectEl);
      for (const opt of selectEl.options) {
        const div = document.createElement("div");
        div.className = "custom-dropdown-option";
        if (opt.value === current) div.classList.add("selected");
        div.textContent = opt.textContent;
        div.addEventListener("click", (e) => {
          e.stopPropagation();
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));
          wrapper.classList.remove("open", "open-up");
        });
        panel.appendChild(div);
      }
      syncTrigger();
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = wrapper.classList.contains("open");
      document.querySelectorAll(".custom-dropdown.open").forEach((d) => d.classList.remove("open", "open-up"));
      if (!wasOpen) {
        buildOptions();
        const rect = wrapper.getBoundingClientRect();
        if (window.innerHeight - rect.bottom < 240) wrapper.classList.add("open-up");
        wrapper.classList.add("open");
        const sel = panel.querySelector(".selected");
        if (sel) sel.scrollIntoView({ block: "nearest" });
      }
    });

    new MutationObserver(syncTrigger).observe(selectEl, { childList: true, subtree: true });
    syncTrigger();
  }

  document.addEventListener("click", () => {
    document.querySelectorAll(".custom-dropdown.open").forEach((d) => d.classList.remove("open", "open-up"));
  });

  // ===================== DROPDOWNS =====================

  function updateCategoryDropdown() {
    categorySelect.innerHTML = categories
      .map((cat) => `<option value="${escapeAttr(cat)}">${escapeHtml(cat)}</option>`)
      .join("");

    const saveCats = categories.filter((c) => c !== "All");
    if (saveCats.length === 0) saveCats.push("All");
    saveCategorySelect.innerHTML = saveCats
      .map((cat) => `<option value="${escapeAttr(cat)}">${escapeHtml(cat)}</option>`)
      .join("");
  }

  function updateDateFilterOptions() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysSet = new Set();

    allSavedTabs.forEach((tab) => {
      const d = new Date(tab.date);
      const tabDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const diff = Math.floor((today - tabDay) / 86400000);
      if (diff >= 0) daysSet.add(diff);
    });

    const prevValue = dateFilterSelect.value;
    const sorted = [...daysSet].sort((a, b) => a - b);
    let html = '<option value="all">All Time</option>';
    sorted.forEach((days) => {
      if (days === 0) html += '<option value="0">Today</option>';
      else if (days === 1) html += '<option value="1">Yesterday</option>';
      else html += `<option value="${days}">${days} days ago</option>`;
    });
    dateFilterSelect.innerHTML = html;

    // Restore previous selection if still valid
    if ([...dateFilterSelect.options].some((o) => o.value === prevValue)) {
      dateFilterSelect.value = prevValue;
    }
  }

  // ===================== FILTERING & SORTING =====================

  function applyFilters() {
    const selectedCategory = categorySelect.value;
    const query = searchInput.value.toLowerCase();
    const sortBy = sortBySelect.value;
    const dateFilter = dateFilterSelect.value;

    let filtered = [...allSavedTabs];

    if (selectedCategory !== "All") {
      filtered = filtered.filter((t) => t.category === selectedCategory);
    }

    if (dateFilter !== "all") {
      const days = parseInt(dateFilter, 10);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const start = new Date(today.getTime() - days * 86400000);
      const end = new Date(start.getTime() + 86400000);
      filtered = filtered.filter((t) => {
        const d = new Date(t.date);
        return d >= start && d < end;
      });
    }

    if (query) {
      filtered = filtered.filter(
        (t) =>
          t.title.toLowerCase().includes(query) ||
          t.url.toLowerCase().includes(query)
      );
    }

    filtered = sortTabs(filtered, sortBy);
    displaySavedTabs(filtered);
    updateCollapseAllButton();
    updateFloatingButton();
  }

  function sortTabs(tabs, sortBy) {
    const s = [...tabs];
    switch (sortBy) {
      case "date-desc":
        return s.sort((a, b) => new Date(b.date) - new Date(a.date));
      case "date-asc":
        return s.sort((a, b) => new Date(a.date) - new Date(b.date));
      case "title-asc":
        return s.sort((a, b) => a.title.localeCompare(b.title));
      case "title-desc":
        return s.sort((a, b) => b.title.localeCompare(a.title));
      default:
        return s.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
  }

  // ===================== DISPLAY =====================

  function displaySavedTabs(tabs) {
    const fragment = document.createDocumentFragment();

    if (tabs.length === 0) {
      tabList.innerHTML = "";
      noTabsMessage.classList.remove("hidden");
      return;
    }

    noTabsMessage.classList.add("hidden");
    const selectedCategory = categorySelect.value;

    if (selectedCategory === "All") {
      buildGroupedTabs(tabs, fragment);
    } else {
      buildFlatTabs(tabs, fragment);
    }

    tabList.innerHTML = "";
    tabList.appendChild(fragment);

    // Set indeterminate states after DOM insertion
    tabList.querySelectorAll('[data-indeterminate="true"]').forEach((cb) => {
      cb.indeterminate = true;
    });

    attachTabListeners();
  }

  function getCategoryDisplayOrder(catNames) {
    if (categoryOrder.length > 0) {
      return [...catNames].sort((a, b) => {
        const ai = categoryOrder.indexOf(a);
        const bi = categoryOrder.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        const at = categoryLastOpened[a]
          ? new Date(categoryLastOpened[a]).getTime()
          : 0;
        const bt = categoryLastOpened[b]
          ? new Date(categoryLastOpened[b]).getTime()
          : 0;
        if (at !== bt) return bt - at;
        return a.localeCompare(b);
      });
    }

    // Default: recently opened first, then alphabetical
    return [...catNames].sort((a, b) => {
      const at = categoryLastOpened[a]
        ? new Date(categoryLastOpened[a]).getTime()
        : 0;
      const bt = categoryLastOpened[b]
        ? new Date(categoryLastOpened[b]).getTime()
        : 0;
      if (at !== bt) return bt - at;
      return a.localeCompare(b);
    });
  }

  function buildGroupedTabs(tabs, fragment) {
    const grouped = {};
    tabs.forEach((t) => {
      const cat = t.category || "All";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(t);
    });

    const ordered = getCategoryDisplayOrder(Object.keys(grouped));

    ordered.forEach((category) => {
      const catTabs = grouped[category];
      const isCollapsed = collapsedCategories.has(category);
      const isHidden = hiddenCategories.has(category);
      const selCount = catTabs.filter((t) => selectedTabs.has(t.url)).length;
      const allSel = selCount === catTabs.length;
      const someSel = selCount > 0 && !allSel;

      const header = document.createElement("div");
      header.className = "category-header";
      header.draggable = true;
      header.dataset.category = category;
      header.innerHTML = `
        <div class="category-header-left">
          <span class="drag-handle" title="Drag to reorder">\u2807</span>
          <button class="collapse-btn" data-category="${escapeAttr(category)}" title="${isCollapsed ? "Expand" : "Collapse"}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="collapse-icon ${isCollapsed ? "collapsed" : ""}">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <input type="checkbox" class="select-all-checkbox" data-category="${escapeAttr(category)}" ${allSel ? "checked" : ""} ${someSel ? 'data-indeterminate="true"' : ""} title="Select all in category">
          <h3>${escapeHtml(category)} <span class="tab-count">(${catTabs.length})</span></h3>
        </div>
        <div class="category-header-actions">
          <button class="hide-category-btn ${isHidden ? "is-hidden" : ""}" data-category="${escapeAttr(category)}" title="${isHidden ? "Show category" : "Hide for privacy"}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${
                isHidden
                  ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
                  : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
              }
            </svg>
          </button>
          <button class="open-category-btn" data-category="${escapeAttr(category)}" title="Open all tabs in category">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
            </svg>
            Open All
          </button>
        </div>
      `;
      fragment.appendChild(header);

      const list = document.createElement("ul");
      list.className = `category-tabs-list${isCollapsed ? " collapsed" : ""}${isHidden ? " privacy-blur" : ""}`;
      list.dataset.category = category;

      catTabs.forEach((tab) => list.appendChild(createTabLi(tab)));
      fragment.appendChild(list);
    });
  }

  function buildFlatTabs(tabs, fragment) {
    const selCount = tabs.filter((t) => selectedTabs.has(t.url)).length;
    const allSel = selCount === tabs.length && tabs.length > 0;
    const someSel = selCount > 0 && !allSel;

    if (tabs.length > 0) {
      const header = document.createElement("div");
      header.className = "category-header";
      header.innerHTML = `
        <div class="category-header-left">
          <input type="checkbox" class="select-all-checkbox-flat" ${allSel ? "checked" : ""} ${someSel ? 'data-indeterminate="true"' : ""} title="Select all tabs">
          <h3>Tabs <span class="tab-count">(${tabs.length})</span></h3>
        </div>
      `;
      fragment.appendChild(header);
    }

    const ul = document.createElement("ul");
    ul.className = "category-tabs-list";
    tabs.forEach((tab) => ul.appendChild(createTabLi(tab, true)));
    fragment.appendChild(ul);
  }

  function createTabLi(tab, showCategory = false) {
    const sel = selectedTabs.has(tab.url);
    const li = document.createElement("li");
    li.innerHTML = `
      <input type="checkbox" class="tab-checkbox" data-url="${escapeAttr(tab.url)}" ${sel ? "checked" : ""} title="Select tab">
      <img src="${tab.favicon || "icons/default-favicon.png"}" alt="">
      <div class="tab-info">
        <a href="${escapeAttr(tab.url)}" title="${escapeAttr(tab.title)}">${escapeHtml(tab.title)}</a>
        <div class="metadata">
          ${showCategory ? `<span>${escapeHtml(tab.category)}</span> &bull; ` : ""}
          <span>${formatDate(tab.date)}</span>
        </div>
      </div>
      <button class="rename-btn" data-url="${escapeAttr(tab.url)}" title="Rename">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <select class="change-category-select" data-url="${escapeAttr(tab.url)}" title="Change category">
        ${categories
          .map(
            (c) =>
              `<option value="${escapeAttr(c)}" ${c === tab.category ? "selected" : ""}>${escapeHtml(c)}</option>`
          )
          .join("")}
      </select>
      <button class="deleteButton" data-url="${escapeAttr(tab.url)}" title="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    `;

    const img = li.querySelector("img");
    if (img) {
      img.addEventListener("error", () => {
        img.src = "icons/default-favicon.png";
      });
    }

    return li;
  }

  // ===================== EVENT LISTENER ATTACHMENT =====================

  function attachTabListeners() {
    tabList
      .querySelectorAll(".deleteButton")
      .forEach((b) => b.addEventListener("click", deleteTab));
    tabList
      .querySelectorAll(".rename-btn")
      .forEach((b) => b.addEventListener("click", startRename));
    tabList
      .querySelectorAll(".open-category-btn")
      .forEach((b) => b.addEventListener("click", openCategoryTabs));
    tabList
      .querySelectorAll(".collapse-btn")
      .forEach((b) => b.addEventListener("click", toggleCategoryCollapse));
    tabList
      .querySelectorAll(".tab-checkbox")
      .forEach((cb) => cb.addEventListener("change", handleTabCheckbox));
    tabList
      .querySelectorAll(".select-all-checkbox")
      .forEach((cb) =>
        cb.addEventListener("change", handleSelectAllCheckbox)
      );
    tabList
      .querySelectorAll(".change-category-select")
      .forEach((s) => s.addEventListener("change", handleCategoryChange));
    tabList
      .querySelectorAll(".hide-category-btn")
      .forEach((b) => b.addEventListener("click", toggleHideCategory));

    const flatAll = tabList.querySelector(".select-all-checkbox-flat");
    if (flatAll) flatAll.addEventListener("change", handleSelectAllFlat);

    // Drag-and-drop on category headers
    tabList
      .querySelectorAll(".category-header[draggable]")
      .forEach((h) => {
        h.addEventListener("dragstart", onDragStart);
        h.addEventListener("dragend", onDragEnd);
        h.addEventListener("dragover", onDragOver);
        h.addEventListener("dragleave", onDragLeave);
        h.addEventListener("drop", onDrop);
      });
  }

  // ===================== RENAME =====================

  function startRename(event) {
    const url =
      event.currentTarget.dataset.url ||
      event.currentTarget.getAttribute("data-url");
    const li = event.currentTarget.closest("li");
    const link = li.querySelector("a");
    const oldTitle = link.textContent;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "rename-input";
    input.value = oldTitle;
    input.maxLength = 200;

    link.style.display = "none";
    link.parentNode.insertBefore(input, link);
    input.focus();
    input.select();

    const finish = () => {
      const newTitle = input.value.trim() || oldTitle;
      if (newTitle !== oldTitle) {
        const idx = allSavedTabs.findIndex((t) => t.url === url);
        if (idx !== -1) {
          allSavedTabs[idx].title = newTitle;
          chrome.storage.local.set({ savedTabs: allSavedTabs });
          link.textContent = newTitle;
          link.title = newTitle;
        }
      }
      input.remove();
      link.style.display = "";
    };

    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        input.value = oldTitle;
        input.blur();
      }
    });
  }

  // ===================== SAVE =====================

  function saveCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      saveTab(tab, () => {
        showToast(`\u2713 Tab saved to "${saveCategorySelect.value}"`);
        saveTabButton.classList.add("btn-saved");
        setTimeout(() => saveTabButton.classList.remove("btn-saved"), 600);
      });
    });
  }

  async function saveAllTabs() {
    try {
      const windows = await chrome.windows.getAll({ populate: true });
      const allTabs = windows.flatMap((w) => w.tabs);
      const category = saveCategorySelect.value;
      const { savedTabs: existing = [] } = await chrome.storage.local.get({
        savedTabs: [],
      });

      const newData = allTabs.map((t) => ({
        url: t.url,
        title: t.title,
        favicon: t.favIconUrl,
        date: new Date().toISOString(),
        category,
      }));

      const merged = [...existing];
      newData.forEach((nt) => {
        const i = merged.findIndex((t) => t.url === nt.url);
        if (i !== -1) merged[i] = nt;
        else merged.push(nt);
      });

      await chrome.storage.local.set({ savedTabs: merged });
      allSavedTabs = merged;
      updateDateFilterOptions();
      applyFilters();
      showToast(`\u2713 ${allTabs.length} tabs saved to "${category}"`);
    } catch (err) {
      console.error("Error saving all tabs:", err);
    }
  }

  function saveTab(tab, callback) {
    const category = saveCategorySelect.value;
    const data = {
      url: tab.url,
      title: tab.title,
      favicon: tab.favIconUrl,
      date: new Date().toISOString(),
      category,
    };

    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      const saved = result.savedTabs;
      const i = saved.findIndex((t) => t.url === data.url);
      if (i !== -1) saved[i] = data;
      else saved.push(data);

      chrome.storage.local.set({ savedTabs: saved }, () => {
        allSavedTabs = saved;
        updateDateFilterOptions();
        applyFilters();
        if (callback) callback();
      });
    });
  }

  // ===================== DELETE =====================

  function deleteTab(event) {
    const url = event.currentTarget.getAttribute("data-url");
    const idx = allSavedTabs.findIndex((t) => t.url === url);
    if (idx === -1) return;

    allSavedTabs.splice(idx, 1);
    selectedTabs.delete(url);
    chrome.storage.local.set({ savedTabs: allSavedTabs });

    // Animate removal instead of full re-render
    const li = event.currentTarget.closest("li");
    if (li) {
      li.classList.add("removing");
      setTimeout(() => {
        li.remove();
        updateHeaderCounts();
        updateFloatingButton();
        updateDateFilterOptions();
        if (allSavedTabs.length === 0) noTabsMessage.classList.remove("hidden");
      }, 200);
    }
  }

  function updateHeaderCounts() {
    tabList
      .querySelectorAll(".category-header[data-category]")
      .forEach((header) => {
        const cat = header.dataset.category;
        const list = tabList.querySelector(
          `.category-tabs-list[data-category="${CSS.escape(cat)}"]`
        );
        if (!list) return;
        const count = list.querySelectorAll("li:not(.removing)").length;
        const span = header.querySelector(".tab-count");
        if (span) span.textContent = `(${count})`;
        if (count === 0) {
          header.remove();
          list.remove();
        }
      });
  }

  // ===================== OPEN TABS =====================
  function openCategoryTabs(event) {
    const category = event.currentTarget.getAttribute("data-category");
    const tabs = allSavedTabs.filter((t) => t.category === category);
    if (!tabs.length) return;

    // Track recently opened & move to top of order
    categoryLastOpened[category] = new Date().toISOString();
    categoryOrder = [
      category,
      ...categoryOrder.filter((c) => c !== category),
    ];
    chrome.storage.local.set({ categoryLastOpened, categoryOrder });

    const promises = tabs.map((t) =>
      chrome.tabs.create({ url: t.url, active: false })
    );
    Promise.all(promises).then((created) => {
      const ids = created.map((t) => t.id);
      chrome.tabs.group({ tabIds: ids }, (gid) => {
        chrome.tabGroups.update(gid, {
          title: category,
          color: getGroupColor(category),
          collapsed: false,
        });
      });
    });
  }

  function openAllSelectedTabs() {
    const toOpen = allSavedTabs.filter((t) => selectedTabs.has(t.url));
    if (!toOpen.length) return;

    // Track recently opened for affected categories
    const cats = new Set(toOpen.map((t) => t.category));
    cats.forEach((cat) => {
      categoryLastOpened[cat] = new Date().toISOString();
      categoryOrder = [cat, ...categoryOrder.filter((c) => c !== cat)];
    });
    chrome.storage.local.set({ categoryLastOpened, categoryOrder });

    // Group selected tabs by category and open each group
    const grouped = {};
    toOpen.forEach((t) => {
      if (!grouped[t.category]) grouped[t.category] = [];
      grouped[t.category].push(t);
    });

    Object.entries(grouped).forEach(([cat, tabs]) => {
      Promise.all(
        tabs.map((t) => chrome.tabs.create({ url: t.url, active: false }))
      ).then((created) => {
        const ids = created.map((t) => t.id);
        chrome.tabs.group({ tabIds: ids }, (gid) => {
          chrome.tabGroups.update(gid, {
            title: cat,
            color: getGroupColor(cat),
            collapsed: false,
          });
        });
      });
    });

    showToast(`Opening ${toOpen.length} selected tabs`);
  }

  // ===================== COLLAPSE / EXPAND =====================

  function toggleCategoryCollapse(event) {
    event.stopPropagation();
    const cat = event.currentTarget.getAttribute("data-category");
    collapsedCategories.has(cat)
      ? collapsedCategories.delete(cat)
      : collapsedCategories.add(cat);
    chrome.storage.local.set({
      collapsedCategories: [...collapsedCategories],
    });

    const list = tabList.querySelector(
      `.category-tabs-list[data-category="${CSS.escape(cat)}"]`
    );
    const icon = event.currentTarget.querySelector(".collapse-icon");
    if (list) list.classList.toggle("collapsed");
    if (icon) icon.classList.toggle("collapsed");
    updateCollapseAllButton();
  }

  function toggleCollapseAll() {
    const displayed = [
      ...tabList.querySelectorAll(".category-tabs-list[data-category]"),
    ].map((l) => l.dataset.category);
    if (!displayed.length) return;

    const allCollapsed = displayed.every((c) => collapsedCategories.has(c));
    displayed.forEach((c) =>
      allCollapsed
        ? collapsedCategories.delete(c)
        : collapsedCategories.add(c)
    );
    chrome.storage.local.set({
      collapsedCategories: [...collapsedCategories],
    });

    tabList.querySelectorAll(".category-tabs-list[data-category]").forEach((l) => {
      l.classList.toggle("collapsed", collapsedCategories.has(l.dataset.category));
    });
    tabList.querySelectorAll(".collapse-btn").forEach((btn) => {
      const c = btn.getAttribute("data-category");
      const icon = btn.querySelector(".collapse-icon");
      if (icon && c)
        icon.classList.toggle("collapsed", collapsedCategories.has(c));
    });
    updateCollapseAllButton();
  }

  function updateCollapseAllButton() {
    const text = document.getElementById("collapseAllText");
    // Always visible (#5)
    collapseAllBtn.style.display = "flex";

    const displayed = [
      ...tabList.querySelectorAll(".category-tabs-list[data-category]"),
    ].map((l) => l.dataset.category);
    if (!displayed.length) {
      collapseAllBtn.style.display = "none";
      return;
    }

    const allCollapsed = displayed.every((c) => collapsedCategories.has(c));
    text.textContent = allCollapsed ? "Expand All" : "Collapse All";
    collapseAllBtn.classList.toggle("all-collapsed", allCollapsed);
  }

  // ===================== SELECTION =====================

  function handleTabCheckbox(event) {
    const url = event.target.getAttribute("data-url");
    event.target.checked ? selectedTabs.add(url) : selectedTabs.delete(url);
    updateSelectionUI();
    updateFloatingButton();
  }

  function handleSelectAllCheckbox(event) {
    const cat = event.currentTarget.getAttribute("data-category");
    const tabs = allSavedTabs.filter((t) => t.category === cat);
    tabs.forEach((t) =>
      event.target.checked
        ? selectedTabs.add(t.url)
        : selectedTabs.delete(t.url)
    );
    updateSelectionUI();
    updateFloatingButton();
  }

  function handleSelectAllFlat(event) {
    getFilteredTabs().forEach((t) =>
      event.target.checked
        ? selectedTabs.add(t.url)
        : selectedTabs.delete(t.url)
    );
    updateSelectionUI();
    updateFloatingButton();
  }

  function getFilteredTabs() {
    let tabs = allSavedTabs;
    const cat = categorySelect.value;
    if (cat !== "All") tabs = tabs.filter((t) => t.category === cat);
    const q = searchInput.value.toLowerCase();
    if (q)
      tabs = tabs.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.url.toLowerCase().includes(q)
      );
    return tabs;
  }

  function updateSelectionUI() {
    tabList.querySelectorAll(".tab-checkbox").forEach((cb) => {
      cb.checked = selectedTabs.has(cb.getAttribute("data-url"));
    });

    if (categorySelect.value === "All") {
      tabList.querySelectorAll(".select-all-checkbox").forEach((cb) => {
        const cat = cb.getAttribute("data-category");
        const tabs = allSavedTabs.filter((t) => t.category === cat);
        const cnt = tabs.filter((t) => selectedTabs.has(t.url)).length;
        cb.checked = cnt === tabs.length && tabs.length > 0;
        cb.indeterminate = cnt > 0 && cnt < tabs.length;
      });
    } else {
      const flat = tabList.querySelector(".select-all-checkbox-flat");
      if (flat) {
        const tabs = getFilteredTabs();
        const cnt = tabs.filter((t) => selectedTabs.has(t.url)).length;
        flat.checked = cnt === tabs.length && tabs.length > 0;
        flat.indeterminate = cnt > 0 && cnt < tabs.length;
      }
    }
  }

  function updateFloatingButton() {
    const cnt = selectedTabs.size;
    if (cnt > 0) {
      openSelectedCount.textContent = cnt;
      floatingOpenSelected.classList.remove("hidden");
    } else {
      floatingOpenSelected.classList.add("hidden");
    }
  }

  // ===================== CATEGORY CHANGE =====================

  function handleCategoryChange(event) {
    const url = event.target.getAttribute("data-url");
    const newCat = event.target.value;
    const idx = allSavedTabs.findIndex((t) => t.url === url);
    if (idx !== -1) {
      allSavedTabs[idx].category = newCat;
      chrome.storage.local.set({ savedTabs: allSavedTabs }, applyFilters);
    }
  }

  // ===================== PRIVACY HIDE =====================

  function toggleHideCategory(event) {
    const cat = event.currentTarget.getAttribute("data-category");
    hiddenCategories.has(cat)
      ? hiddenCategories.delete(cat)
      : hiddenCategories.add(cat);
    chrome.storage.local.set({ hiddenCategories: [...hiddenCategories] });

    const list = tabList.querySelector(
      `.category-tabs-list[data-category="${CSS.escape(cat)}"]`
    );
    if (list) list.classList.toggle("privacy-blur");

    const btn = event.currentTarget;
    const isHidden = hiddenCategories.has(cat);
    btn.classList.toggle("is-hidden", isHidden);
    btn.title = isHidden ? "Show category" : "Hide for privacy";
    btn.querySelector("svg").innerHTML = isHidden
      ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
      : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  }

  // ===================== DRAG AND DROP =====================

  function onDragStart(event) {
    draggedCategory = event.currentTarget.dataset.category;
    event.currentTarget.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedCategory);
    setTimeout(() => (event.currentTarget.style.opacity = "0.4"), 0);
  }

  function onDragEnd(event) {
    event.currentTarget.classList.remove("dragging");
    event.currentTarget.style.opacity = "";
    tabList
      .querySelectorAll(".category-header")
      .forEach((h) =>
        h.classList.remove("drag-over-top", "drag-over-bottom")
      );
    draggedCategory = null;
  }

  function onDragOver(event) {
    event.preventDefault();
    const target = event.currentTarget;
    if (target.dataset.category === draggedCategory) return;
    event.dataTransfer.dropEffect = "move";

    const rect = target.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    target.classList.remove("drag-over-top", "drag-over-bottom");
    target.classList.add(
      event.clientY < mid ? "drag-over-top" : "drag-over-bottom"
    );
  }

  function onDragLeave(event) {
    event.currentTarget.classList.remove("drag-over-top", "drag-over-bottom");
  }

  function onDrop(event) {
    event.preventDefault();
    const targetCat = event.currentTarget.dataset.category;
    if (!draggedCategory || draggedCategory === targetCat) return;

    event.currentTarget.classList.remove("drag-over-top", "drag-over-bottom");

    // Build new order from current DOM position
    const order = [
      ...tabList.querySelectorAll(".category-header[data-category]"),
    ].map((h) => h.dataset.category);
    const dragIdx = order.indexOf(draggedCategory);
    if (dragIdx !== -1) order.splice(dragIdx, 1);

    const rect = event.currentTarget.getBoundingClientRect();
    let targetIdx = order.indexOf(targetCat);
    if (event.clientY > rect.top + rect.height / 2) targetIdx++;
    order.splice(targetIdx, 0, draggedCategory);

    categoryOrder = order;
    chrome.storage.local.set({ categoryOrder });
    applyFilters();
    showToast("Category order updated");
  }
});
