/**
 * ============================================================================
 * MAURITIUS CEB ELECTRICITY BILLS SCRAPER (Google Apps Script)
 * ============================================================================
 * Scrapes customer electricity bills, balances, and breakdown from:
 *   https://payment.ceb.mu/
 *
 * Supports Multiple Accounts concurrently.
 * Storage: 100% Google Drive-free (In-Memory RAM Cache + Script Properties).
 * ============================================================================
 */

const CACHE_KEY = 'ceb_cache_data';
const CACHE_TTL_SECONDS = 25200; // 7 hours (guarantees overlap with 6-hour cron warming)
const PROP_KEY_RESULTS = 'LATEST_CEB_RESULTS';
const PROP_KEY_ACCOUNTS = 'CEB_ACCOUNTS';
const CEB_BASE_URL = 'https://payment.ceb.mu/';
const CEB_POST_URL = 'https://payment.ceb.mu/listtotal.aspx';

/**
 * 1. THE FETCHER: Scrapes all configured CEB accounts
 */
function fetchAndPushCebBills(accountsOverride) {
  const alertEmail = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL') || 
                     Session.getEffectiveUser().getEmail() || 
                     'pramsohok@gmail.com';

  try {
    // 1. Resolve Target Accounts
    let accountsToScrape = [];
    if (accountsOverride && Array.isArray(accountsOverride) && accountsOverride.length > 0) {
      accountsToScrape = accountsOverride;
    } else {
      const storedAccounts = PropertiesService.getScriptProperties().getProperty(PROP_KEY_ACCOUNTS);
      if (storedAccounts) {
        accountsToScrape = storedAccounts.split(',').map(function(a) { return a.trim(); }).filter(Boolean);
      }
    }

    if (accountsToScrape.length === 0) {
      accountsToScrape = ['10001234', '10005678']; // Default placeholder pair
    }

    const accountResults = [];
    let grandTotalDue = 0;

    for (let i = 0; i < accountsToScrape.length; i++) {
      const acc = accountsToScrape[i];
      const accData = scrapeSingleCebAccount(acc);
      accountResults.push(accData);
      grandTotalDue += (accData.total_due || 0);
    }

    const payload = {
      status: 'ok',
      last_updated: new Date().toISOString(),
      summary: {
        total_accounts: accountResults.length,
        total_due_amount: Math.round(grandTotalDue * 100) / 100,
        currency: 'MUR'
      },
      accounts: accountResults,
      sources: {
        portal: CEB_BASE_URL
      }
    };

    const payloadString = JSON.stringify(payload, null, 2);

    // Store in RAM Cache (Sub-10ms) & Script Properties (Persistent)
    try {
      CacheService.getScriptCache().put(CACHE_KEY, payloadString, CACHE_TTL_SECONDS);
    } catch (_) {}

    PropertiesService.getScriptProperties().setProperty(PROP_KEY_RESULTS, payloadString);
    Logger.log('Successfully scraped ' + accountResults.length + ' CEB accounts. Grand Total: Rs ' + grandTotalDue);

    return { success: true, data: payload };

  } catch (err) {
    Logger.log('CEB Scraper Exception: ' + err.toString());
    sendFailureAlert('CEB Scraper Exception', err.toString(), alertEmail);
    return { success: false, error: err.toString() };
  }
}

/**
 * Scrapes a single CEB contract account from payment.ceb.mu
 */
function scrapeSingleCebAccount(accountNumber) {
  const cleanAcc = String(accountNumber).trim();
  const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  try {
    // Step 1: GET landing page to extract ASP.NET ViewState tokens
    const landingResp = UrlFetchApp.fetch(CEB_BASE_URL, {
      method: 'get',
      headers: requestHeaders,
      muteHttpExceptions: true
    });

    if (landingResp.getResponseCode() !== 200) {
      return {
        account_number: cleanAcc,
        customer_name: 'Unavailable',
        total_due: 0,
        bills_detail: '',
        status: 'portal_error',
        error: 'HTTP ' + landingResp.getResponseCode(),
        last_checked: new Date().toISOString()
      };
    }

    const landingHtml = landingResp.getContentText();
    const vsMatch = landingHtml.match(/id="__VIEWSTATE"\s+value="([^"]+)"/i);
    const vgMatch = landingHtml.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]+)"/i);
    const evMatch = landingHtml.match(/id="__EVENTVALIDATION"\s+value="([^"]+)"/i);

    const viewState = vsMatch ? vsMatch[1] : '';
    const viewStateGen = vgMatch ? vgMatch[1] : '';
    const eventVal = evMatch ? evMatch[1] : '';

    // Step 2: POST to listtotal.aspx
    const postPayload = {
      '__VIEWSTATE': viewState,
      '__VIEWSTATEGENERATOR': viewStateGen,
      '__EVENTVALIDATION': eventVal,
      'CAid': cleanAcc,
      'Btnpr': 'Proceed'
    };

    const postResp = UrlFetchApp.fetch(CEB_POST_URL, {
      method: 'post',
      headers: requestHeaders,
      payload: postPayload,
      muteHttpExceptions: true
    });

    const resHtml = postResp.getContentText();

    // Check for disconnection / account error alert
    if (resHtml.indexOf('callloc()') !== -1 || resHtml.indexOf('Please try again later') !== -1) {
      return {
        account_number: cleanAcc,
        customer_name: 'Not Found / Disconnected',
        total_due: 0,
        bills_detail: '',
        status: 'not_found_or_disconnected',
        last_checked: new Date().toISOString()
      };
    }

    // Extract Account Name
    let customerName = 'Unknown';
    const nameMatch = resHtml.match(/id="catext"[^>]*value="([^"]*)"/i) || 
                      resHtml.match(/value="([^"]*)"[^>]*id="catext"/i);
    if (nameMatch && nameMatch[1].trim()) {
      customerName = nameMatch[1].trim();
    }

    // Extract Total Amount Due
    let totalDue = 0;
    const dueMatch = resHtml.match(/id="totid"[^>]*value="([^"]*)"/i) || 
                     resHtml.match(/value="([^"]*)"[^>]*id="totid"/i);
    if (dueMatch && dueMatch[1].trim()) {
      totalDue = parseFloat(dueMatch[1].trim()) || 0;
    }

    // Extract Bills Detail / Breakdown
    let billsDetail = '';
    const billMatch = resHtml.match(/<label id="LstBill"[^>]*>([\s\S]*?)<\/label>/i);
    if (billMatch && billMatch[1].trim()) {
      billsDetail = billMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    return {
      account_number: cleanAcc,
      customer_name: customerName,
      total_due: totalDue,
      bills_detail: billsDetail,
      status: 'active',
      last_checked: new Date().toISOString()
    };

  } catch (e) {
    return {
      account_number: cleanAcc,
      customer_name: 'Unavailable',
      total_due: 0,
      bills_detail: '',
      status: 'error',
      error: e.toString(),
      last_checked: new Date().toISOString()
    };
  }
}

