from __future__ import annotations

from dataclasses import dataclass
from math import ceil, isclose
from typing import Final


@dataclass(frozen=True)
class NormalizedQuantity:
    value: float
    dimension: str
    base_unit: str


MASS_TO_OZ: Final[dict[str, float]] = {
    "oz": 1.0,
    "lb": 16.0,
    "g": 0.0352739619,
    "kg": 35.2739619,
}

VOLUME_TO_TSP: Final[dict[str, float]] = {
    "tsp": 1.0,
    "tbsp": 3.0,
    "fl oz": 6.0,
    "cup": 48.0,
    "pint": 96.0,
    "quart": 192.0,
    "gallon": 768.0,
    "ml": 0.202884136,
    "l": 202.884136,
}

UNIT_ALIASES: Final[dict[str, str]] = {
    # Mass
    "ounce": "oz",
    "ounces": "oz",
    "ozs": "oz",
    "pound": "lb",
    "pounds": "lb",
    "lbs": "lb",
    "gram": "g",
    "grams": "g",
    "gs": "g",
    "kilogram": "kg",
    "kilograms": "kg",
    "kgs": "kg",
    # Volume
    "teaspoon": "tsp",
    "teaspoons": "tsp",
    "ts": "tsp",
    "tspn": "tsp",
    "tablespoon": "tbsp",
    "tablespoons": "tbsp",
    "tbs": "tbsp",
    "tb": "tbsp",
    "cup": "cup",
    "cups": "cup",
    "c": "cup",
    "fluid ounce": "fl oz",
    "fluid ounces": "fl oz",
    "floz": "fl oz",
    "pints": "pint",
    "pt": "pint",
    "pts": "pint",
    "quarts": "quart",
    "qt": "quart",
    "qts": "quart",
    "gallons": "gallon",
    "gal": "gallon",
    "gals": "gallon",
    "milliliter": "ml",
    "milliliters": "ml",
    "millilitre": "ml",
    "millilitres": "ml",
    "mls": "ml",
    "liter": "l",
    "liters": "l",
    "litre": "l",
    "litres": "l",
    # Generic count
    "count": "each",
    "counts": "each",
    "ea": "each",
    "unit": "each",
    "units": "each",
    "whole": "each",
    "piece": "each",
    "pieces": "each",
    "carrot": "each",
    "carrots": "each",
    "pad": "each",
    "pads": "each",
    "paddle": "each",
    "paddles": "each",
    "ear": "each",
    "ears": "each",
    "medium": "each",
    "large": "each",
    "small": "each",
    # Specific count units
    "heads": "head",
    "cloves": "clove",
    "bunches": "bunch",
    "cans": "can",
    "bags": "bag",
    "bottles": "bottle",
    "boxes": "box",
    "packs": "package",
    "pack": "package",
    "packages": "package",
    "packet": "package",
    "packets": "package",
    "jars": "jar",
    "sprigs": "sprig",
    "trays": "tray",
    "tubs": "tub",
    "cartons": "carton",
    "loaves": "loaf",
}

COUNT_UNITS: Final[set[str]] = {
    "each",
    "head",
    "clove",
    "bunch",
    "can",
    "bag",
    "bottle",
    "box",
    "package",
    "jar",
    "sprig",
    "tray",
    "tub",
    "carton",
    "loaf",
}


def normalize_unit(unit: str | None) -> str:
    if not unit:
        return ""
    value = " ".join(str(unit).strip().lower().replace(".", "").split())
    return UNIT_ALIASES.get(value, value)


def normalize_quantity(value: float, unit: str) -> NormalizedQuantity:
    normalized_unit = normalize_unit(unit)
    if normalized_unit == "dozen":
        return NormalizedQuantity(value * 12.0, "count:each", "each")
    if normalized_unit in MASS_TO_OZ:
        return NormalizedQuantity(value * MASS_TO_OZ[normalized_unit], "mass", "oz")
    if normalized_unit in VOLUME_TO_TSP:
        return NormalizedQuantity(value * VOLUME_TO_TSP[normalized_unit], "volume", "tsp")
    if normalized_unit in COUNT_UNITS:
        return NormalizedQuantity(value, f"count:{normalized_unit}", normalized_unit)
    raise ValueError(f"Unsupported unit: {unit!r}")


@dataclass(frozen=True)
class PackageRecommendation:
    purchase_count: int
    package_total_base: float
    purchased_base: float
    excess_base: float


def calculate_packages(required_base: float, package_total_base: float) -> PackageRecommendation:
    if required_base <= 0:
        raise ValueError("required_base must be positive")
    if package_total_base <= 0:
        raise ValueError("package_total_base must be positive")

    purchase_count = ceil(required_base / package_total_base - 1e-12)
    purchased_base = purchase_count * package_total_base
    excess_base = max(0.0, purchased_base - required_base)
    return PackageRecommendation(
        purchase_count=purchase_count,
        package_total_base=package_total_base,
        purchased_base=purchased_base,
        excess_base=excess_base,
    )


def _fmt(value: float) -> str:
    if isclose(value, round(value), abs_tol=1e-9):
        return str(int(round(value)))
    return f"{value:.2f}".rstrip("0").rstrip(".")


def display_base(value: float, dimension: str) -> str:
    if dimension == "mass":
        if value >= 16:
            pounds = int(value // 16)
            ounces = value - pounds * 16
            if isclose(ounces, 0.0, abs_tol=1e-9):
                return f"{_fmt(value / 16)} lb"
            return f"{pounds} lb {_fmt(ounces)} oz"
        return f"{_fmt(value)} oz"
    if dimension == "volume":
        if value >= 48 and isclose(value % 48, 0.0, abs_tol=1e-9):
            return f"{_fmt(value / 48)} cups"
        if value >= 3 and isclose(value % 3, 0.0, abs_tol=1e-9):
            return f"{_fmt(value / 3)} tbsp"
        return f"{_fmt(value)} tsp"
    if dimension.startswith("count:"):
        unit = dimension.split(":", 1)[1]
        return f"{_fmt(value)} {unit}"
    return _fmt(value)
