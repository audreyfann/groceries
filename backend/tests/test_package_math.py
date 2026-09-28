from app.package_math import calculate_packages, normalize_quantity


def test_twelve_ounces_with_four_ounce_bags():
    required = normalize_quantity(12, "oz")
    package = normalize_quantity(4, "oz")
    result = calculate_packages(required.value, package.value)
    assert result.purchase_count == 3
    assert result.purchased_base == 12
    assert result.excess_base == 0


def test_fourteen_ounces_with_four_ounce_bags():
    required = normalize_quantity(14, "oz")
    package = normalize_quantity(4, "oz")
    result = calculate_packages(required.value, package.value)
    assert result.purchase_count == 4
    assert result.purchased_base == 16
    assert result.excess_base == 2


def test_plural_package_units_normalize_together():
    assert normalize_quantity(3, "packs").dimension == "count:package"
    assert normalize_quantity(1, "package").dimension == "count:package"


def test_dozen_is_twelve_each():
    quantity = normalize_quantity(2, "dozen")
    assert quantity.dimension == "count:each"
    assert quantity.value == 24
