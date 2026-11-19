# Order pricing.


def apply_discount(total, percent):
    """Total after a percentage discount (0 to 100)."""
    return total - total * percent / 100
