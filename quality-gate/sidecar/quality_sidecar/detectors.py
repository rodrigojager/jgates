from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable

from . import pii
from .findings import Finding

SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".quality",
    ".venv",
    "venv",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    "__pycache__",
    "target",
}

TEXT_SUFFIXES = {
    ".c",
    ".cc",
    ".conf",
    ".config",
    ".cs",
    ".css",
    ".env",
    ".go",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".kt",
    ".md",
    ".php",
    ".ps1",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}

IAC_SUFFIXES = {
    ".tf",
    ".tfvars",
    ".hcl",
}

IAC_FILE_NAMES = {
    ".gitlab-ci.yml",
    "Chart.yaml",
    "Containerfile",
    "Dockerfile",
    "azure-pipelines.yml",
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
    "serverless.yaml",
    "serverless.yml",
}

SECRET_PATTERNS = [
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    (
        "assigned-secret",
        re.compile(
            r"(?i)\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*[\"']?([A-Za-z0-9_./+=-]{16,})"
        ),
    ),
]

# The PII rules live in pii.py, one per entity; this list keeps the legacy names for any reader of it.
PII_PATTERNS = [(name, pii.PATTERNS[name]) for name in pii.LEGACY_ENTITIES]


def relative_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def is_probably_text(path: Path) -> bool:
    if path.suffix.lower() in TEXT_SUFFIXES:
        return True
    try:
        chunk = path.read_bytes()[:2048]
    except OSError:
        return False
    return b"\0" not in chunk


def iter_project_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*"):
        if path.is_dir():
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        yield path


def iter_source_files(root: Path) -> Iterable[Path]:
    for path in iter_project_files(root):
        if is_probably_text(path):
            yield path


def detect_stack(root: Path) -> dict[str, object]:
    files = {path.name for path in root.iterdir() if path.is_file()}
    markers = {
        "node": ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
        "python": ["pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock"],
        "dotnet": ["global.json"],
        "go": ["go.mod"],
        "rust": ["Cargo.toml", "Cargo.lock"],
        "java": ["pom.xml", "build.gradle", "build.gradle.kts"],
        "php": ["composer.json", "composer.lock"],
        "ruby": ["Gemfile", "Gemfile.lock"],
    }
    detected: dict[str, list[str]] = {}
    for stack, names in markers.items():
        hits = sorted(name for name in names if name in files)
        if hits:
            detected[stack] = hits

    package_json = root / "package.json"
    frameworks: list[str] = []
    if package_json.exists():
        try:
            package = json.loads(package_json.read_text(encoding="utf-8"))
            deps = {
                **package.get("dependencies", {}),
                **package.get("devDependencies", {}),
            }
            for framework in ("react", "next", "vue", "svelte", "astro", "vite", "express", "nestjs"):
                if framework in deps or f"@{framework}/" in " ".join(deps):
                    frameworks.append(framework)
        except (OSError, json.JSONDecodeError):
            frameworks.append("node-unknown")

    return {
        "detected": sorted(detected),
        "markers": detected,
        "frameworks": sorted(set(frameworks)),
    }


def detect_iac_files(root: Path) -> list[str]:
    files: list[str] = []
    for path in iter_source_files(root):
        if is_iac_file(path, root):
            files.append(relative_path(path, root))
    return sorted(set(files))


def is_iac_file(path: Path, root: Path) -> bool:
    rel = relative_path(path, root)
    parts = path.relative_to(root).parts
    name = path.name
    suffix = path.suffix.lower()

    if name in IAC_FILE_NAMES or suffix in IAC_SUFFIXES or name.lower().endswith((".tf.json", ".tfvars.json")):
        return True
    if len(parts) >= 3 and parts[0] == ".github" and parts[1] == "workflows" and suffix in {".yaml", ".yml"}:
        return True
    if suffix not in {".yaml", ".yml", ".json", ".template"}:
        return False

    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:65536]
    except OSError:
        return False
    lower_rel = rel.lower()
    if "apiVersion:" in text and "kind:" in text:
        return True
    if "AWSTemplateFormatVersion" in text:
        return True
    if lower_rel.endswith((".template", ".template.json", ".template.yaml", ".template.yml")) and "Resources" in text:
        return True
    if "\nResources:" in f"\n{text}" and ("Type: AWS::" in text or '"Type"' in text and "AWS::" in text):
        return True
    return False


def detect_builtin_findings(
    root: Path,
    *,
    include_pii: bool = False,
    include_secrets: bool = False,
    pii_config: pii.PiiConfig | None = None,
) -> list[Finding]:
    """Built-in secret and PII rules over the text files of ``root`` (read-only).

    ``pii_config`` selects the PII entities, their severities and the optional validation; ``None`` is the
    default configuration, which reproduces the legacy detector (cpf, cnpj and credit-card).
    """
    findings: list[Finding] = []
    if not include_pii and not include_secrets:
        return findings
    pii_settings = pii_config or pii.default_config()

    for path in iter_source_files(root):
        rel = relative_path(path, root)
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue

        for line_number, line in enumerate(lines, start=1):
            if include_secrets:
                for rule, pattern in SECRET_PATTERNS:
                    if pattern.search(line):
                        findings.append(
                            Finding(
                                tool="builtin",
                                rule=f"secret.{rule}",
                                severity="critical",
                                category="secrets",
                                path=rel,
                                line=line_number,
                                message=f"Possible secret detected by built-in rule {rule}.",
                            )
                        )

            if include_pii:
                findings.extend(pii.line_findings(rel, line_number, line, pii_settings))

    return findings
