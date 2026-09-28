from __future__ import annotations

import asyncio
import html
import json
import os
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from math import ceil
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup

from .package_math import NormalizedQuantity, display_base, normalize_quantity, normalize_unit

DAYLIGHT_DEFAULT_CATALOG_URL = "https://daylightfoods.com/catalog/"
DAYLIGHT_DEFAULT_USER_AGENT = (
    "HammGroceryPlanner/0.3 (+public Daylight catalog lookup; "
    "contact: https://daylightfoods.com/)"
)

PRODUCT_LINK_RE = re.compile(r"/product/", re.IGNORECASE)
UOM_RE = re.compile(r"\bUOM\s*:\s*([A-Z0-9#-]+(?:\s*LB)?)", re.IGNORECASE)
PAGE_RE = re.compile(r"/catalog/page/(\d+)/?", re.IGNORECASE)
SPACE_RE = re.compile(r"\s+")
NON_WORD_RE = re.compile(r"[^a-z0-9]+")

# Words that do not materially identify a product when matching a recipe ingredient.
MATCH_STOP_WORDS = {
    "fresh",
    "whole",
    "large",
    "medium",
    "small",
    "chopped",
    "chop",
    "minced",
    "mince",
    "sliced",
    "slice",
    "diced",
    "dice",
    "peeled",
    "peel",
    "rinsed",
    "drained",
    "optional",
    "about",
    "approximately",
    "approx",
    "worth",
    "for",
    "the",
    "and",
    "or",
}

# These modifiers materially change what a shopper receives. A mismatch lowers ranking.
PROCESS_QUALIFIERS = {
    "frozen",
    "dried",
    "dry",
    "canned",
    "juice",
    "puree",
    "powder",
    "ground",
    "sliced",
    "diced",
    "chopped",
    "peeled",
    "shredded",
    "roasted",
    "salted",
    "unsalted",
    "organic",
    "fresh",
}

SYNONYM_PHRASES = {
    "scallions": "green onions",
    "scallion": "green onion",
    "spring onions": "green onions",
    "spring onion": "green onion",
    "coriander leaves": "cilantro",
    "coriander leaf": "cilantro",
    "garbanzo beans": "chickpeas",
    "garbanzo bean": "chickpea",
    "aubergine": "eggplant",
    "courgette": "zucchini",
    "capsicum": "bell pepper",
}

UNIT_TOKEN_MAP = {
    "LB": "lb",
    "LBS": "lb",
    "POUND": "lb",
    "POUNDS": "lb",
    "OZ": "oz",
    "OUNCE": "oz",
    "OUNCES": "oz",
    "KG": "kg",
    "KGS": "kg",
    "G": "g",
    "GRAM": "g",
    "GRAMS": "g",
    "CT": "each",
    "COUNT": "each",
    "EA": "each",
    "EACH": "each",
    "UNIT": "each",
    "UNITS": "each",
    "GAL": "gallon",
    "GALLON": "gallon",
    "QT": "quart",
    "QUART": "quart",
    "PT": "pint",
    "PINT": "pint",
    "L": "l",
    "LTR": "l",
    "LITER": "l",
    "ML": "ml",
}

PURCHASE_UNIT_MAP = {
    "CASE": "case",
    "EACH": "each",
    "EA": "each",
    "LBS": "lb",
    "LB": "lb",
    "SACK": "sack",
    "TRAY": "tray",
    "BOX": "box",
    "BAG": "bag",
    "PKG": "package",
    "PACKAGE": "package",
    "HC": "case",
}


@dataclass(frozen=True)
class DaylightProduct:
    product_name: str
    product_url: str
    uom: str = ""
    category: str = ""
    source_page: str = ""
    product_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ParsedPackage:
    amount_per_package: float | None
    package_unit: str
    pack_count: float
    purchase_unit: str
    exact: bool
    minimum_total_base: float | None = None
    maximum_total_base: float | None = None
    dimension: str = ""
    notes: tuple[str, ...] = field(default_factory=tuple)

    def package_size_text(self) -> str:
        if self.amount_per_package is None or not self.package_unit:
            return "Package size not parsed"
        amount = _format_number(self.amount_per_package)
        if self.pack_count != 1:
            return f"{_format_number(self.pack_count)} × {amount} {self.package_unit}"
        return f"{amount} {self.package_unit}"

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["notes"] = list(self.notes)
        data["package_size"] = self.package_size_text()
        return data


