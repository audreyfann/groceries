# Hamm Weekly Grocery Planner — v0.3

This project converts the existing `All Items` head-cook tracker into one weekly purchasing workflow. It combines ingredient totals, keeps head-cook attribution, applies pantry/spice/meat exclusions, calculates exact package counts from approved products, and now searches Daylight Foods' public catalog for reviewable product candidates.

## What v0.3 adds

The Daylight adapter:

- reads the public Daylight catalog and its paginated product listings;
- caches the catalog for a configurable period so normal weekly use does not repeatedly crawl the site;
- searches unresolved ingredients and ranks likely product matches;
- parses package structures such as `5-LB`, `10/5oz`, `100/2-OZ`, count ranges, and `BAG6`;
- calculates a proposed number of cases, bags, or units when the recipe quantity is compatible; and
- writes candidates to `Daylight Matches` for human approval before they enter `Product Catalog`.

The public catalog does **not** confirm account-specific price or live availability. Approved Daylight rows therefore remain medium-confidence until the shopper verifies the product in the account portal.

## Example

```text
Weekly need: 13 lb Fuji apples
Public listing: APPLE, FUJI 5-LB — UOM EACH
Calculation: ceil(13 / 5) = 3
Recommendation: buy 3 units
Purchased: 15 lb
Expected excess: 2 lb
```

For a multipack such as `10/5oz`, retailer quantity 1 supplies 10 inner packages × 5 oz = 50 oz.

## Core features

- Monday–Sunday weekly selection from `All Items`.
- Combined quantities across head cooks with event, dish, and source-row attribution.
- Exclusions for pantry staples, linked spice inventory, already ordered/received items, and bulk meat.
- Approved aliases and ingredient-specific conversions.
- Exact package rounding and excess calculation.
- Checklist state preserved after regeneration.
- Daylight public-catalog candidate browsing and approval.
- Optional Instacart/Costco shopping-list handoff.

## Current pantry exclusions

The workbook begins with soy sauce, butter, maple syrup, rice, pasta, oats, sugar, salt, black pepper, ordinary flour, and baking soda. Specialty variants remain separate unless explicitly aliased.

## Files

```text
workbook/head_cook_grocery_planner_v0_3.xlsx  Ready-to-upload version of the real tracker
apps_script/Code.gs                  Google Sheets menu and synchronization
backend/                             FastAPI service and Daylight adapter
render.yaml                          Render deployment blueprint
sheet_templates/                     CSV versions of control tables
DAYLIGHT_QUICK_START.md              Daylight-specific operating guide
SETUP_CHECKLIST.md                   Installation checklist
ARCHITECTURE.md                      Data flow and extension points
TEST_REPORT.txt                      Automated test summary
```

## Setup

### 1. Upload the workbook

Upload the workbook to Google Drive, open it in Google Sheets, and save it as a native Google Sheet. The original tracker tabs remain intact. New tabs include:

- `Planner Guide`
- `Settings`
- `Ingredient Aliases`
- `Always Stocked`
- `Supplier Rules`
- `Ingredient Conversions`
- `Product Catalog`
- `Weekly Overrides`
- `Weekly Order`
- `Excluded Items`
- `Needs Review`
- `Daylight Matches`

### 2. Install Apps Script

1. Open **Extensions → Apps Script**.
2. Replace `Code.gs` with `apps_script/Code.gs`.
3. Save and reload the Sheet.
4. Choose **Grocery Tools → Set up / update planning tabs**.

The script does not rewrite `All Items`.

### 3. Run or deploy the backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Run tests:

```bash
python -m pytest -q
```

### 4. Environment variables

```text
APP_SHARED_TOKEN=<long random secret>
INSTACART_API_KEY=
INSTACART_BASE_URL=https://connect.dev.instacart.tools
DAYLIGHT_CATALOG_URL=https://daylightfoods.com/catalog/
DAYLIGHT_CACHE_HOURS=24
DAYLIGHT_REQUEST_DELAY_SECONDS=0.20
DAYLIGHT_MAX_PAGES=40
DAYLIGHT_TIMEOUT_SECONDS=25
```

The Daylight adapter needs no account credentials. It reads only the public catalog. Keep the Instacart key in the backend environment, never in the Sheet.

### 5. Connect the Sheet

Use **Grocery Tools → Configure connection** and enter the deployed backend URL, `APP_SHARED_TOKEN`, the linked spice-inventory Sheet URL or ID, and its tab name if needed. Then run **Validate setup**.

## Daylight workflow

### Automatic

1. Set `Settings → Week Start`.
2. Leave `Auto Browse Daylight` checked.
3. Choose **Grocery Tools → Generate weekly order**.
4. The planner writes unresolved items to `Needs Review` and searches appropriate rows in the public Daylight catalog.
5. Open `Daylight Matches`.
6. Review the exact listing, UOM, package parsing, match confidence, and proposed quantity.
7. Select the desired row and choose **Grocery Tools → Daylight public catalog → Approve selected match**.
8. Regenerate the week. The approved product can now produce a normal `Weekly Order` line.

### Manual single-item search

Select an ingredient row on `Needs Review`, `All Items`, or another sheet with an Ingredient field. Choose **Search selected ingredient** under the Daylight menu.

### Refresh

Choose **Refresh public catalog** to bypass the cache. Ordinary generation uses the cached snapshot until `DAYLIGHT_CACHE_HOURS` expires.

## Package confidence

- `exact`: package math came directly from a clear title/UOM pattern.
- `estimate`: count range or sold-by-pound behavior requires confirmation.
- `unclear`: the public title did not expose a usable package size.

Approval is blocked when no usable amount/unit was parsed. Even exact public package math does not establish your account price or current availability.

## Supplier routing

```text
Daylight               bulk produce and approved food-service cases
Costco Same-Day        standard groceries and recurring bulk packages
Weee                   approved Asian grocery products
Instacart              fallback items and shopping-list handoff
Separate meat supplier bulk meat excluded from the four-store order
```

Rules are editable in `Supplier Rules`. Exact item rules take priority over the wildcard default.

## API endpoints

```text
GET  /health
POST /generate
POST /daylight/search
POST /daylight/search-batch
POST /daylight/refresh
POST /daylight/status
POST /instacart-link
POST /nearby-retailers
```

All POST endpoints accept `X-Shared-Token` when `APP_SHARED_TOKEN` is set.

## Safeguards

- New Daylight matches are candidates, not silent catalog activations.
- Package-unclear matches cannot be approved through the menu.
- Public Daylight data is labeled as lacking account price and live availability.
- Missing or ambiguous recipe quantities never become orders silently.
- Regeneration preserves checklist state through a stable row ID.
- Bulk meat and stocked-item exclusions remain visible in the audit log.
- The crawler uses a descriptive user agent, checks `robots.txt`, rate-limits requests, and caches results.
