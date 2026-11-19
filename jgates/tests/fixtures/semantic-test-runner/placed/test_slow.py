"""Does not finish within a short time limit."""
import time


def test_sleeps_past_the_limit():
    time.sleep(600)