@dataclass
class CatalogSnapshot:
    products: list[DaylightProduct]
    fetched_at: datetime
    source_pages: int
    catalog_url: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "products": [product.to_dict() for product in self.products],
            "fetched_at": self.fetched_at.isoformat(),
            "source_pages": self.source_pages,
            "catalog_url": self.catalog_url,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "CatalogSnapshot":
        products = [DaylightProduct(**item) for item in value.get("products", [])]
        fetched_at = datetime.fromisoformat(str(value["fetched_at"]).replace("Z", "+00:00"))
        if fetched_at.tzinfo is None:
            fetched_at = fetched_at.replace(tzinfo=timezone.utc)
        return cls(
            products=products,
            fetched_at=fetched_at,
            source_pages=int(value.get("source_pages", 0)),
            catalog_url=str(value.get("catalog_url") or DAYLIGHT_DEFAULT_CATALOG_URL),
        )


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _format_number(value: float) -> str:
    if abs(value - round(value)) < 1e-9:
        return str(int(round(value)))
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _clean_text(value: Any) -> str:
    return SPACE_RE.sub(" ", html.unescape(str(value or "")).replace("\xa0", " ")).strip()


def _product_id_from_url(url: str) -> str:
    path = urlparse(url).path.rstrip("/")
    return path.rsplit("/", 1)[-1] if path else ""


def _normalize_match_text(value: str) -> str:
    result = _clean_text(value).lower()
    for source, target in SYNONYM_PHRASES.items():
        result = re.sub(rf"\b{re.escape(source)}\b", target, result)
    return SPACE_RE.sub(" ", NON_WORD_RE.sub(" ", result)).strip()


def _singularize(token: str) -> str:
    if len(token) <= 3:
        return token
    if token.endswith("ies") and len(token) > 4:
        return token[:-3] + "y"
    if token.endswith("oes") and len(token) > 4:
        return token[:-2]
    if token.endswith("sses"):
        return token[:-2]
    if token.endswith("s") and not token.endswith(("ss", "us", "is")):
        return token[:-1]
    return token


def _tokens(value: str, *, keep_qualifiers: bool = False) -> list[str]:
    normalized = _normalize_match_text(value)
    values: list[str] = []
    for token in normalized.split():
        singular = _singularize(token)
        if singular in MATCH_STOP_WORDS and not keep_qualifiers:
            continue
        if len(singular) <= 1:
            continue
        values.append(singular)
    return values


def product_match_score(query: str, product_name: str) -> float:
    query_normalized = _normalize_match_text(query)
    product_normalized = _normalize_match_text(product_name)
    query_tokens = _tokens(query)
    product_tokens = _tokens(product_name)
    if not query_tokens or not product_tokens:
        return 0.0

    query_set = set(query_tokens)
    product_set = set(product_tokens)
    coverage = len(query_set & product_set) / len(query_set)
    precision = len(query_set & product_set) / max(1, len(product_set))
    sequence = SequenceMatcher(None, query_normalized, product_normalized).ratio()

    query_qualifiers = set(_tokens(query, keep_qualifiers=True)) & PROCESS_QUALIFIERS
    product_qualifiers = set(_tokens(product_name, keep_qualifiers=True)) & PROCESS_QUALIFIERS
    missing_qualifiers = query_qualifiers - product_qualifiers
    extra_qualifiers = product_qualifiers - query_qualifiers

    penalty = 0.0
    if missing_qualifiers:
        penalty += min(0.30, 0.12 * len(missing_qualifiers))
    if extra_qualifiers:
        penalty += min(0.24, 0.08 * len(extra_qualifiers))

    prefix_bonus = 0.08 if query_tokens[0] in product_tokens[:2] else 0.0
    phrase_bonus = 0.12 if query_normalized and query_normalized in product_normalized else 0.0
    score = 0.58 * coverage + 0.17 * precision + 0.25 * sequence + prefix_bonus + phrase_bonus - penalty
    return max(0.0, min(1.0, score))


def _find_product_card(anchor: Any) -> Any:
    current = anchor
    for _ in range(8):
        if current is None:
            break
        tag_name = str(getattr(current, "name", "") or "").lower()
        classes = current.get("class", []) if hasattr(current, "get") else []
        class_text = " ".join(classes) if isinstance(classes, list) else str(classes or "")
        class_text = class_text.lower()

        # WooCommerce product links themselves commonly contain "product" in their
        # class name. They are not the card and do not include the adjacent UOM.
        if tag_name in {"li", "article"}:
            return current
        if tag_name in {"div", "section"} and (
            re.search(r"(^|\s)product($|\s)", class_text)
            or "product-item" in class_text
            or "product-small" in class_text
        ):
            return current
        current = getattr(current, "parent", None)
    return getattr(anchor, "parent", None)


