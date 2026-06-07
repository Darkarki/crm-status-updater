const puppeteer = require('puppeteer-core');
const XLSX = require('./xlsx.full.min.js');
const fs = require('fs');
const path = require('path');

// ===================== CONFIG =====================
const CRM_URL = 'https://tictac.moked-crm.co.il/index.php?company=10&filter=250';
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXCEL_PATH = path.join('C:/Users/inked/Downloads', 'דוח מובייל תיק תק (8).xlsx');
const STATUS_TARGET = 74; // "נמצא בדוח מוב"ל"
// ==================================================

// Load customer codes from Excel
function loadCustomerCodes() {
  const buf = fs.readFileSync(EXCEL_PATH);
  const wb = XLSX.read(buf);

  const codes = new Set();

  // Sheet: "חיבורים קווים", Column I (index 8) = ACCOUNT_NO
  const sheetName = wb.SheetNames.find(n => n.includes('חיבורים') && n.includes('קווים'));
  if (sheetName) {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
    for (let i = 1; i < data.length; i++) {
      const val = data[i] && data[i][8];
      if (val != null) codes.add(String(val).trim());
    }
    console.log(`[Excel] ${sheetName}: ${codes.size} קודי לקוח מעמודה I`);
  }

  return codes;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== CRM Status Updater ===\n');

  // Load Excel
  const customerCodes = loadCustomerCodes();
  if (customerCodes.size === 0) {
    console.log('No customer codes found!');
    return;
  }

  // Connect to Chrome with debug port
  console.log('[Browser] Connecting to Chrome...');
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null
  });

  const page = (await browser.pages())[0];

  // Navigate to CRM
  console.log('[Browser] Navigating to CRM...');
  await page.goto(CRM_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Check if we need to login
  const needsLogin = await page.evaluate(() => {
    return !!document.querySelector('input[name="password"], #login, .login-form');
  });

  if (needsLogin) {
    console.log('[Browser] Login required - please log in manually in the browser window.');
    console.log('[Browser] Waiting for you to log in and reach the sales page...');
    // Wait until we see the sales table
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const hasSales = await page.evaluate(() => document.querySelectorAll('tr.middle.info').length > 0);
      if (hasSales) { console.log('[Browser] Login successful!'); break; }
      if (i % 6 === 0) console.log('[Browser] Still waiting for login... (' + ((i+1)*5) + 's)');
    }
    // Navigate to the filter page
    await page.goto(CRM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  }

  await sleep(3000);

  let stats = { updated: 0, skipped: 0, linesUpdated: 0, total: 0, noSaleId: 0 };
  let pageNum = 1;

  while (true) {
    console.log(`\n--- Page ${pageNum} ---`);

    // Get all rows on current page
    const rowsData = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr.middle.info');
      return Array.from(rows).map((row, idx) => {
        // Get customer code
        const text = row.textContent;
        const codeMatch = text.match(/קוד לקוח[:\s]*(\d+)/);
        const code = codeMatch ? codeMatch[1].trim() : null;

        // Get customer name
        const tds = row.querySelectorAll('td');
        let name = 'unknown';
        for (let i = tds.length - 1; i >= 0; i--) {
          const t = tds[i].textContent.trim();
          const lines = t.split('\n').map(l => l.trim()).filter(l => l.length > 2);
          if (lines.length > 0 && lines[0].length < 40) { name = lines[0]; break; }
        }

        // Get sale ID
        let saleId = null;

        // From status link
        const statusLinks = row.querySelectorAll('a[id*="status_select"]');
        if (statusLinks.length > 0) {
          const m = statusLinks[0].id.match(/status_select_li_\d+_(\d+)/);
          if (m) saleId = m[1];
        }

        // From modal link
        if (!saleId) {
          const modalLink = row.querySelector('a[data-toggle="modal"]');
          if (modalLink) {
            const onclick = modalLink.getAttribute('onclick') || '';
            const m = onclick.match(/le_modal_load\((\d+)/);
            if (m) saleId = m[1];
          }
        }

        // From change_status onclick
        if (!saleId) {
          const changeLinks = row.querySelectorAll('a[onclick*="change_status"]');
          for (const link of changeLinks) {
            const m = (link.getAttribute('onclick') || '').match(/change_status_ajax_leads_sales\((\d+)/);
            if (m) { saleId = m[1]; break; }
          }
        }

        // Check if this is a "mixed" sale (has multiple statuses, e.g. "5 פעיל ולא נמצא")
        // vs a "pure" sale (all lines in same status)
        let isMixed = false;
        const statusBadges = row.querySelectorAll('a, span');
        for (const b of statusBadges) {
          const t = b.textContent.trim();
          // Pattern: "5 פעיל ולא נמצא" - starts with number then status
          if (/^\d+\s+פעיל\s+ולא\s+נמצא/.test(t)) {
            isMixed = true;
            break;
          }
        }

        return { idx, code, name, saleId, isMixed };
      });
    });

    console.log(`Found ${rowsData.length} rows`);

    for (const row of rowsData) {
      stats.total++;

      if (!row.code) {
        stats.skipped++;
        continue;
      }

      if (!customerCodes.has(row.code)) {
        stats.skipped++;
        console.log(`  [skip] ${row.name} (${row.code}) - not in report`);
        continue;
      }

      // Found in report!
      console.log(`  [MATCH] ${row.name} (${row.code})`);

      if (!row.saleId) {
        console.log(`    [warn] No sale ID found`);
        stats.noSaleId++;
        continue;
      }

      if (!row.isMixed) {
        // Pure sale - update via outer function
        console.log(`    [pure] Updating sale ${row.saleId} to status ${STATUS_TARGET}...`);
        await page.evaluate((saleId, status) => {
          change_status_ajax_leads_sales(saleId, status);
        }, parseInt(row.saleId), STATUS_TARGET);
        stats.updated++;
        await sleep(2000);
        continue; // Don't open modal for pure sales
      }

      console.log(`    [mixed] Sale has multiple statuses - opening modal...`);

      // Now open the sale modal to update individual lines
      console.log(`    Opening sale modal...`);
      const modalOpened = await page.evaluate((idx) => {
        const rows = document.querySelectorAll('tr.middle.info');
        const row = rows[idx];
        if (!row) return false;
        const link = row.querySelector('a[data-toggle="modal"]');
        if (!link) return false;
        link.click();
        return true;
      }, row.idx);

      if (!modalOpened) {
        console.log(`    Could not open modal`);
        continue;
      }

      await sleep(4000); // Wait for modal to load

      // Find and update line items in "פעיל" status inside the modal
      const lineResults = await page.evaluate((statusTarget) => {
        // Find the visible modal
        const modals = document.querySelectorAll('.modal');
        let modal = null;
        for (const m of modals) {
          if (m.offsetHeight > 0 && m.offsetWidth > 0) { modal = m; break; }
        }
        if (!modal) return { error: 'no modal found', lines: 0 };

        // Find ALL links in modal that contain "פעיל" and have change_status_ajax_leads_sale_item onclick
        const allLinks = modal.querySelectorAll('a');
        const itemsToUpdate = new Set();

        for (const link of allLinks) {
          const text = link.textContent.trim();
          const onclick = link.getAttribute('onclick') || '';

          // These are the CURRENT STATUS display elements
          // They show "פעיל ולא נמצא..." and have onclick that changes to a different status
          if (text.includes('פעיל') && !text.includes('נמצא בדוח') && text.length < 30) {
            // Get the item ID from links nearby that have change_status_ajax_leads_sale_item
            // The status_select links have pattern: status_select_li_STATUSID_ITEMID
            const idMatch = link.id.match(/status_select_li_\d+_(\d+)/);
            if (idMatch) {
              itemsToUpdate.add(idMatch[1]);
            }
          }
        }

        // Also try: find status dropdown buttons
        const dropdowns = modal.querySelectorAll('[id^="status_dropdown_"]');
        for (const d of dropdowns) {
          const text = d.textContent.trim();
          if (text.includes('פעיל') && !text.includes('נמצא בדוח')) {
            const m = d.id.match(/status_dropdown_(\d+)/);
            if (m) itemsToUpdate.add(m[1]);
          }
        }

        // Also try: look for btn-sm elements that show status
        const badges = modal.querySelectorAll('a.btn-sm, span.btn-sm, a.text-right');
        for (const b of badges) {
          const text = b.textContent.trim();
          if (text.includes('פעיל') && !text.includes('נמצא בדוח') && text.length < 30) {
            const idMatch = b.id.match(/(\d{5,})/);
            if (idMatch) itemsToUpdate.add(idMatch[1]);
            // Also check onclick
            const onclickMatch = (b.getAttribute('onclick') || '').match(/(\d{5,})/);
            if (onclickMatch) itemsToUpdate.add(onclickMatch[1]);
          }
        }

        if (itemsToUpdate.size === 0) {
          // Debug: find what elements ARE showing פעיל
          const debugPwil = [];
          for (const link of allLinks) {
            if (link.textContent.includes('פעיל') && link.textContent.trim().length < 30 && link.getBoundingClientRect().height > 0) {
              debugPwil.push({
                tag: link.tagName,
                id: link.id.substring(0, 40),
                class: link.className.substring(0, 40),
                text: link.textContent.trim().substring(0, 25),
                onclick: (link.getAttribute('onclick') || 'none').substring(0, 60)
              });
            }
          }
          return { error: 'no items found', lines: 0, debug: debugPwil.slice(0, 5) };
        }

        // Update each item
        let updated = 0;
        const errors = [];
        for (const itemId of itemsToUpdate) {
          try {
            change_status_ajax_leads_sale_item(parseInt(itemId), statusTarget);
            updated++;
          } catch (e) {
            errors.push(itemId + ': ' + e.message);
          }
        }

        return { lines: updated, total: itemsToUpdate.size, errors };
      }, STATUS_TARGET);

      if (lineResults.error) {
        console.log(`    Lines: ${lineResults.error}`);
        if (lineResults.debug) {
          console.log(`    Debug - visible פעיל elements:`);
          lineResults.debug.forEach(d => console.log(`      ${d.tag} id:${d.id} class:${d.class} text:${d.text} onclick:${d.onclick}`));
        }
      } else {
        console.log(`    Lines updated: ${lineResults.lines}/${lineResults.total}`);
        stats.linesUpdated += lineResults.lines;
      }

      await sleep(1000);

      // Close modal
      await page.evaluate(() => {
        const closeBtn = document.querySelector('.modal.show .close, .modal.in .close, .modal[style*="display: block"] .close');
        if (closeBtn) closeBtn.click();
        else {
          const backdrop = document.querySelector('.modal-backdrop');
          if (backdrop) backdrop.click();
        }
      });
      await sleep(1500);
    }

    // Check for next page
    const hasNext = await page.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const link of links) {
        const text = link.textContent.trim();
        if (text === '>' || text === '›' || text === 'הבא') {
          link.click();
          return true;
        }
      }
      return false;
    });

    if (!hasNext) {
      console.log('\nNo more pages.');
      break;
    }
    pageNum++;
    await sleep(3000);
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total checked: ${stats.total}`);
  console.log(`Sales updated: ${stats.updated}`);
  console.log(`Lines updated: ${stats.linesUpdated}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`No sale ID: ${stats.noSaleId}`);

  console.log('\nDone! Browser will stay open. Close it manually when ready.');
}

main().catch(err => console.error('Fatal error:', err));
