/**
 * Hamm Weekly Grocery Planner — Google Apps Script
 * Version 0.3.0
 *
 * Required Script Properties:
 *   BACKEND_URL
 *   BACKEND_SHARED_TOKEN
 * Optional:
 *   SPICE_SHEET_ID
 *   SPICE_TAB
 */

const SOURCE_SHEET = 'All Items';
const OUTPUT_SHEET = 'Weekly Order';
const EXCLUDED_SHEET = 'Excluded Items';
const REVIEW_SHEET = 'Needs Review';
const GUIDE_SHEET = 'Planner Guide';
const DAYLIGHT_SHEET = 'Daylight Matches';
const VERSION = '0.3.0';

const HEADER_FILL = '#1F4E3D';
const HEADER_TEXT = '#FFFFFF';
const LIGHT_FILL = '#EAF3EF';
const WARNING_FILL = '#FFF4CC';

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Grocery Tools')
    .addItem('Set up / update planning tabs', 'setupPlannerSheets')
    .addItem('Configure connection', 'configurePlanner')
    .addItem('Validate setup', 'validatePlannerSetup')
    .addSeparator()
    .addItem('Generate weekly order', 'generateWeeklyOrder')
    .addSubMenu(
      ui.createMenu('Daylight public catalog')
        .addItem('Refresh public catalog', 'refreshDaylightCatalog')
        .addItem('Browse unresolved ingredients', 'browseDaylightForUnresolved')
        .addItem('Search selected ingredient', 'searchDaylightForSelectedIngredient')
        .addItem('Approve selected match', 'approveSelectedDaylightMatch')
    )
    .addItem('Create Instacart / Costco link', 'createInstacartLink')
    .addItem('List nearby Instacart retailers', 'listNearbyRetailers')
    .addSeparator()
    .addItem('Force-buy selected ingredient this week', 'forceBuySelectedIngredient')
    .addItem('Ignore selected ingredient this week', 'ignoreSelectedIngredient')
    .addToUi();
}