def parse_catalog_html(raw_html: str, source_page: str, base_url: str = "https://daylightfoods.com") -> list[DaylightProduct]:
    """Extract product title, public URL, and UOM from a Daylight catalog page.

    The parser intentionally uses several generic fallbacks instead of relying on one
    WordPress theme class so a modest site redesign is less likely to break it.
    """

    soup = BeautifulSoup(raw_html, "html.parser")
    products: list[DaylightProduct] = []
    seen: set[str] = set()

    anchors = soup.select('a[href*="/product/"]')
    for anchor in anchors:
        href = _clean_text(anchor.get("href"))
        if not href:
            continue
        url = urljoin(base_url, href)
        if url in seen:
            continue

        title_node = anchor.select_one(".woocommerce-loop-product__title, h2, h3, h4")
        title = _clean_text(title_node.get_text(" ", strip=True) if title_node else anchor.get_text(" ", strip=True))
        if not title or title.lower() in {"details", "buy now", "image", "read more"}:
            card = _find_product_card(anchor)
            if card is not None:
                title_node = card.select_one(".woocommerce-loop-product__title, h2, h3, h4")
                title = _clean_text(title_node.get_text(" ", strip=True) if title_node else "")
        if not title or len(title) < 2:
            continue

        card = _find_product_card(anchor)
        card_text = _clean_text(card.get_text(" ", strip=True) if card is not None else "")
        uom_match = UOM_RE.search(card_text)
        uom = _clean_text(uom_match.group(1)).upper() if uom_match else ""

        products.append(
            DaylightProduct(
                product_name=title,
                product_url=url,
                uom=uom,
                source_page=source_page,
                product_id=_product_id_from_url(url),
            )
        )
        seen.add(url)

    return products


def extract_last_catalog_page(raw_html: str) -> int:
    soup = BeautifulSoup(raw_html, "html.parser")
    pages = [1]
    for anchor in soup.select("a[href]"):
        match = PAGE_RE.search(str(anchor.get("href") or ""))
        if match:
            pages.append(int(match.group(1)))
    return max(pages)


def _normalize_title_for_package(title: str) -> str:
    value = _clean_text(title).upper().replace("–", "-").replace("—", "-")
    # A trailing pound sign denotes pounds (e.g., 30#); a leading #1 is a grade and is left alone.
    value = re.sub(r"(?<=\d)\s*#(?=$|[-\s])", " LB", value)
    value = value.replace("LBS.", "LB").replace("LBS", "LB")
    return SPACE_RE.sub(" ", value)


def _unit_from_token(token: str) -> str:
    return UNIT_TOKEN_MAP.get(token.upper().strip(), token.lower().strip())


def _purchase_unit_from_uom(uom: str) -> str:
    normalized = _clean_text(uom).upper().replace(" ", "")
    if normalized.startswith("BAG") and normalized[3:].isdigit():
        return "bag"
    if normalized.endswith("LB") and normalized[:-2].replace(".", "", 1).isdigit():
        return f"{normalized[:-2]}-lb unit"
    return PURCHASE_UNIT_MAP.get(normalized, normalized.lower() or "unit")


def _quantity_to_base(value: float, unit: str) -> NormalizedQuantity | None:
    try:
        return normalize_quantity(value, unit)
    except ValueError:
        return None


