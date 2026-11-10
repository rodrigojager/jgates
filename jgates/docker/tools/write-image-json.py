"""Writes /etc/jgates/image.json at image build time and smoke-checks every pinned tool.

Each tool is asked for its version; a pinned tool whose version differs from its pin fails the build. Probes of the
JGates CLI read this file instead of spawning the tools.
"""

import json
import os
import platform
import re
import subprocess
import sys

TOOLS_DIR = "/opt/jgates/tools"


def run(*argv: str) -> str:
    return subprocess.run(argv, check=True, capture_output=True, text=True).stdout.strip()


def first_version(text: str) -> str:
    match = re.search(r"\d+\.\d+(?:\.\d+)?", text)
    if not match:
        raise SystemExit(f"no version found in: {text!r}")
    return match.group(0)


def distribution_version(tool_env: str, distribution: str) -> str:
    python = f"{TOOLS_DIR}/{tool_env}/bin/python"
    return run(python, "-c", f"import importlib.metadata as m; print(m.version({distribution!r}))")


def main() -> None:
    target = sys.argv[1]
    pinned = {
        "uv": (first_version(run("uv", "--version")), os.environ["PIN_UV"]),
        "ruff": (first_version(run("ruff", "--version")), os.environ["PIN_RUFF"]),
        "pytest": (distribution_version("pytest", "pytest"), os.environ["PIN_PYTEST"]),
        "pytest-cov": (distribution_version("pytest", "pytest-cov"), os.environ["PIN_PYTEST_COV"]),
        "coverage": (distribution_version("pytest", "coverage"), os.environ["PIN_COVERAGE"]),
    }
    wrong = {name: got for name, (got, pin) in pinned.items() if got != pin}
    if wrong:
        raise SystemExit(f"tool versions differ from their pins: {wrong}")
    # The --version smoke of the pinned tools that are run as commands.
    if not run("pytest", "--version").endswith(pinned["pytest"][0]):
        raise SystemExit("pytest --version does not report the pinned version")

    tools = {name: got for name, (got, _pin) in pinned.items()}
    tools["git"] = first_version(run("git", "--version"))
    tools["rsync"] = first_version(run("rsync", "--version").splitlines()[0])
    tools["tini"] = first_version(run("tini", "--version"))

    document = {
        "schemaVersion": 1,
        "jgatesVersion": os.environ["JGATES_VERSION"],
        "imageVersion": os.environ["IMAGE_VERSION"],
        "sourceRevision": os.environ["SOURCE_REVISION"],
        "architecture": platform.machine(),
        "stacks": ["python"],
        "tools": dict(sorted(tools.items())),
        "runtimes": {"python": platform.python_version()},
        "defaults": {"user": "10001:10001", "workdir": "/workspace", "memoryMb": 4096, "cpus": 2},
    }
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2)
        handle.write("\n")
    os.chmod(target, 0o444)
    print(json.dumps(document["tools"]))


if __name__ == "__main__":
    main()
