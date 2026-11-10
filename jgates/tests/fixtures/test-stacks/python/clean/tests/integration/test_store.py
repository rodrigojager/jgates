from calc import add


def test_round_trip():
    store = {"total": add(1, 2)}
    assert store["total"] == 3


def test_sum_of_many():
    total = 0
    for value in range(5):
        total = add(total, value)
    assert total == 10
