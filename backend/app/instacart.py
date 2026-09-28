from __future__ import annotations

import os
from typing import Any

import httpx


SUPPORTED_UNIT_MAP = {
    "unit": "each",
    "each": "each",
    "head": "head",
    "bunch": "bunch",
    "can": "can",
    "bag": "package",
    "bags": "package",
    "package": "package",
    "packages": "package",
    "pack": "package",
    "box": "package",
    "boxes": "package",
    "bottle": "package",
    "bottles": "package",
    "case": "package",
    "cases": "package",
    "jar": "package",
    "jars": "package",
    "tray": "package",
    "trays": "package",
    "tub": "package",
    "tubs": "package",
    "carton": "package",
    "cartons": "package",
}


def _api_config() -> tuple[str, str]:
    api_key = os.getenv("INSTACART_API_KEY")
    if not api_key:
        raise RuntimeError("INSTACART_API_KEY is not configured")
    base_url = os.getenv("INSTACART_BASE_URL", "https://connect.dev.instacart.tools").rstrip("/")
    return api_key, base_url


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


async def create_shopping_list(title: str, recommendations: list[dict[str, Any]]) -> dict[str, Any]:
    api_key, base_url = _api_config()

    line_items: list[dict[str, Any]] = []
    seen_upcs: set[str] = set()
    seen_product_ids: set[int] = set()

    for item in recommendations:
        buy_quantity = float(item.get("buy_quantity", 1) or 1)
        purchase_unit = str(item.get("purchase_unit", "unit")).lower()
        line_item: dict[str, Any] = {
            "name": item.get("exact_product") or item.get("ingredient"),
            "display_text": (
                f"{item.get('ingredient')}: buy {buy_quantity:g} "
                f"{item.get('purchase_unit') or 'unit'}"
            ),
            "line_item_measurements": [
                {
                    "quantity": buy_quantity,
                    "unit": SUPPORTED_UNIT_MAP.get(purchase_unit, "each"),
                }
            ],
        }

        upc = str(item.get("upc") or "").strip()
        product_id_raw = str(item.get("product_id") or "").strip()
        if upc and upc not in seen_upcs:
            line_item["upcs"] = [upc]
            seen_upcs.add(upc)
        elif product_id_raw.isdigit() and int(product_id_raw) not in seen_product_ids:
            product_id = int(product_id_raw)
            line_item["product_ids"] = [product_id]
            seen_product_ids.add(product_id)
        line_items.append(line_item)

    body = {
        "title": title,
        "link_type": "shopping_list",
        "line_items": line_items,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.post(
                f"{base_url}/idp/v1/products/products_link",
                json=body,
                headers=_headers(api_key),
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:1000]
            raise RuntimeError(
                f"Instacart returned HTTP {exc.response.status_code}: {detail}"
            ) from exc
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Instacart request failed: {exc}") from exc
        return response.json()


async def get_nearby_retailers(postal_code: str, country_code: str = "US") -> dict[str, Any]:
    api_key, base_url = _api_config()
    params = {
        "postal_code": postal_code.strip(),
        "country_code": country_code.strip().upper() or "US",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.get(
                f"{base_url}/idp/v1/retailers",
                params=params,
                headers=_headers(api_key),
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:1000]
            raise RuntimeError(
                f"Instacart returned HTTP {exc.response.status_code}: {detail}"
            ) from exc
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Instacart request failed: {exc}") from exc
        return response.json()
