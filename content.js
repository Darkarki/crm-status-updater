// Content script - bridges MAIN world (runner) with chrome APIs.
// If the extension was reloaded while this tab stayed open, this old copy loses chrome.storage
// ("Extension context invalidated"). Then progress cannot be saved between pages: tell the user to refresh the tab.
console.log('CRM Status Updater: Content script loaded');

function storageOk() {
  try { return !!(chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local); } catch (e) { return false; }
}

function warnRefresh() {
  if (document.getElementById('crm-upd-refresh')) return;
  const d = document.createElement('div');
  d.id = 'crm-upd-refresh';
  d.style.cssText = 'position:fixed;top:10px;right:10px;z-index:100000;background:#c62828;color:#fff;padding:14px 18px;border-radius:10px;font:bold 15px sans-serif;direction:rtl;box-shadow:0 4px 12px rgba(0,0,0,.3);cursor:pointer';
  d.textContent = 'התוסף עודכן: לחץ כאן או F5 כדי לרענן את הדף, ואז הפעל שוב';
  d.onclick = () => location.reload();
  document.body.appendChild(d);
}

window.addEventListener('message', function(event) {
  if (event.source !== window) return;
  if (!event.data || !event.data.crmUpdater) return;
  if (!storageOk()) { warnRefresh(); return; }
  const msg = event.data;
  try {
    if (msg.type === 'saveStats') {
      chrome.storage.local.set({ crmUpdaterStats: msg.stats });
    } else if (msg.type === 'done' || msg.type === 'stop') {
      chrome.storage.local.remove(['crmUpdaterRunning', 'crmUpdaterCodes', 'crmUpdaterStats']);
    }
  } catch (e) {
    warnRefresh();
  }
});
