from inventory import total


def test_total_of_nothing_is_zero():
    assert total([]) == 0
