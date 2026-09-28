from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Iterable

import httpx

from .normalization import canonicalize, clean_text


CATEGORY_ROUTES: dict[str, tuple[str, ...]] = {
    "produce": ("Daylight", "Costco Same-Day", "Instacart"),
    "asian_specialty": ("Weee", "Instacart", "Costco Same-Day"),
    "dairy_refrigerated": ("Costco Same-Day", "Instacart"),
    "frozen": ("Costco Same-Day", "Weee", "Instacart"),
    "meat_seafood": ("Costco Same-Day", "Instacart"),
    "bakery": ("Costco Same-Day", "Instacart"),
    "non_food": ("Costco Same-Day", "Instacart"),
    "general_grocery": ("Costco Same-Day", "Instacart", "Weee"),
    "unknown": ("Costco Same-Day", "Instacart", "Daylight"),
}

VALID_CATEGORIES = set(CATEGORY_ROUTES)
VALID_CONFIDENCE = {"high", "medium", "low"}


@dataclass(frozen=True)
class IngredientClassification:
    category: str
    confidence: str
    reason: str
    preferred_retailers: tuple[str, ...]
    source: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "confidence": self.confidence,
            "reason": self.reason,
            "preferred_retailers": list(self.preferred_retailers),
            "source": self.source,
        }


# These are intentionally ingredient-level terms, not recipe or cuisine labels.
FRESH_PRODUCE_TERMS = {
    # fruit
    "apple", "apples", "apricot", "apricots", "avocado", "avocados", "banana", "bananas",
    "berry", "berries", "blackberry", "blackberries", "blueberry", "blueberries",
    "boysenberry", "boysenberries", "cantaloupe", "cherry", "cherries", "coconut", "cranberry",
    "cranberries", "date", "dates", "fig", "figs", "grape", "grapes", "grapefruit", "guava",
    "kiwi", "lemon", "lemons", "lime", "limes", "mango", "mangoes", "melon", "nectarine",
    "nectarines", "orange", "oranges", "papaya", "peach", "peaches", "pear", "pears",
    "persimmon", "persimmons", "pineapple", "pineapples", "plantain", "plantains", "plum",
    "plums", "pomegranate", "raspberry", "raspberries", "strawberry", "strawberries",
    "tangerine", "tangerines", "watermelon",
    # vegetables, aromatics, greens, mushrooms
    "artichoke", "artichokes", "arugula", "asparagus", "beet", "beets", "bok choy", "broccoli",
    "broccolini", "brussels sprout", "brussels sprouts", "cabbage", "carrot", "carrots", "cassava",
    "cauliflower", "celery", "chard", "chayote", "cucumber", "cucumbers", "daikon", "eggplant",
    "eggplants", "endive", "fennel", "garlic", "ginger", "green bean", "green beans", "jicama",
    "kale", "leek", "leeks", "lettuce", "mushroom", "mushrooms", "nopales", "cactus", "okra",
    "onion", "onions", "parsnip", "parsnips", "pepper", "peppers", "potato", "potatoes",
    "pumpkin", "radish", "radishes", "romaine", "rutabaga", "scallion", "scallions", "shallot",
    "shallots", "snap peas", "snow peas", "spinach", "sprouts", "squash", "sweet potato",
    "sweet potatoes", "taro", "tomatillo", "tomatillos", "tomato", "tomatoes", "turnip", "turnips",
    "watercress", "yam", "yams", "zucchini",
    # fresh herbs
    "basil", "chives", "cilantro", "dill", "mint", "oregano", "parsley", "rosemary", "sage",
    "tarragon", "thyme",
}

ASIAN_SPECIALTY_TERMS = {
    "black bean sauce", "black vinegar", "bonito flakes", "chili crisp", "chilli crisp", "chinkiang vinegar",
    "chinese sausage", "curry roux", "dashi", "doenjang", "doubanjiang", "douchi", "dumpling",
    "dumplings", "edamame", "fish sauce", "furikake", "gochujang", "gyoza", "hoisin", "kimchi",
    "kombu", "mirin", "miso", "nori", "oyster sauce", "panko", "pickled mustard greens", "ponzu",
    "rice cake", "rice cakes", "rice noodles", "rice vinegar", "sesame oil", "shaoxing",
    "sichuan peppercorn", "sichuan peppercorns", "soba", "tamari", "tempeh", "tofu", "udon",
    "wakame", "wonton", "wontons", "yuba",
}

MEAT_SEAFOOD_TERMS = {
    "beef", "brisket", "chicken", "clam", "clams", "cod", "crab", "duck", "fish", "halibut",
    "ham", "lamb", "lobster", "meat", "mussel", "mussels", "pork", "salmon", "sausage", "shrimp",
    "steak", "tilapia", "trout", "tuna", "turkey",
}

