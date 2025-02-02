document.addEventListener("DOMContentLoaded", () => {
  const saveTabButton = document.getElementById("saveTab")
  const openAllButton = document.getElementById("openAll")
  const addCategoryButton = document.getElementById("addCategory")
  const searchInput = document.getElementById("search")
  const categorySelect = document.getElementById("category")
  const newCategoryInput = document.getElementById("newCategory")

  saveTabButton.addEventListener("click", saveCurrentTab)
  openAllButton.addEventListener("click", openAllTabs)
  addCategoryButton.addEventListener("click", addCategory)
  searchInput.addEventListener("input", searchTabs)

  let categories = ["default"]

  // Load categories and display saved tabs when the popup is opened
  chrome.storage.local.get({ categories: ["default"], savedTabs: [] }, (result) => {
    categories = result.categories
    updateCategoryDropdown()
    displaySavedTabs(result.savedTabs)
  })

  function searchTabs() {
    const query = searchInput.value.toLowerCase()
    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      const filteredTabs = result.savedTabs.filter(
        (tab) => tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query),
      )
      displaySavedTabs(filteredTabs)
    })
  }

  function addCategory() {
    const newCategory = newCategoryInput.value.trim()
    if (newCategory && !categories.includes(newCategory)) {
      categories.push(newCategory)
      chrome.storage.local.set({ categories }, () => {
        updateCategoryDropdown()
        newCategoryInput.value = ""
      })
    }
  }

  function updateCategoryDropdown() {
    categorySelect.innerHTML = categories.map((cat) => `<option value="${cat}">${cat}</option>`).join("")
  }

  function saveCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0]
      const category = categorySelect.value
      const tabData = {
        url: tab.url,
        title: tab.title,
        favicon: tab.favIconUrl,
        date: new Date().toLocaleString(),
        category: category,
      }

      chrome.storage.local.get({ savedTabs: [] }, (result) => {
        const savedTabs = result.savedTabs

        // Check if the URL already exists
        const isDuplicate = savedTabs.some((savedTab) => savedTab.url === tabData.url)
        if (isDuplicate) {
          alert("This URL is already saved!")
          return
        }

        savedTabs.push(tabData)
        chrome.storage.local.set({ savedTabs }, () => {
          displaySavedTabs(savedTabs)
        })
      })
    })
  }

  function displaySavedTabs(tabs) {
    const tabList = document.getElementById("tabList")
    tabList.innerHTML = ""
    tabs.forEach((tab, index) => {
      const li = document.createElement("li")
      li.innerHTML = `
        <img src="${tab.favicon || "icons/default-favicon.png"}" alt="Favicon">
        <a href="${tab.url}" target="_blank" title="${tab.title}">${tab.title}</a>
        <span>${tab.category}</span>
        <button class="deleteButton" data-index="${index}">Delete</button>
      `
      tabList.appendChild(li)
    })

    // Add delete functionality
    document.querySelectorAll(".deleteButton").forEach((button) => {
      button.addEventListener("click", deleteTab)
    })
  }

  function openAllTabs() {
    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      result.savedTabs.forEach((tab) => {
        chrome.tabs.create({ url: tab.url })
      })
    })
  }

  function deleteTab(event) {
    const index = event.target.getAttribute("data-index")
    chrome.storage.local.get({ savedTabs: [] }, (result) => {
      const savedTabs = result.savedTabs
      savedTabs.splice(index, 1)
      chrome.storage.local.set({ savedTabs }, () => {
        displaySavedTabs(savedTabs)
      })
    })
  }
})

