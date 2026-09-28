/**
 * Hamm Weekly Grocery Planner — Google Apps Script
 * Version 0.4.0
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
const VERSION = '0.4.0';

const HEADER_FILL = '#1F4E3D';
const HEADER_TEXT = '#FFFFFF';
const LIGHT_FILL = '#EAF3EF';
const WARNING_FILL = '#FFF4CC';


const ALL_ITEMS_HEADERS = [
  'Item ID', 'Event', 'Lead', 'Event Date', 'Dish', 'Ingredient', 'Quantity (raw)',
  'Parsed Low', 'Parsed High', 'Unit', 'Quantity Quality', 'Status', 'Supplier',
  'Arrived', 'Action', 'Notes', 'Source Sheet', 'Source Row'
];

const NON_SOURCE_SHEETS = new Set([
  SOURCE_SHEET, OUTPUT_SHEET, EXCLUDED_SHEET, REVIEW_SHEET, GUIDE_SHEET, DAYLIGHT_SHEET,
  'Settings', 'Ingredient Aliases', 'Always Stocked', 'Supplier Rules',
  'Ingredient Conversions', 'Product Catalog', 'Weekly Overrides',
  'Dashboard', 'Buy List', 'Pending Orders', 'Suppliers', 'Website Import'
]);

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Grocery Tools')
    .addItem('Set up / update planning tabs', 'setupPlannerSheets')
    .addItem('Refresh source data', 'refreshAllItemsFromHeadCookTabs')
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
    ['1', 'Keep entering groceries in the weekly Grocery tabs.', 'Tabs such as Grocery - Sep 14, 2026'],
    ['2', 'Refresh source data; the script rebuilds All Items automatically.', 'Grocery Tools → Refresh source data'],
    ['3', 'Set the Monday for the order week.', 'Settings'],
    ['4', 'Keep pantry staples and aliases current.', 'Always Stocked / Ingredient Aliases'],
    ['5', 'Generate the week; unresolved items are searched in the Daylight public catalog.', 'Weekly Order / Daylight Matches'],
    ['6', 'Approve a Daylight match once to reuse the exact package later.', 'Daylight Matches / Product Catalog'],
    ['7', 'Review low-confidence and missing-product lines.', 'Needs Review'],
    ['8', 'Check off purchases; shopper, user, and time are retained.', 'Weekly Order'],
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
    ['Auto Refresh Source Data', true, 'Rebuild All Items from weekly head-cook tabs before each order'],
    ['Source Tab Prefix', 'Grocery -', 'Preferred weekly-tab prefix; if no matching table is found, all non-planner tabs are scanned'],
    ['Auto Browse Daylight', true, 'Search the public Daylight catalog after generating unresolved items'],
    ['Daylight Results Per Ingredient', 5, 'Top public catalog matches to show for each ingredient'],
    ['Daylight Max Ingredients Per Run', 25, 'Caps catalog matching work during one generation'],
  ]);

  ensureSettingRow_(settingsSheet, 'Auto Refresh Source Data', true, 'Rebuild All Items from weekly head-cook tabs before each order');
  ensureSettingRow_(settingsSheet, 'Source Tab Prefix', 'Grocery -', 'Preferred weekly-tab prefix; if no matching table is found, all non-planner tabs are scanned');
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

  const sourceSheet = ensureSheet_(ss, SOURCE_SHEET, [ALL_ITEMS_HEADERS]);

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
  let imported = null;
  if (sourceSheet.getLastRow() <= 1) {
    try {
      imported = refreshAllItemsFromHeadCookTabs_(true);
    } catch (error) {
      imported = {row_count: 0, warning: error.message};
    }
  }
  const importNote = imported && imported.row_count
    ? ` Imported ${imported.row_count} source lines from ${imported.parsed_sheet_count} tab(s).`
    : ' Use Grocery Tools → Refresh source data after your weekly grocery tabs are ready.';
  SpreadsheetApp.getUi().alert(
    'Planner tabs are ready.' + importNote + ' Configure the backend, then generate a week.'
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
    'Settings', 'Ingredient Aliases', 'Always Stocked', 'Supplier Rules',
    'Ingredient Conversions', 'Product Catalog', 'Weekly Overrides', DAYLIGHT_SHEET
  ];
  requiredSheets.forEach(name => {
    if (!ss.getSheetByName(name)) issues.push(`Missing sheet: ${name}`);
  });

  let source = ss.getSheetByName(SOURCE_SHEET);
  if (!source || source.getLastRow() < 2) {
    try {
      refreshAllItemsFromHeadCookTabs_(true);
      source = ss.getSheetByName(SOURCE_SHEET);
    } catch (error) {
      issues.push(`Source data could not be refreshed: ${error.message}`);
    }
  }

  if (!source) {
    issues.push(`The generated ${SOURCE_SHEET} tab could not be created.`);
  } else {
    const headers = source.getRange(1, 1, 1, source.getLastColumn()).getDisplayValues()[0];
    ['Event Date', 'Lead', 'Ingredient', 'Parsed Low', 'Parsed High', 'Unit'].forEach(header => {
      if (!headers.includes(header)) issues.push(`${SOURCE_SHEET} is missing column: ${header}`);
    });
    if (source.getLastRow() < 2) {
      issues.push(
        'No ingredient rows were found. A source tab needs an Ingredient header and a Quantity, Total Quantity, or Individual Quantity header.'
      );
    }
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
    SpreadsheetApp.getUi().alert('Setup validation passed. Source data and backend connection are ready.');
  }
}

function generateWeeklyOrder() {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BACKEND_URL')) throw new Error('Run Grocery Tools → Configure connection first.');

  const settings = readSettings_();
  const weekStart = settings['Week Start'];
  if (!weekStart) throw new Error('Settings must contain Week Start.');

  let source = ss.getSheetByName(SOURCE_SHEET);
  if (parseBoolean_(settings['Auto Refresh Source Data']) || !source || source.getLastRow() < 2) {
    refreshAllItemsFromHeadCookTabs_(true);
    source = ss.getSheetByName(SOURCE_SHEET);
  }
  if (!source || source.getLastRow() < 2) {
    throw new Error(
      'No source ingredients were found. Run Grocery Tools → Refresh source data and make sure a weekly tab has Ingredient and Quantity headers.'
    );
  }

  const payload = {
    week_start: formatDateIso_(weekStart),
    all_items: sheetToObjects_(source),
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


function refreshAllItemsFromHeadCookTabs() {
  const result = refreshAllItemsFromHeadCookTabs_(false);
  const sheetNames = result.parsed_sheets.length ? `\n\nRead: ${result.parsed_sheets.join(', ')}` : '';
  const preserved = result.preserved_existing
    ? '\n\nNo new source table was found, so the existing All Items data was preserved.'
    : '';
  SpreadsheetApp.getUi().alert(
    `Source refresh complete.\n\nIngredient lines: ${result.row_count}\nSource tabs: ${result.parsed_sheet_count}` +
    sheetNames + preserved
  );
}

function refreshAllItemsFromHeadCookTabs_(silent) {
  const ss = SpreadsheetApp.getActive();
  let settings = {};
  try {
    settings = readSettings_();
  } catch (error) {
    settings = {};
  }

  const prefix = String(settings['Source Tab Prefix'] || 'Grocery -').trim().toLowerCase();
  const weekStart = settings['Week Start'];
  let defaultYear = new Date().getFullYear();
  try {
    defaultYear = new Date(formatDateIso_(weekStart)).getFullYear();
  } catch (error) {
    // Keep the current year when Week Start is not configured yet.
  }

  const candidates = ss.getSheets().filter(sheet => !NON_SOURCE_SHEETS.has(sheet.getName()));
  const preferred = prefix
    ? candidates.filter(sheet => sheet.getName().trim().toLowerCase().startsWith(prefix))
    : [];

  let collected = collectSourceRows_(preferred.length ? preferred : candidates, defaultYear);
  if (!collected.rows.length && preferred.length && preferred.length !== candidates.length) {
    collected = collectSourceRows_(candidates, defaultYear);
  }

  let target = ss.getSheetByName(SOURCE_SHEET);
  if (!target) target = ss.insertSheet(SOURCE_SHEET);
  const existingCount = Math.max(0, target.getLastRow() - 1);

  if (!collected.rows.length && existingCount > 0) {
    styleSourceSheet_(target);
    return {
      row_count: existingCount,
      parsed_sheet_count: 0,
      parsed_sheets: [],
      skipped_sheets: collected.skipped_sheets,
      preserved_existing: true,
    };
  }

  replaceSheet_(target, ALL_ITEMS_HEADERS, collected.rows);
  if (collected.rows.length) {
    target.getRange(2, 4, collected.rows.length, 1).setNumberFormat('yyyy-mm-dd');
    target.getRange(2, 14, collected.rows.length, 1).insertCheckboxes();
  }
  styleSourceSheet_(target);

  return {
    row_count: collected.rows.length,
    parsed_sheet_count: collected.parsed_sheets.length,
    parsed_sheets: collected.parsed_sheets,
    skipped_sheets: collected.skipped_sheets,
    preserved_existing: false,
  };
}

function collectSourceRows_(sheets, defaultYear) {
  const rows = [];
  const parsedSheets = [];
  const skippedSheets = [];

  sheets.forEach(sheet => {
    const result = extractNormalizedRowsFromSourceSheet_(sheet, defaultYear);
    if (result.header_found) {
      parsedSheets.push(sheet.getName());
      rows.push(...result.rows);
    } else {
      skippedSheets.push(sheet.getName());
    }
  });

  return {rows, parsed_sheets: parsedSheets, skipped_sheets: skippedSheets};
}

function extractNormalizedRowsFromSourceSheet_(sheet, defaultYear) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) {
    return {header_found: false, rows: []};
  }

  const range = sheet.getDataRange();
  const display = range.getDisplayValues();
  const raw = range.getValues();
  const backgrounds = range.getBackgrounds();
  const fontWeights = range.getFontWeights();
  const rows = [];
  const groups = {};
  let headerMap = null;
  let headerFound = false;
  let currentIngredient = '';
  let currentDish = '';
  let blankStreak = 0;

  const context = {
    date: inferDateFromSourceTabName_(sheet.getName(), defaultYear),
    lead: inferLeadFromSourceTabName_(sheet.getName()),
    event: sheet.getName(),
    dish: '',
  };

  display.forEach((displayRow, rowIndex) => {
    const rawRow = raw[rowIndex];
    const detectedHeader = detectSourceHeaderMap_(displayRow);
    if (detectedHeader) {
      headerMap = detectedHeader;
      headerFound = true;
      currentIngredient = '';
      currentDish = '';
      blankStreak = 0;
      return;
    }

    updateSourceContextFromRow_(context, displayRow, rawRow, defaultYear);
    if (!headerMap) return;

    const ingredientCell = cleanSourceCell_(valueAt_(displayRow, headerMap.ingredient));
    const combined = headerMap.leadQuantity >= 0
      ? parseCombinedLeadQuantity_(valueAt_(displayRow, headerMap.leadQuantity))
      : {lead: '', quantity: ''};
    const lead = cleanSourceCell_(valueAt_(displayRow, headerMap.lead)) || combined.lead || context.lead;
    const supplier = cleanSourceCell_(valueAt_(displayRow, headerMap.supplier));
    const notes = cleanSourceCell_(valueAt_(displayRow, headerMap.notes));
    const orderedValue = rawValueAt_(rawRow, headerMap.ordered);
    const arrivedValue = rawValueAt_(rawRow, headerMap.arrived);
    const directQuantity = cleanSourceCell_(valueAt_(displayRow, headerMap.quantity));
    const totalQuantity = cleanSourceCell_(valueAt_(displayRow, headerMap.totalQuantity)) || directQuantity;
    const individualQuantity = cleanSourceCell_(valueAt_(displayRow, headerMap.individualQuantity)) || combined.quantity;

    const relevantValues = [
      ingredientCell, lead, supplier, notes, directQuantity, totalQuantity, individualQuantity,
      valueAt_(displayRow, headerMap.ordered), valueAt_(displayRow, headerMap.arrived)
    ];
    if (!relevantValues.some(value => String(value || '').trim())) {
      blankStreak += 1;
      if (blankStreak >= 2) currentIngredient = '';
      return;
    }
    blankStreak = 0;

    const fontWeight = headerMap.ingredient >= 0 ? fontWeights[rowIndex][headerMap.ingredient] : '';
    const background = headerMap.ingredient >= 0 ? backgrounds[rowIndex][headerMap.ingredient] : '';
    if (ingredientCell && isSourceBoundaryRow_(
      ingredientCell,
      individualQuantity || totalQuantity,
      lead,
      supplier,
      orderedValue,
      arrivedValue,
      fontWeight,
      background
    )) {
      if (!isRecipeInstructionText_(ingredientCell)) {
        currentDish = ingredientCell;
        context.dish = ingredientCell;
      }
      currentIngredient = '';
      return;
    }

    if (ingredientCell) currentIngredient = ingredientCell;
    const ingredient = currentIngredient;
    if (!ingredient || isGenericSourceLabel_(ingredient)) return;

    const rowDateValue = rawValueAt_(rawRow, headerMap.eventDate) || valueAt_(displayRow, headerMap.eventDate);
    const eventDate = parseSourceDateValue_(rowDateValue, defaultYear) || context.date;
    const event = cleanSourceCell_(valueAt_(displayRow, headerMap.event)) || context.event || sheet.getName();
    const dish = cleanSourceCell_(valueAt_(displayRow, headerMap.dish)) || currentDish || context.dish;
    const explicitStatus = cleanSourceCell_(valueAt_(displayRow, headerMap.status));
    const explicitAction = cleanSourceCell_(valueAt_(displayRow, headerMap.action));

    const base = {
      sheet,
      row_number: rowIndex + 1,
      event,
      lead,
      event_date: eventDate,
      dish,
      ingredient,
      supplier,
      ordered: orderedValue,
      arrived: arrivedValue,
      explicit_status: explicitStatus,
      explicit_action: explicitAction,
      notes,
    };

    if (headerMap.individualQuantity >= 0 || headerMap.leadQuantity >= 0) {
      const key = [ingredient.toLowerCase(), dish.toLowerCase(), event.toLowerCase()].join('|');
      if (!groups[key]) groups[key] = {output_count: 0, fallback: null};
      if (totalQuantity && !groups[key].fallback) {
        groups[key].fallback = {...base, quantity_raw: totalQuantity, row_number: rowIndex + 1};
      }
      if (individualQuantity) {
        rows.push(buildNormalizedSourceRow_({...base, quantity_raw: individualQuantity}));
        groups[key].output_count += 1;
      } else if (lead && !totalQuantity) {
        rows.push(buildNormalizedSourceRow_({...base, quantity_raw: ''}));
        groups[key].output_count += 1;
      }
      return;
    }

    const quantityRaw = directQuantity || totalQuantity;
    const hasProcurementSignal = Boolean(
      quantityRaw || lead || supplier || notes || truthySource_(orderedValue) || truthySource_(arrivedValue)
    );
    if (!hasProcurementSignal) return;
    rows.push(buildNormalizedSourceRow_({...base, quantity_raw: quantityRaw}));
  });

  Object.values(groups).forEach(group => {
    if (group.output_count === 0 && group.fallback) {
      rows.push(buildNormalizedSourceRow_({...group.fallback, item_suffix: 'total'}));
    }
  });

  rows.sort((a, b) => {
    const aDate = a[3] instanceof Date ? a[3].getTime() : 0;
    const bDate = b[3] instanceof Date ? b[3].getTime() : 0;
    return aDate - bDate || String(a[16]).localeCompare(String(b[16])) || Number(a[17]) - Number(b[17]);
  });
  return {header_found: headerFound, rows};
}

function buildNormalizedSourceRow_(item) {
  const parsed = parseSourceQuantity_(item.quantity_raw);
  const procurement = deriveProcurementState_(
    item.supplier,
    item.ordered,
    item.arrived,
    item.explicit_status,
    item.explicit_action
  );
  const suffix = item.item_suffix ? `-${item.item_suffix}` : '';
  const itemId = `SRC-${item.sheet.getSheetId()}-${item.row_number}${suffix}`;
  return [
    itemId,
    item.event || item.sheet.getName(),
    item.lead || '',
    item.event_date || '',
    item.dish || '',
    item.ingredient || '',
    String(item.quantity_raw || '').trim(),
    parsed.low,
    parsed.high,
    parsed.unit,
    parsed.quality,
    procurement.status,
    item.supplier || '',
    procurement.arrived,
    procurement.action,
    item.notes || '',
    item.sheet.getName(),
    item.row_number,
  ];
}

function detectSourceHeaderMap_(row) {
  const normalized = row.map(normalizeSourceHeader_);
  const ingredient = findHeaderIndex_(normalized, [
    'ingredient', 'ingredients', 'grocery item', 'item'
  ]);
  const leadQuantity = normalized.findIndex(value =>
    value.includes('head cook') && value.includes('quantity')
  );
  const lead = findHeaderIndex_(normalized, [
    'head cook', 'cook', 'lead', 'headcook'
  ]);
  const individualQuantity = findHeaderIndex_(normalized, [
    'individual quantity', 'head cook quantity', 'cook quantity',
    'quantity per head cook', 'individual amount'
  ]);
  const totalQuantity = findHeaderIndex_(normalized, [
    'total quantity', 'combined quantity', 'weekly total', 'quantity total quantity',
    'quantity total', 'total amount'
  ]);
  let quantity = findHeaderIndex_(normalized, ['quantity', 'qty', 'amount']);
  if (quantity < 0) {
    quantity = normalized.findIndex(value =>
      value === 'quantity total quantity' || value === 'quantity total'
    );
  }

  if (ingredient < 0 || [quantity, totalQuantity, individualQuantity, leadQuantity].every(index => index < 0)) {
    return null;
  }

  return {
    ingredient,
    quantity,
    totalQuantity,
    individualQuantity,
    leadQuantity,
    lead,
    notes: findHeaderIndex_(normalized, ['head cook notes', 'cook notes', 'notes', 'note']),
    supplier: findHeaderIndex_(normalized, ['supplier', 'store', 'vendor']),
    ordered: findHeaderIndex_(normalized, ['ordered', 'order placed', 'purchased', 'ordered checkbox']),
    arrived: findHeaderIndex_(normalized, ['arrived', 'received', 'delivered', 'arrived checkbox']),
    eventDate: findHeaderIndex_(normalized, ['event date', 'meal date', 'dinner date', 'date']),
    event: findHeaderIndex_(normalized, ['event', 'theme', 'dinner']),
    dish: findHeaderIndex_(normalized, ['dish', 'recipe', 'course']),
    status: findHeaderIndex_(normalized, ['status', 'procurement status']),
    action: findHeaderIndex_(normalized, ['action', 'next action']),
  };
}

function findHeaderIndex_(normalizedRow, aliases) {
  const aliasSet = new Set(aliases.map(normalizeSourceHeader_));
  return normalizedRow.findIndex(value => aliasSet.has(value));
}

function normalizeSourceHeader_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[?*]/g, '')
    .replace(/[\\/|:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSourceCell_(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function valueAt_(row, index) {
  return index >= 0 && index < row.length ? row[index] : '';
}

function rawValueAt_(row, index) {
  return index >= 0 && index < row.length ? row[index] : '';
}

function parseCombinedLeadQuantity_(value) {
  const text = cleanSourceCell_(value);
  if (!text) return {lead: '', quantity: ''};
  const match = text.match(/^(.+?)\s*(?:—|–|-|:|\|)\s*((?:\d|[¼½¾⅓⅔⅛⅜⅝⅞]).*)$/);
  return match ? {lead: match[1].trim(), quantity: match[2].trim()} : {lead: text, quantity: ''};
}

function updateSourceContextFromRow_(context, displayRow, rawRow, defaultYear) {
  for (let column = 0; column < displayRow.length - 1; column += 1) {
    const label = normalizeSourceHeader_(displayRow[column]);
    if (!label) continue;
    const displayValue = displayRow[column + 1];
    const rawValue = rawRow[column + 1];
    if (['event date', 'meal date', 'dinner date', 'date'].includes(label)) {
      context.date = parseSourceDateValue_(rawValue || displayValue, defaultYear) || context.date;
    } else if (['head cook', 'cook', 'lead'].includes(label)) {
      context.lead = cleanSourceCell_(displayValue) || context.lead;
    } else if (['event', 'theme', 'dinner'].includes(label)) {
      context.event = cleanSourceCell_(displayValue) || context.event;
    } else if (['dish', 'recipe', 'course'].includes(label)) {
      context.dish = cleanSourceCell_(displayValue) || context.dish;
    }
  }
}

function isSourceBoundaryRow_(text, quantity, lead, supplier, ordered, arrived, fontWeight, background) {
  if (isRecipeInstructionText_(text)) return true;
  if (quantity || lead || supplier || truthySource_(ordered) || truthySource_(arrived)) return false;
  const normalized = cleanSourceCell_(text).toLowerCase();
  const styled = String(fontWeight || '').toLowerCase() === 'bold' || isNonDefaultFill_(background);
  const namedSection = /^(dish|course|item\s*\d+|main|side|dessert|drink|starch|vegetable|tofu|chicken|recipe)\b/.test(normalized);
  return styled || namedSection || normalized.endsWith(':');
}

function isRecipeInstructionText_(text) {
  const normalized = cleanSourceCell_(text).toLowerCase();
  return normalized.startsWith('recipe instruction') ||
    normalized.startsWith('instructions') ||
    normalized.startsWith('directions') ||
    /^https?:\/\//.test(normalized);
}

function isGenericSourceLabel_(text) {
  const normalized = normalizeSourceHeader_(text);
  return [
    'ingredient', 'ingredients', 'quantity', 'total quantity', 'individual quantity',
    'head cook', 'head cook notes', 'notes', 'supplier', 'ordered', 'arrived'
  ].includes(normalized);
}

function isNonDefaultFill_(background) {
  const value = String(background || '').toLowerCase();
  return value && !['#ffffff', 'white', '#fff', ''].includes(value);
}

function inferLeadFromSourceTabName_(name) {
  const text = cleanSourceCell_(name);
  if (!text || /^grocery\b/i.test(text) || inferDateFromSourceTabName_(text, new Date().getFullYear())) return '';
  return text;
}

function inferDateFromSourceTabName_(name, defaultYear) {
  let text = cleanSourceCell_(name)
    .replace(/^grocery\s*[-–—:]\s*/i, '')
    .replace(/\bweek\s+of\b/i, '')
    .trim();

  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return localDate_(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  if (numeric) {
    let year = numeric[3] ? Number(numeric[3]) : defaultYear;
    if (year < 100) year += 2000;
    return localDate_(year, Number(numeric[1]), Number(numeric[2]));
  }

  const months = monthMap_();
  const monthNames = Object.keys(months).join('|');
  const monthMatch = text.match(new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[-–—]\\s*\\d{1,2})?(?:,?\\s+(20\\d{2}))?`, 'i'));
  if (monthMatch) {
    return localDate_(Number(monthMatch[3] || defaultYear), months[monthMatch[1].toLowerCase()], Number(monthMatch[2]));
  }
  return null;
}

function parseSourceDateValue_(value, defaultYear) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = cleanSourceCell_(value);
  if (!text) return null;
  return inferDateFromSourceTabName_(text, defaultYear);
}

function monthMap_() {
  return {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
  };
}

function localDate_(year, month, day) {
  const result = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0);
  return Number.isNaN(result.getTime()) ? null : result;
}

function deriveProcurementState_(supplier, orderedValue, arrivedValue, explicitStatus, explicitAction) {
  const supplierText = cleanSourceCell_(supplier).toLowerCase();
  const arrived = truthySource_(arrivedValue);
  const ordered = truthySource_(orderedValue);
  const inStock = ['we have', 'we have it', 'in stock', 'pantry'].includes(supplierText);

  let status = cleanSourceCell_(explicitStatus);
  let action = cleanSourceCell_(explicitAction);
  if (!status) {
    if (arrived) status = 'Received';
    else if (inStock) status = 'We Have';
    else if (ordered) status = 'Ordered';
    else status = 'Unspecified';
  }
  if (!action) {
    if (arrived) action = 'Received';
    else if (inStock) action = 'In stock';
    else if (ordered) action = 'Await delivery';
    else action = 'Buy / assign supplier';
  }
  return {status, action, arrived};
}

function truthySource_(value) {
  if (value === true) return true;
  return ['true', 'yes', 'y', '1', 'checked', 'ordered', 'arrived', 'received', 'done']
    .includes(String(value || '').trim().toLowerCase());
}

function parseSourceQuantity_(value) {
  const original = cleanSourceCell_(value);
  if (!original) return {low: '', high: '', unit: '', quality: 'Missing'};

  let text = expandUnicodeFractions_(original)
    .replace(/[–—]/g, '-')
    .replace(/,/g, '')
    .trim();
  const lower = text.toLowerCase();
  if (/\b(to taste|as needed|a lot|some|several|handful|enough for|enough to)\b/.test(lower) || /\+/.test(text)) {
    return {low: '', high: '', unit: '', quality: 'Ambiguous'};
  }

  const numberPattern = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?)';
  const rangeMatch = text.match(new RegExp(`(${numberPattern})\\s*(?:-|\\bto\\b)\\s*(${numberPattern})`, 'i'));
  const firstMatch = text.match(new RegExp(numberPattern));
  if (!firstMatch) return {low: '', high: '', unit: '', quality: 'Ambiguous'};

  let low;
  let high;
  let numberEnd;
  let quality = 'Parsed';
  if (rangeMatch) {
    low = parseSourceNumber_(rangeMatch[1]);
    high = parseSourceNumber_(rangeMatch[2]);
    numberEnd = rangeMatch.index + rangeMatch[0].length;
    quality = 'Range';
  } else {
    low = parseSourceNumber_(firstMatch[0]);
    high = low;
    numberEnd = firstMatch.index + firstMatch[0].length;
    if (/\b(about|approx|approximately|around|roughly)\b|~/.test(lower)) quality = 'Approximate';
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return {low: '', high: '', unit: '', quality: 'Ambiguous'};
  }

  const unit = detectSourceUnit_(text, numberEnd) || 'count';
  return {low, high, unit, quality};
}

function expandUnicodeFractions_(value) {
  const fractions = {
    '¼': '1/4', '½': '1/2', '¾': '3/4', '⅓': '1/3', '⅔': '2/3',
    '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8'
  };
  return String(value || '').replace(/(\d)?([¼½¾⅓⅔⅛⅜⅝⅞])/g, (match, whole, fraction) =>
    whole ? `${whole} ${fractions[fraction]}` : fractions[fraction]
  );
}

function parseSourceNumber_(token) {
  const text = cleanSourceCell_(token);
  const mixed = text.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = text.match(/^(\d+)\/(\d+)$/);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return Number(text);
}

function detectSourceUnit_(text, numberEnd) {
  const afterNumber = String(text || '').slice(numberEnd, numberEnd + 30).toLowerCase();
  const whole = String(text || '').toLowerCase();
  const patterns = [
    [/\b(?:fluid ounces?|fl\.?\s*oz|floz)\b/i, 'fl oz'],
    [/\b(?:tablespoons?|tbsp|tbs)\b/i, 'tbsp'],
    [/\b(?:teaspoons?|tsp)\b/i, 'tsp'],
    [/\b(?:kilograms?|kgs?)\b/i, 'kg'],
    [/\b(?:grams?|g)\b/i, 'g'],
    [/\b(?:pounds?|lbs?)\b/i, 'lb'],
    [/\b(?:ounces?|oz)\b/i, 'oz'],
    [/\b(?:milliliters?|millilitres?|mls?)\b/i, 'ml'],
    [/\b(?:liters?|litres?|l)\b/i, 'l'],
    [/\b(?:gallons?|gals?)\b/i, 'gallon'],
    [/\b(?:quarts?|qts?)\b/i, 'quart'],
    [/\b(?:pints?|pts?)\b/i, 'pint'],
    [/\b(?:cups?|c)\b/i, 'cup'],
    [/\bdozen\b/i, 'dozen'],
    [/\bheads?\b/i, 'head'],
    [/\bcloves?\b/i, 'clove'],
    [/\bbunch(?:es)?\b/i, 'bunch'],
    [/\bcans?\b/i, 'can'],
    [/\bbags?\b/i, 'bag'],
    [/\bbottles?\b/i, 'bottle'],
    [/\bboxes?\b/i, 'box'],
    [/\b(?:packs?|packages?|packets?)\b/i, 'package'],
    [/\bjars?\b/i, 'jar'],
    [/\bsprigs?\b/i, 'sprig'],
    [/\btrays?\b/i, 'tray'],
    [/\btubs?\b/i, 'tub'],
    [/\bcartons?\b/i, 'carton'],
    [/\bloaves?\b/i, 'loaf'],
    [/\b(?:each|count|whole|pieces?|units?|medium|large|small|carrots?|tomatoes?|onions?|avocados?|eggs?|fillets?|filets?|thighs?|pads?|paddles?|ears?|stalks?|sheets?|blocks?|containers?)\b/i, 'count'],
  ];
  for (const [pattern, unit] of patterns) {
    if (pattern.test(afterNumber)) return unit;
  }
  for (const [pattern, unit] of patterns) {
    if (pattern.test(whole)) return unit;
  }
  return '';
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
  const tabName = String(props.getProperty('SPICE_TAB') || '').trim();
  let sheet = tabName ? linked.getSheetByName(tabName) : null;
  if (!sheet) {
    sheet = linked.getSheets()[0];
    if (tabName && sheet) props.setProperty('SPICE_TAB', '');
  }
  if (!sheet) throw new Error('The spice inventory spreadsheet has no readable tabs.');
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
  styleSourceSheet_(ss.getSheetByName(SOURCE_SHEET));
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
    const autoRefreshRow = settingRow_(settings, 'Auto Refresh Source Data');
    if (autoRefreshRow > 0) settings.getRange(autoRefreshRow, 2).insertCheckboxes();
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


function styleSourceSheet_(sheet) {
  if (!sheet) return;
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  const lastColumn = Math.max(sheet.getLastColumn(), ALL_ITEMS_HEADERS.length);
  const lastRow = Math.max(sheet.getLastRow(), 1);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, lastColumn)
    .setBackground(HEADER_FILL)
    .setFontColor(HEADER_TEXT)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange(1, 1, lastRow, lastColumn).setWrap(true).setVerticalAlignment('top');
  sheet.getRange(1, 1, lastRow, lastColumn).createFilter();
  const widths = [130, 190, 150, 105, 220, 190, 150, 90, 90, 90, 110, 120, 120, 80, 150, 260, 150, 85];
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
  if (lastRow > 1) {
    sheet.getRange(2, 4, lastRow - 1, 1).setNumberFormat('yyyy-mm-dd');
  }
  sheet.setTabColor('#5B9BD5');
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