function setupPlannerSheets() {
  const ss = SpreadsheetApp.getActive();

  const guideSheet = ensureSheet_(ss, GUIDE_SHEET, [
    ['Hamm Weekly Grocery Planner', '', ''],
    ['Version', VERSION, ''],
    ['', '', ''],
    ['Step', 'What to do', 'Where'],
    ['1', 'Set the Monday for the order week.', 'Settings'],
    ['2', 'Keep pantry staples and aliases current.', 'Always Stocked / Ingredient Aliases'],
    ['3', 'Generate the week; unresolved items are searched in the Daylight public catalog.', 'Weekly Order / Daylight Matches'],
    ['4', 'Approve a Daylight match once to reuse the exact package later.', 'Daylight Matches / Product Catalog'],
    ['5', 'Review low-confidence and missing-product lines.', 'Needs Review'],
    ['6', 'Check off purchases; shopper, user, and time are retained.', 'Weekly Order'],
    ['', '', ''],
    ['Important', 'The Instacart key belongs in the backend environment, never in this spreadsheet.', ''],
  ]);

  const settingsSheet = ensureSheet_(ss, 'Settings', [
    ['Setting', 'Value', 'Notes'],
    ['Week Start', mondayIso_(new Date()), 'Monday of the week to generate'],
    ['Bulk Meat Threshold (lb)', 5, 'Large meat orders go to the separate supplier'],
    ['Bulk Meat Count Threshold', 20, 'Also catches large count/package meat orders'],
    ['Include Undated Rows', false, 'Usually leave off so old placeholder rows do not flood review'],
    ['Catalog Stale After (days)', 14, 'Older product checks remain usable but show medium confidence'],
    ['Product Selection Mode', 'balanced', 'balanced, lowest cost, or lowest waste'],
    ['Delivery Postal Code', '', 'Used to check nearby Instacart retailers'],
    ['Country Code', 'US', 'US or CA'],
    ['Auto Browse Daylight', true, 'Search the public Daylight catalog after generating unresolved items'],
    ['Daylight Results Per Ingredient', 5, 'Top public catalog matches to show for each ingredient'],
    ['Daylight Max Ingredients Per Run', 25, 'Caps catalog matching work during one generation'],
  ]);

  ensureSettingRow_(settingsSheet, 'Auto Browse Daylight', true, 'Search the public Daylight catalog after generating unresolved items');
  ensureSettingRow_(settingsSheet, 'Daylight Results Per Ingredient', 5, 'Top public catalog matches to show for each ingredient');
  ensureSettingRow_(settingsSheet, 'Daylight Max Ingredients Per Run', 25, 'Caps catalog matching work during one generation');
  if (guideSheet.getLastRow() >= 2) guideSheet.getRange(2, 2).setValue(VERSION);

  ensureSheet_(ss, 'Ingredient Aliases', [
    ['Canonical Item', 'Aliases', 'Active', 'Notes'],
    ['garlic', 'garlic cloves; cloves garlic; cloves of garlic; garlic clove', true, ''],
    ['green onions', 'green onion; scallions; spring onions', true, ''],
  ]);

  ensureSheet_(ss, 'Always Stocked', [
    ['Canonical Item', 'Aliases', 'Active', 'Notes'],
    ['soy sauce', 'soy sauce or tamari', true, 'Standalone tamari remains separate unless added'],
    ['butter', 'salted butter; unsalted butter', true, ''],
    ['maple syrup', '', true, ''],
    ['rice', '', true, 'Specialty rice remains separate unless aliased'],
    ['pasta', '', true, ''],
    ['oats', '', true, ''],
    ['sugar', 'granulated sugar; white sugar', true, ''],
    ['salt', 'kosher salt; sea salt; table salt', true, ''],
    ['black pepper', 'pepper; ground black pepper; black peppercorns; peppercorns', true, ''],
    ['flour', 'AP flour; all-purpose flour; plain flour', true, 'Specialty flours remain separate'],
    ['baking soda', 'sodium bicarbonate; bicarbonate of soda', true, ''],
  ]);

  ensureSheet_(ss, 'Supplier Rules', [
    ['Canonical Item', 'Primary Retailer', 'Fallback Retailers', 'Active', 'Notes'],
    ['frozen berries', 'Costco Same-Day', 'Instacart', true, 'Example exact rule'],
    ['*', 'Costco Same-Day', 'Instacart', true, 'Default; add exact Daylight and Weee rules as needed'],
  ]);

  ensureSheet_(ss, 'Ingredient Conversions', [
    ['Canonical Item', 'From Quantity', 'From Unit', 'To Quantity', 'To Unit', 'Approved By', 'Active', 'Notes'],
    ['frozen berries', 1, 'cup', 5, 'oz', '', false, 'Example only; approve after checking your recipe assumption'],
  ]);

  ensureSheet_(ss, 'Product Catalog', [
    [
      'Canonical Item', 'Retailer', 'Product Name', 'Product ID', 'UPC',
      'Amount Per Package', 'Package Unit', 'Pack Count', 'Purchase Unit',
      'Price', 'Product URL', 'Preference Rank', 'Approved', 'In Stock',
      'Active', 'Last Checked', 'Notes'
    ],
    [
      'frozen berries', 'Costco Same-Day', 'REPLACE WITH AN EXACT LISTING', '', '',
      4, 'oz', 1, 'bag', '', '', 1, false, false, false, '',
      'Inactive example: retailer quantity 1 supplies one 4 oz bag'
    ],
  ]);

  ensureSheet_(ss, 'Weekly Overrides', [
    ['Week Start', 'Ingredient', 'Override', 'Notes'],
    [mondayIso_(new Date()), '', '', 'Use buy or ignore only when overriding normal rules'],
  ]);

  ensureSheet_(ss, OUTPUT_SHEET, [[
    'Bought', 'Stable ID', 'Store', 'Ingredient', 'Exact Product', 'Buy Quantity',
    'Purchase Unit', 'Package Size', 'Needed', 'Original Need', 'Purchased', 'Excess',
    'Estimated Total', 'Head Cooks', 'Attribution', 'Product URL', 'Confidence',
    'Reason', 'Conversion', 'Last Checked', 'Shopper', 'Checked By', 'Checked At',
    'Notes', 'UPC', 'Product ID'
  ]]);

  ensureSheet_(ss, EXCLUDED_SHEET, [[
    'Bucket', 'Ingredient', 'Quantity', 'Reason', 'Lead', 'Event', 'Dish', 'Source'
  ]]);

  ensureSheet_(ss, REVIEW_SHEET, [[
    'Ingredient', 'Head Cook', 'Quantity', 'Reason', 'Preferred Retailers', 'Source', 'Search Hint'
  ]]);

  ensureSheet_(ss, DAYLIGHT_SHEET, [[
    'Approve', 'Ingredient', 'Required', 'Product Name', 'Daylight UOM', 'Package Size',
    'Buy Quantity', 'Purchase Unit', 'Purchased', 'Excess', 'Product URL', 'Match Score',
    'Match Confidence', 'Package Confidence', 'Status', 'Calculation', 'Notes', 'Last Checked',
    'Product ID', 'Amount Per Package', 'Package Unit', 'Pack Count'
  ]]);

  formatPlannerSheets_();
  SpreadsheetApp.getUi().alert(
    'Planner tabs are ready. Add real approved products to Product Catalog, configure the backend, then generate a week.'
  );
}

function configurePlanner() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const backend = ui.prompt(
    'Backend URL',
    `Enter the deployed backend URL without a trailing slash. Current: ${props.getProperty('BACKEND_URL') || '(none)'}`,
    ui.ButtonSet.OK_CANCEL
  );
  if (backend.getSelectedButton() !== ui.Button.OK) return;

  const token = ui.prompt(
    'Shared backend token',
    'Enter APP_SHARED_TOKEN from the backend. This is not the Instacart API key.',
    ui.ButtonSet.OK_CANCEL
  );
  if (token.getSelectedButton() !== ui.Button.OK) return;

  const spiceSource = ui.prompt(
    'Spice inventory spreadsheet',
    'Paste the full Google Sheets URL or its spreadsheet ID. Leave blank to disable spice syncing.',
    ui.ButtonSet.OK_CANCEL
  );
  if (spiceSource.getSelectedButton() !== ui.Button.OK) return;

  const spiceTab = ui.prompt(
    'Spice inventory tab',
    'Optional tab name. Leave blank to use the first tab.',
    ui.ButtonSet.OK_CANCEL
  );
  if (spiceTab.getSelectedButton() !== ui.Button.OK) return;

  const backendUrl = backend.getResponseText().trim().replace(/\/$/, '');
  const spiceId = extractGoogleSheetId_(spiceSource.getResponseText().trim());
  props.setProperties({
    BACKEND_URL: backendUrl,
    BACKEND_SHARED_TOKEN: token.getResponseText().trim(),
    SPICE_SHEET_ID: spiceId,
    SPICE_TAB: spiceTab.getResponseText().trim(),
  });

  ui.alert('Connection saved. Keep the Instacart API key only in the backend environment variables.');
}

