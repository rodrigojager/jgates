from pkg.age import is_adult, price


# Strengthened suite: the boundary values are probed on both sides.
def test_old_person_is_adult():
    assert is_adult(40) is True


def test_child_is_not_adult():
    assert is_adult(5) is False


def test_boundary_18():
    assert is_adult(18) is True
    assert is_adult(17) is False


def test_large_order_is_discounted():
    assert price(200) == 180


def test_small_order_is_not():
    assert price(50) == 50


def test_boundary_100():
    assert price(100) == 100
    assert price(101) < 101
    assert price(110) == 99

