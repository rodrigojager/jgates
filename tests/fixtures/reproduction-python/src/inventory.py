# Stock reservations.


def reserve(stock, quantity):
    """Stock left after reserving quantity; never below zero."""
    if quantity > stock:
        raise ValueError("not enough stock")
    return stock - quantity
