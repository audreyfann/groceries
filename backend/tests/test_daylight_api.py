from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.daylight import CatalogSnapshot, DaylightProduct, daylight_catalog
from app.main import app


client = TestClient(app)


def seed_catalog() -> None:
    daylight_catalog._snapshot = CatalogSnapshot(
        products=[
            DaylightProduct(
                product_name="APPLE, FUJI 5-LB",
                product_url="https://daylightfoods.com/product/apple-fuji-5-lb/",
                uom="EACH",
                product_id="apple-fuji-5-lb",
            ),
            DaylightProduct(
                product_name="AVOCADO, HASS 6-CT UNIT",
                product_url="https://daylightfoods.com/product/avocado-hass-6-ct-unit/",
                uom="BAG6",
                product_id="avocado-hass-6-ct-unit",
            ),
        ],
        fetched_at=datetime.now(timezone.utc),
        source_pages=32,
        catalog_url="https://daylightfoods.com/catalog/",
    )


def test_health_version() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "0.3.0"}


def test_daylight_search_endpoint_calculates_packages() -> None:
    seed_catalog()
    response = client.post(
        "/daylight/search",
        json={
            "query": "fuji apples",
            "canonical_item": "fuji apples",
            "required_text": "13 lb",
            "limit": 5,
        },
    )
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["product_name"] == "APPLE, FUJI 5-LB"
    assert result["buy_quantity"] == 3
    assert result["purchased"] == "15 lb"


def test_daylight_batch_endpoint_matches_multiple_ingredients() -> None:
    seed_catalog()
    response = client.post(
        "/daylight/search-batch",
        json={
            "items": [
                {"query": "fuji apples", "canonical_item": "fuji apples", "required_text": "13 lb"},
                {"query": "hass avocados", "canonical_item": "hass avocados", "required_text": "14 each"},
            ],
            "limit": 1,
            "max_items": 25,
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["searched_item_count"] == 2
    assert payload["match_count"] == 2
    assert {item["ingredient"] for item in payload["matches"]} == {"fuji apples", "hass avocados"}