function validatePlannerSetup() {
  const ss = SpreadsheetApp.getActive();
  const issues = [];
  const requiredSheets = [
    SOURCE_SHEET, 'Settings', 'Ingredient Aliases', 'Always Stocked', 'Supplier Rules',
    'Ingredient Conversions', 'Product Catalog', 'Weekly Overrides', DAYLIGHT_SHEET
  ];
  requiredSheets.forEach(name => {
    if (!ss.getSheetByName(name)) issues.push(`Missing sheet: ${name}`);
  });

  const source = ss.getSheetByName(SOURCE_SHEET);
  if (source) {
    const headers = source.getRange(1, 1, 1, source.getLastColumn()).getDisplayValues()[0];
    ['Event Date', 'Lead', 'Ingredient', 'Parsed Low', 'Parsed High', 'Unit'].forEach(header => {
      if (!headers.includes(header)) issues.push(`All Items is missing column: ${header}`);
    });
  }

  const props = PropertiesService.getScriptProperties();
  const backendUrl = props.getProperty('BACKEND_URL');
  if (!backendUrl) {
    issues.push('Backend URL is not configured.');
  } else {
    try {
      const response = UrlFetchApp.fetch(`${backendUrl}/health`, {muteHttpExceptions: true});
      if (response.getResponseCode() !== 200) {
        issues.push(`Backend health check returned ${response.getResponseCode()}.`);
      }
    } catch (error) {
      issues.push(`Backend health check failed: ${error.message}`);
    }
  }

  const spiceId = props.getProperty('SPICE_SHEET_ID');
  if (spiceId) {
    try {
      readSpiceInventory_();
    } catch (error) {
      issues.push(`Spice inventory could not be read: ${error.message}`);
    }
  }

  if (issues.length) {
    SpreadsheetApp.getUi().alert(`Setup needs attention:\n\n• ${issues.join('\n• ')}`);
  } else {
    SpreadsheetApp.getUi().alert('Setup validation passed.');
  }
}

function generateWeeklyOrder() {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BACKEND_URL')) throw new Error('Run Grocery Tools → Configure connection first.');
  if (!ss.getSheetByName(SOURCE_SHEET)) throw new Error(`Missing required source tab: ${SOURCE_SHEET}`);

  const settings = readSettings_();
  const weekStart = settings['Week Start'];
  if (!weekStart) throw new Error('Settings must contain Week Start.');

  const payload = {
    week_start: formatDateIso_(weekStart),
    all_items: sheetToObjects_(ss.getSheetByName(SOURCE_SHEET)),
    ingredient_aliases: sheetToObjects_(ss.getSheetByName('Ingredient Aliases')),
    always_stocked: sheetToObjects_(ss.getSheetByName('Always Stocked')),
    spice_inventory: readSpiceInventory_(),
    weekly_overrides: sheetToObjects_(ss.getSheetByName('Weekly Overrides')),
    supplier_rules: sheetToObjects_(ss.getSheetByName('Supplier Rules')),
    product_catalog: sheetToObjects_(ss.getSheetByName('Product Catalog')),
    ingredient_conversions: sheetToObjects_(ss.getSheetByName('Ingredient Conversions')),
    settings: {
      bulk_meat_lb_threshold: Number(settings['Bulk Meat Threshold (lb)'] || 5),
      bulk_meat_count_threshold: Number(settings['Bulk Meat Count Threshold'] || 20),
      include_undated_rows: parseBoolean_(settings['Include Undated Rows']),
      catalog_stale_after_days: Number(settings['Catalog Stale After (days)'] || 14),
      selection_mode: String(settings['Product Selection Mode'] || 'balanced'),
    },
  };

  const response = callBackend_('/generate', payload);
  writeWeeklyOrder_(response.recommendations || []);
  writeExcluded_(response.excluded || []);
  writeReview_(response.review || []);

  let daylightLine = '';
  if (parseBoolean_(settings['Auto Browse Daylight'])) {
    try {
      const daylight = browseDaylightForReviewRows_(response.review || [], false, true);
      daylightLine = `\nDaylight public matches: ${daylight.match_count || 0} across ${daylight.searched_item_count || 0} ingredients`;
    } catch (error) {
      daylightLine = `\nDaylight browse warning: ${error.message}`;
    }
  }

  const summary = response.summary || {};
  SpreadsheetApp.getUi().alert(
    `Week generated.\n\n` +
    `Purchase recommendations: ${summary.recommendation_count || 0}\n` +
    `Excluded/audit lines: ${summary.excluded_count || 0}\n` +
    `Needs review: ${summary.review_count || 0}\n` +
    `Source rows in week: ${summary.selected_source_rows || 0}\n` +
    `Undated rows skipped: ${summary.skipped_undated_rows || 0}` +
    daylightLine
  );
}

function createInstacartLink() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(OUTPUT_SHEET);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('Generate the weekly order first.');

  const rows = sheetToObjects_(sheet).filter(row => {
    const bought = parseBoolean_(row['Bought']);
    const store = String(row['Store'] || '').toLowerCase();
    return !bought && (store.includes('costco') || store.includes('instacart'));
  });
  if (!rows.length) throw new Error('No unchecked Costco Same-Day or Instacart rows were found.');

  const recommendations = rows.map(row => ({
    ingredient: row['Ingredient'],
    exact_product: row['Exact Product'],
    buy_quantity: Number(row['Buy Quantity']),
    purchase_unit: row['Purchase Unit'],
    upc: row['UPC'],
    product_id: row['Product ID'],
  }));

  const settings = readSettings_();
  const title = `Hamm groceries — week of ${formatDateIso_(settings['Week Start'])}`;
  const response = callBackend_('/instacart-link', {title, recommendations});
  const url = response.products_link_url;
  if (!url) throw new Error('The backend did not return products_link_url.');

  const html = HtmlService.createHtmlOutput(
    `<p><a href="${escapeHtml_(url)}" target="_blank">Open the shoppable list</a></p>` +
    '<p>Review Instacart’s product matches and final quantities before checkout.</p>'
  ).setWidth(440).setHeight(170);
  SpreadsheetApp.getUi().showModalDialog(html, 'Instacart / Costco shopping link');
}

