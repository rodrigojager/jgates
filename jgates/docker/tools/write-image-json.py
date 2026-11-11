"""Writes /etc/jgates/image.json at image build time and smoke-checks every tool of the image.

Every tool is asked for its version (its own version command, or the package metadata for the libraries the image
ships for runners); a tool whose version differs from its pin fails the build, and so does a tool that does not
answer. The pins are the build arguments of the Dockerfile (environment variables of this step), the `name==version`
lines of the Python lock inputs and the exact dependencies of the Node prefixes. Probes of the JGates CLI read the
written file instead of spawning the tools.
"""

import glob
import json
import os
import platform
import re
import subprocess
import sys
import tomllib

PYTHON_TOOLS = "/opt/tools/python"
PYTHON_LOCKS = "/opt/tools/locks/python"
NODE_TOOLS = "/opt/tools/node"
JGATES_PACKAGE = "/opt/jgates/jgates/package.json"
SIDECAR_PROJECT = "/opt/jgates/quality-gate/pyproject.toml"
VERSION = r"(\d+\.\d+(?:\.\d+)?)"

# name, command, pattern of the version in its output (default: the first dotted number). Sections of PLAN-image.md.
COMMANDS = [
    # 2.1 Base and shared runtime
    ("git", ["git", "--version"], None),
    ("curl", ["curl", "--version"], None),
    ("rsync", ["rsync", "--version"], None),
    ("tini", ["tini", "--version"], None),
    ("jq", ["jq", "--version"], None),
    ("unzip", ["unzip", "-v"], None),
    ("xz", ["xz", "--version"], None),
    ("gcc", ["gcc", "-dumpfullversion"], None),
    ("make", ["make", "--version"], None),
    ("pkg-config", ["pkg-config", "--version"], None),
    ("jgates", ["jgates", "--version"], r"jgates (\S+)"),
    # 2.2 Python
    ("python", ["python3", "--version"], None),
    ("uv", ["uv", "--version"], None),
    ("ruff", ["ruff", "--version"], None),
    ("mypy", ["mypy", "--version"], None),
    ("pytest", ["pytest", "--version"], None),
    ("coverage", ["coverage", "--version"], None),
    # mutmut reads its configuration first and needs a project with sources, even for --version.
    ("mutmut", ["sh", "-c", "mkdir -p /tmp/jgates-mutmut/src && cd /tmp/jgates-mutmut && mutmut --version"], None),
    ("import-linter", ["lint-imports", "--version"], None),
    ("schemathesis", ["schemathesis", "--version"], None),
    ("semgrep", ["semgrep", "--version"], None),
    ("checkov", ["checkov", "--version"], None),
    ("zizmor", ["zizmor", "--version"], None),
    # 2.3 TypeScript / JavaScript
    ("node", ["node", "--version"], None),
    ("npm", ["npm", "--version"], None),
    ("corepack", ["corepack", "--version"], None),
    ("typescript", ["tsc", "--version"], None),
    ("pyright", ["pyright", "--version"], None),
    ("eslint", ["eslint", "--version"], None),
    ("prettier", ["prettier", "--version"], None),
    ("vitest", ["vitest", "--version"], None),
    ("stryker", ["stryker", "--version"], None),
    ("jscpd", ["jscpd", "--version"], None),
    ("dependency-cruiser", ["depcruise", "--version"], None),
    # 2.4 Go, Rust and .NET
    ("go", ["go", "version"], None),
    ("golangci-lint", ["golangci-lint", "--version"], None),
    ("govulncheck", ["govulncheck", "-version"], r"govulncheck@v(\S+)"),
    ("rustup", ["rustup", "--version"], r"rustup (\d+\.\d+\.\d+)"),
    ("rustc", ["rustc", "--version"], None),
    ("cargo", ["cargo", "--version"], None),
    ("rustfmt", ["rustfmt", "--version"], None),
    ("clippy", ["cargo", "clippy", "--version"], None),
    ("cargo-audit", ["cargo", "audit", "--version"], None),
    ("cargo-llvm-cov", ["cargo", "llvm-cov", "--version"], None),
    ("dotnet", ["dotnet", "--version"], None),
    ("dotnet-format", ["dotnet", "format", "--version"], None),
    # Stryker.NET's --version names the project version of its dashboard: the tool answers --help, and its version is the
    # package folder of the tool store.
    ("dotnet-stryker", ["sh", "-c", "dotnet-stryker --help >/dev/null && ls /opt/dotnet-tools/.store/dotnet-stryker"], r"^(\d+\.\d+\.\d+)\s*$"),
    ("dotnet-ef", ["dotnet-ef", "--version"], r"^(\d+\.\d+\.\d+)\s*$"),
    # 2.5 Cross-stack security, API and runtime tools
    ("gitleaks", ["gitleaks", "version"], None),
    ("trivy", ["trivy", "--version"], None),
    ("osv-scanner", ["osv-scanner", "--version"], None),
    ("oasdiff", ["oasdiff", "--version"], None),
    ("java", ["java", "--version"], None),
    ("zap", ["zap.sh", "-cmd", "-version"], r"^(\d+\.\d+\.\d+)\s*$"),
    ("shellcheck", ["shellcheck", "--version"], r"version: (\S+)"),
    ("hadolint", ["hadolint", "--version"], None),
    ("squawk", ["squawk", "--version"], None),
]

