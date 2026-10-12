// Background service worker - manages multi-page updating

chrome.webNavigation.onCompleted.addListener(async function(details) {
  if (details.frameId !== 0) return;
  if (!details.url.includes('tictac.moked-crm.co.il')) return;
  if (!/[?&]filter=(250|35|63)(&|$)/.test(details.url)) return;   // the lists the runner goes through

  const data = await chrome.storage.local.get(['crmUpdaterRunning', 'crmUpdaterCodes', 'crmUpdaterStats']);
  if (!data.crmUpdaterRunning || !data.crmUpdaterCodes) return;

  console.log('[BG] Auto-resuming on page load');

  // Wait for page to fully render
  // no fixed wait: runner.js waits for the table and the CRM's AJAX itself

  try {
    // Inject codes into MAIN world
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      func: (codes, stats) => {
        window._crmUpdaterResumeCodes = codes;
        window._crmUpdaterResumeStats = stats;
      },
      args: [data.crmUpdaterCodes, data.crmUpdaterStats || { updated: 0, skipped: 0, total: 0 }],
      world: 'MAIN'
    });

    // Inject runner
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['runner.js'],
      world: 'MAIN'
    });
  } catch(e) {
    console.error('[BG] Inject error:', e);
  }
});

// Listen for messages from content script (to save stats from page world)
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'crmUpdaterSaveStats') {
    chrome.storage.local.set({ crmUpdaterStats: msg.stats });
  }
  if (msg.type === 'crmUpdaterDone') {
    chrome.storage.local.remove(['crmUpdaterRunning', 'crmUpdaterCodes', 'crmUpdaterStats']);
  }
  if (msg.type === 'crmUpdaterStop') {
    chrome.storage.local.remove(['crmUpdaterRunning', 'crmUpdaterCodes', 'crmUpdaterStats']);
  }
});