function listNearbyRetailers() {
  const settings = readSettings_();
  const postal = String(settings['Delivery Postal Code'] || '').trim();
  if (!postal) throw new Error('Enter Delivery Postal Code on Settings.');
  const country = String(settings['Country Code'] || 'US').trim().toUpperCase();
  const response = callBackend_('/nearby-retailers', {postal_code: postal, country_code: country});
  const retailers = (response.retailers || []).map(item => item.name).filter(Boolean);
  SpreadsheetApp.getUi().alert(
    retailers.length ? `Nearby retailers:\n\n• ${retailers.join('\n• ')}` : 'No nearby retailers were returned.'
  );
}

function refreshDaylightCatalog() {
  const response = callBackend_('/daylight/refresh', {force: true});
  SpreadsheetApp.getUi().alert(
    `Daylight public catalog refreshed.\n\n` +
    `Products: ${response.product_count || 0}\n` +
    `Pages read: ${response.source_pages || 0}\n` +
    `Checked: ${response.fetched_at || ''}`
  );
}

function browseDaylightForUnresolved() {
  const ss = SpreadsheetApp.getActive();
  const reviewSheet = ss.getSheetByName(REVIEW_SHEET);
  if (!reviewSheet || reviewSheet.getLastRow() < 2) {
    throw new Error('There are no unresolved ingredients. Generate the weekly order first.');
  }
  const result = browseDaylightForReviewRows_(sheetToObjects_(reviewSheet), false, false);
  SpreadsheetApp.getUi().alert(
    `Daylight browsing complete.\n\n` +
    `Ingredients searched: ${result.searched_item_count || 0}\n` +
    `Candidate matches: ${result.match_count || 0}\n\n` +
    `Open “${DAYLIGHT_SHEET}” to review them.`
  );
}

function browseDaylightForReviewRows_(reviewRows, forceRefresh, silent) {
  const settings = readSettings_();
  const perIngredient = Math.max(1, Math.min(20, Number(settings['Daylight Results Per Ingredient'] || 5)));
  const maxIngredients = Math.max(1, Math.min(100, Number(settings['Daylight Max Ingredients Per Run'] || 25)));

  const unique = {};
  (reviewRows || []).forEach(row => {
    const ingredient = String(row.ingredient || row['Ingredient'] || '').trim();
    const hint = String(row.search_hint || row['Search Hint'] || ingredient).trim();
    const reason = String(row.reason || row['Reason'] || '').toLowerCase();
    if (!ingredient || !hint) return;
    if (!row.search_hint && !row['Search Hint'] && !reason.includes('catalog product')) return;
    const preferred = String(row.preferred_retailers || row['Preferred Retailers'] || '');
    unique[ingredient.toLowerCase()] = {
      query: hint,
      canonical_item: ingredient,
      required_text: String(row.quantity_raw || row['Quantity'] || '').trim(),
      preferred_retailers: preferred,
    };
  });

  const items = Object.values(unique)
    .sort((a, b) => {
      const aPrimary = String(a.preferred_retailers).split(',')[0].trim().toLowerCase() === 'daylight' ? 0 : 1;
      const bPrimary = String(b.preferred_retailers).split(',')[0].trim().toLowerCase() === 'daylight' ? 0 : 1;
      return aPrimary - bPrimary || a.canonical_item.localeCompare(b.canonical_item);
    })
    .slice(0, maxIngredients);

  if (!items.length) {
    writeDaylightMatches_([]);
    return {searched_item_count: 0, match_count: 0, matches: []};
  }

  const response = callBackend_('/daylight/search-batch', {
    items,
    limit: perIngredient,
    max_items: maxIngredients,
    force_refresh: Boolean(forceRefresh),
  });
  writeDaylightMatches_(response.matches || []);
  return response;
}

function searchDaylightForSelectedIngredient() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getActiveRange();
  if (!range || range.getRow() < 2) throw new Error('Select a row containing an ingredient.');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const values = sheet.getRange(range.getRow(), 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const row = {};
  headers.forEach((header, index) => { if (header) row[header] = values[index]; });

  const ingredient = firstValue_(row, ['Ingredient', 'Canonical Item', 'Item', 'Spice']);
  if (!ingredient) throw new Error('The selected row does not contain an ingredient.');
  const required = firstValue_(row, ['Quantity', 'Needed', 'Quantity (raw)', 'Required', 'Original Need']);
  const settings = readSettings_();
  const limit = Math.max(1, Math.min(20, Number(settings['Daylight Results Per Ingredient'] || 5)));

  const response = callBackend_('/daylight/search', {
    query: ingredient,
    canonical_item: ingredient,
    required_text: required || '',
    limit,
    force_refresh: false,
  });
  writeDaylightMatches_(response.results || []);
  SpreadsheetApp.getUi().alert(
    `Found ${(response.results || []).length} Daylight public catalog matches for ${ingredient}.\n\n` +
    `Open “${DAYLIGHT_SHEET}” and approve the product you want.`
  );
}

