// Content script - bridges MAIN world (runner) with chrome APIs
console.log('CRM Status Updater: Content script loaded');

window.addEventListener('message', function(event) {
  if (event.source !== window) return;
  if (!event.data || !event.data.crmUpdater) return;

  const msg = event.data;
  if (msg.type === 'saveStats') {
    chrome.storage.local.set({ crmUpdaterStats: msg.stats });
  } else if (msg.type === 'done') {
    chrome.storage.local.remove(['crmUpdaterRunning', 'crmUpdaterCodes', 'crmUpdaterStats']);
  } else if (msg.type === 'stop') {
    chrome.storage.local.remove(['crmUpdaterRunning', 'crmUpdaterCodes', 'crmUpdaterStats']);
  }
});
