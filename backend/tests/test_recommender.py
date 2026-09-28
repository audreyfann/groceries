from app.recommender import generate_plan


def base_payload():
    return {
        "week_start": "2026-09-21",
        "all_items": [],
        "ingredient_aliases": [],
        "always_stocked": [],
        "spice_inventory": [],
        "weekly_overrides": [],
        "supplier_rules": [
            {
                "Canonical Item": "*",
                "Primary Retailer": "Costco Same-Day",
                "Fallback Retailers": "Instacart",
                "Active": True,
            }
        ],
        "product_catalog": [],
        "ingredient_conversions": [],
        "ingredient_categories": [],
        "settings": {
            "bulk_meat_lb_threshold": 5,
            "bulk_meat_count_threshold": 20,
            "include_undated_rows": False,
            "catalog_stale_after_days": 0,
            "selection_mode": "balanced",
        },
    }


def source_item(item_id, lead, ingredient, amount, unit, *, status="Unspecified", action="Buy / assign supplier"):
    return {
        "Item ID": item_id,
        "Event": "Demo dinner",
        "Lead": lead,
        "Event Date": "2026-09-23",
        "Dish": "Demo dish",
        "Ingredient": ingredient,
        "Quantity (raw)": f"{amount} {unit}",
        "Parsed Low": amount,
        "Parsed High": amount,
        "Unit": unit,
        "Quantity Quality": "Parsed",
        "Status": status,
        "Arrived": False,
        "Action": action,
        "Source Sheet": lead,
        "Source Row": 10,
    }


def test_aggregates_two_cooks_and_buys_three_bags():
    payload = base_payload()
    payload["all_items"] = [
        source_item("1", "Audrey", "Frozen berries", 5, "oz"),
        source_item("2", "Malti", "Frozen berries", 7, "oz"),
    ]
    payload["product_catalog"] = [
        {
            "Canonical Item": "frozen berries",
            "Retailer": "Costco Same-Day",
            "Product Name": "Four ounce berry bag",
            "Amount Per Package": 4,
            "Package Unit": "oz",
            "Pack Count": 1,
            "Purchase Unit": "bag",
            "Price": 2.5,
            "Approved": True,
            "In Stock": True,
            "Active": True,
        }
    ]
    result = generate_plan(payload)
    assert result["summary"]["recommendation_count"] == 1
    recommendation = result["recommendations"][0]
    assert recommendation["buy_quantity"] == 3
    assert recommendation["needed"] == "12 oz"
    assert recommendation["purchased"] == "12 oz"
    assert recommendation["excess"] == "0 oz"
    assert recommendation["head_cooks"] == "Audrey, Malti"


def test_explicit_pantry_and_spice_exclusions():
    payload = base_payload()
    payload["all_items"] = [
        source_item("1", "Audrey", "All-purpose flour", 2, "cup"),
        source_item("2", "Audrey", "Baking soda", 1, "tsp"),
        source_item("3", "Malti", "Cumin", 2, "tbsp"),
    ]
    payload["spice_inventory"] = [{"Spice": "cumin", "Active": True}]
    result = generate_plan(payload)
    assert result["summary"]["recommendation_count"] == 0
    reasons = {row["ingredient"]: row["reason"] for row in result["excluded"]}
    assert reasons["flour"] == "always-stocked pantry rule"
    assert reasons["baking soda"] == "always-stocked pantry rule"
    assert reasons["cumin"] == "listed in linked spice inventory"


def test_bulk_meat_goes_to_separate_supplier():
    payload = base_payload()
    payload["all_items"] = [source_item("1", "Audrey", "Chicken thighs", 30, "lb")]
    result = generate_plan(payload)
    assert result["excluded"][0]["bucket"] == "separate meat supplier"


def test_force_buy_overrides_always_stocked():
    payload = base_payload()
    payload["all_items"] = [source_item("1", "Audrey", "Butter", 32, "oz")]
    payload["weekly_overrides"] = [
        {"Week Start": "2026-09-21", "Ingredient": "butter", "Override": "buy"}
    ]
    payload["product_catalog"] = [
        {
            "Canonical Item": "butter",
            "Retailer": "Costco Same-Day",
            "Product Name": "Butter 4 lb",
            "Amount Per Package": 4,
            "Package Unit": "lb",
            "Pack Count": 1,
            "Purchase Unit": "package",
            "Approved": True,
            "In Stock": True,
            "Active": True,
        }
    ]
    result = generate_plan(payload)
    assert result["recommendations"][0]["buy_quantity"] == 1