function approveSelectedDaylightMatch() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getActiveSheet();
  if (sheet.getName() !== DAYLIGHT_SHEET) throw new Error(`Select a row on “${DAYLIGHT_SHEET}”.`);
  const rowNumber = sheet.getActiveRange().getRow();
  if (rowNumber < 2) throw new Error('Select a Daylight product row.');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const rawValues = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
  const displayValues = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const row = {};
  headers.forEach((header, index) => {
    if (header) row[header] = rawValues[index] === '' ? displayValues[index] : rawValues[index];
  });

  const amount = Number(row['Amount Per Package']);
  const packCount = Number(row['Pack Count'] || 1);
  const packageUnit = String(row['Package Unit'] || '').trim();
  if (!Number.isFinite(amount) || amount <= 0 || !packageUnit || !Number.isFinite(packCount) || packCount <= 0) {
    throw new Error('This match does not have a usable package size. Pick another match or enter the package manually.');
  }

  const ingredient = String(row['Ingredient'] || '').trim();
  const productName = String(row['Product Name'] || '').trim();
  const productUrl = String(row['Product URL'] || '').trim();
  if (!ingredient || !productName || !productUrl) throw new Error('The selected match is missing required product information.');

  const notes = [
    'DAYLIGHT_PUBLIC_CATALOG: public listing only; account price and live availability are not confirmed.',
    String(row['Notes'] || '').trim(),
  ].filter(Boolean).join(' ');

  const catalogRow = [
    ingredient,
    'Daylight',
    productName,
    String(row['Product ID'] || '').trim(),
    '',
    amount,
    packageUnit,
    packCount,
    String(row['Purchase Unit'] || 'unit').trim(),
    '',
    productUrl,
    1,
    true,
    true,
    true,
    parseDateOrToday_(row['Last Checked']),
    notes,
  ];

  upsertProductCatalogRow_(catalogRow);
  sheet.getRange(rowNumber, 1).setValue(true);
  SpreadsheetApp.getUi().alert(
    `${productName} was added to Product Catalog for ${ingredient}.\n\n` +
    'Generate the weekly order again to use it. Confirm price and availability in your Daylight account before ordering.'
  );
}

function writeDaylightMatches_(matches) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DAYLIGHT_SHEET) || ss.insertSheet(DAYLIGHT_SHEET);
  const headers = [
    'Approve', 'Ingredient', 'Required', 'Product Name', 'Daylight UOM', 'Package Size',
    'Buy Quantity', 'Purchase Unit', 'Purchased', 'Excess', 'Product URL', 'Match Score',
    'Match Confidence', 'Package Confidence', 'Status', 'Calculation', 'Notes', 'Last Checked',
    'Product ID', 'Amount Per Package', 'Package Unit', 'Pack Count'
  ];
  const values = (matches || [])
    .slice()
    .sort((a, b) => {
      const ingredientCompare = String(a.ingredient || '').localeCompare(String(b.ingredient || ''));
      return ingredientCompare || Number(b.match_score || 0) - Number(a.match_score || 0);
    })
    .map(item => [
      false,
      item.ingredient || '',
      item.required || '',
      item.product_name || '',
      item.daylight_uom || '',
      item.package_size || '',
      item.buy_quantity == null ? '' : item.buy_quantity,
      item.purchase_unit || '',
      item.purchased || '',
      item.excess || '',
      item.product_url || '',
      item.match_score == null ? '' : item.match_score,
      item.match_confidence || '',
      item.package_confidence || '',
      item.recommendation_status || '',
      item.calculation_note || '',
      item.notes || '',
      item.last_checked || '',
      item.product_id || '',
      item.amount_per_package == null ? '' : item.amount_per_package,
      item.package_unit || '',
      item.pack_count == null ? '' : item.pack_count,
    ]);

  replaceSheet_(sheet, headers, values);
  if (values.length) {
    sheet.getRange(2, 1, values.length, 1).insertCheckboxes();
    sheet.getRange(2, 12, values.length, 1).setNumberFormat('0.0%');
    sheet.getRange(2, 18, values.length, 1).setNumberFormat('yyyy-mm-dd');
  }
  styleDaylightSheet_(sheet);
}

function upsertProductCatalogRow_(catalogRow) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('Product Catalog');
  if (!sheet) throw new Error('Missing Product Catalog. Run Set up / update planning tabs.');
  const rows = sheetToObjects_(sheet);
  const ingredient = String(catalogRow[0]).toLowerCase();
  const productId = String(catalogRow[3] || '').toLowerCase();
  const productUrl = String(catalogRow[10] || '').toLowerCase();
  let targetRow = -1;
  rows.forEach((row, index) => {
    const sameIngredient = String(row['Canonical Item'] || '').trim().toLowerCase() === ingredient;
    const sameUrl = productUrl && String(row['Product URL'] || '').trim().toLowerCase() === productUrl;
    const sameId = productId && String(row['Product ID'] || '').trim().toLowerCase() === productId;
    if (sameIngredient && (sameUrl || sameId)) targetRow = index + 2;
  });
  if (targetRow > 0) {
    sheet.getRange(targetRow, 1, 1, catalogRow.length).setValues([catalogRow]);
  } else {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, catalogRow.length).setValues([catalogRow]);
  }
  applyPlannerValidations_();
}

function styleDaylightSheet_(sheet) {
  styleSimpleOutput_(sheet, [
    70, 150, 105, 300, 100, 130, 90, 105, 110, 110, 280, 90, 105, 110, 100,
    260, 360, 105, 120, 120, 100, 90
  ]);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const fullRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
    const statusRange = sheet.getRange(2, 15, lastRow - 1, 1);
    sheet.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo('ready')
        .setBackground('#D9EAD3')
        .setRanges([statusRange])
        .build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo('estimate')
        .setBackground(WARNING_FILL)
        .setRanges([statusRange])
        .build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$A2=TRUE')
        .setBackground('#D9EAD3')
        .setRanges([fullRange])
        .build(),
    ]);
  }
}