def parse_daylight_package(product_name: str, uom: str = "") -> ParsedPackage:
    """Parse a public Daylight title into package math metadata.

    Exact examples supported:
      * 5-LB
      * 10/5oz
      * 4/4.4 LB
      * 6/3KG
      * 100/2-OZ
      * 6-CT UNIT / BAG6

    Count ranges such as 64-88 CT are retained as ranges and marked non-exact.
    """

    title = _normalize_title_for_package(product_name)
    uom_clean = _clean_text(uom).upper().replace(" ", "")
    purchase_unit = _purchase_unit_from_uom(uom)
    notes: list[str] = []

    # Explicit UOMs that encode the purchasable quantity are the clearest signal.
    uom_weight = re.fullmatch(r"(\d+(?:\.\d+)?)LB", uom_clean)
    if uom_weight:
        amount = float(uom_weight.group(1))
        normalized = normalize_quantity(amount, "lb")
        return ParsedPackage(
            amount_per_package=amount,
            package_unit="lb",
            pack_count=1,
            purchase_unit=purchase_unit,
            exact=True,
            minimum_total_base=normalized.value,
            maximum_total_base=normalized.value,
            dimension=normalized.dimension,
            notes=("Quantity encoded by Daylight UOM",),
        )

    uom_bag = re.fullmatch(r"BAG(\d+)", uom_clean)
    if uom_bag:
        amount = float(uom_bag.group(1))
        normalized = normalize_quantity(amount, "each")
        return ParsedPackage(
            amount_per_package=amount,
            package_unit="each",
            pack_count=1,
            purchase_unit="bag",
            exact=True,
            minimum_total_base=normalized.value,
            maximum_total_base=normalized.value,
            dimension=normalized.dimension,
            notes=("Count encoded by Daylight UOM",),
        )

    # Multipacks: 10/5oz, 4/4.4 LB, 100/2-OZ, 3/33-CT.
    multipack_re = re.compile(
        r"(?<![\d.])(?P<count>\d+(?:\.\d+)?)\s*/\s*(?P<amount>\d+(?:\.\d+)?)\s*-?\s*"
        r"(?P<unit>LB|OZ|KG|G|CT|COUNT|EA|EACH|GAL|QT|PT|ML|L)\b",
        re.IGNORECASE,
    )
    multipack_matches = list(multipack_re.finditer(title))
    if multipack_matches:
        match = multipack_matches[-1]
        count = float(match.group("count"))
        amount = float(match.group("amount"))
        unit = _unit_from_token(match.group("unit"))

        # Produce count strings like 175/198CT are size ranges, not 175 packs of 198.
        if unit == "each" and count >= 24 and amount >= 24 and amount / count < 2.5:
            low, high = sorted((count, amount))
            low_q = normalize_quantity(low, "each")
            high_q = normalize_quantity(high, "each")
            return ParsedPackage(
                amount_per_package=low,
                package_unit="each",
                pack_count=1,
                purchase_unit=purchase_unit,
                exact=False,
                minimum_total_base=low_q.value,
                maximum_total_base=high_q.value,
                dimension=low_q.dimension,
                notes=("Catalog title gives a count range",),
            )

        normalized = normalize_quantity(amount * count, unit)
        return ParsedPackage(
            amount_per_package=amount,
            package_unit=unit,
            pack_count=count,
            purchase_unit=purchase_unit,
            exact=True,
            minimum_total_base=normalized.value,
            maximum_total_base=normalized.value,
            dimension=normalized.dimension,
            notes=tuple(notes),
        )

    # Count ranges: 64-88 CT, 5-7 CT, 72/88 CT.
    range_re = re.compile(
        r"(?<![\d.])(?P<low>\d+(?:\.\d+)?)\s*[-/]\s*(?P<high>\d+(?:\.\d+)?)\s*-?\s*"
        r"(?P<unit>CT|COUNT|EA|EACH)\b",
        re.IGNORECASE,
    )
    range_matches = list(range_re.finditer(title))
    if range_matches:
        match = range_matches[-1]
        low, high = sorted((float(match.group("low")), float(match.group("high"))))
        if uom_clean in {"EACH", "EA"}:
            one_each = normalize_quantity(1, "each")
            return ParsedPackage(
                amount_per_package=1,
                package_unit="each",
                pack_count=1,
                purchase_unit="each",
                exact=False,
                minimum_total_base=one_each.value,
                maximum_total_base=one_each.value,
                dimension=one_each.dimension,
                notes=(
                    f"Daylight UOM says sold each while the title references a {low:g}-{high:g} count case/grade; treating one order unit as one item",
                ),
            )
        low_q = normalize_quantity(low, "each")
        high_q = normalize_quantity(high, "each")
        return ParsedPackage(
            amount_per_package=low,
            package_unit="each",
            pack_count=1,
            purchase_unit=purchase_unit,
            exact=False,
            minimum_total_base=low_q.value,
            maximum_total_base=high_q.value,
            dimension=low_q.dimension,
            notes=("Catalog title gives a count range",),
        )

    # Single explicit package amount: 5-LB, 30LB, 80-CT, 2 OZ.
    single_re = re.compile(
        r"(?<![\d.])(?P<amount>\d+(?:\.\d+)?)\s*-?\s*"
        r"(?P<unit>LB|OZ|KG|G|CT|COUNT|EA|EACH|GAL|QT|PT|ML|L)\b",
        re.IGNORECASE,
    )
    single_matches = list(single_re.finditer(title))
    if single_matches:
        match = single_matches[-1]
        amount = float(match.group("amount"))
        unit = _unit_from_token(match.group("unit"))
        normalized = normalize_quantity(amount, unit)

        # The UOM is the purchasable unit. A count in a produce title can describe
        # the master case or grade even when the account orders individual pieces.
        if uom_clean in {"EACH", "EA"} and unit == "each" and amount != 1:
            one_each = normalize_quantity(1, "each")
            return ParsedPackage(
                amount_per_package=1,
                package_unit="each",
                pack_count=1,
                purchase_unit="each",
                exact=False,
                minimum_total_base=one_each.value,
                maximum_total_base=one_each.value,
                dimension=one_each.dimension,
                notes=(
                    f"Daylight UOM says sold each while the title references {amount:g}-count case/grade; treating one order unit as one item",
                ),
            )

        # If UOM says sold by pound, the public ordering unit and title case weight conflict.
        if uom_clean in {"LBS", "LB"} and unit == "lb" and amount != 1:
            one_lb = normalize_quantity(1, "lb")
            return ParsedPackage(
                amount_per_package=1,
                package_unit="lb",
                pack_count=1,
                purchase_unit="lb",
                exact=False,
                minimum_total_base=one_lb.value,
                maximum_total_base=one_lb.value,
                dimension=one_lb.dimension,
                notes=(
                    f"Daylight UOM says sold by pound while the title references {amount:g} lb; confirm account minimum",
                ),
            )

        return ParsedPackage(
            amount_per_package=amount,
            package_unit=unit,
            pack_count=1,
            purchase_unit=purchase_unit,
            exact=True,
            minimum_total_base=normalized.value,
            maximum_total_base=normalized.value,
            dimension=normalized.dimension,
            notes=tuple(notes),
        )

    # Parenthesized produce counts such as AVOCADO, HASS (48) #1 2-LYR.
    parenthetical_count = re.search(r"\((\d{2,3})\)", title)
    if parenthetical_count:
        amount = float(parenthetical_count.group(1))
        if uom_clean in {"EACH", "EA"}:
            one_each = normalize_quantity(1, "each")
            return ParsedPackage(
                amount_per_package=1,
                package_unit="each",
                pack_count=1,
                purchase_unit="each",
                exact=False,
                minimum_total_base=one_each.value,
                maximum_total_base=one_each.value,
                dimension=one_each.dimension,
                notes=(
                    f"Daylight UOM says sold each while the title references parenthetical size {amount:g}; treating one order unit as one item",
                ),
            )
        normalized = normalize_quantity(amount, "each")
        return ParsedPackage(
            amount_per_package=amount,
            package_unit="each",
            pack_count=1,
            purchase_unit=purchase_unit,
            exact=False,
            minimum_total_base=normalized.value,
            maximum_total_base=normalized.value,
            dimension=normalized.dimension,
            notes=("Count inferred from parenthesized produce size",),
        )

    # UOM itself can identify a variable ordering unit even when the title has no size.
    if uom_clean in {"LBS", "LB"}:
        normalized = normalize_quantity(1, "lb")
        return ParsedPackage(
            amount_per_package=1,
            package_unit="lb",
            pack_count=1,
            purchase_unit="lb",
            exact=False,
            minimum_total_base=normalized.value,
            maximum_total_base=normalized.value,
            dimension=normalized.dimension,
            notes=("Public UOM indicates ordering by pound; confirm account minimum",),
        )
    if uom_clean in {"EACH", "EA"}:
        normalized = normalize_quantity(1, "each")
        return ParsedPackage(
            amount_per_package=1,
            package_unit="each",
            pack_count=1,
            purchase_unit="each",
            exact=False,
            minimum_total_base=normalized.value,
            maximum_total_base=normalized.value,
            dimension=normalized.dimension,
            notes=("No package count appears in the public title; treating UOM EACH as one item",),
        )

    return ParsedPackage(
        amount_per_package=None,
        package_unit="",
        pack_count=1,
        purchase_unit=purchase_unit,
        exact=False,
        notes=("Package size could not be parsed from the public title and UOM",),
    )


