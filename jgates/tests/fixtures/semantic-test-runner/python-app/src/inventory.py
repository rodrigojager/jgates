"""A tiny inventory: the code the placed test files exercise."""


def total(items, discount=0):
    """The price of the items (price * quantity), less a percentage discount."""
    gross = sum(item["price"] * item["quantity"] for item in items)
    return round(gross * (100 - discount) / 100, 2)
