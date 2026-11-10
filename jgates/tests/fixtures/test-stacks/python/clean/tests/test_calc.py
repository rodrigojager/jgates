from hypothesis import given
from hypothesis import strategies as st

from calc import absolute, add


def test_add():
    assert add(2, 3) == 5


def test_absolute():
    assert absolute(-4) == 4
    assert absolute(4) == 4


@given(st.integers(), st.integers())
def test_add_is_commutative(a, b):
    assert add(a, b) == add(b, a)