def parse_required_text(value: str) -> tuple[NormalizedQuantity | None, str]:
    """Parse planner display strings such as '1 lb 2 oz', '12 each', or '4 cups'."""

    text = _clean_text(value).lower()
    if not text:
        return None, "Required quantity is blank"

    pair_re = re.compile(
        r"(?P<amount>\d+(?:\.\d+)?)\s*"
        r"(?P<unit>lb|lbs|pounds?|oz|ounces?|kg|kgs|g|grams?|cups?|tbsp|tablespoons?|"
        r"tsp|teaspoons?|fl\s*oz|ml|l|liters?|each|head|heads|clove|cloves|bunch|bunches|"
        r"bag|bags|box|boxes|can|cans|bottle|bottles|package|packages|pack|packs|jar|jars|"
        r"sprig|sprigs|tray|trays|tub|tubs|carton|cartons|loaf|loaves)\b",
        re.IGNORECASE,
    )
    matches = list(pair_re.finditer(text))
    if not matches:
        return None, f"Could not parse required quantity: {value}"

    total = 0.0
    dimension = ""
    base_unit = ""
    for match in matches:
        amount = float(match.group("amount"))
        unit = normalize_unit(match.group("unit"))
        try:
            normalized = normalize_quantity(amount, unit)
        except ValueError:
            return None, f"Unsupported required unit: {unit}"
        if not dimension:
            dimension = normalized.dimension
            base_unit = normalized.base_unit
        elif normalized.dimension != dimension:
            return None, "Required quantity contains incompatible unit dimensions"
        total += normalized.value

    return NormalizedQuantity(total, dimension, base_unit), ""


