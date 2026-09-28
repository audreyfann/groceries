# Daylight public catalog — quick start

1. Deploy backend v0.3 and install the matching Apps Script.
2. Run **Grocery Tools → Set up / update planning tabs**.
3. Run **Grocery Tools → Validate setup**.
4. Choose **Daylight public catalog → Refresh public catalog** once.
5. Set the week and choose **Generate weekly order**.
6. Open `Daylight Matches`.
7. Compare the top candidates for each ingredient:
   - Product Name
   - Daylight UOM
   - Package Size
   - Buy Quantity
   - Match Confidence
   - Package Confidence
   - Calculation
8. Select the desired row and choose **Approve selected match**.
9. Regenerate the weekly order.
10. Open the Daylight product link and confirm account price and availability before ordering.

## Reading package fields

- `10/5oz` = one case containing ten 5 oz inner packs.
- `5-LB` with UOM `EACH` = one purchasable 5 lb unit.
- `BAG6` = one bag containing six items.
- `64-88 CT` = a count range; the planner marks it as an estimate.
- UOM `LBS` = sold by weight; confirm any account minimum.

## Troubleshooting

- **No matches:** select the ingredient and run the single-item search; simplify the ingredient wording or add an alias.
- **Package unclear:** open the listing and enter the package manually in `Product Catalog`.
- **Wrong processed form:** reject frozen/dried/sliced mismatches and search with the desired qualifier.
- **Backend error:** verify `/health`, `APP_SHARED_TOKEN`, and Render logs.
- **Catalog layout changed:** the backend will report that no product cards were parsed rather than silently returning an empty catalog.
