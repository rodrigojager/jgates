from pkg.age import is_adult, price


# Weak suite: it never probes the boundary values 18 and 100.
def test_old_person_is_adult():
    assert is_adult(40) is True


def test_child_is_not_adult():
    assert is_adult(5) is False


def test_large_order_is_discounted():
    assert price(200) == 180


def test_small_order_is_not():
    assert price(50) == 50
