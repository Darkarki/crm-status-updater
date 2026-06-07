let customerCodes = [];

document.getElementById('excel-file').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  document.getElementById('file-name').textContent = file.name;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const workbook = XLSX.read(e.target.result, { type: 'array' });

      // Sources to try in order of preference
      const sources = [
        { find: name => name.includes('חיבורים') && name.includes('קווים'), label: 'חיבורים קווים' },
        { find: name => name.includes('אקטובים') && name.includes('מפורט'), label: 'אקטובים מפורט' },
        { find: name => name.includes('מפורט'), label: 'מפורט' },
      ];

      customerCodes = [];
      let foundSheets = [];

      for (const src of sources) {
        const sheetName = workbook.SheetNames.find(src.find);
        if (!sheetName) continue;
        if (foundSheets.find(f => f.startsWith(sheetName))) continue;

        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        // Auto-detect "קוד לקוח" column - scan first 10 rows for header
        let codeCol = -1;
        let dataStartRow = 1;
        for (let r = 0; r < Math.min(10, data.length); r++) {
          const row = data[r];
          if (!row) continue;
          for (let c = 0; c < row.length; c++) {
            const v = String(row[c] || '').trim();
            if (v === 'קוד לקוח' || v === 'ACCOUNT_NO' || v.includes('קוד לקוח')) {
              codeCol = c;
              dataStartRow = r + 1;
              break;
            }
          }
          if (codeCol >= 0) break;
        }

        if (codeCol < 0) continue;

        let count = 0;
        for (let i = dataStartRow; i < data.length; i++) {
          const row = data[i];
          if (row && row[codeCol] !== undefined && row[codeCol] !== null && String(row[codeCol]).trim() !== '') {
            const code = String(row[codeCol]).trim();
            if (!customerCodes.includes(code)) {
              customerCodes.push(code);
              count++;
            }
          }
        }
        const colLetter = String.fromCharCode(65 + codeCol);
        foundSheets.push(`${sheetName}: ${count} קודים (עמודה ${colLetter})`);
      }

      if (customerCodes.length === 0) {
        document.getElementById('excel-info').style.display = 'block';
        document.getElementById('excel-info').style.color = '#c62828';
        document.getElementById('excel-info').textContent =
          'לא נמצאו קודי לקוח. לשוניות קיימות: ' + workbook.SheetNames.join(', ');
        return;
      }

      document.getElementById('excel-info').style.display = 'block';
      document.getElementById('excel-info').style.color = '#2e7d32';
      document.getElementById('excel-info').textContent =
        `נמצאו ${customerCodes.length} קודי לקוח מ: ${foundSheets.join(' | ')}`;

      document.getElementById('start-btn').disabled = false;

    } catch (err) {
      document.getElementById('excel-info').style.display = 'block';
      document.getElementById('excel-info').style.color = '#c62828';
      document.getElementById('excel-info').textContent = 'שגיאה בקריאת הקובץ: ' + err.message;
    }
  };
  reader.readAsArrayBuffer(file);
});

document.getElementById('start-btn').addEventListener('click', async function() {
  if (customerCodes.length === 0) return;

  this.disabled = true;
  document.getElementById('stop-btn').style.display = 'block';
  document.getElementById('status').textContent = 'מתחיל עדכון...';
  document.getElementById('stats').style.display = 'flex';
  document.getElementById('log').style.display = 'block';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes('tictac.moked-crm.co.il')) {
    document.getElementById('status').textContent = 'יש לפתוח את TicTac CRM קודם!';
    this.disabled = false;
    return;
  }

  // Save state for auto-resume across pages
  await chrome.storage.local.set({
    crmUpdaterRunning: true,
    crmUpdaterCodes: customerCodes,
    crmUpdaterStats: { updated: 0, skipped: 0, total: 0 }
  });

  try {
    // Inject codes into MAIN world
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (codes) => {
        window._crmUpdaterResumeCodes = codes;
        window._crmUpdaterResumeStats = { updated: 0, skipped: 0, total: 0 };
      },
      args: [customerCodes],
      world: 'MAIN'
    });

    // Inject runner
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['runner.js'],
      world: 'MAIN'
    });
  } catch (err) {
    document.getElementById('status').textContent = 'שגיאה: ' + err.message;
    this.disabled = false;
  }
});