def _recommend_purchase(required: NormalizedQuantity | None, package: ParsedPackage) -> dict[str, Any]:
    result: dict[str, Any] = {
        "buy_quantity": None,
        "purchased": "",
        "excess": "",
        "recommendation_status": "package unclear",
        "calculation_note": "",
    }
    if required is None:
        result["calculation_note"] = "Required quantity could not be normalized"
        return result
    if package.minimum_total_base is None or not package.dimension:
        result["calculation_note"] = "Package size could not be normalized"
        return result
    if required.dimension != package.dimension:
        result["calculation_note"] = (
            f"Requirement is {required.dimension}; Daylight package is {package.dimension}. "
            "Add an ingredient-specific conversion before calculating packages."
        )
        return result

    minimum_package = package.minimum_total_base
    if minimum_package <= 0:
        result["calculation_note"] = "Package size must be positive"
        return result

    buy_quantity = ceil(required.value / minimum_package - 1e-12)
    min_purchased = buy_quantity * minimum_package
    max_purchased = buy_quantity * (package.maximum_total_base or minimum_package)
    min_excess = max(0.0, min_purchased - required.value)
    max_excess = max(0.0, max_purchased - required.value)

    result["buy_quantity"] = buy_quantity
    if abs(max_purchased - min_purchased) < 1e-9:
        result["purchased"] = display_base(min_purchased, required.dimension)
        result["excess"] = display_base(min_excess, required.dimension)
    else:
        result["purchased"] = (
            f"{display_base(min_purchased, required.dimension)}–"
            f"{display_base(max_purchased, required.dimension)}"
        )
        result["excess"] = (
            f"{display_base(min_excess, required.dimension)}–"
            f"{display_base(max_excess, required.dimension)}"
        )
    result["recommendation_status"] = "ready" if package.exact else "estimate"
    result["calculation_note"] = (
        "Rounded up using the exact public package size"
        if package.exact
        else "Conservative quantity based on the low end of the public package range/ordering unit"
    )
    return result


def build_search_result(
    *,
    query: str,
    canonical_item: str,
    required_text: str,
    product: DaylightProduct,
    score: float,
    fetched_at: datetime,
) -> dict[str, Any]:
    package = parse_daylight_package(product.product_name, product.uom)
    required, required_error = parse_required_text(required_text) if required_text else (None, "")
    purchase = _recommend_purchase(required, package)

    match_confidence = "high" if score >= 0.78 else "medium" if score >= 0.50 else "low"
    package_confidence = "exact" if package.exact else "estimate" if package.amount_per_package else "unclear"
    notes = list(package.notes)
    if required_error:
        notes.append(required_error)
    notes.append("Public catalog does not confirm account price or live availability")

    return {
        "ingredient": canonical_item or query,
        "query": query,
        "required": required_text,
        "product_name": product.product_name,
        "product_id": product.product_id,
        "daylight_uom": product.uom,
        "amount_per_package": package.amount_per_package,
        "package_unit": package.package_unit,
        "pack_count": package.pack_count,
        "purchase_unit": package.purchase_unit,
        "package_size": package.package_size_text(),
        "buy_quantity": purchase["buy_quantity"],
        "purchased": purchase["purchased"],
        "excess": purchase["excess"],
        "product_url": product.product_url,
        "match_score": round(score, 4),
        "match_confidence": match_confidence,
        "package_confidence": package_confidence,
        "recommendation_status": purchase["recommendation_status"],
        "calculation_note": purchase["calculation_note"],
        "notes": "; ".join(dict.fromkeys(note for note in notes if note)),
        "last_checked": fetched_at.date().isoformat(),
        "catalog_source": "Daylight public catalog",
    }


