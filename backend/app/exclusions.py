from __future__ import annotations

from dataclasses import dataclass

from .normalization import clean_text
from .package_math import normalize_quantity


DEFAULT_ALWAYS_STOCKED = {
    "soy sauce",
    "butter",
    "maple syrup",
    "rice",
    "pasta",
    "oats",
    "sugar",
    "salt",
    "black pepper",
    "flour",
    "baking soda",
}

MEAT_TERMS = {
    "beef",
    "steak",
    "chicken",
    "turkey",
    "pork",
    "lamb",
    "goat",
    "fish",
    "salmon",
    "tilapia",
    "shrimp",
    "prawn",
    "sausage",
    "bacon",
    "ham",
    "meat",
}

NON_MEAT_QUALIFIERS = {
    "vegan",
    "vegetarian",
    "plant-based",
    "plant",
    "meatless",
    "mock",
    "impossible",
    "beyond",
    "tofu",
    "tempeh",
    "seitan",
}


@dataclass(frozen=True)
class ExclusionDecision:
    excluded: bool
    bucket: str
    reason: str


def truthy(value: object) -> bool:
    return str(value or "").strip().lower() in {"true", "yes", "y", "1", "checked"}


def contains_meat_term(canonical: str) -> bool:
    normalized = clean_text(canonical).replace("-", " ")
    tokens = set(normalized.split())
    if tokens & NON_MEAT_QUALIFIERS:
        return False
    return bool(tokens & MEAT_TERMS)


def evaluate_exclusion(
    *,
    canonical: str,
    quantity: float | None,
    unit: str | None,
    status: str | None,
    action: str | None,
    arrived: object,
    always_stocked: set[str],
    spice_inventory: set[str],
    force_buy: bool,
    bulk_meat_lb_threshold: float,
    bulk_meat_count_threshold: float,
) -> ExclusionDecision:
    if force_buy:
        return ExclusionDecision(False, "purchase", "weekly force-buy override")

    status_text = clean_text(status)
    action_text = clean_text(action)

    if truthy(arrived) or status_text == "received" or action_text == "received":
        return ExclusionDecision(True, "already fulfilled", "marked received/arrived in source sheet")

    if action_text == "await delivery" or status_text == "ordered":
        return ExclusionDecision(True, "awaiting delivery", "already ordered")

    if canonical in always_stocked:
        return ExclusionDecision(True, "assumed stocked", "always-stocked pantry rule")

    if canonical in spice_inventory:
        return ExclusionDecision(True, "assumed stocked", "listed in linked spice inventory")

    if status_text in {"we have", "in stock"} or action_text == "in stock":
        return ExclusionDecision(True, "assumed stocked", "source row says We Have/In stock")

    if contains_meat_term(canonical) and quantity is not None and unit:
        try:
            normalized = normalize_quantity(quantity, unit)
            if normalized.dimension == "mass" and normalized.value >= bulk_meat_lb_threshold * 16:
                return ExclusionDecision(
                    True,
                    "separate meat supplier",
                    f"bulk meat at or above {bulk_meat_lb_threshold:g} lb",
                )
            if normalized.dimension.startswith("count:") and normalized.value >= bulk_meat_count_threshold:
                return ExclusionDecision(
                    True,
                    "separate meat supplier",
                    f"bulk meat at or above {bulk_meat_count_threshold:g} count/packages",
                )
        except ValueError:
            pass

    return ExclusionDecision(False, "purchase", "not excluded")
