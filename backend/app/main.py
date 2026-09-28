from __future__ import annotations

import os
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .classifier import classify_ingredients
from .daylight import daylight_catalog
from .instacart import create_shopping_list, get_nearby_retailers
from .recommender import generate_plan

app = FastAPI(title="Weekly Grocery Planner", version="0.5.0")


class GeneratePayload(BaseModel):
    week_start: str
    all_items: list[dict[str, Any]] = Field(default_factory=list)
    ingredient_aliases: list[dict[str, Any]] = Field(default_factory=list)
    always_stocked: list[dict[str, Any]] = Field(default_factory=list)
    spice_inventory: list[dict[str, Any]] = Field(default_factory=list)
    weekly_overrides: list[dict[str, Any]] = Field(default_factory=list)
    supplier_rules: list[dict[str, Any]] = Field(default_factory=list)
    product_catalog: list[dict[str, Any]] = Field(default_factory=list)
    ingredient_conversions: list[dict[str, Any]] = Field(default_factory=list)
    ingredient_categories: list[dict[str, Any]] = Field(default_factory=list)
    settings: dict[str, Any] = Field(default_factory=dict)




class ClassifyPayload(BaseModel):
    ingredients: list[str] = Field(default_factory=list)
    ingredient_aliases: list[dict[str, Any]] = Field(default_factory=list)
    ingredient_categories: list[dict[str, Any]] = Field(default_factory=list)


class InstacartPayload(BaseModel):
    title: str
    recommendations: list[dict[str, Any]] = Field(default_factory=list)


class DaylightSearchPayload(BaseModel):
    query: str
    canonical_item: str = ""
    required_text: str = ""
    limit: int = Field(default=5, ge=1, le=20)
    force_refresh: bool = False


class DaylightBatchPayload(BaseModel):
    items: list[dict[str, Any]] = Field(default_factory=list)
    limit: int = Field(default=5, ge=1, le=20)
    force_refresh: bool = False
    max_items: int = Field(default=25, ge=1, le=100)


class DaylightRefreshPayload(BaseModel):
    force: bool = True


class RetailersPayload(BaseModel):
    postal_code: str
    country_code: str = "US"


def require_shared_token(x_shared_token: str | None = Header(default=None)) -> None:
    expected = os.getenv("APP_SHARED_TOKEN")
    if expected and x_shared_token != expected:
        raise HTTPException(status_code=401, detail="Invalid shared token")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.5.0"}


@app.post("/generate", dependencies=[Depends(require_shared_token)])
def generate(payload: GeneratePayload) -> dict[str, Any]:
    try:
        return generate_plan(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/classify", dependencies=[Depends(require_shared_token)])
def classify(payload: ClassifyPayload) -> dict[str, Any]:
    from .normalization import build_alias_map

    alias_map = build_alias_map(payload.ingredient_aliases)
    results = classify_ingredients(payload.ingredients, payload.ingredient_categories, alias_map)
    return {
        "items": [
            {"ingredient": ingredient, **classification.as_dict()}
            for ingredient, classification in sorted(results.items())
        ]
    }


@app.post("/instacart-link", dependencies=[Depends(require_shared_token)])
async def instacart_link(payload: InstacartPayload) -> dict[str, Any]:
    try:
        return await create_shopping_list(payload.title, payload.recommendations)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/nearby-retailers", dependencies=[Depends(require_shared_token)])
async def nearby_retailers(payload: RetailersPayload) -> dict[str, Any]:
    try:
        return await get_nearby_retailers(payload.postal_code, payload.country_code)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/daylight/search", dependencies=[Depends(require_shared_token)])
async def daylight_search(payload: DaylightSearchPayload) -> dict[str, Any]:
    try:
        return await daylight_catalog.search(
            query=payload.query,
            canonical_item=payload.canonical_item,
            required_text=payload.required_text,
            limit=payload.limit,
            force_refresh=payload.force_refresh,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/daylight/search-batch", dependencies=[Depends(require_shared_token)])
async def daylight_search_batch(payload: DaylightBatchPayload) -> dict[str, Any]:
    try:
        return await daylight_catalog.search_batch(
            payload.items,
            limit=payload.limit,
            force_refresh=payload.force_refresh,
            max_items=payload.max_items,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/daylight/refresh", dependencies=[Depends(require_shared_token)])
async def daylight_refresh(payload: DaylightRefreshPayload) -> dict[str, Any]:
    try:
        snapshot = await daylight_catalog.refresh(force=payload.force)
        return {
            "status": "ok",
            "product_count": len(snapshot.products),
            "source_pages": snapshot.source_pages,
            "fetched_at": snapshot.fetched_at.isoformat(),
            "catalog_url": snapshot.catalog_url,
        }
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/daylight/status", dependencies=[Depends(require_shared_token)])
async def daylight_status() -> dict[str, Any]:
    return await daylight_catalog.status()
