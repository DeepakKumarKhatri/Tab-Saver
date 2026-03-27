document.addEventListener("DOMContentLoaded", () => {
  const backButton = document.getElementById("backButton");
  const newCategoryInput = document.getElementById("newCategoryInput");
  const addCategoryBtn = document.getElementById("addCategoryBtn");
  const categoryList = document.getElementById("categoryList");
  const exportBtn = document.getElementById("exportBtn");
  const importBtn = document.getElementById("importBtn");
  const importFileInput = document.getElementById("importFileInput");
  const importExportMessage = document.getElementById("importExportMessage");
  const clearAllBtn = document.getElementById("clearAllBtn");
  const totalTabsEl = document.getElementById("totalTabs");
  const totalCategoriesEl = document.getElementById("totalCategories");
  const autoSaveCheckbox = document.getElementById("autoSaveEnabled");

  let categories = ["All"];
  let savedTabs = [];

  // Load data on page load
  loadData();

  // Event Listeners
  backButton.addEventListener("click", () => {
    document.body.classList.add("page-exit");
    setTimeout(() => (window.location.href = "popup.html"), 100);
  });

  addCategoryBtn.addEventListener("click", addCategory);
  newCategoryInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      addCategory();
    }
  });

  exportBtn.addEventListener("click", exportData);
  importBtn.addEventListener("click", () => importFileInput.click());
  importFileInput.addEventListener("change", importData);
  clearAllBtn.addEventListener("click", clearAllData);
  autoSaveCheckbox.addEventListener("change", saveAutoSaveSetting);

  // Load categories and tabs from storage
  function loadData() {
    chrome.storage.local.get({ categories: ["All"], savedTabs: [], autoSaveEnabled: false }, (result) => {
      categories = result.categories;
      savedTabs = result.savedTabs;
      autoSaveCheckbox.checked = result.autoSaveEnabled;
      savedTabs = result.savedTabs;
      displayCategories();
      updateStatistics();
    });
  }

  // Add new category
  function addCategory() {
    const newCategory = newCategoryInput.value.trim();
    
    if (!newCategory) {
      showMessage("Please enter a category name", "error");
      return;
    }

    if (categories.includes(newCategory)) {
      showMessage("Category already exists", "error");
      return;
    }

    if (newCategory.length > 30) {
      showMessage("Category name too long (max 30 characters)", "error");
      return;
    }

    categories.push(newCategory);
    chrome.storage.local.set({ categories }, () => {
      newCategoryInput.value = "";
      displayCategories();
      updateStatistics();
      showMessage(`Category "${newCategory}" added successfully`, "success");
    });
  }

  // Display all categories
  function displayCategories() {
    categoryList.innerHTML = "";

    categories.forEach((category, index) => {
      const isDefault = category === "All";
      const categoryItem = document.createElement("div");
      categoryItem.className = `category-item${isDefault ? " default" : ""}`;
      categoryItem.innerHTML = `
        <span class="category-name">${category}</span>
        <div class="category-actions">
          ${
            !isDefault
              ? `
            <button class="edit-btn" data-index="${index}">Edit</button>
            <button class="delete-category-btn" data-index="${index}">Delete</button>
          `
              : '<span style="font-size: 12px; color: #7f8c8d;">(Default)</span>'
          }
        </div>
      `;
      categoryList.appendChild(categoryItem);
    });

    // Add event listeners to edit and delete buttons
    document.querySelectorAll(".edit-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const index = parseInt(e.target.getAttribute("data-index"));
        editCategory(index);
      });
    });

    document.querySelectorAll(".delete-category-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const index = parseInt(e.target.getAttribute("data-index"));
        deleteCategory(index);
      });
    });
  }

  // Edit category
  function editCategory(index) {
    const categoryItem = categoryList.children[index];
    const currentName = categories[index];
    
    categoryItem.classList.add("editing");
    categoryItem.innerHTML = `
      <input type="text" class="category-name-input" value="${currentName}" maxlength="30" />
      <div class="category-actions">
        <button class="save-btn">Save</button>
        <button class="cancel-btn">Cancel</button>
      </div>
    `;

    const input = categoryItem.querySelector(".category-name-input");
    const saveBtn = categoryItem.querySelector(".save-btn");
    const cancelBtn = categoryItem.querySelector(".cancel-btn");

    input.focus();
    input.select();

    const saveEdit = () => {
      const newName = input.value.trim();
      
      if (!newName) {
        showMessage("Category name cannot be empty", "error");
        return;
      }

      if (newName !== currentName && categories.includes(newName)) {
        showMessage("Category already exists", "error");
        return;
      }

      const oldName = categories[index];
      categories[index] = newName;

      // Update tabs with old category name
      const updatedTabs = savedTabs.map((tab) => {
        if (tab.category === oldName) {
          return { ...tab, category: newName };
        }
        return tab;
      });

      chrome.storage.local.set({ categories, savedTabs: updatedTabs }, () => {
        savedTabs = updatedTabs;
        displayCategories();
        showMessage(`Category renamed to "${newName}"`, "success");
      });
    };

    const cancelEdit = () => {
      displayCategories();
    };

    saveBtn.addEventListener("click", saveEdit);
    cancelBtn.addEventListener("click", cancelEdit);
    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        saveEdit();
      } else if (e.key === "Escape") {
        cancelEdit();
      }
    });
  }

  // Delete category
  function deleteCategory(index) {
    const categoryName = categories[index];
    
    if (categoryName === "All") {
      showMessage("Cannot delete the default category", "error");
      return;
    }

    const tabsInCategory = savedTabs.filter(
      (tab) => tab.category === categoryName
    ).length;

    let confirmMessage = `Delete category "${categoryName}"?`;
    if (tabsInCategory > 0) {
      confirmMessage += `\n\n${tabsInCategory} tab(s) will be moved to "All" category.`;
    }

    if (confirm(confirmMessage)) {
      categories.splice(index, 1);

      // Move tabs to "All" category
      const updatedTabs = savedTabs.map((tab) => {
        if (tab.category === categoryName) {
          return { ...tab, category: "All" };
        }
        return tab;
      });

      chrome.storage.local.set({ categories, savedTabs: updatedTabs }, () => {
        savedTabs = updatedTabs;
        displayCategories();
        updateStatistics();
        showMessage(`Category "${categoryName}" deleted`, "success");
      });
    }
  }

  // Export data
  function exportData() {
    const exportData = {
      version: "1.0",
      exportDate: new Date().toISOString(),
      categories: categories,
      savedTabs: savedTabs,
    };

    const dataStr = JSON.stringify(exportData, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tab-saver-backup-${
      new Date().toISOString().split("T")[0]
    }.json`;
    link.click();
    URL.revokeObjectURL(url);

    showMessage("Data exported successfully", "success");
  }

  // Import data
  function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const importedData = JSON.parse(e.target.result);

        // Validate data structure
        if (
          !importedData.categories ||
          !Array.isArray(importedData.categories) ||
          !importedData.savedTabs ||
          !Array.isArray(importedData.savedTabs)
        ) {
          showMessage("Invalid data format", "error");
          return;
        }

        // Ask user whether to merge or replace
        const shouldMerge = confirm(
          "Do you want to MERGE with existing data?\n\n" +
            "Click OK to merge (keep existing + add new)\n" +
            "Click Cancel to replace (delete existing)"
        );

        if (shouldMerge) {
          // Merge categories
          const mergedCategories = [
            ...new Set([...categories, ...importedData.categories]),
          ];
          
          // Merge tabs (avoid duplicates by URL)
          const existingUrls = new Set(savedTabs.map((tab) => tab.url));
          const newTabs = importedData.savedTabs.filter(
            (tab) => !existingUrls.has(tab.url)
          );
          const mergedTabs = [...savedTabs, ...newTabs];

          chrome.storage.local.set(
            {
              categories: mergedCategories,
              savedTabs: mergedTabs,
            },
            () => {
              loadData();
              showMessage(
                `Data merged! Added ${newTabs.length} new tabs and ${
                  mergedCategories.length - categories.length
                } new categories`,
                "success"
              );
            }
          );
        } else {
          // Replace all data
          chrome.storage.local.set(
            {
              categories: importedData.categories,
              savedTabs: importedData.savedTabs,
            },
            () => {
              loadData();
              showMessage("Data imported and replaced successfully", "success");
            }
          );
        }
      } catch (error) {
        console.error("Import error:", error);
        showMessage("Error importing data: Invalid JSON file", "error");
      }
    };
    reader.readAsText(file);
    
    // Reset file input
    importFileInput.value = "";
  }

  // Clear all data
  function clearAllData() {
    const confirmation = confirm(
      "⚠️ WARNING: This will delete ALL saved tabs and categories!\n\n" +
        "This action cannot be undone. Are you sure?"
    );

    if (confirmation) {
      const doubleConfirmation = confirm(
        "Are you ABSOLUTELY sure?\n\n" +
          `You will lose ${savedTabs.length} saved tabs and ${
            categories.length - 1
          } categories.`
      );

      if (doubleConfirmation) {
        chrome.storage.local.set(
          {
            categories: ["All"],
            savedTabs: [],
          },
          () => {
            loadData();
            showMessage("All data cleared", "info");
          }
        );
      }
    }
  }

  // Update statistics
  function updateStatistics() {
    totalTabsEl.textContent = savedTabs.length;
    totalCategoriesEl.textContent = categories.length;
  }

  // Save auto-save setting
  function saveAutoSaveSetting() {
    const autoSaveEnabled = autoSaveCheckbox.checked;
    chrome.storage.local.set({ autoSaveEnabled }, () => {
      showMessage(
        autoSaveEnabled 
          ? "Auto-save enabled! You'll be prompted when closing the browser." 
          : "Auto-save disabled.",
        "success"
      );
    });
  }

  // Show message
  function showMessage(message, type) {
    importExportMessage.textContent = message;
    importExportMessage.className = `message ${type}`;
    importExportMessage.classList.remove("hidden");

    setTimeout(() => {
      importExportMessage.classList.add("hidden");
    }, 4000);
  }
});
