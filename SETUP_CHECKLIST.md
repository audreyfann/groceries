# Setup checklist — v0.5

## Spreadsheet

- [ ] Upload `head_cook_grocery_planner_v0_3.xlsx` to Google Drive.
- [ ] Open it as a Google Sheet and confirm the original `All Items` data is present.
- [ ] Set the ordering Monday in `Settings`.
- [ ] Add the delivery postal code.
- [ ] Review `Always Stocked`, `Ingredient Aliases`, and `Supplier Rules`.
- [ ] Confirm `Auto Browse Daylight` is checked.

## Apps Script

- [ ] Open **Extensions → Apps Script**.
- [ ] Replace `Code.gs` with `apps_script/Code.gs`.
- [ ] Save and reload the spreadsheet.
- [ ] Run **Grocery Tools → Set up / update planning tabs**.
- [ ] Authorize spreadsheet, linked-spice-sheet, and external-request access when prompted.

## Backend

- [ ] Deploy using `render.yaml`, or run FastAPI elsewhere.
- [ ] Set `APP_SHARED_TOKEN` to a long random value.
- [ ] Leave `INSTACART_API_KEY` blank until available.
- [ ] Keep the default Daylight public-catalog settings initially.
- [ ] Confirm `/health` returns `{"status":"ok","version":"0.3.0"}`.

## Connect services

- [ ] Run **Grocery Tools → Configure connection**.
- [ ] Enter the backend URL and shared token.
- [ ] Paste the spice-inventory Sheet URL and optional tab name.
- [ ] Run **Grocery Tools → Validate setup**.

## Verify Daylight browsing

- [ ] Choose **Grocery Tools → Daylight public catalog → Refresh public catalog**.
- [ ] Confirm the alert reports products and source pages.
- [ ] Generate a week with at least one unresolved produce item.
- [ ] Open `Daylight Matches` and inspect the top candidates.
- [ ] Confirm the product name, UOM, package size, and calculation against the linked listing.
- [ ] Approve one selected match.
- [ ] Confirm it appears in `Product Catalog` with the `DAYLIGHT_PUBLIC_CATALOG` note.
- [ ] Regenerate and confirm the recommendation appears in `Weekly Order` at medium confidence.
- [ ] Verify price and availability in the Daylight account before placing the order.

## First weekly run

- [ ] Resolve important `Needs Review` rows.
- [ ] Confirm bulk meat appears only under the separate supplier.
- [ ] Confirm pantry staples and linked spices are excluded but documented.
- [ ] Assign shoppers and test the Bought checkbox.
- [ ] Regenerate once to verify checklist state persists.

## Instacart later

- [ ] Add the API key only to the backend environment.
- [ ] Use the development endpoint for a development key.
- [ ] Review every generated match before checkout.


## Smart routing

- Run **Set up / update planning tabs** to create `Ingredient Categories`.
- Fresh produce is automatically routed to Daylight.
- Asian specialty groceries are automatically routed to Weee.
- Add an exact row to `Ingredient Categories` when the automatic category should be overridden.
- Optional: set `OPENAI_API_KEY` in Render for AI fallback on ambiguous ingredient names.
