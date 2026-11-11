from app.fib import fib


def test_fib_bench(benchmark) -> None:
    assert benchmark(fib, 20) == 6765
