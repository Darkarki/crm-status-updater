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
  const PACE = { afterUpdate: 2500, afterModalOpen: 1500, afterModalClose: 1500, beforeNextPage: 4000, tableStable: 1500 };
  const jitter = ms => ms + Math.round(Math.random() * ms * 0.4);          // +0..40% so it never fires on a fixed beat
  // The lists (CRM filters) one run goes through, in order, and the line statuses that move to 74 "נמצא בדוח מובייל".
  const FILTERS = [{ id: 250, name: 'פעיל ולא נמצא בדוחות' }, { id: 35, name: 'פעיל - לא לתגמול' }, { id: 63, name: 'נויד בהצלחה' }];
  const SOURCE_STATUS = /פעיל\s*ולא\s*נמצא|פעיל\s*-\s*לא\s*לתגמול|נויד\s*בהצלחה/;
  async function until(fn, timeout = 10000, step = 80) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { if (fn()) return true; } catch (e) {} await sleep(step); }
    return false;
  }
  // the CRM uses jQuery for its AJAX; wait until every request it started is finished
  const ajaxIdle = () => !(window.jQuery && window.jQuery.active > 0);
  async function afterAjax(timeout = 2500) { await sleep(150); await until(ajaxIdle, timeout); }

  function rowCodes(row) {
    const out = new Set();
    const t = row.textContent;
    const re = /קוד\s*לקוח[:\s]*([A-Za-z]*[\s-]*\d[\d\s-]*)/g;
    let m;
    while ((m = re.exec(t))) { const n = norm(m[1]); if (n) out.add(n); }
    if (!out.size) {                                   // no "קוד לקוח" label: try every number in the row against the report
      for (const tok of t.match(/\d[\d-]{4,12}\d/g) || []) { const n = norm(tok); if (n && n.length >= 6 && codes.has(n)) out.add(n); }
    }
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
    for (const a of row.querySelectorAll('a[onclick*="modal_load"]')) {
      m = (a.getAttribute('onclick') || '').match(/(?:sale|le)_modal_load\((\d+)/);
      if (m) return m[1];
    }
    const pk = row.querySelector('#ORDERID[data-pk], [data-pk]');
    return pk ? pk.getAttribute('data-pk') : null;
  }

  // Customer rows. The CRM's classic markup is tr.middle.info; if that is gone (markup change, or the rows come in
  // later by AJAX), fall back to the innermost table rows that contain "קוד לקוח" and a status/modal link.
  let rowMethod = '';
  function findRows() {
    // Real markup (snapshot 2026-10-12): customers are <tr class="middle warning"> (yellow) AND <tr class="middle info">
    // (blue); the old selector tr.middle.info saw only the blue ones (3 of 20 on a page). Header rows have no code.
    const rows = [...document.querySelectorAll('tr.middle')].filter(tr => /קוד\s*לקוח/.test(tr.textContent));
    rowMethod = 'tr.middle + קוד לקוח';
    if (rows.length) return rows;
    const LINK = 'a[id*="status_select"], a[onclick*="change_status"], a[onclick*="modal_load"], a[data-toggle="modal"]';
    const cands = [...document.querySelectorAll('tr')].filter(tr => tr.querySelector(LINK));
    rowMethod = 'שורות עם כפתור';
    return cands.filter(tr => !cands.some(o => o !== tr && tr.contains(o)));
  }

  const findModal = () => [...document.querySelectorAll('.modal')].find(m => m.offsetHeight > 0 && m.offsetWidth > 0) || null;
  const modalDropdowns = modal => modal.querySelectorAll('[class*="status_dropdown_"], [id^="status_dropdown_"]');

  async function updateLineStatuses(row) {
    const link = row.querySelector('a[onclick*="modal_load"][onclick*="name"]') || row.querySelector('a[onclick*="modal_load"]') || row.querySelector('a[data-toggle="modal"]');
    if (!link) return 0;
    link.click();
    let modal = null;
    await until(() => (modal = findModal()) && modalDropdowns(modal).length > 0, 12000);
    await afterAjax();
    await sleep(jitter(PACE.afterModalOpen));
    if (!modal) return 0;
    const items = new Set();
    for (const d of modalDropdowns(modal)) {
      const text = d.textContent.trim();
      const m = d.id.match(/status_dropdown_(\d+)/) || (d.className || '').match(/status_dropdown_(\d+)/);
      if (m && SOURCE_STATUS.test(text) && !text.includes('נמצא בדוח')) items.add(m[1]);
    }
    let n = 0;
    for (const id of items) {
      try { change_status_ajax_leads_sale_item(parseInt(id), 74); await afterAjax(); await sleep(jitter(PACE.afterUpdate)); n++; } catch (e) {}
    }
    const close = modal.querySelector('.close, [data-dismiss="modal"]');
    if (close) close.click();
    await until(() => !findModal(), 4000);
    await sleep(jitter(PACE.afterModalClose));
    return n;
  }

  async function updateStatus(row, saleId) {
    const mixed = !row.querySelector('a[id*="status_select"]') ||
      [...row.querySelectorAll('a, span, div')].some(b => { const t = b.textContent.trim(); return /^\d+\s+/.test(t) && SOURCE_STATUS.test(t); });
    if (!mixed) {
      try { change_status_ajax_leads_sales(saleId, 74); await afterAjax(); await sleep(jitter(PACE.afterUpdate)); return true; } catch (e) { return false; }
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
  (async () => { try {
    // wait for the table instead of a fixed delay (an empty last page simply has no rows)
    await until(() => findRows().length > 0, 20000, 200);
    setStatus('ממתין לטבלה...');
    await afterAjax(2500);
    // the table must stop changing for a full second before we read it
    let last = -1, stableSince = Date.now();
    await until(() => {
      const n = findRows().length;
      if (n !== last) { last = n; stableSince = Date.now(); }
      return Date.now() - stableSince >= PACE.tableStable;
    }, 8000, 150);
    const rows = findRows();
    const url = new URL(window.location.href);
    const pg = parseInt(url.searchParams.get('pg') || '1');
    // A NEW run always starts on page 1 (the tab may still sit on a page past the end from an earlier run -> 0 rows).
    const fi = stats.filterIdx || 0;
    const cur = FILTERS[fi];
    if (!stats.started || String(url.searchParams.get('filter')) !== String(cur.id)) {
      stats.started = true; stats.filterIdx = fi; save();
      if (pg !== 1 || String(url.searchParams.get('filter')) !== String(cur.id)) {
        setStatus(`עובר לרשימה "${cur.name}"...`); url.searchParams.set('filter', cur.id); url.searchParams.set('pg', 1);
        await sleep(1000); window.location.href = url.toString(); return;
      }
    }
    addLog(`${cur.name} · עמוד ${pg}: ${rows.length} שורות, ${codes.size} קודים מהאקסל`, '#1a73e8');

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
      setStatus(`${cur.name} · עמוד ${pg} · ${i + 1}/${rows.length}`);
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

    if (rows.length === 0) {
      const trs = document.querySelectorAll('tr').length, withCode = [...document.querySelectorAll('tr')].filter(t => /קוד\s*לקוח/.test(t.textContent)).length;
      const sample = [...document.querySelectorAll('tr')].map(t => t.textContent.replace(/\s+/g, ' ').trim()).filter(x => /\d{6,}/.test(x)).slice(0, 2);
      sample.forEach(x => addLog('דוגמה: ' + x.slice(0, 160), '#888'));
      addLog(`עמוד ${pg} ריק (${document.querySelectorAll('table').length} טבלאות, ${trs} שורות tr, ${withCode} עם "קוד לקוח")`, '#888');
      if (fi + 1 < FILTERS.length) {
        const nx = FILTERS[fi + 1];
        stats.filterIdx = fi + 1; save();
        addLog(`סיימתי "${cur.name}", עובר ל"${nx.name}"`, '#1a73e8');
        url.searchParams.set('filter', nx.id); url.searchParams.set('pg', 1);
        await sleep(jitter(PACE.beforeNextPage)); window.location.href = url.toString(); return;
      }
      return finish();
    }
    // Updated rows leave this filtered list, so the next rows moved up into THIS page: check it again.
    // Only a page where nothing new was found moves on.
    if (updatedHere > 0) { setStatus(`עמוד ${pg}: ${updatedHere} עודכנו, בודק שוב את אותו עמוד`); await sleep(jitter(PACE.beforeNextPage)); window.location.reload(); return; }
    url.searchParams.set('pg', pg + 1);
    setStatus(`עובר לעמוד ${pg + 1}`);
    await sleep(jitter(PACE.beforeNextPage));
    window.location.href = url.toString();
  } catch (e) {
    console.error('CRM Updater error', e);
    setStatus('שגיאה: ' + (e && e.message || e));
    addLog('שגיאה: ' + (e && e.stack || e), '#c62828');
  } })();

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
