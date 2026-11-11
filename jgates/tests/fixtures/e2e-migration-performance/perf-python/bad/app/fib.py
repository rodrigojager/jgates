import time


def fib(n: int) -> int:
    time.sleep(0.02)
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
