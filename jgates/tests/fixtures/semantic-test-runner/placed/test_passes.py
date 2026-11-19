"""Passes: uses the project's code and its prepared dependency, and proves the container's limits from the inside."""
import socket

import six

from inventory import total


def test_total_applies_the_discount():
    assert total([{"price": 10, "quantity": 3}], discount=10) == 27.0


def test_the_prepared_dependency_is_importable():
    assert six.PY3


def test_there_is_no_network():
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=3).close()
    except OSError:
        return
    raise AssertionError("a connection was possible")


def test_the_workspace_copy_and_the_dependencies_are_read_only():
    for target in ("/workspace/written-by-the-test.txt", "/workspace/.venv/written-by-the-test.txt"):
        try:
            open(target, "w").close()
        except OSError:
            continue
        raise AssertionError(f"{target} could be written")