function firstValue_(row, headers) {
  for (const header of headers) {
    const value = row[header];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function parseDateOrToday_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = String(value || '').trim();
  if (text) {
    const parsed = new Date(`${text}T12:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}


function forceBuySelectedIngredient() {
  setSelectedIngredientOverride_('buy');
}

function ignoreSelectedIngredient() {
  setSelectedIngredientOverride_('ignore');
}

function setSelectedIngredientOverride_(override) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getActiveSheet();
  const row = sheet.getActiveRange().getRow();
  if (row < 2) throw new Error('Select a data row containing an ingredient.');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const ingredientIndex = headers.indexOf('Ingredient');
  if (ingredientIndex < 0) throw new Error('The selected sheet does not contain an Ingredient column.');
  const ingredient = String(sheet.getRange(row, ingredientIndex + 1).getDisplayValue()).trim();
  if (!ingredient) throw new Error('The selected row has no ingredient.');

  const settings = readSettings_();
  const weekStart = formatDateIso_(settings['Week Start']);
  const overrides = ss.getSheetByName('Weekly Overrides');
  const rows = sheetToObjects_(overrides);
  let matchRow = -1;
  rows.forEach((item, index) => {
    const itemWeek = item['Week Start'];
    if (!itemWeek) return;
    if (formatDateIso_(itemWeek) === weekStart &&
        String(item['Ingredient'] || '').trim().toLowerCase() === ingredient.toLowerCase()) {
      matchRow = index + 2;
    }
  });

  const values = [new Date(`${weekStart}T12:00:00`), ingredient, override, 'Added from Grocery Tools'];
  if (matchRow > 0) {
    overrides.getRange(matchRow, 1, 1, 4).setValues([values]);
  } else {
    overrides.appendRow(values);
  }
  SpreadsheetApp.getUi().alert(`${ingredient} will be set to “${override}” for the week of ${weekStart}.`);
}

function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== OUTPUT_SHEET || e.range.getRow() < 2 || e.range.getColumn() !== 1) return;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const checkedByCol = headers.indexOf('Checked By') + 1;
  const checkedAtCol = headers.indexOf('Checked At') + 1;
  if (!checkedByCol || !checkedAtCol) return;

  if (parseBoolean_(e.value)) {
    const email = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'Unknown user';
    sheet.getRange(e.range.getRow(), checkedByCol).setValue(email);
    sheet.getRange(e.range.getRow(), checkedAtCol).setValue(new Date());
  } else {
    sheet.getRange(e.range.getRow(), checkedByCol).clearContent();
    sheet.getRange(e.range.getRow(), checkedAtCol).clearContent();
  }
}

function writeWeeklyOrder_(recommendations) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(OUTPUT_SHEET) || ss.insertSheet(OUTPUT_SHEET);
  const prior = existingOrderState_(sheet);
  const headers = [
    'Bought', 'Stable ID', 'Store', 'Ingredient', 'Exact Product', 'Buy Quantity',
    'Purchase Unit', 'Package Size', 'Needed', 'Original Need', 'Purchased', 'Excess',
    'Estimated Total', 'Head Cooks', 'Attribution', 'Product URL', 'Confidence',
    'Reason', 'Conversion', 'Last Checked', 'Shopper', 'Checked By', 'Checked At',
    'Notes', 'UPC', 'Product ID'
  ];

  const values = recommendations
    .slice()
    .sort((a, b) => `${a.store}|${a.ingredient}`.localeCompare(`${b.store}|${b.ingredient}`))
    .map(item => {
      const saved = prior[item.stable_id] || {};
      return [
        saved.bought || false,
        item.stable_id,
        item.store,
        item.ingredient,
        item.exact_product,
        item.buy_quantity,
        item.purchase_unit,
        item.package_size,
        item.needed,
        item.original_needed || '',
        item.purchased,
        item.excess,
        item.estimated_total == null ? '' : item.estimated_total,
        item.head_cooks,
        item.attribution,
        item.product_url,
        item.confidence,
        item.reason,
        item.conversion_note || '',
        item.last_checked || '',
        saved.shopper || '',
        saved.checkedBy || '',
        saved.checkedAt || '',
        saved.notes || '',
        item.upc || '',
        item.product_id || '',
      ];
    });

  replaceSheet_(sheet, headers, values);
  if (values.length) {
    sheet.getRange(2, 1, values.length, 1).insertCheckboxes();
    sheet.getRange(2, 13, values.length, 1).setNumberFormat('$0.00');
    sheet.getRange(2, 23, values.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
  styleOutputSheet_(sheet);
}

function writeExcluded_(rows) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EXCLUDED_SHEET) || SpreadsheetApp.getActive().insertSheet(EXCLUDED_SHEET);
  const headers = ['Bucket', 'Ingredient', 'Quantity', 'Reason', 'Lead', 'Event', 'Dish', 'Source'];
  const values = rows.map(row => [
    row.bucket || '', row.ingredient || '', row.quantity || row.quantity_raw || '', row.reason || '',
    row.lead || '', row.event || '', row.dish || '', row.source || ''
  ]);
  replaceSheet_(sheet, headers, values);
  styleSimpleOutput_(sheet, [130, 160, 110, 260, 130, 180, 220, 120]);
}

function writeReview_(rows) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(REVIEW_SHEET) || SpreadsheetApp.getActive().insertSheet(REVIEW_SHEET);
  const headers = ['Ingredient', 'Head Cook', 'Quantity', 'Reason', 'Preferred Retailers', 'Source', 'Search Hint'];
  const values = rows.map(row => [
    row.ingredient || '', row.lead || '', row.quantity_raw || '', row.reason || '',
    row.preferred_retailers || '', row.source || '', row.search_hint || ''
  ]);
  replaceSheet_(sheet, headers, values);
  styleSimpleOutput_(sheet, [160, 130, 120, 300, 200, 140, 160]);
}

function existingOrderState_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return {};
  const rows = sheetToObjects_(sheet);
  const state = {};
  rows.forEach(row => {
    const id = String(row['Stable ID'] || '').trim();
    if (!id) return;
    state[id] = {
      bought: parseBoolean_(row['Bought']),
      shopper: row['Shopper'] || '',
      checkedBy: row['Checked By'] || '',
      checkedAt: row['Checked At'] || '',
      notes: row['Notes'] || '',
    };
  });
  return state;
}

function readSettings_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('Settings');
  if (!sheet) throw new Error('Missing Settings tab. Run Set up / update planning tabs.');
  const values = sheet.getDataRange().getValues();
  const settings = {};
  values.slice(1).forEach(row => {
    if (row[0] !== '') settings[String(row[0]).trim()] = row[1];
  });
  return settings;
}

function readSpiceInventory_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPICE_SHEET_ID');
  if (!id) return [];

  const linked = SpreadsheetApp.openById(id);
  const tabName = props.getProperty('SPICE_TAB');
  const sheet = tabName ? linked.getSheetByName(tabName) : linked.getSheets()[0];
  if (!sheet) throw new Error('Configured spice inventory tab was not found.');
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];

  const values = sheet.getDataRange().getDisplayValues();
  const headers = values[0].map(value => String(value).trim().toLowerCase());
  const nameHeaders = ['spice', 'ingredient', 'item', 'name', 'canonical item'];
  const statusHeaders = ['status', 'stock status', 'inventory status'];
  let nameIndex = headers.findIndex(value => nameHeaders.includes(value));
  const statusIndex = headers.findIndex(value => statusHeaders.includes(value));

  if (nameIndex >= 0) {
    return values.slice(1)
      .filter(row => String(row[nameIndex] || '').trim())
      .map(row => ({
        Spice: String(row[nameIndex]).trim(),
        Status: statusIndex >= 0 ? String(row[statusIndex]).trim() : '',
        Active: statusIndex < 0 || !['out', 'out of stock', 'empty', 'none'].includes(String(row[statusIndex]).trim().toLowerCase()),
      }));
  }

  // Headerless fallback: use the first column containing at least two nonempty text values.
  let bestColumn = 0;
  let bestCount = -1;
  for (let column = 0; column < values[0].length; column += 1) {
    const count = values.map(row => String(row[column] || '').trim()).filter(Boolean).length;
    if (count > bestCount) {
      bestColumn = column;
      bestCount = count;
    }
  }
  const headerWords = new Set(['spice', 'spices', 'ingredient', 'ingredients', 'item', 'items', 'name']);
  return values
    .map(row => String(row[bestColumn] || '').trim())
    .filter(value => value && !headerWords.has(value.toLowerCase()))
    .map(value => ({Spice: value, Active: true}));
}

function callBackend_(path, payload) {
  const props = PropertiesService.getScriptProperties();
  const backendUrl = props.getProperty('BACKEND_URL');
  if (!backendUrl) throw new Error('Backend URL is not configured.');
  const token = props.getProperty('BACKEND_SHARED_TOKEN') || '';
  const response = UrlFetchApp.fetch(`${backendUrl}${path}`, {
    method: 'post',
    contentType: 'application/json',
    headers: {'X-Shared-Token': token},
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(`Backend error ${status}: ${body}`);
  }
  return JSON.parse(body);
}

function sheetToObjects_(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const headers = values[0].map(value => String(value).trim());
  return values.slice(1)
    .filter(row => row.some(value => value !== '' && value !== null))
    .map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        if (header) obj[header] = row[index];
      });
      return obj;
    });
}

function ensureSettingRow_(sheet, key, value, notes) {
  if (!sheet) return;
  const rows = sheet.getDataRange().getValues();
  const existing = rows.findIndex((row, index) => index > 0 && String(row[0] || '').trim() === key);
  if (existing >= 0) return;
  sheet.appendRow([key, value, notes || '']);
}

function settingRow_(sheet, key) {
  if (!sheet || sheet.getLastRow() < 2) return -1;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  const index = values.findIndex(row => String(row[0] || '').trim() === key);
  return index < 0 ? -1 : index + 2;
}

function ensureSheet_(ss, name, initialValues) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0 && initialValues && initialValues.length) {
    sheet.getRange(1, 1, initialValues.length, initialValues[0].length).setValues(initialValues);
  }
  return sheet;
}

function replaceSheet_(sheet, headers, rows) {
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.clearContents();
  sheet.clearFormats();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

function formatPlannerSheets_() {
  const ss = SpreadsheetApp.getActive();
  styleGuideSheet_(ss.getSheetByName(GUIDE_SHEET));
  styleControlSheet_(ss.getSheetByName('Settings'), [180, 180, 360]);
  styleControlSheet_(ss.getSheetByName('Ingredient Aliases'), [170, 360, 80, 280]);
  styleControlSheet_(ss.getSheetByName('Always Stocked'), [170, 360, 80, 300]);
  styleControlSheet_(ss.getSheetByName('Supplier Rules'), [170, 170, 250, 80, 320]);
  styleControlSheet_(ss.getSheetByName('Ingredient Conversions'), [170, 110, 100, 110, 100, 150, 80, 300]);
  styleControlSheet_(ss.getSheetByName('Product Catalog'), [160, 150, 300, 110, 110, 130, 100, 90, 110, 90, 280, 100, 80, 80, 80, 120, 320]);
  styleControlSheet_(ss.getSheetByName('Weekly Overrides'), [120, 170, 100, 360]);
  styleOutputSheet_(ss.getSheetByName(OUTPUT_SHEET));
  styleSimpleOutput_(ss.getSheetByName(EXCLUDED_SHEET), [130, 160, 110, 260, 130, 180, 220, 120]);
  styleSimpleOutput_(ss.getSheetByName(REVIEW_SHEET), [160, 130, 120, 300, 200, 140, 160]);
  styleDaylightSheet_(ss.getSheetByName(DAYLIGHT_SHEET));
  applyPlannerValidations_();
}

function applyPlannerValidations_() {
  const ss = SpreadsheetApp.getActive();
  const checkboxSheets = [
    ['Ingredient Aliases', 3], ['Always Stocked', 3], ['Supplier Rules', 4],
    ['Ingredient Conversions', 7], ['Product Catalog', 13], ['Product Catalog', 14], ['Product Catalog', 15],
    [DAYLIGHT_SHEET, 1]
  ];
  checkboxSheets.forEach(([name, column]) => {
    const sheet = ss.getSheetByName(name);
    if (sheet) sheet.getRange(2, column, 999, 1).insertCheckboxes();
  });

  const settings = ss.getSheetByName('Settings');
  if (settings) {
    settings.getRange('B2').setNumberFormat('yyyy-mm-dd');
    settings.getRange('B5').insertCheckboxes();
    settings.getRange('B7').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['balanced', 'lowest cost', 'lowest waste'], true).build()
    );
    settings.getRange('B9').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['US', 'CA'], true).build()
    );
    const autoBrowseRow = settingRow_(settings, 'Auto Browse Daylight');
    if (autoBrowseRow > 0) settings.getRange(autoBrowseRow, 2).insertCheckboxes();
  }

  const supplierRules = ss.getSheetByName('Supplier Rules');
  const catalog = ss.getSheetByName('Product Catalog');
  const retailers = ['Daylight', 'Costco Same-Day', 'Weee', 'Instacart'];
  if (supplierRules) supplierRules.getRange(2, 2, 999, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(retailers, true).build()
  );
  if (catalog) {
    catalog.getRange(2, 2, 999, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(retailers, true).build()
    );
    catalog.getRange(2, 16, 999, 1).setNumberFormat('yyyy-mm-dd');
    catalog.getRange(2, 10, 999, 1).setNumberFormat('$0.00');
  }

  const overrides = ss.getSheetByName('Weekly Overrides');
  if (overrides) {
    overrides.getRange(2, 1, 999, 1).setNumberFormat('yyyy-mm-dd');
    overrides.getRange(2, 3, 999, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['buy', 'ignore'], true).build()
    );
  }
}

function styleGuideSheet_(sheet) {
  if (!sheet) return;
  sheet.setFrozenRows(1);
  sheet.getRange('A1:C1').merge();
  sheet.getRange('A1').setFontSize(18).setFontWeight('bold').setFontColor(HEADER_TEXT).setBackground(HEADER_FILL);
  sheet.getRange('A4:C4').setFontWeight('bold').setFontColor(HEADER_TEXT).setBackground(HEADER_FILL);
  sheet.getRange(1, 1, sheet.getLastRow(), 3).setWrap(true).setVerticalAlignment('top');
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 470);
  sheet.setColumnWidth(3, 210);
}

function styleControlSheet_(sheet, widths) {
  if (!sheet) return;
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.setFrozenRows(1);
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const lastRow = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(1, 1, 1, lastColumn)
    .setBackground(HEADER_FILL)
    .setFontColor(HEADER_TEXT)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange(1, 1, lastRow, lastColumn).setWrap(true).setVerticalAlignment('top');
  if (lastRow >= 1) sheet.getRange(1, 1, lastRow, lastColumn).createFilter();
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
}

function styleOutputSheet_(sheet) {
  if (!sheet) return;
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const lastRow = Math.max(sheet.getLastRow(), 1);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, lastColumn)
    .setBackground(HEADER_FILL)
    .setFontColor(HEADER_TEXT)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange(1, 1, lastRow, lastColumn).setWrap(true).setVerticalAlignment('top');
  sheet.getRange(1, 1, lastRow, lastColumn).createFilter();

  const widths = [70, 100, 135, 155, 280, 90, 100, 125, 110, 120, 110, 110, 100, 150, 360, 260, 90, 320, 260, 105, 130, 190, 145, 260, 100, 100];
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));

  if (lastColumn >= 2) sheet.hideColumns(2, 1);
  if (lastColumn >= 26) sheet.hideColumns(25, 2);

  if (lastRow > 1) {
    const dataRange = sheet.getRange(2, 1, lastRow - 1, lastColumn);
    const rules = [
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$A2=TRUE')
        .setBackground('#D9EAD3')
        .setRanges([dataRange])
        .build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo('medium')
        .setBackground(WARNING_FILL)
        .setRanges([sheet.getRange(2, 17, lastRow - 1, 1)])
        .build(),
    ];
    sheet.setConditionalFormatRules(rules);
  }
}

function styleSimpleOutput_(sheet, widths) {
  if (!sheet) return;
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const lastRow = Math.max(sheet.getLastRow(), 1);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, lastColumn)
    .setBackground(HEADER_FILL)
    .setFontColor(HEADER_TEXT)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange(1, 1, lastRow, lastColumn).setWrap(true).setVerticalAlignment('top');
  sheet.getRange(1, 1, lastRow, lastColumn).createFilter();
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
}

function formatDateIso_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function mondayIso_(date) {
  const copy = new Date(date);
  const day = copy.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + delta);
  return Utilities.formatDate(copy, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function extractGoogleSheetId_(value) {
  if (!value) return '';
  const match = String(value).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : String(value).trim();
}

function parseBoolean_(value) {
  return ['true', 'yes', 'y', '1', 'checked'].includes(String(value || '').trim().toLowerCase());
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
