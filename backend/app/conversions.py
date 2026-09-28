from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Any

from .normalization import canonicalize
from .package_math import normalize_quantity


@dataclass(frozen=True)
class ConversionEdge:
    target_dimension: str
    factor: float
    label: str


ConversionGraph = dict[str, dict[str, list[ConversionEdge]]]


def _value(row: dict[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in row and row[name] not in (None, ""):
            return row[name]
    return default


def _truthy(value: Any) -> bool:
    return str(value if value is not None else "").strip().lower() in {
        "true",
        "yes",
        "y",
        "1",
        "checked",
    }


def build_conversion_graph(
    rows: list[dict[str, Any]], alias_map: dict[str, str]
) -> ConversionGraph:
    graph: ConversionGraph = {}
    for row in rows:
        active = _value(row, "Active", "active", default=True)
        if str(active).strip().lower() in {"false", "0", "no", "n"}:
            continue
        approved = _value(row, "Approved", "approved", default=True)
        if approved not in (None, "") and not _truthy(approved):
            continue

        raw_item = _value(row, "Canonical Item", "Ingredient", "Item")
        canonical = canonicalize(str(raw_item or ""), alias_map).canonical
        if not canonical:
            continue

        try:
            from_amount = float(_value(row, "From Quantity", "From Amount"))
            to_amount = float(_value(row, "To Quantity", "To Amount"))
            from_unit = str(_value(row, "From Unit"))
            to_unit = str(_value(row, "To Unit"))
            from_q = normalize_quantity(from_amount, from_unit)
            to_q = normalize_quantity(to_amount, to_unit)
        except (TypeError, ValueError):
            continue

        if from_q.value <= 0 or to_q.value <= 0:
            continue

        label = (
            f"{from_amount:g} {from_unit} = {to_amount:g} {to_unit}"
            + (
                f" ({_value(row, 'Approved By')})"
                if _value(row, "Approved By")
                else ""
            )
        )
        graph.setdefault(canonical, {}).setdefault(from_q.dimension, []).append(
            ConversionEdge(to_q.dimension, to_q.value / from_q.value, label)
        )
        graph.setdefault(canonical, {}).setdefault(to_q.dimension, []).append(
            ConversionEdge(from_q.dimension, from_q.value / to_q.value, label + " [inverse]")
        )
    return graph


def convert_amount(
    *,
    canonical: str,
    value: float,
    from_dimension: str,
    to_dimension: str,
    graph: ConversionGraph,
) -> tuple[float, list[str]] | None:
    if from_dimension == to_dimension:
        return value, []

    item_graph = graph.get(canonical, {})
    queue: deque[tuple[str, float, list[str]]] = deque([(from_dimension, 1.0, [])])
    visited = {from_dimension}

    while queue:
        dimension, factor, labels = queue.popleft()
        for edge in item_graph.get(dimension, []):
            if edge.target_dimension in visited:
                continue
            next_factor = factor * edge.factor
            next_labels = [*labels, edge.label]
            if edge.target_dimension == to_dimension:
                return value * next_factor, next_labels
            visited.add(edge.target_dimension)
            queue.append((edge.target_dimension, next_factor, next_labels))
    return None
