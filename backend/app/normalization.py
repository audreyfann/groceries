from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable


DEFAULT_ALIASES: dict[str, str] = {
    "ap flour": "flour",
    "all purpose flour": "flour",
    "all-purpose flour": "flour",
    "plain flour": "flour",
    "bicarbonate of soda": "baking soda",
    "sodium bicarbonate": "baking soda",
    "salted butter": "butter",
    "unsalted butter": "butter",
    "granulated sugar": "sugar",
    "white sugar": "sugar",
    "table salt": "salt",
    "kosher salt": "salt",
    "sea salt": "salt",
    "ground black pepper": "black pepper",
    "pepper": "black pepper",
    "peppercorns": "black pepper",
    "black peppercorns": "black pepper",
    "soy sauce or tamari": "soy sauce",
    "garlic cloves": "garlic",
    "cloves garlic": "garlic",
    "cloves of garlic": "garlic",
    "garlic clove": "garlic",
    "green onion": "green onions",
    "scallions": "green onions",
    "spring onions": "green onions",
}

LEADING_QUANTITY_RE = re.compile(
    r"^\s*(?:\d+(?:\.\d+)?|\d+\s*/\s*\d+|[¼½¾⅓⅔⅛⅜⅝⅞])?\s*"
    r"(?:teaspoons?|tsp|tablespoons?|tbsp|cups?|ounces?|oz|pounds?|lbs?|lb|grams?|g|kilograms?|kg)\s+",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Canonicalization:
    canonical: str
    normalized_input: str
    confidence: str
    reason: str


def clean_text(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower().strip()
    text = LEADING_QUANTITY_RE.sub("", text)
    text = text.split(",", 1)[0]
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"[^a-z0-9&+\-/ ]+", " ", text)
    text = " ".join(text.split())
    return text


def build_alias_map(rows: Iterable[dict]) -> dict[str, str]:
    aliases = {clean_text(k): clean_text(v) for k, v in DEFAULT_ALIASES.items()}
    for row in rows:
        active = str(row.get("Active", row.get("active", "TRUE"))).strip().lower()
        if active in {"false", "0", "no", "n"}:
            continue
        canonical = clean_text(row.get("Canonical Item") or row.get("Canonical") or row.get("canonical"))
        if not canonical:
            continue
        aliases[canonical] = canonical
        raw_aliases = row.get("Aliases") or row.get("aliases") or ""
        for alias in re.split(r"[;|\n]", str(raw_aliases)):
            alias = clean_text(alias)
            if alias:
                aliases[alias] = canonical
    return aliases


def canonicalize(value: str | None, alias_map: dict[str, str]) -> Canonicalization:
    normalized = clean_text(value)
    if not normalized:
        return Canonicalization("", "", "low", "blank ingredient")
    if normalized in alias_map:
        canonical = alias_map[normalized]
        return Canonicalization(canonical, normalized, "high", "exact alias match")

    # Conservative singular fallback. It never performs fuzzy automatic merging.
    if normalized.endswith("s") and normalized[:-1] in alias_map:
        canonical = alias_map[normalized[:-1]]
        return Canonicalization(canonical, normalized, "medium", "simple singular alias match")

    return Canonicalization(normalized, normalized, "medium", "normalized text; not yet approved as an alias")