# Libraries the image ships for the runners (no command of their own): name, environment, distribution.
PYTHON_LIBRARIES = [
    ("pytest-cov", "pytest", "pytest-cov"),
    ("hypothesis", "pytest", "hypothesis"),
    ("tomlkit", "quality-sidecar", "tomlkit"),
]
NODE_LIBRARIES = [
    ("typescript-eslint", "eslint", "typescript-eslint"),
    ("vitest-coverage-v8", "vitest", "@vitest/coverage-v8"),
    ("stryker-vitest-runner", "stryker", "@stryker-mutator/vitest-runner"),
    ("stryker-jest-runner", "stryker", "@stryker-mutator/jest-runner"),
    ("fast-check", "fast-check", "fast-check"),
]

# Tool name -> build argument holding its pin.
ENV_PINS = {
    "jgates": "JGATES_VERSION",
    "uv": "UV_VERSION",
    "node": "NODE_VERSION",
    "go": "GO_VERSION",
    "golangci-lint": "GOLANGCI_LINT_VERSION",
    "govulncheck": "GOVULNCHECK_VERSION",
    "rustup": "RUSTUP_VERSION",
    "rustc": "RUST_VERSION",
    "cargo": "RUST_VERSION",
    "cargo-audit": "CARGO_AUDIT_VERSION",
    "cargo-llvm-cov": "CARGO_LLVM_COV_VERSION",
    "dotnet": "DOTNET_SDK_VERSION",
    "gitleaks": "GITLEAKS_VERSION",
    "trivy": "TRIVY_VERSION",
    "osv-scanner": "OSV_SCANNER_VERSION",
    "oasdiff": "OASDIFF_VERSION",
    "java": "JAVA_VERSION",
    "zap": "ZAP_VERSION",
    "hadolint": "HADOLINT_VERSION",
    "squawk": "SQUAWK_VERSION",
    "dotnet-stryker": "DOTNET_STRYKER_VERSION",
    "dotnet-ef": "DOTNET_EF_VERSION",
}
# Tool name -> package whose locked version is its pin, when they differ.
PACKAGE_OF = {
    "stryker": "@stryker-mutator/core",
    "vitest-coverage-v8": "@vitest/coverage-v8",
    "stryker-vitest-runner": "@stryker-mutator/vitest-runner",
    "stryker-jest-runner": "@stryker-mutator/jest-runner",
}


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


def python_pins() -> dict[str, str]:
    pins: dict[str, str] = {}
    for path in glob.glob(f"{PYTHON_LOCKS}/*/*.in"):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                match = re.match(r"^([A-Za-z0-9_.\-]+)==(\S+)\s*$", line)
                if match:
                    pins[match.group(1).lower()] = match.group(2)
    return pins


def node_pins() -> dict[str, str]:
    pins: dict[str, str] = {}
    for path in glob.glob(f"{NODE_TOOLS}/*/package.json"):
        with open(path, encoding="utf-8") as handle:
            for package, version in json.load(handle).get("dependencies", {}).items():
                if pins.get(package, version) != version:
                    raise SystemExit(f"{package} is pinned to {pins[package]} and {version} in different prefixes")
                pins[package] = version
    return pins


def python_library(env: str, distribution: str) -> str:
    python = f"{PYTHON_TOOLS}/{env}/bin/python"
    return output_of([python, "-c", f"import importlib.metadata as m; print(m.version({distribution!r}))"]).strip()


def node_library(prefix: str, package: str) -> str:
    with open(f"{NODE_TOOLS}/{prefix}/node_modules/{package}/package.json", encoding="utf-8") as handle:
        return json.load(handle)["version"]


def main() -> None:
    target = sys.argv[1]
    os.makedirs(os.environ.get("HOME", "/tmp/jgates-smoke"), exist_ok=True)
    tools: dict[str, str] = {}
    for name, argv, pattern in COMMANDS:
        tools[name] = version_in(name, output_of(argv), pattern)
    for name, env, distribution in PYTHON_LIBRARIES:
        tools[name] = python_library(env, distribution)
    for name, prefix, package in NODE_LIBRARIES:
        tools[name] = node_library(prefix, package)
    with open(SIDECAR_PROJECT, "rb") as handle:
        tools["quality-sidecar"] = tomllib.load(handle)["project"]["version"]
    with open(JGATES_PACKAGE, encoding="utf-8") as handle:
        package_version = json.load(handle)["version"]

    pins: dict[str, str] = {name: os.environ[variable] for name, variable in ENV_PINS.items()}
    locked = {**python_pins(), **node_pins()}
    for name in tools:
        package = PACKAGE_OF.get(name, name)
        if name not in pins and package in locked:
            pins[name] = locked[package]
    wrong = {name: {"found": tools[name], "pinned": pin} for name, pin in pins.items() if tools.get(name) != pin}
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
