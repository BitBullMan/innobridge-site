// ============================================================
// Google Apps Script - AML Address Lookup API (v3 - Dashboard)
// ============================================================
// v3 更新:
// - 新增 action=stats: 返回 Dashboard 统计数据
// - 新增 action=recent: 返回最近 N 条黑名单记录
// - 保持原有 address 查询兼容
// ============================================================
// 部署步骤:
// 1. 打开 Google Sheet (innobridge_aml_database)
// 2. Extensions → Apps Script
// 3. 粘贴此代码替换所有内容
// 4. 点击 Deploy → Manage deployments
// 5. 编辑现有部署 → Version 选 "New version"
// 6. 点 Deploy (Update)
// ============================================================

// Configuration
const SHEET_NAME = 'AML_Addresses';
const ADDRESS_COL = 1;  // Column A = address

// Cache for performance
const CACHE_TTL = 21600;      // 6 hours for address lookups
const STATS_CACHE_TTL = 1800; // 30 min for stats
const RECENT_CACHE_TTL = 900; // 15 min for recent list

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  try {
    // Guard: when run from editor, e is undefined
    if (!e || !e.parameter) e = { parameter: {} };

    const callback = e.parameter.callback || '';
    const action = (e.parameter.action || '').toLowerCase();

    // Route by action
    if (action === 'stats') {
      return sendResponse(getStats(), callback);
    }
    if (action === 'recent') {
      var limit = parseInt(e.parameter.limit) || 100;
      if (limit > 200) limit = 200;
      return sendResponse(getRecent(limit), callback);
    }

    // Default: address lookup (backward compatible)
    var address = (e.parameter.address || '').trim().toLowerCase();
    if (!address) {
      return sendResponse({ success: false, error: 'Missing address parameter. Use ?action=stats or ?action=recent or ?address=xxx' }, callback);
    }

    // Try cache first
    var cache = CacheService.getScriptCache();
    var cacheKey = 'aml_' + address;
    var cached = cache.get(cacheKey);
    if (cached) {
      return sendResponse(JSON.parse(cached), callback);
    }

    // Query the sheet
    var results = lookupAddress(address);
    var responseData = {
      success: true,
      address: address,
      found: results.length > 0,
      results: results,
      checked_at: new Date().toISOString(),
      total_records: getRowCount()
    };

    cache.put(cacheKey, JSON.stringify(responseData), CACHE_TTL);
    return sendResponse(responseData, callback);

  } catch (error) {
    return sendResponse({ success: false, error: error.message }, e.parameter.callback || '');
  }
}

// ============================================================
// JSONP / JSON Response
// ============================================================
function sendResponse(data, callback) {
  var jsonStr = JSON.stringify(data);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + jsonStr + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  } else {
    return ContentService.createTextOutput(jsonStr)
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// action=stats  - Dashboard Statistics
// ============================================================
function getStats() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('dashboard_stats');
  if (cached) {
    return JSON.parse(cached);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet not found');

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return h.toString().toLowerCase().trim(); });

  // Build column index map
  var col = {};
  headers.forEach(function(h, i) { col[h] = i; });

  var usdtEthCount = 0, usdtTronCount = 0, usdcEthCount = 0;
  var totalFrozen = 0;
  var todayStr = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  var todayNew = 0;

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var chain = (row[col['chain']] || '').toString().toUpperCase().trim();
    var asset = (row[col['asset']] || '').toString().toUpperCase().trim();
    var frozenAmt = parseFloat(row[col['frozen_amount']]) || 0;
    var addedDate = (row[col['added_date']] || row[col['date_added']] || '').toString();

    // Count by chain+asset
    if (asset === 'USDT' && chain === 'ETH') usdtEthCount++;
    else if (asset === 'USDT' && chain === 'TRON') usdtTronCount++;
    else if (asset === 'USDC' && chain === 'ETH') usdcEthCount++;
    else {
      // For older records without asset/chain, try to detect from address
      var addr = (row[col['address']] || '').toString();
      if (addr.startsWith('T') && addr.length >= 30) usdtTronCount++;
      else if (addr.startsWith('0x')) usdtEthCount++;
    }

    totalFrozen += frozenAmt;

    // Today's new
    if (addedDate.indexOf(todayStr) === 0) {
      todayNew++;
    }
  }

  var totalAddresses = data.length - 1;
  var now = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm:ss');

  var result = {
    success: true,
    stats: {
      total_addresses: totalAddresses,
      usdt_eth_count: usdtEthCount,
      usdt_tron_count: usdtTronCount,
      usdc_eth_count: usdcEthCount,
      total_frozen_amount: Math.round(totalFrozen * 100) / 100,
      today_new_count: todayNew,
      last_updated: now
    }
  };

  // Cache for 30 min
  cache.put('dashboard_stats', JSON.stringify(result), STATS_CACHE_TTL);
  return result;
}

