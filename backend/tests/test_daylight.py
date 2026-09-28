from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.daylight import (
    DaylightProduct,
    build_search_result,
    extract_last_catalog_page,
    parse_catalog_html,
    parse_daylight_package,
    parse_required_text,
    product_match_score,
)


CATALOG_HTML = """
<html>
  <body>
    <ul class="products">
      <li class="product">
        <a class="woocommerce-LoopProduct-link woocommerce-loop-product__link" href="https://daylightfoods.com/product/apple-fuji-5-lb/">
          <h2 class="woocommerce-loop-product__title">APPLE, FUJI 5-LB</h2>
        </a>
        <span>UOM: EACH</span>
      </li>
      <li class="product">
        <a class="woocommerce-LoopProduct-link woocommerce-loop-product__link" href="/product/arugula-wild-organic-10-5oz/">
          <h2>ARUGULA, WILD ORGANIC 10/5oz</h2>
        </a>
        UOM: CASE
      </li>
      <li class="product">
        <a class="woocommerce-LoopProduct-link woocommerce-loop-product__link" href="/product/avocado-hass-6-ct-unit/">
          <h2>AVOCADO, HASS 6-CT UNIT</h2>
        </a>
        UOM: BAG6
      </li>
    </ul>
    <a href="https://daylightfoods.com/catalog/page/2/">2</a>
    <a href="https://daylightfoods.com/catalog/page/32/">32</a>
  </body>
</html>
"""


def test_parse_catalog_html_and_last_page() -> None:
    products = parse_catalog_html(CATALOG_HTML, "https://daylightfoods.com/catalog/")
    assert len(products) == 3
    assert products[0].product_name == "APPLE, FUJI 5-LB"
    assert products[0].uom == "EACH"
    assert products[1].product_url == "https://daylightfoods.com/product/arugula-wild-organic-10-5oz/"
    assert extract_last_catalog_page(CATALOG_HTML) == 32


@pytest.mark.parametrize(
    ("title", "uom", "amount", "unit", "count", "exact"),
    [
        ("APPLE, FUJI 5-LB", "EACH", 5, "lb", 1, True),
        ("ARUGULA, WILD ORGANIC 10/5oz", "CASE", 5, "oz", 10, True),
        ("APPLE, SLICED 100/2-OZ", "CASE", 2, "oz", 100, True),
        ("Artichoke, QTR HRT Marinated 6/3KG", "CASE", 3, "kg", 6, True),
        ("AVOCADO, HASS 6-CT UNIT", "BAG6", 6, "each", 1, True),
        ("APPLE, FUJI 64-88 CT", "CASE", 64, "each", 1, False),
        ("APPLE, GRANNY SMITH 175/198CT.", "CASE", 175, "each", 1, False),
        ("BLUEBERRY, FROZEN IQF 30#", "CASE", 30, "lb", 1, True),
    ],
)
def test_parse_daylight_package(
    title: str,
    uom: str,
    amount: float,
    unit: str,
    count: float,
    exact: bool,
) -> None:
    parsed = parse_daylight_package(title, uom)
    assert parsed.amount_per_package == amount
    assert parsed.package_unit == unit
    assert parsed.pack_count == count
    assert parsed.exact is exact


def test_sold_by_pound_is_marked_estimate() -> None:
    parsed = parse_daylight_package("ASPARAGUS, STANDARD 11-LB", "LBS")
    assert parsed.amount_per_package == 1
    assert parsed.package_unit == "lb"
    assert parsed.purchase_unit == "lb"
    assert parsed.exact is False
    assert "confirm account minimum" in parsed.notes[0]


def test_required_text_compound_mass() -> None:
    required, error = parse_required_text("1 lb 2 oz")
    assert error == ""
    assert required is not None
    assert required.dimension == "mass"
    assert required.value == pytest.approx(18)


def test_five_pound_apple_recommendation() -> None:
    product = DaylightProduct(
        product_name="APPLE, FUJI 5-LB",
        product_url="https://daylightfoods.com/product/apple-fuji-5-lb/",
        uom="EACH",
        product_id="apple-fuji-5-lb",
    )
    result = build_search_result(
        query="fuji apples",
        canonical_item="fuji apples",
        required_text="13 lb",
        product=product,
        score=0.95,
        fetched_at=datetime(2026, 9, 27, tzinfo=timezone.utc),
    )
    assert result["buy_quantity"] == 3
    assert result["purchased"] == "15 lb"
    assert result["excess"] == "2 lb"
    assert result["recommendation_status"] == "ready"


def test_bag_six_avocado_recommendation() -> None:
    product = DaylightProduct(
        product_name="AVOCADO, HASS 6-CT UNIT",
        product_url="https://daylightfoods.com/product/avocado-hass-6-ct-unit/",
        uom="BAG6",
    )
    result = build_search_result(
        query="hass avocados",
        canonical_item="hass avocados",
        required_text="14 each",
        product=product,
        score=0.93,
        fetched_at=datetime(2026, 9, 27, tzinfo=timezone.utc),
    )
    assert result["buy_quantity"] == 3
    assert result["purchased"] == "18 each"
    assert result["excess"] == "4 each"


def test_match_score_prefers_exact_processing_state() -> None:
    query = "frozen blueberries"
    exact = product_match_score(query, "BLUEBERRY, FROZEN IQF 30-LB")
    dried = product_match_score(query, "BLUEBERRY, DRIED 5-LB")
    assert exact > dried
    assert exact > 0.6


def test_count_title_with_each_uom_treats_order_unit_as_one_item() -> None:
    parsed = parse_daylight_package("ARTICHOKE, 24-CT", "EACH")
    assert parsed.amount_per_package == 1
    assert parsed.package_unit == "each"
    assert parsed.purchase_unit == "each"
    assert parsed.exact is False
    assert "sold each" in parsed.notes[0]
