"""The boundary is at 18: an adult is 18 or older."""


def is_adult(age):
    return age >= 18


def price(total):
    """Orders above 100 get a ten percent discount; exactly 100 does not."""
    if total > 100:
        return total - total / 10
    return total