class DaylightCatalogClient:
    def __init__(self) -> None:
        self.catalog_url = os.getenv("DAYLIGHT_CATALOG_URL", DAYLIGHT_DEFAULT_CATALOG_URL).rstrip("/") + "/"
        self.user_agent = os.getenv("DAYLIGHT_USER_AGENT", DAYLIGHT_DEFAULT_USER_AGENT)
        self.cache_hours = max(0.25, float(os.getenv("DAYLIGHT_CACHE_HOURS", "24")))
        self.request_delay = max(0.0, float(os.getenv("DAYLIGHT_REQUEST_DELAY_SECONDS", "0.20")))
        self.max_pages = max(1, int(os.getenv("DAYLIGHT_MAX_PAGES", "40")))
        self.timeout_seconds = max(5.0, float(os.getenv("DAYLIGHT_TIMEOUT_SECONDS", "25")))
        self.cache_path = Path(os.getenv("DAYLIGHT_CACHE_PATH", "/tmp/daylight_public_catalog.json"))
        self._snapshot: CatalogSnapshot | None = None
        self._lock = asyncio.Lock()

    def _fresh(self, snapshot: CatalogSnapshot | None) -> bool:
        if snapshot is None:
            return False
        age_seconds = (_now_utc() - snapshot.fetched_at).total_seconds()
        return age_seconds <= self.cache_hours * 3600

    def _load_disk_cache(self) -> CatalogSnapshot | None:
        try:
            if not self.cache_path.exists():
                return None
            snapshot = CatalogSnapshot.from_dict(json.loads(self.cache_path.read_text(encoding="utf-8")))
            return snapshot if self._fresh(snapshot) else None
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return None

    def _save_disk_cache(self, snapshot: CatalogSnapshot) -> None:
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.cache_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(snapshot.to_dict(), ensure_ascii=False), encoding="utf-8")
            temporary.replace(self.cache_path)
        except OSError:
            # The in-memory cache remains usable even if the platform filesystem is read-only.
            return

    async def _fetch_text(self, client: httpx.AsyncClient, url: str) -> str:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = await client.get(url)
                response.raise_for_status()
                return response.text
            except (httpx.HTTPError, httpx.TimeoutException) as exc:
                last_error = exc
                if attempt < 2:
                    await asyncio.sleep(0.5 * (2**attempt))
        raise RuntimeError(f"Could not fetch Daylight public catalog page {url}: {last_error}")

    async def _robots_allows(self, client: httpx.AsyncClient) -> bool:
        robots_url = urljoin(self.catalog_url, "/robots.txt")
        try:
            response = await client.get(robots_url)
            if response.status_code >= 400:
                return True
            parser = RobotFileParser()
            parser.parse(response.text.splitlines())
            return parser.can_fetch(self.user_agent, self.catalog_url)
        except httpx.HTTPError:
            # The page explicitly labels itself a public catalog; a robots outage should not
            # permanently disable the user-facing lookup. We still use conservative rate limits.
            return True

    async def refresh(self, *, force: bool = False) -> CatalogSnapshot:
        if not force and self._fresh(self._snapshot):
            return self._snapshot  # type: ignore[return-value]

        async with self._lock:
            if not force and self._fresh(self._snapshot):
                return self._snapshot  # type: ignore[return-value]
            if not force:
                disk = self._load_disk_cache()
                if disk is not None:
                    self._snapshot = disk
                    return disk

            headers = {"User-Agent": self.user_agent, "Accept": "text/html,application/xhtml+xml"}
            timeout = httpx.Timeout(self.timeout_seconds)
            async with httpx.AsyncClient(headers=headers, timeout=timeout, follow_redirects=True) as client:
                if not await self._robots_allows(client):
                    raise RuntimeError("Daylight robots.txt does not allow this catalog fetch")

                first_html = await self._fetch_text(client, self.catalog_url)
                last_page = min(extract_last_catalog_page(first_html), self.max_pages)
                page_html: dict[int, str] = {1: first_html}
                semaphore = asyncio.Semaphore(3)

                async def fetch_page(page_number: int) -> tuple[int, str]:
                    async with semaphore:
                        if self.request_delay:
                            await asyncio.sleep(self.request_delay * ((page_number - 2) % 3))
                        url = urljoin(self.catalog_url, f"page/{page_number}/")
                        return page_number, await self._fetch_text(client, url)

                if last_page > 1:
                    results = await asyncio.gather(
                        *(fetch_page(page) for page in range(2, last_page + 1)),
                        return_exceptions=True,
                    )
                    failures: list[str] = []
                    for result in results:
                        if isinstance(result, Exception):
                            failures.append(str(result))
                        else:
                            page_number, raw_html = result
                            page_html[page_number] = raw_html
                    if failures and len(page_html) < max(2, last_page // 2):
                        raise RuntimeError(
                            "Too many Daylight catalog pages failed to load: " + "; ".join(failures[:3])
                        )

            products_by_url: dict[str, DaylightProduct] = {}
            for page_number, raw_html in sorted(page_html.items()):
                page_url = self.catalog_url if page_number == 1 else urljoin(self.catalog_url, f"page/{page_number}/")
                for product in parse_catalog_html(raw_html, page_url, self.catalog_url):
                    products_by_url[product.product_url] = product

            products = sorted(products_by_url.values(), key=lambda item: item.product_name.lower())
            if not products:
                raise RuntimeError(
                    "Daylight catalog loaded but no product cards were parsed. The public page layout may have changed."
                )

            snapshot = CatalogSnapshot(
                products=products,
                fetched_at=_now_utc(),
                source_pages=len(page_html),
                catalog_url=self.catalog_url,
            )
            self._snapshot = snapshot
            self._save_disk_cache(snapshot)
            return snapshot

    async def status(self) -> dict[str, Any]:
        snapshot = self._snapshot or self._load_disk_cache()
        return {
            "configured_catalog_url": self.catalog_url,
            "cached": snapshot is not None,
            "cache_fresh": self._fresh(snapshot),
            "product_count": len(snapshot.products) if snapshot else 0,
            "source_pages": snapshot.source_pages if snapshot else 0,
            "fetched_at": snapshot.fetched_at.isoformat() if snapshot else "",
            "cache_hours": self.cache_hours,
        }

    async def search(
        self,
        *,
        query: str,
        canonical_item: str = "",
        required_text: str = "",
        limit: int = 5,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        query = _clean_text(query)
        if not query:
            raise ValueError("Daylight search query cannot be blank")
        limit = min(max(int(limit), 1), 20)
        snapshot = await self.refresh(force=force_refresh)
        scored: list[tuple[float, DaylightProduct]] = []
        for product in snapshot.products:
            score = product_match_score(query, product.product_name)
            if score >= 0.20:
                scored.append((score, product))
        scored.sort(key=lambda item: (-item[0], item[1].product_name.lower()))

        results = [
            build_search_result(
                query=query,
                canonical_item=canonical_item or query,
                required_text=required_text,
                product=product,
                score=score,
                fetched_at=snapshot.fetched_at,
            )
            for score, product in scored[:limit]
        ]
        return {
            "query": query,
            "canonical_item": canonical_item or query,
            "required": required_text,
            "results": results,
            "catalog": {
                "product_count": len(snapshot.products),
                "source_pages": snapshot.source_pages,
                "fetched_at": snapshot.fetched_at.isoformat(),
                "catalog_url": snapshot.catalog_url,
            },
        }

    async def search_batch(
        self,
        items: Iterable[dict[str, Any]],
        *,
        limit: int = 5,
        force_refresh: bool = False,
        max_items: int = 25,
    ) -> dict[str, Any]:
        snapshot = await self.refresh(force=force_refresh)
        selected = list(items)[: max(1, min(max_items, 100))]
        matches: list[dict[str, Any]] = []
        for item in selected:
            query = _clean_text(item.get("query") or item.get("ingredient") or "")
            if not query:
                continue
            canonical_item = _clean_text(item.get("canonical_item") or item.get("ingredient") or query)
            required_text = _clean_text(item.get("required_text") or item.get("required") or item.get("quantity_raw") or "")
            scored: list[tuple[float, DaylightProduct]] = []
            for product in snapshot.products:
                score = product_match_score(query, product.product_name)
                if score >= 0.20:
                    scored.append((score, product))
            scored.sort(key=lambda value: (-value[0], value[1].product_name.lower()))
            for score, product in scored[: min(max(int(limit), 1), 20)]:
                matches.append(
                    build_search_result(
                        query=query,
                        canonical_item=canonical_item,
                        required_text=required_text,
                        product=product,
                        score=score,
                        fetched_at=snapshot.fetched_at,
                    )
                )

        return {
            "matches": matches,
            "searched_item_count": len(selected),
            "match_count": len(matches),
            "catalog": {
                "product_count": len(snapshot.products),
                "source_pages": snapshot.source_pages,
                "fetched_at": snapshot.fetched_at.isoformat(),
                "catalog_url": snapshot.catalog_url,
            },
        }


daylight_catalog = DaylightCatalogClient()
