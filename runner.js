// CRM Updater Runner - injected into the page
// Reads codes from window._crmUpdaterResumeCodes (set by background)
// or from sessionStorage

(function() {
  const customerCodes = window._crmUpdaterResumeCodes;
  const resumeStats = window._crmUpdaterResumeStats || { updated: 0, skipped: 0, total: 0 };

  if (!customerCodes || customerCodes.length === 0) {
    console.log('CRM Updater: No codes to resume');
    return;
  }

  console.log('CRM Updater: Resuming with', customerCodes.length, 'codes, stats:', resumeStats);

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getCustomerCode(row) {
    const m = row.textContent.match(/קוד לקוח[:\s]*(\d+)/);
    return m ? m[1].trim() : null;
  }

  function getCustomerName(row) {
    const tds = row.querySelectorAll('td');
    for (let i = tds.length - 1; i >= 0; i--) {
      const t = tds[i].textContent.trim();
      const lines = t.split('\n').map(l => l.trim()).filter(l => l.length > 2 && !l.includes('function'));
      if (lines.length > 0 && lines[0].length < 40) return lines[0];
    }
    return 'לא ידוע';
  }

  function findModal() {
    const modals = document.querySelectorAll('.modal');
    for (const m of modals) if (m.offsetHeight > 0 && m.offsetWidth > 0) return m;
    return null;
  }

  async function updateLineStatuses(row) {
    const modalLink = row.querySelector('a[data-toggle="modal"]');
    if (!modalLink) return 0;
    modalLink.click();
    await sleep(4000);

    let modal = findModal();
    if (!modal) { await sleep(3000); modal = findModal(); }
    if (!modal) return 0;

    const itemsToUpdate = new Set();
    const dropdowns = modal.querySelectorAll('[class*="status_dropdown_"], [id^="status_dropdown_"]');
    for (const d of dropdowns) {
      const text = d.textContent.trim();
      let m = d.id.match(/status_dropdown_(\d+)/);
      if (!m) m = (d.className || '').match(/status_dropdown_(\d+)/);
      if (m && text.includes('פעיל') && !text.includes('נמצא בדוח')) {
        itemsToUpdate.add(m[1]);
      }
    }

    let updates = 0;
    for (const itemId of itemsToUpdate) {
      try {
        change_status_ajax_leads_sale_item(parseInt(itemId), 74);
        updates++;
        await sleep(1200);
      } catch(e) {}
    }

    await sleep(800);
    const closeBtn = modal.querySelector('.close, [data-dismiss="modal"]');
    if (closeBtn) closeBtn.click();
    await sleep(1500);
    return updates;
  }

  async function updateStatus(row) {
    let saleId = null;
    const statusLinks = row.querySelectorAll('a[id*="status_select"]');
    if (statusLinks.length > 0) {
      const m = statusLinks[0].id.match(/status_select_li_\d+_(\d+)/);
      if (m) saleId = m[1];
    }
    if (!saleId) {
      const ml = row.querySelector('a[data-toggle="modal"]');
      if (ml) {
        const m = (ml.getAttribute('onclick')||'').match(/le_modal_load\((\d+)/);
        if (m) saleId = m[1];
      }
    }
    if (!saleId) return false;

    let isMixed = false;
    const badges = row.querySelectorAll('a, span, div');
    for (const b of badges) {
      if (/^\d+\s+פעיל\s+ולא\s+נמצא/.test(b.textContent.trim())) { isMixed = true; break; }
    }

    if (!isMixed) {
      try {
        change_status_ajax_leads_sales(saleId, 74);
        await sleep(1500);
        return true;
      } catch(e) { return false; }
    }
    return (await updateLineStatuses(row)) > 0;
  }

  // Create panel
  const existingPanel = document.getElementById('crm-updater-panel');
  if (existingPanel) existingPanel.remove();

  const panel = document.createElement('div');
  panel.id = 'crm-updater-panel';
  panel.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;background:#fff;border:2px solid #1a73e8;border-radius:10px;padding:15px;width:300px;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:sans-serif;direction:rtl;';
  panel.innerHTML = `
    <h3 style="margin:0 0 10px;color:#1a73e8;font-size:16px;">עדכון סטטוסים (המשך)</h3>
    <div id="crm-upd-status" style="font-size:13px;margin-bottom:8px;">ממשיך מעמוד קודם...</div>
    <div style="display:flex;justify-content:space-around;margin-bottom:8px;">
      <div style="text-align:center"><div id="crm-upd-updated" style="font-size:22px;font-weight:bold;color:#2e7d32;">${resumeStats.updated}</div><div style="font-size:11px;color:#888;">עודכנו</div></div>
      <div style="text-align:center"><div id="crm-upd-skipped" style="font-size:22px;font-weight:bold;color:#888;">${resumeStats.skipped}</div><div style="font-size:11px;color:#888;">לא נמצאו</div></div>
      <div style="text-align:center"><div id="crm-upd-total" style="font-size:22px;font-weight:bold;color:#1a73e8;">${resumeStats.total}</div><div style="font-size:11px;color:#888;">נבדקו</div></div>
    </div>
    <button id="crm-upd-stop" style="width:100%;padding:8px;background:#c62828;color:white;border:none;border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;margin-bottom:8px;">עצור</button>
    <div id="crm-upd-log" style="max-height:150px;overflow-y:auto;font-size:11px;background:#f8f8f8;border-radius:4px;padding:6px;"></div>
  `;
  document.body.appendChild(panel);

  window._crmUpdaterStop = false;
  document.getElementById('crm-upd-stop').addEventListener('click', () => {
    window._crmUpdaterStop = true;
  });

  function setStatus(s) { document.getElementById('crm-upd-status').textContent = s; }
  function addLog(t, c) {
    const log = document.getElementById('crm-upd-log');
    const e = document.createElement('div');
    e.style.cssText = 'margin-bottom:3px;color:' + (c||'#333');
    e.textContent = t;
    log.prepend(e);
  }
  function updateStats(st) {
    document.getElementById('crm-upd-updated').textContent = st.updated;
    document.getElementById('crm-upd-skipped').textContent = st.skipped;
    document.getElementById('crm-upd-total').textContent = st.total;
  }

  (async () => {
    const codesSet = customerCodes; // already array
    const rows = document.querySelectorAll('tr.middle.info');
    addLog(`עמוד עם ${rows.length} לקוחות`, '#1a73e8');

    let stats = Object.assign({}, resumeStats);

    for (let i = 0; i < rows.length; i++) {
      if (window._crmUpdaterStop) {
        addLog('נעצר', '#c62828');
        window.postMessage({ crmUpdater: true, type: 'stop' }, '*');
        return;
      }

      const row = rows[i];
      const code = getCustomerCode(row);
      const name = getCustomerName(row);

      if (!code) {
        stats.skipped++; stats.total++;
        addLog(`${name} - אין קוד`, '#888');
        updateStats(stats);
        continue;
      }
      stats.total++;

      if (codesSet.includes(code)) {
        addLog(`נמצא! ${name} (${code})`, '#2e7d32');
        setStatus(`מעדכן: ${name}`);
        const ok = await updateStatus(row);
        if (ok) { stats.updated++; addLog(`${name} - עודכן!`, '#2e7d32'); }
        else addLog(`${name} - שגיאה`, '#c62828');
        await sleep(1500);
      } else {
        stats.skipped++;
        addLog(`${name} (${code}) - לא בדוח`, '#888');
      }
      updateStats(stats);
      setStatus(`בודק ${i+1}/${rows.length}`);
    }

    // Save and go to next page
    setStatus('עובר לעמוד הבא...');
    addLog('עמוד הסתיים', '#1a73e8');
    await sleep(2000);

    if (rows.length === 0) {
      setStatus(`הושלם! ${stats.updated} עודכנו`);
      addLog('=== סיום ===', '#1a73e8');
      window.postMessage({ crmUpdater: true, type: 'done' }, '*');
      return;
    }

    // Save stats and navigate
    window.postMessage({ crmUpdater: true, type: 'saveStats', stats: stats }, '*');
    await sleep(800);

    const url = new URL(window.location.href);
    const pg = parseInt(url.searchParams.get('pg') || '1') + 1;
    url.searchParams.set('pg', pg);
    window.location.href = url.toString();
  })();
})();
