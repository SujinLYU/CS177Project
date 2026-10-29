// Open the panel immediately inside the user gesture. Awaiting script injection
// first can lose the activation required by chrome.sidePanel.open().
chrome.action.onClicked.addListener((tab) => {
  if (Number.isInteger(tab.windowId)) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
      console.warn("Pip could not open the side panel:", error.message);
    });
  }

  // activeTab grants access only after this click. No page text is read.
  if (Number.isInteger(tab.id) && /^https?:\/\//i.test(tab.url || "")) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    }).catch(() => {
      // Chrome Web Store and other protected pages reject injection. The
      // side panel still works there; the companion stays off that page.
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return;

  if (message.type === "PIP_OPEN_PANEL" && Number.isInteger(sender.tab?.windowId)) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false, error: "Click the Pip toolbar icon to open your task list." }),
    );
    return true;
  }

  if (message.type === "PIP_GET_COUNT") {
    chrome.action.getBadgeText({}).then(
      (text) => sendResponse({ count: Number.parseInt(text, 10) || 0 }),
      () => sendResponse({ count: 0 }),
    );
    return true;
  }

  // Only our extension UI can set the count, not an injected webpage pet.
  if (message.type === "PIP_TASK_COUNT" &&
      sender.url?.startsWith(chrome.runtime.getURL("")) &&
      Number.isFinite(message.count)) {
    const count = Math.max(0, Math.min(999, Math.floor(message.count)));
    Promise.all([
      chrome.action.setBadgeBackgroundColor({ color: "#25745B" }),
      chrome.action.setBadgeText({ text: count ? String(count) : "" }),
      chrome.tabs.query({}).then((tabs) => Promise.allSettled(tabs.map((tab) =>
        chrome.tabs.sendMessage(tab.id, { type: "PIP_TASK_COUNT", count }),
      ))),
    ]).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
});