def test_ingredient_conversion_volume_to_mass():
    payload = base_payload()
    payload["all_items"] = [source_item("1", "Audrey", "Frozen berries", 6, "cup")]
    payload["ingredient_conversions"] = [
        {
            "Canonical Item": "frozen berries",
            "From Quantity": 1,
            "From Unit": "cup",
            "To Quantity": 5,
            "To Unit": "oz",
            "Approved": True,
            "Active": True,
        }
    ]
    payload["product_catalog"] = [
        {
            "Canonical Item": "frozen berries",
            "Retailer": "Costco Same-Day",
            "Product Name": "Four ounce berry bag",
            "Amount Per Package": 4,
            "Package Unit": "oz",
            "Pack Count": 1,
            "Purchase Unit": "bag",
            "Approved": True,
            "In Stock": True,
            "Active": True,
        }
    ]
    result = generate_plan(payload)
    rec = result["recommendations"][0]
    assert rec["needed"] == "1 lb 14 oz"
    assert rec["buy_quantity"] == 8
    assert rec["excess"] == "2 oz"
    assert "1 cup = 5 oz" in rec["conversion_note"]


def test_undated_rows_are_skipped_by_default():
    payload = base_payload()
    item = source_item("1", "Audrey", "Frozen berries", 5, "oz")
    item["Event Date"] = "Theme/Cuisine"
    payload["all_items"] = [item]
    result = generate_plan(payload)
    assert result["summary"]["skipped_undated_rows"] == 1
    assert result["summary"]["review_count"] == 0


def test_daylight_public_catalog_product_is_medium_confidence():
    payload = base_payload()
    payload["all_items"] = [source_item("1", "Audrey", "Fuji apples", 13, "lb")]
    payload["supplier_rules"] = [
        {
            "Canonical Item": "fuji apples",
            "Primary Retailer": "Daylight",
            "Fallback Retailers": "Instacart",
            "Active": True,
        }
    ]
    payload["product_catalog"] = [
        {
            "Canonical Item": "fuji apples",
            "Retailer": "Daylight",
            "Product Name": "APPLE, FUJI 5-LB",
            "Product ID": "apple-fuji-5-lb",
            "Amount Per Package": 5,
            "Package Unit": "lb",
            "Pack Count": 1,
            "Purchase Unit": "each",
            "Approved": True,
            "In Stock": True,
            "Active": True,
            "Notes": "DAYLIGHT_PUBLIC_CATALOG: public listing only; account price and live availability are not confirmed.",
        }
    ]
    result = generate_plan(payload)
    recommendation = result["recommendations"][0]
    assert recommendation["buy_quantity"] == 3
    assert recommendation["confidence"] == "medium"
    assert "does not confirm account price or live availability" in recommendation["reason"]


def test_fresh_produce_routes_to_daylight_without_manual_rule():
    payload = base_payload()
    payload["all_items"] = [source_item("1", "Audrey", "Roma tomatoes", 8, "lb")]
    result = generate_plan(payload)
    assert result["summary"]["review_count"] == 1
    review = result["review"][0]
    assert review["category"] == "produce"
    assert review["preferred_retailers"].split(", ")[0] == "Daylight"


def test_frozen_produce_stays_costco_not_daylight():
    payload = base_payload()
    payload["all_items"] = [source_item("1", "Audrey", "Frozen berries", 12, "oz")]
    result = generate_plan(payload)
    review = result["review"][0]
    assert review["category"] == "frozen"
    assert review["preferred_retailers"].split(", ")[0] == "Costco Same-Day"


def test_asian_specialty_routes_to_weee():
    payload = base_payload()
    payload["all_items"] = [source_item("1", "Audrey", "Gochujang", 2, "jar")]
    result = generate_plan(payload)
    review = result["review"][0]
    assert review["category"] == "asian_specialty"
    assert review["preferred_retailers"].split(", ")[0] == "Weee"


def test_manual_category_override_beats_smart_classifier():
    payload = base_payload()
    payload["all_items"] = [source_item("1", "Audrey", "Tomatoes", 8, "lb")]
    payload["ingredient_categories"] = [{
        "Canonical Item": "tomatoes",
        "Category": "general_grocery",
        "Preferred Retailers": "Instacart; Costco Same-Day",
        "Active": True,
        "Notes": "Buy canned tomatoes for this item",
    }]
    result = generate_plan(payload)
    review = result["review"][0]
    assert review["classification_source"] == "manual"
    assert review["preferred_retailers"].split(", ")[0] == "Instacart"
