"""Stdlib-only line coverage for the main fixture API.

Usage: python measure_coverage.py <api_dir>
Runs unittest discovery in <api_dir>/tests with a settrace hook, then prints
JSON: {"percent": float, "covered": int, "total": int, "tests_ok": bool}.
"""
import dis
import json
import os
import sys
import unittest


def executable_lines(path):
    with open(path, "r", encoding="utf-8") as handle:
        code = compile(handle.read(), path, "exec")
    lines, stack = set(), [code]
    while stack:
        current = stack.pop()
        lines.update(line for _, line in dis.findlinestarts(current) if line)
        stack.extend(c for c in current.co_consts if hasattr(c, "co_code"))
    return lines


def main(api_dir):
    api_dir = os.path.realpath(api_dir)
    src = os.path.join(api_dir, "src")
    sys.path.insert(0, src)
    executed = {}

    def tracer(frame, event, arg):
        filename = os.path.realpath(frame.f_code.co_filename)
        if not filename.startswith(src + os.sep):
            return None
        executed.setdefault(filename, set()).add(frame.f_lineno)
        return tracer

    sys.settrace(tracer)
    suite = unittest.defaultTestLoader.discover(os.path.join(api_dir, "tests"), top_level_dir=api_dir)
    result = unittest.TextTestRunner(stream=open(os.devnull, "w")).run(suite)
    sys.settrace(None)

    covered = total = 0
    for root, _, files in os.walk(src):
        for name in sorted(files):
            if name.endswith(".py"):
                path = os.path.realpath(os.path.join(root, name))
                lines = executable_lines(path)
                total += len(lines)
                covered += len(lines & executed.get(path, set()))
    percent = round(100.0 * covered / total, 2) if total else 0.0
    print(json.dumps({"percent": percent, "covered": covered, "total": total, "tests_ok": result.wasSuccessful()}))


if __name__ == "__main__":
    main(sys.argv[1])
