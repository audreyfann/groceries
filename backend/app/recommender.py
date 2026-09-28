from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from math import isfinite
from typing import Any

from dateutil import parser as date_parser

from .classifier import IngredientClassification, classify_ingredients
from .conversions import ConversionGraph, build_conversion_graph, convert_amount
from .exclusions import DEFAULT_ALWAYS_STOCKED, evaluate_exclusion, truthy
from .normalization import build_alias_map, canonicalize, clean_text
from .package_math import NormalizedQuantity, calculate_packages, display_base, normalize_quantity


DEFAULT_SUPPLIER_ORDER = ["Costco Same-Day", "Weee", "Instacart", "Daylight"]
COMPOUND_QUANTITY_RE = re.compile(r"\+|\bor\b|\bto taste\b|\benough (?:for|to)\b", re.IGNORECASE)


def _value(row: dict[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in row and row[name] not in (None, ""):
            return row[name]
    return default


def _float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        result = float(str(value).replace(",", "").strip())
        return result if isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    text = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", text, flags=re.IGNORECASE)
    try:
        return date_parser.parse(text, fuzzy=True).date()
    except (ValueError, TypeError, OverflowError):
        return None


def _week_start(value: str) -> date:
    parsed = _parse_date(value)
    if not parsed:
        raise ValueError("week_start must be a valid date")
    return parsed - timedelta(days=parsed.weekday())


def _bool(value: Any, default: bool = False) -> bool:
    if value in (None, ""):
        return default
    return str(value).strip().lower() in {"true", "yes", "y", "1", "checked"}


def _rows_to_name_set(rows: list[dict[str, Any]], alias_map: dict[str, str]) -> set[str]:
    result: set[str] = set()
    for row in rows:
        active = str(_value(row, "Active", "active", default="TRUE")).strip().lower()
        if active in {"false", "0", "no", "n", "out"}:
            continue
        status = clean_text(_value(row, "Status", "Stock Status", default=""))
        if status in {"out", "out of stock", "none", "empty"}:
            continue
        raw = _value(row, "Canonical Item", "Ingredient", "Spice", "Item", "Name", "canonical")
        if raw:
            canonical = canonicalize(str(raw), alias_map).canonical
            if canonical:
                result.add(canonical)
    return result


def _override_map(rows: list[dict[str, Any]], week_start: date, alias_map: dict[str, str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for row in rows:
        row_week = _parse_date(_value(row, "Week Start", "Week", "week_start"))
        if row_week and row_week - timedelta(days=row_week.weekday()) != week_start:
            continue
        raw = _value(row, "Ingredient", "Canonical Item", "Item")
        action = clean_text(_value(row, "Override", "Action", default=""))
        if raw and action:
            result[canonicalize(str(raw), alias_map).canonical] = action
    return result


def _supplier_order(
    canonical: str,
    rows: list[dict[str, Any]],
    alias_map: dict[str, str],
    classification: IngredientClassification | None = None,
) -> list[str]:
    """Return retailer priority. Exact user rules win, then smart classification, then wildcard."""
    wildcard: list[str] | None = None
    for row in rows:
        active = str(_value(row, "Active", "active", default="TRUE")).strip().lower()
        if active in {"false", "0", "no", "n"}:
            continue
        raw = str(_value(row, "Canonical Item", "Ingredient", "Item", default="")).strip()
        if raw == "*":
            match = True
            is_wildcard = True
        else:
            match = canonicalize(raw, alias_map).canonical == canonical
            is_wildcard = False
        if not match:
            continue
        primary = str(_value(row, "Primary Retailer", "Primary", default="")).strip()
        fallback = str(_value(row, "Fallback Retailers", "Fallback", default="")).strip()
        values = [primary] if primary else []
        values.extend([v.strip() for v in re.split(r"[;|,]", fallback) if v.strip()])
        if not values:
            continue
        if is_wildcard:
            wildcard = values
        else:
            return values
    if classification and classification.preferred_retailers:
        return list(classification.preferred_retailers)
    return wildcard or list(DEFAULT_SUPPLIER_ORDER)


def _catalog_products(canonical: str, rows: list[dict[str, Any]], alias_map: dict[str, str]) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    for row in rows:
        active = str(_value(row, "Active", "active", default="TRUE")).strip().lower()
        in_stock = str(_value(row, "In Stock", "Available", "in_stock", default="TRUE")).strip().lower()
        if active in {"false", "0", "no", "n"} or in_stock in {"false", "0", "no", "n", "out"}:
            continue
        raw = _value(row, "Canonical Item", "Ingredient", "Item")
        if canonicalize(str(raw or ""), alias_map).canonical != canonical:
            continue
        products.append(row)
    return products


def _stable_id(week: date, canonical: str, target_dimension: str, product_key: str) -> str:
    payload = f"{week.isoformat()}|{canonical}|{target_dimension}|{product_key}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _retailer_rank(retailer: str, order: list[str]) -> int:
    normalized = clean_text(retailer)
    for index, value in enumerate(order):
        if clean_text(value) == normalized:
            return index
    return len(order) + 5


def _last_checked(product: dict[str, Any]) -> date | None:
    return _parse_date(_value(product, "Last Checked", "Checked At", "last_checked"))


def _is_stale(product: dict[str, Any], stale_after_days: float) -> bool:
    if stale_after_days <= 0:
        return False
    checked = _last_checked(product)
    if not checked:
        return True
    return (date.today() - checked).days > stale_after_days


def _waste_bucket(waste_ratio: float) -> int:
    if waste_ratio <= 0.01:
        return 0
    if waste_ratio <= 0.10:
        return 1
    if waste_ratio <= 0.25:
        return 2
    if waste_ratio <= 0.50:
        return 3
    return 4


def _candidate_score(
    *,
    approved: bool,
    preference_rank: float,
    retailer_rank: int,
    stale: bool,
    line_cost: float | None,
    waste_ratio: float,
    purchase_count: int,
    selection_mode: str,
) -> tuple[float, ...]:
    prefix: tuple[float, ...] = (
        0 if approved else 1,
        preference_rank,
        retailer_rank,
        1 if stale else 0,
    )
    cost_missing = 0 if line_cost is not None else 1
    cost_value = line_cost if line_cost is not None else 10**9
    mode = clean_text(selection_mode)
    if mode in {"lowest waste", "waste"}:
        return (*prefix, waste_ratio, cost_missing, cost_value, purchase_count)
    if mode in {"lowest cost", "cost"}:
        return (*prefix, cost_missing, cost_value, waste_ratio, purchase_count)
    return (*prefix, _waste_bucket(waste_ratio), cost_missing, cost_value, waste_ratio, purchase_count)


def _convert_requirements_for_product(
    *,
    canonical: str,
    requirements: list[dict[str, Any]],
    target_dimension: str,
    conversion_graph: ConversionGraph,
) -> tuple[float, list[str]] | None:
    total = 0.0
    notes: list[str] = []
    for requirement in requirements:
        normalized: NormalizedQuantity = requirement["normalized"]
        converted = convert_amount(
            canonical=canonical,
            value=normalized.value,
            from_dimension=normalized.dimension,
            to_dimension=target_dimension,
            graph=conversion_graph,
        )
        if converted is None:
            return None
        converted_value, labels = converted
        total += converted_value
        notes.extend(labels)
    return total, list(dict.fromkeys(notes))


def _select_product(
    *,
    canonical: str,
    requirements: list[dict[str, Any]],
    products: list[dict[str, Any]],
    supplier_order: list[str],
    conversion_graph: ConversionGraph,
    selection_mode: str,
    stale_after_days: float,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    candidates: list[tuple[tuple[float, ...], dict[str, Any], dict[str, Any]]] = []

    for product in products:
        package_amount = _float(_value(product, "Amount Per Package", "Package Amount", "package_amount"))
        package_unit = str(_value(product, "Package Unit", "Unit", "package_unit", default="")).strip()
        pack_count = _float(_value(product, "Pack Count", "Units Per Purchase", "pack_count", default=1)) or 1
        if package_amount is None or not package_unit or pack_count <= 0:
            continue
        try:
            package_q = normalize_quantity(package_amount * pack_count, package_unit)
        except ValueError:
            continue

        converted = _convert_requirements_for_product(
            canonical=canonical,
            requirements=requirements,
            target_dimension=package_q.dimension,
            conversion_graph=conversion_graph,
        )
        if converted is None:
            continue
        required_base, conversion_notes = converted
        if required_base <= 0:
            continue

        recommendation = calculate_packages(required_base, package_q.value)
        price = _float(_value(product, "Price", "price"))
        line_cost = recommendation.purchase_count * price if price is not None else None
        waste_ratio = recommendation.excess_base / required_base
        approved = truthy(_value(product, "Approved", "approved", default=False))
        preference_rank = _float(_value(product, "Preference Rank", "Priority", default=100)) or 100
        retailer = str(_value(product, "Retailer", "Store", default=""))
        stale = _is_stale(product, stale_after_days)

        score = _candidate_score(
            approved=approved,
            preference_rank=preference_rank,
            retailer_rank=_retailer_rank(retailer, supplier_order),
            stale=stale,
            line_cost=line_cost,
            waste_ratio=waste_ratio,
            purchase_count=recommendation.purchase_count,
            selection_mode=selection_mode,
        )
        computed = {
            "purchase_count": recommendation.purchase_count,
            "package_total_base": recommendation.package_total_base,
            "purchased_base": recommendation.purchased_base,
            "excess_base": recommendation.excess_base,
            "required_base": required_base,
            "target_dimension": package_q.dimension,
            "line_cost": line_cost,
            "waste_ratio": waste_ratio,
            "approved": approved,
            "stale": stale,
            "conversion_notes": conversion_notes,
        }
        candidates.append((score, product, computed))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    _, product, computed = candidates[0]
    return product, computed


def _requirement_summary(requirements: list[dict[str, Any]]) -> str:
    totals: dict[str, float] = defaultdict(float)
    for requirement in requirements:
        normalized: NormalizedQuantity = requirement["normalized"]
        totals[normalized.dimension] += normalized.value
    return " + ".join(display_base(value, dimension) for dimension, value in sorted(totals.items()))


def _compound_quantity(raw: str) -> bool:
    return bool(COMPOUND_QUANTITY_RE.search(raw or ""))


def generate_plan(payload: dict[str, Any]) -> dict[str, Any]:
    week = _week_start(str(payload.get("week_start", "")))
    week_end = week + timedelta(days=6)
    all_items = list(payload.get("all_items") or [])
    alias_rows = list(payload.get("ingredient_aliases") or [])
    always_stocked_rows = list(payload.get("always_stocked") or [])
    spice_rows = list(payload.get("spice_inventory") or [])
    override_rows = list(payload.get("weekly_overrides") or [])
    supplier_rows = list(payload.get("supplier_rules") or [])
    catalog_rows = list(payload.get("product_catalog") or [])
    conversion_rows = list(payload.get("ingredient_conversions") or [])
    category_rows = list(payload.get("ingredient_categories") or [])
    settings = payload.get("settings") or {}

    bulk_meat_lb_threshold = _float(settings.get("bulk_meat_lb_threshold")) or 5.0
    bulk_meat_count_threshold = _float(settings.get("bulk_meat_count_threshold")) or 20.0
    include_undated = _bool(settings.get("include_undated_rows"), default=False)
    stale_after_days = _float(settings.get("catalog_stale_after_days")) or 14.0
    selection_mode = str(settings.get("selection_mode") or "balanced")

    # Always Stocked aliases are valid ingredient aliases too.
    alias_map = build_alias_map([*alias_rows, *always_stocked_rows])
    always_stocked = set(DEFAULT_ALWAYS_STOCKED)
    always_stocked.update(_rows_to_name_set(always_stocked_rows, alias_map))
    spices = _rows_to_name_set(spice_rows, alias_map)
    overrides = _override_map(override_rows, week, alias_map)
    conversion_graph = build_conversion_graph(conversion_rows, alias_map)

    excluded: list[dict[str, Any]] = []
    review: list[dict[str, Any]] = []
    grouped: dict[str, dict[str, Any]] = {}
    skipped_undated = 0
    selected_source_rows = 0

    for row in all_items:
        event_date = _parse_date(_value(row, "Event Date", "event_date"))
        if event_date is None:
            skipped_undated += 1
            if include_undated:
                review.append({
                    "ingredient": _value(row, "Ingredient", default=""),
                    "lead": _value(row, "Lead", default=""),
                    "reason": "Event Date could not be parsed",
                    "source": f"{_value(row, 'Source Sheet', default='')}!{_value(row, 'Source Row', default='')}",
                })
            continue
        if not (week <= event_date <= week_end):
            continue
        selected_source_rows += 1

        ingredient_raw = str(_value(row, "Ingredient", default="")).strip()
        canonicalization = canonicalize(ingredient_raw, alias_map)
        canonical = canonicalization.canonical
        if not canonical:
            review.append({"ingredient": ingredient_raw, "lead": _value(row, "Lead", default=""), "reason": "Blank ingredient"})
            continue

        qty_low = _float(_value(row, "Parsed Low", "parsed_low"))
        qty_high = _float(_value(row, "Parsed High", "parsed_high"))
        quantity = qty_high if qty_high is not None else qty_low
        unit = str(_value(row, "Unit", "unit", default="")).strip()
        quantity_raw = str(_value(row, "Quantity (raw)", "quantity_raw", default="")).strip()
        quantity_quality = clean_text(_value(row, "Quantity Quality", "quantity_quality", default=""))
        force_buy = overrides.get(canonical) in {"buy", "purchase", "force buy", "actually need this"}
        force_ignore = overrides.get(canonical) in {"ignore", "stocked", "we have"}

        attribution = {
            "lead": str(_value(row, "Lead", default="")).strip(),
            "event": str(_value(row, "Event", default="")).strip(),
            "dish": str(_value(row, "Dish", default="")).strip(),
            "quantity_raw": quantity_raw,
            "source": f"{_value(row, 'Source Sheet', default='')}!{_value(row, 'Source Row', default='')}",
            "source_supplier": str(_value(row, "Supplier", default="")).strip(),
        }

        if force_ignore:
            excluded.append({
                "ingredient": canonical,
                "quantity": quantity_raw,
                "bucket": "assumed stocked",
                "reason": "weekly ignore override",
                **attribution,
            })
            continue

        decision = evaluate_exclusion(
            canonical=canonical,
            quantity=quantity,
            unit=unit,
            status=_value(row, "Status", default=""),
            action=_value(row, "Action", default=""),
            arrived=_value(row, "Arrived", default=False),
            always_stocked=always_stocked,
            spice_inventory=spices,
            force_buy=force_buy,
            bulk_meat_lb_threshold=bulk_meat_lb_threshold,
            bulk_meat_count_threshold=bulk_meat_count_threshold,
        )

        if decision.excluded:
            excluded.append({
                "ingredient": canonical,
                "quantity": quantity_raw,
                "bucket": decision.bucket,
                "reason": decision.reason,
                **attribution,
            })
            continue

        if quantity_quality in {"missing", "ambiguous"} or quantity is None or not unit:
            review.append({
                "ingredient": canonical,
                "lead": attribution["lead"],
                "quantity_raw": quantity_raw,
                "reason": "Quantity or unit is missing/ambiguous",
                "source": attribution["source"],
            })
            continue
        if _compound_quantity(quantity_raw):
            review.append({
                "ingredient": canonical,
                "lead": attribution["lead"],
                "quantity_raw": quantity_raw,
                "reason": "Compound quantity should be confirmed before ordering",
                "source": attribution["source"],
            })
            continue

        try:
            normalized = normalize_quantity(quantity, unit)
        except ValueError as exc:
            review.append({
                "ingredient": canonical,
                "lead": attribution["lead"],
                "quantity_raw": quantity_raw,
                "reason": str(exc),
                "source": attribution["source"],
            })
            continue

        if canonical not in grouped:
            grouped[canonical] = {
                "canonical": canonical,
                "requirements": [],
                "canonical_confidence": canonicalization.confidence,
                "has_approximate": False,
            }
        if canonicalization.confidence != "high":
            grouped[canonical]["canonical_confidence"] = "medium"
        if quantity_quality in {"approximate", "range"}:
            grouped[canonical]["has_approximate"] = True
        grouped[canonical]["requirements"].append({
            "normalized": normalized,
            "attribution": {
                **attribution,
                "normalized_amount": display_base(normalized.value, normalized.dimension),
            },
        })

    classifications = classify_ingredients(grouped.keys(), category_rows, alias_map)
    recommendations: list[dict[str, Any]] = []

    for canonical, group in sorted(grouped.items()):
        classification = classifications.get(canonical)
        requirements = group["requirements"]
        products = _catalog_products(canonical, catalog_rows, alias_map)
        supplier_order = _supplier_order(canonical, supplier_rows, alias_map, classification)
        selected = _select_product(
            canonical=canonical,
            requirements=requirements,
            products=products,
            supplier_order=supplier_order,
            conversion_graph=conversion_graph,
            selection_mode=selection_mode,
            stale_after_days=stale_after_days,
        )
        attributions = [item["attribution"] for item in requirements]
        original_summary = _requirement_summary(requirements)

        if not selected:
            review.append({
                "ingredient": canonical,
                "lead": ", ".join(sorted({a["lead"] for a in attributions if a["lead"]})),
                "quantity_raw": original_summary,
                "reason": "No compatible active catalog product; add or approve one in Product Catalog",
                "source": "; ".join(a["source"] for a in attributions),
                "search_hint": canonical,
                "preferred_retailers": ", ".join(supplier_order),
                "category": classification.category if classification else "unknown",
                "category_confidence": classification.confidence if classification else "low",
                "category_reason": classification.reason if classification else "No classification available",
                "classification_source": classification.source if classification else "none",
            })
            continue

        product, computed = selected
        retailer = str(_value(product, "Retailer", "Store", default="")).strip()
        product_name = str(_value(product, "Product Name", "Exact Product", "Title", default="")).strip()
        product_key = str(_value(product, "Product ID", "SKU", "UPC", "Product URL", default=product_name))
        purchase_unit = str(_value(product, "Purchase Unit", default="unit")).strip() or "unit"
        package_amount = _float(_value(product, "Amount Per Package", "Package Amount", default=0)) or 0
        package_unit = str(_value(product, "Package Unit", "Unit", default="")).strip()
        pack_count = _float(_value(product, "Pack Count", "Units Per Purchase", default=1)) or 1
        package_description = (
            f"{pack_count:g} × {package_amount:g} {package_unit}"
            if pack_count != 1
            else f"{package_amount:g} {package_unit}"
        )
        heads = sorted({a["lead"] for a in attributions if a["lead"]})
        attr_display = "; ".join(
            f"{a['lead'] or 'Unknown'} — {a['normalized_amount']} — {a['dish'] or a['event']}"
            for a in attributions
        )

        approved = computed["approved"]
        confidence = "high"
        confidence_reasons: list[str] = []
        if not approved:
            confidence = "medium"
            confidence_reasons.append("product not marked approved")
        if group["canonical_confidence"] != "high":
            confidence = "medium"
            confidence_reasons.append("ingredient alias not yet explicitly approved")
        if group["has_approximate"]:
            confidence = "medium"
            confidence_reasons.append("source quantity is approximate")
        if computed["stale"]:
            confidence = "medium"
            confidence_reasons.append("catalog availability/price check is stale")
        product_notes = clean_text(_value(product, "Notes", "notes", default=""))
        if "daylight public catalog" in product_notes or "daylight_public_catalog" in product_notes:
            confidence = "medium"
            confidence_reasons.append("Daylight public catalog does not confirm account price or live availability")

        reason = "compatible package; quantity rounded up to a whole purchasable unit"
        if confidence_reasons:
            reason += "; " + "; ".join(confidence_reasons)

        conversion_note = "; ".join(computed["conversion_notes"])
        last_checked = _last_checked(product)

        recommendations.append({
            "stable_id": _stable_id(week, canonical, computed["target_dimension"], product_key),
            "store": retailer,
            "ingredient": canonical,
            "exact_product": product_name,
            "buy_quantity": computed["purchase_count"],
            "purchase_unit": purchase_unit,
            "package_size": package_description,
            "needed": display_base(computed["required_base"], computed["target_dimension"]),
            "original_needed": original_summary if conversion_note else "",
            "purchased": display_base(computed["purchased_base"], computed["target_dimension"]),
            "excess": display_base(computed["excess_base"], computed["target_dimension"]),
            "estimated_total": computed["line_cost"],
            "head_cooks": ", ".join(heads),
            "attribution": attr_display,
            "product_url": str(_value(product, "Product URL", "URL", default="")).strip(),
            "upc": str(_value(product, "UPC", default="")).strip(),
            "product_id": str(_value(product, "Product ID", default="")).strip(),
            "confidence": confidence,
            "reason": reason,
            "conversion_note": conversion_note,
            "last_checked": last_checked.isoformat() if last_checked else "",
            "preferred_retailers": ", ".join(supplier_order),
            "category": classification.category if classification else "unknown",
            "category_confidence": classification.confidence if classification else "low",
            "category_reason": classification.reason if classification else "No classification available",
            "classification_source": classification.source if classification else "none",
        })

    return {
        "week_start": week.isoformat(),
        "week_end": week_end.isoformat(),
        "recommendations": recommendations,
        "excluded": excluded,
        "review": review,
        "summary": {
            "recommendation_count": len(recommendations),
            "excluded_count": len(excluded),
            "review_count": len(review),
            "selected_source_rows": selected_source_rows,
            "skipped_undated_rows": skipped_undated,
            "classified_ingredient_count": len(classifications),
            "produce_ingredient_count": sum(1 for item in classifications.values() if item.category == "produce"),
            "ai_classification_count": sum(1 for item in classifications.values() if item.source == "ai"),
        },
    }