DAIRY_REFRIGERATED_TERMS = {
    "buttermilk", "cheese", "cream", "creme fraiche", "egg", "eggs", "half and half", "milk",
    "mozzarella", "parmesan", "ricotta", "sour cream", "yogurt",
}

BAKERY_TERMS = {
    "bagel", "bagels", "bread", "brioche", "bun", "buns", "croissant", "croissants", "flatbread",
    "lavash", "naan", "pita", "roll", "rolls", "tortilla", "tortillas",
}

NON_FOOD_TERMS = {
    "aluminum foil", "foil", "napkin", "napkins", "paper towel", "paper towels", "parchment",
    "plastic wrap", "skewer", "skewers", "toothpick", "toothpicks", "trash bag", "trash bags",
}

FROZEN_MARKERS = {"frozen", "freezer"}
PROCESSED_MARKERS = {
    "canned", "can of", "jarred", "bottled", "dried", "dehydrated", "freeze dried", "pickled",
    "powder", "powdered", "paste", "puree", "purée", "sauce", "juice", "concentrate", "broth",
    "stock", "wine", "vinegar", "oil", "syrup", "jam", "jelly", "preserves",
}
FRESH_MARKERS = {"fresh", "whole", "raw", "bunch", "head", "heads", "sprig", "sprigs"}


def _contains_phrase(text: str, phrases: Iterable[str]) -> str | None:
    padded = f" {text} "
    for phrase in sorted(phrases, key=len, reverse=True):
        if f" {phrase} " in padded or text == phrase:
            return phrase
    return None


def _route(category: str) -> tuple[str, ...]:
    return CATEGORY_ROUTES.get(category, CATEGORY_ROUTES["unknown"])


def _classification(category: str, confidence: str, reason: str, source: str = "rules") -> IngredientClassification:
    return IngredientClassification(category, confidence, reason, _route(category), source)


def classify_local(ingredient: str) -> IngredientClassification:
    text = clean_text(ingredient)
    if not text:
        return _classification("unknown", "low", "blank ingredient")

    phrase = _contains_phrase(text, NON_FOOD_TERMS)
    if phrase:
        return _classification("non_food", "high", f"matched non-food term: {phrase}")

    phrase = _contains_phrase(text, MEAT_SEAFOOD_TERMS)
    if phrase:
        return _classification("meat_seafood", "high", f"matched meat/seafood term: {phrase}")

    phrase = _contains_phrase(text, ASIAN_SPECIALTY_TERMS)
    if phrase:
        return _classification("asian_specialty", "high", f"matched Asian specialty term: {phrase}")

    if any(marker in text for marker in FROZEN_MARKERS):
        return _classification("frozen", "high", "ingredient is explicitly frozen")

    phrase = _contains_phrase(text, DAIRY_REFRIGERATED_TERMS)
    if phrase:
        return _classification("dairy_refrigerated", "high", f"matched dairy/refrigerated term: {phrase}")

    phrase = _contains_phrase(text, BAKERY_TERMS)
    if phrase:
        return _classification("bakery", "high", f"matched bakery term: {phrase}")

    produce_phrase = _contains_phrase(text, FRESH_PRODUCE_TERMS)
    processed_phrase = next((marker for marker in PROCESSED_MARKERS if marker in text), None)
    if produce_phrase and not processed_phrase:
        confidence = "high" if any(marker in text for marker in FRESH_MARKERS) or text == produce_phrase else "medium"
        return _classification("produce", confidence, f"matched fresh produce term: {produce_phrase}")
    if produce_phrase and processed_phrase:
        return _classification(
            "general_grocery",
            "high",
            f"contains produce term {produce_phrase!r}, but is processed ({processed_phrase})",
        )

    # Common generic pantry and packaged-food indicators.
    if any(marker in text for marker in PROCESSED_MARKERS):
        return _classification("general_grocery", "medium", "matched packaged or processed grocery wording")

    return _classification("unknown", "low", "no high-confidence category rule matched")


def _parse_retailers(value: Any, category: str) -> tuple[str, ...]:
    text = str(value or "").strip()
    if not text:
        return _route(category)
    values = tuple(part.strip() for part in re.split(r"[;|,]", text) if part.strip())
    return values or _route(category)