// ============================================================
// action=recent  - Recent Blacklisted Addresses
// ============================================================
function getRecent(limit) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'recent_' + limit;
  var cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet not found');

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return h.toString().toLowerCase().trim(); });
  var col = {};
  headers.forEach(function(h, i) { col[h] = i; });

  // Build list of all rows with relevant fields
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var addr = (row[col['address']] || '').toString().trim();
    if (!addr) continue;

    var dateStr = (row[col['firstseen']] || row[col['added_date']] || row[col['date_added']] || '').toString();
    var dateMs = 0;
    try {
      if (dateStr) {
        var d = new Date(dateStr);
        if (!isNaN(d.getTime())) dateMs = d.getTime();
      }
    } catch(e) {}

    rows.push({
      address: addr,
      chain: (row[col['chain']] || '').toString().trim(),
      asset: (row[col['asset']] || '').toString().trim(),
      risk_level: (row[col['risk_level']] || 'HIGH').toString().trim(),
      risk_score: (row[col['risk_score']] || '').toString().trim(),
      frozen_amount: (row[col['frozen_amount']] || '').toString().trim(),
      frozen_amount_display: (row[col['frozen_amount_display']] || '').toString().trim(),
      firstSeen: dateStr,
      added_date: (row[col['added_date']] || row[col['date_added']] || '').toString().trim(),
      txHash: (row[col['txhash']] || '').toString().trim(),
      category: (row[col['category']] || '').toString().trim(),
      label: (row[col['label']] || '').toString().trim(),
      _sortDate: dateMs
    });
  }

  // Sort by date descending (most recent first)
  rows.sort(function(a, b) { return b._sortDate - a._sortDate; });

  // Take top N
  var recent = rows.slice(0, limit);

  // Remove internal sort field
  for (var j = 0; j < recent.length; j++) {
    delete recent[j]._sortDate;
  }

  var result = {
    success: true,
    results: recent,
    total: data.length - 1,
    returned: recent.length
  };

  cache.put(cacheKey, JSON.stringify(result), RECENT_CACHE_TTL);
  return result;
}

// ============================================================
// Address Lookup (original v2 logic)
// ============================================================
function lookupAddress(address) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found');

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return h.toString().toLowerCase().trim(); });
  var results = [];

  var colMap = {};
  headers.forEach(function(h, i) { colMap[h] = i; });

  for (var i = 1; i < data.length; i++) {
    var rowAddr = (data[i][colMap['address']] || '').toString().toLowerCase().trim();
    if (rowAddr === address) {
      var result = {};
      headers.forEach(function(h, j) {
        result[h] = data[i][j] !== undefined ? data[i][j].toString() : '';
      });
      results.push(result);
    }
  }

  return results;
}

function getRowCount() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('total_rows');
  if (cached) return parseInt(cached);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  var count = sheet ? sheet.getLastRow() - 1 : 0;
  cache.put('total_rows', count.toString(), 3600);
  return count;
}

// ============================================================
// Test Functions
// ============================================================
function testStats() {
  var result = getStats();
  Logger.log(JSON.stringify(result, null, 2));
}

function testRecent() {
  var result = getRecent(10);
  Logger.log(JSON.stringify(result, null, 2));
}

function testLookup() {
  var testAddress = '0x0000000000000000000000000000000000000000';
  var results = lookupAddress(testAddress);
  Logger.log('Results for ' + testAddress + ': ' + JSON.stringify(results));
  Logger.log('Total rows: ' + getRowCount());
}
