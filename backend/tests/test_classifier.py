from app.classifier import classify_local


def test_fresh_bok_choy_is_produce():
    result = classify_local("baby bok choy")
    assert result.category == "produce"
    assert result.preferred_retailers[0] == "Daylight"


def test_lemon_juice_is_not_produce():
    result = classify_local("lemon juice")
    assert result.category == "general_grocery"


def test_pickled_mustard_greens_are_asian_specialty():
    result = classify_local("Chinese pickled mustard greens")
    assert result.category == "asian_specialty"
    assert result.preferred_retailers[0] == "Weee"


def test_frozen_berries_are_frozen():
    result = classify_local("mixed frozen berries")
    assert result.category == "frozen"
    assert result.preferred_retailers[0] == "Costco Same-Day"