def _manual_classifications(
    rows: list[dict[str, Any]],
    alias_map: dict[str, str],
) -> dict[str, IngredientClassification]:
    result: dict[str, IngredientClassification] = {}
    for row in rows:
        active = str(row.get("Active", True)).strip().lower()
        if active in {"false", "0", "no", "n", "out"}:
            continue
        raw = row.get("Canonical Item") or row.get("Ingredient") or row.get("Item")
        if not raw:
            continue
        canonical = canonicalize(str(raw), alias_map).canonical
        category = clean_text(row.get("Category") or row.get("Type") or "unknown").replace(" ", "_")
        if category not in VALID_CATEGORIES:
            category = "unknown"
        retailers = _parse_retailers(row.get("Preferred Retailers") or row.get("Retailers"), category)
        notes = str(row.get("Notes") or "manual category override").strip()
        result[canonical] = IngredientClassification(
            category=category,
            confidence="high",
            reason=notes or "manual category override",
            preferred_retailers=retailers,
            source="manual",
        )
    return result


def _extract_response_text(data: dict[str, Any]) -> str:
    direct = data.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct
    for item in data.get("output") or []:
        for content in item.get("content") or []:
            if content.get("type") == "output_text" and content.get("text"):
                return str(content["text"])
    return ""


def _ai_enabled() -> bool:
    enabled = os.getenv("OPENAI_CLASSIFIER_ENABLED", "true").strip().lower()
    return enabled not in {"false", "0", "no", "off"} and bool(os.getenv("OPENAI_API_KEY", "").strip())


def _classify_with_openai(items: list[str]) -> dict[str, IngredientClassification]:
    if not items or not _ai_enabled():
        return {}

    model = os.getenv("OPENAI_CLASSIFIER_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"
    timeout = float(os.getenv("OPENAI_CLASSIFIER_TIMEOUT_SECONDS", "20"))
    api_key = os.environ["OPENAI_API_KEY"].strip()
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["items"],
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["ingredient", "category", "confidence", "reason"],
                    "properties": {
                        "ingredient": {"type": "string"},
                        "category": {"type": "string", "enum": sorted(VALID_CATEGORIES)},
                        "confidence": {"type": "string", "enum": sorted(VALID_CONFIDENCE)},
                        "reason": {"type": "string"},
                    },
                },
            }
        },
    }
    instructions = (
        "Classify grocery ingredient names for a residential kitchen purchasing workflow. "
        "Use produce only for fresh/raw fruit, vegetables, mushrooms, aromatics, and fresh herbs. "
        "Frozen, canned, dried, pickled, bottled, juiced, powdered, pasted, sauced, or otherwise processed versions are not produce. "
        "Use asian_specialty for distinctly Asian pantry/refrigerated products such as tofu, miso, gochujang, nori, or Shaoxing wine. "
        "Return one result for every input ingredient, preserving the exact ingredient string."
    )
    payload = {
        "model": model,
        "store": False,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": instructions}]},
            {
                "role": "user",
                "content": [{"type": "input_text", "text": json.dumps({"ingredients": items})}],
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "ingredient_classifications",
                "strict": True,
                "schema": schema,
            }
        },
        "max_output_tokens": 1800,
    }

    try:
        response = httpx.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=timeout,
        )
        response.raise_for_status()
        parsed = json.loads(_extract_response_text(response.json()))
    except (httpx.HTTPError, ValueError, TypeError, json.JSONDecodeError):
        return {}

    result: dict[str, IngredientClassification] = {}
    requested = {clean_text(item): item for item in items}
    for item in parsed.get("items") or []:
        ingredient = clean_text(item.get("ingredient"))
        if ingredient not in requested:
            continue
        category = clean_text(item.get("category")).replace(" ", "_")
        confidence = clean_text(item.get("confidence"))
        if category not in VALID_CATEGORIES or confidence not in VALID_CONFIDENCE:
            continue
        result[ingredient] = IngredientClassification(
            category=category,
            confidence=confidence,
            reason=str(item.get("reason") or "AI classification").strip(),
            preferred_retailers=_route(category),
            source="ai",
        )
    return result


def classify_ingredients(
    ingredients: Iterable[str],
    override_rows: list[dict[str, Any]],
    alias_map: dict[str, str],
) -> dict[str, IngredientClassification]:
    manual = _manual_classifications(override_rows, alias_map)
    result: dict[str, IngredientClassification] = {}
    unresolved_for_ai: list[str] = []

    for raw in ingredients:
        canonical = canonicalize(str(raw), alias_map).canonical
        if not canonical:
            continue
        if canonical in manual:
            result[canonical] = manual[canonical]
            continue
        local = classify_local(canonical)
        result[canonical] = local
        if local.confidence == "low" or local.category == "unknown":
            unresolved_for_ai.append(canonical)

    ai_results = _classify_with_openai(sorted(set(unresolved_for_ai)))
    for canonical, ai_result in ai_results.items():
        result[canonical] = ai_result
    return result
