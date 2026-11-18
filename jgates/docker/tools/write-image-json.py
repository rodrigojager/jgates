"""Writes /etc/jgates/image.json at image build time and smoke-checks every tool of the image.

Every program is asked for its version (its own version command, or the package metadata for the libraries the image
ships for runners); a program whose version differs from its pin fails the build, and so does one that does not answer.
The programs come from two files and no list is kept here: runtimes.json (the toolchains and base programs the
Dockerfile installs itself, each pinned by a build argument of the final stage) and the index of the install entries,
/usr/share/jgates/installs.json (written by jgates/scripts/image-installs.mjs from the per-tool files of
PLAN-image.md section 3, with each program's version command and pin). Probes of the JGates CLI read the written file
instead of spawning the tools.
"""

import json
import os
import platform
import re
import subprocess
import sys
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIMES = os.path.join(HERE, "runtimes.json")
INSTALLS = os.path.join(HERE, "installs.json")
JGATES_PACKAGE = "/opt/jgates/jgates/package.json"
SIDECAR_PROJECT = "/opt/jgates/quality-gate/pyproject.toml"
VERSION = r"(\d+\.\d+(?:\.\d+)?)"


def output_of(argv: list[str]) -> str:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=180, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SystemExit(f"{argv[0]} did not answer: {error}")
    if result.returncode != 0:
        raise SystemExit(f"{' '.join(argv)} exited with {result.returncode}: {(result.stderr or result.stdout).strip()[:500]}")
    return result.stdout + "\n" + result.stderr


def version_in(name: str, text: str, pattern: str | None) -> str:
    match = re.search(pattern or VERSION, text, re.MULTILINE)
    if not match:
        raise SystemExit(f"{name}: no version in {text.strip()[:300]!r}")
    return match.group(1)


def library_version(name: str, library: dict) -> str:
    if "python" in library:
        argv = [library["python"], "-c", f"import importlib.metadata as m; print(m.version({library['distribution']!r}))"]
        return output_of(argv).strip()
    if "packageJson" in library:
        with open(library["packageJson"], encoding="utf-8") as handle:
            return json.load(handle)["version"]
    raise SystemExit(f"{name}: {library.get('missing', 'no version command and no package to read')}")


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main() -> None:
    target = sys.argv[1]
    os.makedirs(os.environ.get("HOME", "/tmp/jgates-smoke"), exist_ok=True)
    tools: dict[str, str] = {}
    pins: dict[str, str] = {}
    for runtime in load(RUNTIMES)["runtimes"]:
        name = runtime["name"]
        tools[name] = version_in(name, output_of(runtime["version"]), runtime.get("pattern"))
        if runtime.get("pinArg"):
            pins[name] = os.environ[runtime["pinArg"]]
    for entry in load(INSTALLS)["entries"]:
        for provide in entry["provides"]:
            name = provide.get("name")
            if name is None:
                continue
            if name in tools:
                raise SystemExit(f"{name} is listed twice (runtimes.json and the install entry {entry['name']})")
            if "command" in provide:
                tools[name] = version_in(name, output_of(provide["command"]), provide.get("pattern"))
            else:
                tools[name] = library_version(name, provide.get("library", {}))
            if provide.get("pin"):
                pins[name] = provide["pin"]
    with open(SIDECAR_PROJECT, "rb") as handle:
        tools["quality-sidecar"] = tomllib.load(handle)["project"]["version"]
    with open(JGATES_PACKAGE, encoding="utf-8") as handle:
        package_version = json.load(handle)["version"]

    wrong = {name: {"found": tools.get(name), "pinned": pin} for name, pin in pins.items() if tools.get(name) != pin}
    if package_version != os.environ["JGATES_VERSION"]:
        wrong["jgates-package"] = {"found": package_version, "pinned": os.environ["JGATES_VERSION"]}
    if wrong:
        raise SystemExit(f"tool versions differ from their pins: {json.dumps(wrong, sort_keys=True)}")

    document = {
        "schemaVersion": 1,
        "jgatesVersion": os.environ["JGATES_VERSION"],
        "imageVersion": os.environ["IMAGE_VERSION"],
        "sourceRevision": os.environ["SOURCE_REVISION"],
        "architecture": platform.machine(),
        "stacks": ["python", "typescript", "javascript", "go", "rust", "dotnet"],
        "tools": dict(sorted(tools.items())),
        "pinned": sorted(pins),
        "runtimes": {
            "python": tools["python"],
            "node": tools["node"],
            "go": tools["go"],
            "rust": tools["rustc"],
            "dotnet": tools["dotnet"],
            "java": tools["java"],
        },
        "toolsPython": os.environ["TOOLS_PYTHON_VERSION"],
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
