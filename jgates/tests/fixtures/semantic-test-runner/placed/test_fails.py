"""Fails: one test names a wrong expectation, the other passes."""
from inventory import total


def test_total_ignores_the_discount():
    assert total([{"price": 10, "quantity": 3}], discount=10) == 30.0


def test_total_of_one_item():
    assert total([{"price": 5, "quantity": 1}]) == 5