/**
 * 2. WEB APP ENDPOINT: Exposes cached CEB results as JSON
 * Supports:
 *   GET /                           -> Returns cached multi-account JSON instantly
 *   GET /?action=refresh            -> Forces a live scrape from payment.ceb.mu
 *   GET /?accounts=12345,67890      -> Filters / scrapes specific accounts
 */
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};

  let targetAccounts = null;
  if (params.accounts) {
    targetAccounts = params.accounts.split(',').map(function(a) { return a.trim(); }).filter(Boolean);
  }

  // Live on-demand refresh
  if (params.action === 'refresh' || targetAccounts) {
    Logger.log('On-demand live refresh requested for CEB accounts');
    const refreshResult = fetchAndPushCebBills(targetAccounts);
    if (refreshResult.success) {
      const resp = refreshResult.data;
      resp.cache_source = 'live_refresh';
      return jsonResponse(resp);
    } else {
      return jsonResponse({
        status: 'error',
        error: 'Refresh failed',
        details: refreshResult.error
      });
    }
  }

  // 1. Fast RAM Cache Read (< 10ms)
  try {
    const memoryData = CacheService.getScriptCache().get(CACHE_KEY);
    if (memoryData) {
      return ContentService.createTextOutput(memoryData)
                           .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (_) {}

  // 2. Persistent ScriptProperties Read (~15ms)
  const propData = PropertiesService.getScriptProperties().getProperty(PROP_KEY_RESULTS);
  if (propData) {
    // Re-warm RAM cache
    try {
      CacheService.getScriptCache().put(CACHE_KEY, propData, CACHE_TTL_SECONDS);
    } catch (_) {}

    return ContentService.createTextOutput(propData)
                         .setMimeType(ContentService.MimeType.JSON);
  }

  // 3. Cold Start: Scrape immediately if no cache exists
  const initialFetch = fetchAndPushCebBills();
  if (initialFetch.success) {
    return jsonResponse(initialFetch.data);
  } else {
    return jsonResponse({
      status: 'error',
      error: 'Initial scrape failed',
      details: initialFetch.error
    });
  }
}

/**
 * 3. JSON RESPONSE FORMATTER
 */
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data, null, 2))
                       .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 4. AUTOMATED SCHEDULED TRIGGERS
 * - Every 6 Hours periodic refresh
 * - Daily morning check at 08:00
 */
function createCebTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }

  // 6-Hour Periodic Refresh to keep RAM & ScriptProperties warm
  ScriptApp.newTrigger('fetchAndPushCebBills')
    .timeBased()
    .everyHours(6)
    .create();

  // Daily Morning Sync (08:00 AM)
  ScriptApp.newTrigger('fetchAndPushCebBills')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  Logger.log('CEB triggers created: Every 6 hours & Daily at 8:00 AM');
}

/**
 * 5. FAILURE ALERTING
 */
function sendFailureAlert(subject, details, recipientEmail) {
  if (!recipientEmail) return;

  const props = PropertiesService.getScriptProperties();
  const lastAlert = parseInt(props.getProperty('LAST_ALERT_TIMESTAMP') || '0', 10);
  const now = Date.now();
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;

  if (now - lastAlert < TWELVE_HOURS) {
    return;
  }

  try {
    MailApp.sendEmail({
      to: recipientEmail,
      subject: '[Home Assistant Alert] Mauritius CEB Bill Scraper Failed: ' + subject,
      body: 'The automated CEB bill scraper encountered an error at ' + 
            new Date().toISOString() + ':\n\n' +
            'Reason: ' + subject + '\n\n' +
            'Technical Details:\n' + details + '\n\n' +
            'Portal: ' + CEB_BASE_URL
    });
    props.setProperty('LAST_ALERT_TIMESTAMP', now.toString());
  } catch (_) {}
}

