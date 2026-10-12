// CRM Updater Runner - injected into the page (MAIN world).
// Reads codes from window._crmUpdaterResumeCodes and state from window._crmUpdaterResumeStats (set by background/popup).
//
// v1.2 (2026-10-12):
// - FASTER: no fixed sleeps. Every action waits only until the CRM's own AJAX is finished (jQuery.active / fetch idle),
//   the modal is really open, or the table is really rendered.
// - MISSES FIXED: updated customers drop out of this filtered list, so the rows below move up a page. The old runner
//   jumped to pg+1 and never saw them. Now: if a page had updates, the SAME page is reloaded; only a page with nothing
//   left to do moves on. A list of handled sale ids makes sure nobody is checked twice and the loop always ends.
// - Customer codes are normalised on both sides (digits only, no leading zeros), every code in a row is checked,
//   codes with letters/prefixes are no longer skipped as "no code".
// - At the end: a list of customers that were in the report but did not change status, for a manual look.

(function() {
  const rawCodes = window._crmUpdaterResumeCodes;
  const resume = window._crmUpdaterResumeStats || {};
  if (!rawCodes || rawCodes.length === 0) { console.log('CRM Updater: No codes to resume'); return; }

  const norm = c => { const d = String(c ?? '').trim().replace(/\.0+$/, '').replace(/\D/g, '').replace(/^0+/, ''); return d || null; };
  const codes = new Set(rawCodes.map(norm).filter(Boolean));
  const stats = { updated: 0, skipped: 0, total: 0, failed: [], handled: [], ...resume };
  const handled = new Set(stats.handled || []);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // PACE: minimum pauses on top of "wait until the CRM is done" (too fast made the CRM skip pages and hang).
  // Raise these numbers if it still runs ahead of the CRM.
  const PACE = { afterUpdate: 800, afterModalOpen: 700, afterModalClose: 600, beforeNextPage: 1500, tableStable: 1000 };
  async function until(fn, timeout = 10000, step = 80) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { if (fn()) return true; } catch (e) {} await sleep(step); }
    return false;
  }
  // the CRM uses jQuery for its AJAX; wait until every request it started is finished
  const ajaxIdle = () => !(window.jQuery && window.jQuery.active > 0);
  async function afterAjax(timeout = 12000) { await sleep(60); await until(ajaxIdle, timeout); }

  function rowCodes(row) {
    const out = new Set();
    const t = row.textContent;
    const re = /קוד\s*לקוח[:\s]*([A-Za-z]*[\s-]*\d[\d\s-]*)/g;
    let m;
    while ((m = re.exec(t))) { const n = norm(m[1]); if (n) out.add(n); }
    return [...out];
  }

  function getCustomerName(row) {
    const tds = row.querySelectorAll('td');
    for (let i = tds.length - 1; i >= 0; i--) {
      const lines = tds[i].textContent.trim().split('\n').map(l => l.trim()).filter(l => l.length > 2 && !l.includes('function'));
      if (lines.length > 0 && lines[0].length < 40) return lines[0];
    }
    return 'לא ידוע';
  }

  function saleIdOf(row) {
    const sl = row.querySelector('a[id*="status_select"]');
    let m = sl && sl.id.match(/status_select_li_\d+_(\d+)/);
    if (m) return m[1];
    for (const a of row.querySelectorAll('a[onclick*="change_status"]')) {
      m = (a.getAttribute('onclick') || '').match(/change_status_ajax_leads_sales\((\d+)/);
      if (m) return m[1];
    }
    const ml = row.querySelector('a[data-toggle="modal"]');
    m = ml && (ml.getAttribute('onclick') || '').match(/le_modal_load\((\d+)/);
    return m ? m[1] : null;
  }

  const findModal = () => [...document.querySelectorAll('.modal')].find(m => m.offsetHeight > 0 && m.offsetWidth > 0) || null;
  const modalDropdowns = modal => modal.querySelectorAll('[class*="status_dropdown_"], [id^="status_dropdown_"]');

  async function updateLineStatuses(row) {
    const link = row.querySelector('a[data-toggle="modal"]');
    if (!link) return 0;
    link.click();
    let modal = null;
    await until(() => (modal = findModal()) && modalDropdowns(modal).length > 0, 12000);
    await afterAjax();
    await sleep(PACE.afterModalOpen);
    if (!modal) return 0;
    const items = new Set();
    for (const d of modalDropdowns(modal)) {
      const text = d.textContent.trim();
      const m = d.id.match(/status_dropdown_(\d+)/) || (d.className || '').match(/status_dropdown_(\d+)/);
      if (m && text.includes('פעיל') && !text.includes('נמצא בדוח')) items.add(m[1]);
    }
    let n = 0;
    for (const id of items) {
      try { change_status_ajax_leads_sale_item(parseInt(id), 74); await afterAjax(); await sleep(PACE.afterUpdate); n++; } catch (e) {}
    }
    const close = modal.querySelector('.close, [data-dismiss="modal"]');
    if (close) close.click();
    await until(() => !findModal(), 4000);
    await sleep(PACE.afterModalClose);
    return n;
  }

  async function updateStatus(row, saleId) {
    const mixed = [...row.querySelectorAll('a, span, div')].some(b => /^\d+\s+פעיל\s+ולא\s+נמצא/.test(b.textContent.trim()));
    if (!mixed) {
      try { change_status_ajax_leads_sales(saleId, 74); await afterAjax(); await sleep(PACE.afterUpdate); return true; } catch (e) { return false; }
    }
    return (await updateLineStatuses(row)) > 0;
  }

  // ---------------------------------------------------------------- panel
  document.getElementById('crm-updater-panel')?.remove();
  const panel = document.createElement('div');
  panel.id = 'crm-updater-panel';
  panel.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;background:#fff;border:2px solid #1a73e8;border-radius:10px;padding:15px;width:300px;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:sans-serif;direction:rtl;';
  panel.innerHTML = `
    <h3 style="margin:0 0 10px;color:#1a73e8;font-size:16px;">עדכון סטטוסים</h3>
    <div id="crm-upd-status" style="font-size:13px;margin-bottom:8px;">טוען עמוד...</div>
    <div style="display:flex;justify-content:space-around;margin-bottom:8px;">
      <div style="text-align:center"><div id="crm-upd-updated" style="font-size:22px;font-weight:bold;color:#2e7d32;">${stats.updated}</div><div style="font-size:11px;color:#888;">עודכנו</div></div>
      <div style="text-align:center"><div id="crm-upd-skipped" style="font-size:22px;font-weight:bold;color:#888;">${stats.skipped}</div><div style="font-size:11px;color:#888;">לא בדוח</div></div>
      <div style="text-align:center"><div id="crm-upd-total" style="font-size:22px;font-weight:bold;color:#1a73e8;">${stats.total}</div><div style="font-size:11px;color:#888;">נבדקו</div></div>
    </div>
    <button id="crm-upd-stop" style="width:100%;padding:8px;background:#c62828;color:white;border:none;border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;margin-bottom:8px;">עצור</button>
    <div id="crm-upd-log" style="max-height:180px;overflow-y:auto;font-size:11px;background:#f8f8f8;border-radius:4px;padding:6px;"></div>`;
  document.body.appendChild(panel);
  window._crmUpdaterStop = false;
  document.getElementById('crm-upd-stop').addEventListener('click', () => { window._crmUpdaterStop = true; });
  const setStatus = s => { document.getElementById('crm-upd-status').textContent = s; };
  function addLog(t, c) {
    const e = document.createElement('div'); e.style.cssText = 'margin-bottom:3px;color:' + (c || '#333'); e.textContent = t;
    document.getElementById('crm-upd-log').prepend(e);
  }
  const showStats = () => {
    document.getElementById('crm-upd-updated').textContent = stats.updated;
    document.getElementById('crm-upd-skipped').textContent = stats.skipped;
    document.getElementById('crm-upd-total').textContent = stats.total;
  };
  const save = () => { stats.handled = [...handled]; window.postMessage({ crmUpdater: true, type: 'saveStats', stats }, '*'); };

  // ---------------------------------------------------------------- main
  (async () => {
    // wait for the table instead of a fixed delay (an empty last page simply has no rows)
    await until(() => document.querySelectorAll('tr.middle.info').length > 0 || document.readyState === 'complete' && Date.now() - performance.timing.domContentLoadedEventEnd > 2500, 15000);
    await afterAjax(5000);
    // the table must stop changing for a full second before we read it
    let last = -1, stableSince = Date.now();
    await until(() => {
      const n = document.querySelectorAll('tr.middle.info').length;
      if (n !== last) { last = n; stableSince = Date.now(); }
      return Date.now() - stableSince >= PACE.tableStable && ajaxIdle();
    }, 20000, 150);
    const rows = [...document.querySelectorAll('tr.middle.info')];
    const url = new URL(window.location.href);
    const pg = parseInt(url.searchParams.get('pg') || '1');
    addLog(`עמוד ${pg}: ${rows.length} שורות`, '#1a73e8');

    let updatedHere = 0, newHere = 0;
    for (let i = 0; i < rows.length; i++) {
      if (window._crmUpdaterStop) { addLog('נעצר', '#c62828'); save(); window.postMessage({ crmUpdater: true, type: 'stop' }, '*'); return; }
      const row = rows[i];
      const saleId = saleIdOf(row);
      const key = saleId || `row:${rowCodes(row).join(',')}:${getCustomerName(row)}`;
      if (handled.has(key)) continue;                       // already checked on an earlier pass
      handled.add(key); newHere++; stats.total++;
      const name = getCustomerName(row);
      const rc = rowCodes(row);
      setStatus(`עמוד ${pg} · ${i + 1}/${rows.length}`);
      if (!rc.length) { stats.skipped++; addLog(`${name} - אין קוד לקוח בשורה`, '#e65100'); showStats(); continue; }
      const hit = rc.find(c => codes.has(c));
      if (!hit) { stats.skipped++; showStats(); continue; }
      if (!saleId) { stats.failed.push(`${name} (${hit}): לא נמצא מזהה מכירה`); addLog(`${name} - אין מזהה מכירה`, '#c62828'); showStats(); continue; }
      const ok = await updateStatus(row, saleId);
      if (ok) { stats.updated++; updatedHere++; addLog(`${name} (${hit}) - עודכן`, '#2e7d32'); }
      else { stats.failed.push(`${name} (${hit})`); addLog(`${name} (${hit}) - לא עודכן`, '#c62828'); }
      showStats();
    }
    save();

    if (rows.length === 0) return finish();
    // Updated rows leave this filtered list, so the next rows moved up into THIS page: check it again.
    // Only a page where nothing new was found moves on.
    if (updatedHere > 0) { setStatus(`עמוד ${pg}: ${updatedHere} עודכנו, בודק שוב את אותו עמוד`); await sleep(PACE.beforeNextPage); window.location.reload(); return; }
    url.searchParams.set('pg', pg + 1);
    setStatus(`עובר לעמוד ${pg + 1}`);
    await sleep(PACE.beforeNextPage);
    window.location.href = url.toString();
  })();

  function finish() {
    setStatus(`הסתיים: ${stats.updated} עודכנו`);
    addLog(`=== סיום: ${stats.updated} עודכנו, ${stats.total} נבדקו ===`, '#1a73e8');
    if (stats.failed.length) {
      addLog(`לבדיקה ידנית (${stats.failed.length}):`, '#c62828');
      stats.failed.forEach(f => addLog('• ' + f, '#c62828'));
    }
    window.postMessage({ crmUpdater: true, type: 'done', stats }, '*');
  }
})();