// Stop button
document.getElementById('stop-btn').addEventListener('click', async function() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { window._crmUpdaterStop = true; }
    });
  } catch(e) {}
  document.getElementById('status').textContent = 'נעצר!';
  document.getElementById('start-btn').disabled = false;
  document.getElementById('stop-btn').style.display = 'none';
});

// This function runs IN the CRM page
function runUpdater(customerCodes) {

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getCustomerCode(row) {
    const text = row.textContent;
    const match = text.match(/קוד לקוח[:\s]*(\d+)/);
    return match ? match[1].trim() : null;
  }

  function getCustomerName(row) {
    const tds = row.querySelectorAll('td');
    for (let i = tds.length - 1; i >= 0; i--) {
      const text = tds[i].textContent.trim();
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2 && !l.includes('function'));
      if (lines.length > 0 && lines[0].length < 40) return lines[0];
    }
    return 'לא ידוע';
  }

  async function updateStatus(row) {
    let saleId = null;

    // Method 1: from status link ID "status_select_li_XX_SALEID"
    const statusLinks = row.querySelectorAll('a[id*="status_select"]');
    if (statusLinks.length > 0) {
      const idMatch = statusLinks[0].id.match(/status_select_li_\d+_(\d+)/);
      if (idMatch) saleId = idMatch[1];
    }

    // Method 2: from onclick "change_status_ajax_leads_sales(SALEID, XX)"
    if (!saleId) {
      const changeLinks = row.querySelectorAll('a[onclick*="change_status"]');
      for (const link of changeLinks) {
        const match = (link.getAttribute('onclick') || '').match(/change_status_ajax_leads_sales\((\d+)/);
        if (match) { saleId = match[1]; break; }
      }
    }

    // Method 3: from modal link "le_modal_load(SALEID, 'name')"
    if (!saleId) {
      const modalLink = row.querySelector('a[data-toggle="modal"]');
      if (modalLink) {
        const onclick = modalLink.getAttribute('onclick') || '';
        const match = onclick.match(/le_modal_load\((\d+)/);
        if (match) saleId = match[1];
      }
    }

    // Method 4: from any link with numeric ID pattern
    if (!saleId) {
      const allLinks = row.querySelectorAll('a[id]');
      for (const link of allLinks) {
        const match = link.id.match(/_(\d{4,})$/);
        if (match) { saleId = match[1]; break; }
      }
    }

    if (!saleId) {
      console.log('CRM Updater: Could not find sale ID for row');
      return false;
    }

    // Check if this is a "mixed" sale - one with multiple statuses
    // Pattern: "5 פעיל ולא נמצא" (number followed by status)
    let isMixed = false;
    const statusBadges = row.querySelectorAll('a, span, div');
    for (const b of statusBadges) {
      const t = b.textContent.trim();
      if (/^\d+\s+פעיל\s+ולא\s+נמצא/.test(t) || /^\d+\s+פעיל\s+הלא\s+נמצא/.test(t)) {
        isMixed = true;
        break;
      }
    }

    if (!isMixed) {
      // Pure sale - just update the whole sale status
      console.log('CRM Updater: [PURE] Calling change_status_ajax_leads_sales(' + saleId + ', 74)');
      try {
        change_status_ajax_leads_sales(saleId, 74);
        await sleep(1500);
        return true;
      } catch (err) {
        console.log('CRM Updater: Error calling sale status:', err);
        return false;
      }
    }

    // Mixed sale - open modal and update individual lines
    console.log('CRM Updater: [MIXED] Sale has multiple statuses, opening modal for sale', saleId);
    const lineCount = await updateLineStatuses(row, saleId);
    return lineCount > 0;
  }

  // Helper to find the visible modal
  function findModal() {
    const modals = document.querySelectorAll('.modal');
    for (const m of modals) {
      if (m.offsetHeight > 0 && m.offsetWidth > 0) return m;
    }
    return null;
  }

  // Open the sale modal and update individual line statuses
  async function updateLineStatuses(row, saleId) {
    const modalLink = row.querySelector('a[data-toggle="modal"]');
    if (!modalLink) {
      console.log('CRM Updater: No modal link found in row');
      return 0;
    }
    console.log('CRM Updater: Opening sale modal');
    modalLink.click();

    // Wait for modal to open and load content
    await sleep(4000);

    let modal = findModal();
    if (!modal) {
      console.log('CRM Updater: Modal not visible, waiting more...');
      await sleep(3000);
      modal = findModal();
    }

    if (!modal) {
      console.log('CRM Updater: Modal still not found');
      return 0;
    }

    // Strategy: Find all line items by looking for change_status_ajax_leads_sale_item references
    // For each unique item ID, check if its CURRENT status is "פעיל"
    // If yes, call change_status_ajax_leads_sale_item(itemId, 74)

    // Step 1: Get all item IDs that have status options
    const allItemIds = new Set();
    const statusOptions = modal.querySelectorAll('a[id^="status_select_li_"]');
    for (const opt of statusOptions) {
      const m = opt.id.match(/status_select_li_\d+_(\d+)/);
      if (m) allItemIds.add(m[1]);
    }
    console.log('CRM Updater: Found', allItemIds.size, 'unique item IDs in modal');

    // Step 2: For each item, find its current status display
    // The display element has "פעיל" text and is visible (not in dropdown ul)
    const itemsToUpdate = new Set();

    // Method A: Look for status_dropdown_ITEMID (in id OR className)
    const dropdowns = modal.querySelectorAll('[class*="status_dropdown_"], [id^="status_dropdown_"]');
    for (const d of dropdowns) {
      const text = d.textContent.trim();
      // Check both id and class
      let m = d.id.match(/status_dropdown_(\d+)/);
      if (!m) m = (d.className || '').match(/status_dropdown_(\d+)/);
      if (m && text.includes('פעיל') && !text.includes('נמצא בדוח')) {
        itemsToUpdate.add(m[1]);
      }
    }

    // Method B: For each item ID, check if any visible badge near it shows "פעיל"
    // The current status is usually in a button/badge (not in a UL dropdown menu)
    if (itemsToUpdate.size === 0) {
      for (const itemId of allItemIds) {
        // Find elements with this item ID that are NOT in a dropdown menu (UL)
        // and show "פעיל"
        const allWithId = modal.querySelectorAll('[id*="' + itemId + '"]');
        for (const el of allWithId) {
          // Skip dropdown menu items (status_select_li_*)
          if (el.id.startsWith('status_select_li_')) continue;
          const text = el.textContent.trim();
          if (text.includes('פעיל') && !text.includes('נמצא בדוח') && text.length < 40) {
            itemsToUpdate.add(itemId);
            break;
          }
        }
      }
    }

    // Method C: walk through all visible badges (a.btn, button) and find ones showing פעיל
    if (itemsToUpdate.size === 0) {
      const badges = modal.querySelectorAll('a, button');
      for (const b of badges) {
        // Skip if inside a dropdown UL
        if (b.closest('ul.dropdown-menu, .dropdown-menu')) continue;
        const text = b.textContent.trim();
        if (text.includes('פעיל') && !text.includes('נמצא בדוח') && text.length < 30 && b.offsetHeight > 0) {
          // Try to find item ID from this element
          const idStr = b.id || (b.getAttribute('onclick') || '');
          const m = idStr.match(/(\d{6,})/);
          if (m && allItemIds.has(m[1])) {
            itemsToUpdate.add(m[1]);
            continue;
          }
          // Try parent
          const parent = b.closest('[id]');
          if (parent) {
            const pm = parent.id.match(/(\d{6,})/);
            if (pm && allItemIds.has(pm[1])) {
              itemsToUpdate.add(pm[1]);
            }
          }
        }
      }
    }

    console.log('CRM Updater: Items to update:', Array.from(itemsToUpdate));

    // Step 3: Update each item
    let lineUpdates = 0;
    for (const itemId of itemsToUpdate) {
      console.log('CRM Updater: Updating item', itemId);
      try {
        change_status_ajax_leads_sale_item(parseInt(itemId), 74);
        lineUpdates++;
        await sleep(1200);
      } catch (err) {
        console.log('CRM Updater: Error:', err);
      }
    }

    console.log('CRM Updater: Updated', lineUpdates, 'lines');

    // Close the modal
    await sleep(800);
    const closeBtn = modal.querySelector('.close, [data-dismiss="modal"], .btn-close, button.close');
    if (closeBtn) {
      closeBtn.click();
    } else {
      const backdrop = document.querySelector('.modal-backdrop');
      if (backdrop) backdrop.click();
    }
    await sleep(1500);
    return lineUpdates;
  }

  // Create floating status panel on the page
  const panel = document.createElement('div');
  panel.id = 'crm-updater-panel';
  panel.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;background:#fff;border:2px solid #1a73e8;border-radius:10px;padding:15px;width:300px;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:sans-serif;direction:rtl;';
  panel.innerHTML = `
    <h3 style="margin:0 0 10px;color:#1a73e8;font-size:16px;">עדכון סטטוסים</h3>
    <div id="crm-upd-status" style="font-size:13px;margin-bottom:8px;">מתחיל...</div>
    <div style="display:flex;justify-content:space-around;margin-bottom:8px;">
      <div style="text-align:center"><div id="crm-upd-updated" style="font-size:22px;font-weight:bold;color:#2e7d32;">0</div><div style="font-size:11px;color:#888;">עודכנו</div></div>
      <div style="text-align:center"><div id="crm-upd-skipped" style="font-size:22px;font-weight:bold;color:#888;">0</div><div style="font-size:11px;color:#888;">לא נמצאו</div></div>
      <div style="text-align:center"><div id="crm-upd-total" style="font-size:22px;font-weight:bold;color:#1a73e8;">0</div><div style="font-size:11px;color:#888;">נבדקו</div></div>
    </div>
    <button id="crm-upd-stop" style="width:100%;padding:8px;background:#c62828;color:white;border:none;border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;margin-bottom:8px;">עצור</button>
    <div id="crm-upd-log" style="max-height:150px;overflow-y:auto;font-size:11px;background:#f8f8f8;border-radius:4px;padding:6px;"></div>
  `;
  document.body.appendChild(panel);
  document.getElementById('crm-upd-stop').addEventListener('click', () => { window._crmUpdaterStop = true; });

  function updatePanel(status, updated, skipped, total) {
    document.getElementById('crm-upd-status').textContent = status;
    document.getElementById('crm-upd-updated').textContent = updated;
    document.getElementById('crm-upd-skipped').textContent = skipped;
    document.getElementById('crm-upd-total').textContent = total;
  }

  function addLog(text, color) {
    const log = document.getElementById('crm-upd-log');
    const entry = document.createElement('div');
    entry.style.cssText = 'margin-bottom:3px;color:' + (color || '#333');
    entry.textContent = text;
    log.prepend(entry);
  }

  // Navigate to next page using URL pg parameter
  async function goToNextPage() {
    const url = new URL(window.location.href);
    const currentPg = parseInt(url.searchParams.get('pg') || '1');
    const nextPg = currentPg + 1;
    url.searchParams.set('pg', nextPg);
    console.log('CRM Updater: Navigating to page', nextPg);
    // Save state so we can resume after page reload
    sessionStorage.setItem('crmUpdaterCodes', JSON.stringify(customerCodes));
    sessionStorage.setItem('crmUpdaterStats', JSON.stringify(currentStats));
    sessionStorage.setItem('crmUpdaterRunning', '1');
    window.location.href = url.toString();
  }

  // Process current page rows
  async function processPage(startStats) {
    const rows = document.querySelectorAll('tr.middle.info');
    console.log('CRM Updater: Found', rows.length, 'rows');
    addLog(`--- עמוד עם ${rows.length} לקוחות ---`, '#1a73e8');

    let stats = startStats;

    for (let i = 0; i < rows.length; i++) {
      if (window._crmUpdaterStop) {
        addLog('נעצר על ידי המשתמש', '#c62828');
        updatePanel(`נעצר! ${stats.updated} עודכנו מתוך ${stats.total}`, stats.updated, stats.skipped, stats.total);
        sessionStorage.removeItem('crmUpdaterRunning');
        return { stopped: true, stats };
      }

      const row = rows[i];
      const code = getCustomerCode(row);
      const name = getCustomerName(row);

      if (!code) {
        stats.skipped++;
        stats.total++;
        addLog(`${name} - אין קוד לקוח`, '#888');
        updatePanel(`בודק ${i+1}/${rows.length}`, stats.updated, stats.skipped, stats.total);
        continue;
      }

      stats.total++;

      if (customerCodes.includes(code)) {
        addLog(`נמצא! ${name} (${code}) - מעדכן...`, '#2e7d32');
        updatePanel(`מעדכן: ${name}`, stats.updated, stats.skipped, stats.total);

        const success = await updateStatus(row);
        if (success) {
          stats.updated++;
          addLog(`${name} (${code}) - עודכן!`, '#2e7d32');
        } else {
          addLog(`${name} (${code}) - שגיאה, עדכן ידנית`, '#c62828');
        }
        currentStats = stats;
        await sleep(1500);
      } else {
        stats.skipped++;
        addLog(`${name} (${code}) - לא בדוח`, '#888');
      }

      currentStats = stats;
      updatePanel(`בודק ${i+1}/${rows.length}`, stats.updated, stats.skipped, stats.total);
    }

    return { stopped: false, stats };
  }

  // Main process - check if resuming from previous page
  window._crmUpdaterStop = false;
  let currentStats = { updated: 0, skipped: 0, total: 0 };

  // Check if we have saved state from a previous page
  const savedStats = sessionStorage.getItem('crmUpdaterStats');
  if (savedStats) {
    try {
      currentStats = JSON.parse(savedStats);
      sessionStorage.removeItem('crmUpdaterStats');
      addLog(`המשך מעמוד קודם: ${currentStats.updated} כבר עודכנו`, '#1a73e8');
    } catch(e) {}
  }

  (async () => {
    const result = await processPage(currentStats);
    if (result.stopped) return;

    currentStats = result.stats;
    updatePanel(`עמוד הסתיים. עובר לבא...`, currentStats.updated, currentStats.skipped, currentStats.total);
    addLog(`עמוד הסתיים, עובר לעמוד הבא...`, '#1a73e8');
    await sleep(2000);

    // Check if there's a next page
    const rows = document.querySelectorAll('tr.middle.info');
    if (rows.length === 0) {
      updatePanel(`הושלם! ${currentStats.updated} עודכנו מתוך ${currentStats.total}`, currentStats.updated, currentStats.skipped, currentStats.total);
      addLog(`=== סיום: אין יותר עמודים ===`, '#1a73e8');
      sessionStorage.removeItem('crmUpdaterRunning');
      return;
    }

    await goToNextPage();
  })();
}

// Auto-resume on page load if we were running
if (sessionStorage.getItem('crmUpdaterRunning') === '1') {
  const savedCodes = sessionStorage.getItem('crmUpdaterCodes');
  if (savedCodes) {
    try {
      const codes = JSON.parse(savedCodes);
      // Wait for page to be ready then restart
      setTimeout(() => {
        if (typeof runUpdater === 'function') {
          runUpdater(codes);
        }
      }, 3000);
    } catch(e) {}
  }
}

// Listen for messages from content script (for backwards compat)
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'progress') {
    document.getElementById('status').textContent = msg.text;
    document.getElementById('stat-updated').textContent = msg.updated || 0;
    document.getElementById('stat-skipped').textContent = msg.skipped || 0;
    document.getElementById('stat-total').textContent = msg.total || 0;
  }
  if (msg.type === 'log') {
    const logDiv = document.getElementById('log');
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + (msg.cls || '');
    entry.textContent = msg.text;
    logDiv.prepend(entry);
  }
  if (msg.type === 'done') {
    document.getElementById('status').textContent = 'הושלם!';
    document.getElementById('start-btn').disabled = false;
    document.getElementById('start-btn').textContent = 'סיום - ניתן לסגור';
  }
});
