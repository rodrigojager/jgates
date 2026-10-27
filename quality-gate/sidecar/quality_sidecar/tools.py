from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

import defusedxml.ElementTree as ET

from .detectors import detect_iac_files
from .findings import Finding, normalize_severity


@dataclass
class ToolResult:
    name: str
    status: str
    command: list[str] = field(default_factory=list)
    exit_code: int | None = None
    duration_ms: int = 0
    output_path: str | None = None
    stdout_path: str | None = None
    stderr_path: str | None = None
    error: str | None = None
    summary: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Scanners whose configuration file the JGates bridge may replace in local mode (the binding ids of the
# quality-bridge instance in .jgates/tools.yml). Every other scanner keeps the trusted package configuration.
CONFIGURABLE_TOOLS = ("gitleaks", "trivy", "osv-scanner")


class ToolConfigError(Exception):
    """A configuration file the local bridge cannot honor. Never ignored: the bridge answers with this error."""

    def __init__(self, code: str, message: str, *, tool: str | None = None, path: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.tool = tool
        self.path = path


@dataclass(frozen=True)
class LocalToolOptions:
    """Choices only the local JGates bridge passes (no flag of quality-gate reaches them, so governed mode keeps the trusted configuration).

    ``configs`` maps a scanner of CONFIGURABLE_TOOLS to its project configuration file (already resolved inside the
    target by ``resolve_local_tool_configs``); a scanner without an entry keeps the trusted package file.
    ``subchecks`` lists the external tools to run; ``None`` keeps the legacy behavior (every tool of the mode).
    """

    configs: dict[str, Path] = field(default_factory=dict)
    subchecks: frozenset[str] | None = None
    # The governed CI path (jgates ci): MegaLinter runs only the linters of megalinter-linters.json that are not
    # excluded, each with the arguments that force the trusted configuration and turn suppressions off.
    hardened: bool = False


def resolve_local_tool_configs(root: Path, requested: Any) -> dict[str, Path]:
    """Resolves the configuration files the bridge request names. Paths are relative to the target (or absolute) and
    must stay inside it after following symlinks; the file must exist. Anything else raises ToolConfigError."""
    if requested is None:
        return {}
    if not isinstance(requested, dict):
        raise ToolConfigError("invalid-request", "toolConfigs must be an object")
    root_real = root.resolve()
    resolved: dict[str, Path] = {}
    for tool, value in requested.items():
        if tool not in CONFIGURABLE_TOOLS:
            raise ToolConfigError(
                "invalid-request",
                f"toolConfigs.{tool} is not configurable; allowed: {', '.join(CONFIGURABLE_TOOLS)}",
                tool=str(tool),
            )
        if not isinstance(value, str) or not value or "\0" in value:
            raise ToolConfigError("invalid-request", f"toolConfigs.{tool} must be a non-empty path", tool=tool)
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = root_real / candidate
        real = candidate.resolve()
        try:
            real.relative_to(root_real)
        except ValueError:
            raise ToolConfigError(
                "config-outside-target",
                f"the {tool} configuration {value} is outside the workspace root {root_real}",
                tool=tool,
                path=value,
            ) from None
        if not real.is_file():
            raise ToolConfigError("config-missing", f"the {tool} configuration {value} is not a file", tool=tool, path=value)
        resolved[tool] = real
    return resolved


def _config_choice(local: LocalToolOptions | None, tool: str, trusted: str) -> tuple[str, dict[str, str]]:
    """The configuration file a scanner runs with, and how the report describes it."""
    chosen = local.configs.get(tool) if local else None
    if chosen is not None:
        return str(chosen), {"source": "project", "path": str(chosen)}
    return trusted, {"source": "package", "path": trusted}


def _relative(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", errors="replace")


def _command_exists(command: str) -> bool:
    return Path(command).exists() if "/" in command else shutil.which(command) is not None


def _resolve_command(command: str) -> str | None:
    if "/" in command or "\\" in command:
        return command if Path(command).exists() else None
    return shutil.which(command)


def run_command(
    name: str,
    command: list[str],
    output_dir: Path,
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    timeout_seconds: int = 1800,
    acceptable_exit_codes: set[int] | None = None,
    output_path: Path | None = None,
    inherit_environment: bool = False,
) -> ToolResult:
    acceptable = acceptable_exit_codes if acceptable_exit_codes is not None else {0}
    executable = command[0]
    resolved_executable = _resolve_command(executable)
    if not resolved_executable:
        return ToolResult(name=name, status="missing", command=command, error=f"Command not found: {executable}")
    resolved_command = [resolved_executable, *command[1:]]

    stdout_path = output_dir / f"{name}.stdout.log"
    stderr_path = output_dir / f"{name}.stderr.log"
    started = time.perf_counter()
    try:
        result = subprocess.run(
            resolved_command,
            cwd=str(cwd),
            env=_subprocess_environment(env, inherit=inherit_environment),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        duration_ms = int((time.perf_counter() - started) * 1000)
        _write_text(stdout_path, error.stdout or "")
        _write_text(stderr_path, error.stderr or f"Timed out after {timeout_seconds} seconds.")
        return ToolResult(
            name=name,
            status="timeout",
            command=resolved_command,
            duration_ms=duration_ms,
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            error=f"Timed out after {timeout_seconds} seconds.",
        )
    except OSError as error:
        duration_ms = int((time.perf_counter() - started) * 1000)
        return ToolResult(name=name, status="error", command=resolved_command, duration_ms=duration_ms, error=str(error))

    duration_ms = int((time.perf_counter() - started) * 1000)
    _write_text(stdout_path, result.stdout)
    _write_text(stderr_path, result.stderr)
    status = "ok" if result.returncode in acceptable else "error"
    if result.returncode not in acceptable:
        error = f"Exit code {result.returncode}"
    else:
        error = None

    return ToolResult(
        name=name,
        status=status,
        command=resolved_command,
        exit_code=result.returncode,
        duration_ms=duration_ms,
        output_path=str(output_path) if output_path else None,
        stdout_path=str(stdout_path),
        stderr_path=str(stderr_path),
        error=error,
    )


SAFE_SUBPROCESS_ENV_NAMES = {
    "ALL_PROXY",
    "COMSPEC",
    "CURL_CA_BUNDLE",
    "DOTNET_ROOT",
    "GIT_SSL_CAINFO",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOCALAPPDATA",
    "NODE_EXTRA_CA_CERTS",
    "NO_COLOR",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PYTHONIOENCODING",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
    "XDG_CACHE_HOME",
}


def _subprocess_environment(overrides: dict[str, str] | None, *, inherit: bool) -> dict[str, str]:
    """Build a least-privilege environment for analyzers.

    Project-owned test commands are the sole opt-in caller that inherits the
    complete environment. Security analyzers receive only runtime, locale,
    proxy, and CA settings plus values supplied by this package itself.
    """
    if inherit:
        environment = dict(os.environ)
    else:
        allowed = {name.upper() for name in SAFE_SUBPROCESS_ENV_NAMES}
        environment = {name: value for name, value in os.environ.items() if name.upper() in allowed}
    environment.setdefault("PYTHONIOENCODING", "utf-8")
    environment.setdefault("NO_COLOR", "1")
    environment.update(overrides or {})
    return environment


def run_external_tools(
    root: Path,
    reports_dir: Path,
    mode: str,
    *,
    enable_secrets: bool = False,
    enable_iac: bool = True,
    run_project_tests: bool = False,
    local: LocalToolOptions | None = None,
) -> tuple[list[ToolResult], list[Finding]]:
    if mode in {"quick", "offline"}:
        return [], []
    requested = local.subchecks if local else None

    raw_dir = reports_dir / "raw"
    _prepare_raw_dir(raw_dir)
    results: list[ToolResult] = []
    findings: list[Finding] = []
    iac_files = detect_iac_files(root)
    _quality_gate_flavor()  # fail early on an unsupported flavor

    tool_specs = [
        (
            "megalinter",
            lambda current_root, current_raw: _run_megalinter(
                current_root, current_raw, hardened=bool(local and local.hardened)
            ),
        ),
        ("semgrep", lambda current_root, current_raw: _run_semgrep(current_root, current_raw)),
        (
            "gitleaks",
            lambda current_root, current_raw: _run_gitleaks(current_root, current_raw, local=local)
            if enable_secrets
            else ToolResult(
                name="gitleaks",
                status="skipped",
                summary={"reason": "Secrets scanning disabled. Use --enable-secrets to run Gitleaks."},
            ),
        ),
        (
            "trivy",
            lambda current_root, current_raw: _run_trivy(current_root, current_raw, enable_secrets=enable_secrets, local=local),
        ),
        (
            "checkov",
            lambda current_root, current_raw: _run_checkov(current_root, current_raw, iac_files)
            if enable_iac and iac_files
            else ToolResult(
                name="checkov",
                status="skipped",
                summary={
                    "reason": "IaC scanning disabled by --disable-iac."
                    if not enable_iac
                    else "No IaC files detected.",
                    "iacFiles": len(iac_files),
                },
            ),
        ),
        ("osv-scanner", lambda current_root, current_raw: _run_osv_scanner(current_root, current_raw, local=local)),
        ("jscpd", lambda current_root, current_raw: _run_jscpd(current_root, current_raw)),
    ]
    for name, runner in tool_specs:
        if requested is not None and name not in requested:
            # The reviewed plan turned this subcheck off: it does not run at all (no time, no network).
            results.append(ToolResult(name=name, status="skipped", summary={"reason": "Not requested by the plan.", "findings": 0}))
            continue
        result = runner(root, raw_dir)
        parsed_findings = parse_tool_findings(name, result, root)
        if parsed_findings and result.status == "ok":
            result.status = "findings"
        result.summary["findings"] = len(parsed_findings)
        results.append(result)
        findings.extend(parsed_findings)

    if run_project_tests and (requested is None or "project-tests" in requested):
        test_result, test_findings = _run_project_tests(root, raw_dir)
        if test_result:
            results.append(test_result)
            findings.extend(test_findings)

    return results, findings


RAW_EVIDENCE_MARKER = ".jgates-quality-gate-owned"
RAW_EVIDENCE_FILES = {
    "checkov.json",
    "gitleaks.json",
    "osv-scanner.json",
    "semgrep.json",
    "trivy.json",
    *{
        f"{tool}.{stream}.log"
        for tool in (
            "checkov",
            "gitleaks",
            "jscpd",
            "megalinter",
            "osv-scanner",
            "project-tests",
            "semgrep",
            "trivy",
        )
        for stream in ("stdout", "stderr")
    },
}
RAW_EVIDENCE_DIRS = {"jscpd", "megalinter"}


def _prepare_raw_dir(raw_dir: Path) -> None:
    if raw_dir.is_symlink():
        raise RuntimeError(f"Refusing unsafe raw evidence directory symlink: {raw_dir}")
    raw_dir.mkdir(parents=True, exist_ok=True)
    marker = raw_dir / RAW_EVIDENCE_MARKER
    if marker.is_symlink():
        raise RuntimeError(f"Refusing unsafe raw evidence marker symlink: {marker}")

    for name in RAW_EVIDENCE_FILES | RAW_EVIDENCE_DIRS:
        path = raw_dir / name
        if path.is_symlink():
            raise RuntimeError(f"Refusing unsafe raw evidence output symlink: {path}")

    if marker.is_file():
        for name in RAW_EVIDENCE_FILES:
            path = raw_dir / name
            if path.is_file():
                path.unlink()
        for name in RAW_EVIDENCE_DIRS:
            path = raw_dir / name
            if path.is_file():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)

    marker.write_text("Owned by the JGates quality gate.\n", encoding="utf-8")


MEGALINTER_ENABLED_LINTERS = ",".join(
    [
        "ACTION_ACTIONLINT",
        "BASH_SHELLCHECK",
        "CSHARP_CSHARPIER",
        "CSHARP_DOTNET_FORMAT",
        "CSHARP_ROSLYNATOR",
        "DOCKERFILE_HADOLINT",
        "HTML_HTMLHINT",
        "JAVASCRIPT_ES",
        "MARKDOWN_MARKDOWNLINT",
        "POWERSHELL_POWERSHELL",
        "TYPESCRIPT_STANDARD",
        "XML_XMLLINT",
        "YAML_YAMLLINT",
    ]
)

MEGALINTER_GENERIC_DUPLICATE_LINTERS = ",".join(
    [
        "COPYPASTE_JSCPD",
        "REPOSITORY_CHECKOV",
        "REPOSITORY_GIT_DIFF",
        "REPOSITORY_GITLEAKS",
        "REPOSITORY_OSV_SCANNER",
        "REPOSITORY_SEMGREP",
        "REPOSITORY_TRIVY",
        # The upstream packages have no release that fixes the critical
        # transitive dependencies removed from the published image.
        "GHERKIN_GHERKIN_LINT",
        "SQL_TSQLLINT",
    ]
)

INSTALLED_CONFIG_DIR = Path("/opt/quality-sidecar/sidecar/config")
SOURCE_CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"
MEGALINTER_CONFIG_DIR = (INSTALLED_CONFIG_DIR if INSTALLED_CONFIG_DIR.is_dir() else SOURCE_CONFIG_DIR).resolve()
MEGALINTER_ESLINT_CONFIG_DIR = str(MEGALINTER_CONFIG_DIR)
ESLINT_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "eslint.config.mjs")
MEGALINTER_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "megalinter-ci.yml")
CHECKOV_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "checkov-ci.yml")
GITLEAKS_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "gitleaks-ci.toml")
GITLEAKS_TRUSTED_IGNORE = str(MEGALINTER_CONFIG_DIR / "gitleaksignore-ci")
JSCPD_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "jscpd-ci.json")
OSV_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "osv-scanner-ci.toml")
TRIVY_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "trivy-ci.yaml")
TRIVY_TRUSTED_IGNORE = str(MEGALINTER_CONFIG_DIR / "trivyignore-ci")
TFLINT_TRUSTED_CONFIG = str(MEGALINTER_CONFIG_DIR / "tflint-ci.hcl")
QUALITY_GATE_FLAVOR_FILE = Path("/etc/jgates/quality-gate-flavor")


def _quality_gate_flavor() -> str:
    if QUALITY_GATE_FLAVOR_FILE.is_file():
        try:
            flavor = QUALITY_GATE_FLAVOR_FILE.read_text(encoding="utf-8").strip().lower()
        except OSError as error:
            raise RuntimeError(f"Unable to read baked quality-gate flavor: {error}") from error
    else:
        # Source-checkout fallback for local development and unit tests. The
        # production image always contains the root-owned file above.
        flavor = os.environ.get("QUALITY_GATE_FLAVOR", "generic").strip().lower()

    if flavor not in {"generic", "dotnetweb"}:
        raise RuntimeError(f"Unsupported quality-gate flavor: {flavor or '<empty>'}")
    return flavor


MEGALINTER_LINTERS_FILE = MEGALINTER_CONFIG_DIR / "megalinter-linters.json"
CI_TREATMENTS = ("trusted", "self-reported", "excluded")


def load_megalinter_linters(path: Path | None = None) -> list[dict[str, Any]]:
    """The linters of megalinter-linters.json (id, configuration, suppressions, jgates ci treatment). Raises on a
    malformed list: the governed path never runs MegaLinter with a list it cannot read."""
    source = path or MEGALINTER_LINTERS_FILE
    document = json.loads(source.read_text(encoding="utf-8"))
    linters = document.get("linters") if isinstance(document, dict) else None
    if document.get("schemaVersion") != 1 or not isinstance(linters, list) or not linters:
        raise RuntimeError(f"{source}: a schemaVersion 1 document with a non-empty linters list is expected")
    seen: set[str] = set()
    for linter in linters:
        if not isinstance(linter, dict) or not isinstance(linter.get("id"), str) or linter.get("ci") not in CI_TREATMENTS:
            raise RuntimeError(f"{source}: every linter needs an id and a ci treatment ({', '.join(CI_TREATMENTS)})")
        if linter["id"] in seen:
            raise RuntimeError(f"{source}: {linter['id']} is listed twice")
        seen.add(linter["id"])
    return linters


def megalinter_hardened_env(flavor: str, linters: list[dict[str, Any]] | None = None) -> dict[str, str]:
    """What jgates ci adds to MegaLinter's environment: ENABLE_LINTERS closed to the linters the list does not exclude
    (only those this flavor ships, for the dotnetweb flavor) and the arguments that force each one's configuration."""
    entries = linters if linters is not None else load_megalinter_linters()
    allowed = [entry for entry in entries if entry["ci"] != "excluded"]
    if flavor == "dotnetweb":
        shipped = set(MEGALINTER_ENABLED_LINTERS.split(","))
        allowed = [entry for entry in allowed if entry["id"] in shipped]
    env = {"ENABLE_LINTERS": ",".join(entry["id"] for entry in allowed)}
    for entry in allowed:
        arguments = entry.get("ciArguments")
        if isinstance(arguments, str) and arguments:
            env[f"{entry['id']}_ARGUMENTS"] = arguments.replace("{configDir}", str(MEGALINTER_CONFIG_DIR))
    return env


def _run_megalinter(root: Path, raw_dir: Path, *, hardened: bool = False) -> ToolResult:
    configured = None if hardened else os.environ.get("MEGALINTER_COMMAND")
    command = [configured] if configured else ["/entrypoint.sh"]
    env = {
        "DEFAULT_WORKSPACE": str(root),
        "GITHUB_WORKSPACE": str(root),
        "REPORT_OUTPUT_FOLDER": str(raw_dir / "megalinter"),
        "VALIDATE_ALL_CODEBASE": "true",
        "APPLY_FIXES": "none",
        "PRINT_ALL_FILES": "false",
        "SHOW_ELAPSED_TIME": "true",
        # MegaLinter otherwise treats formatter failures as warnings. The
        # quality gate must reject unformatted code instead of silently
        # approving it as a successful analyzer run.
        "FORMATTERS_DISABLE_ERRORS": "false",
        # These cache paths are image-owned policy, not job-controlled input.
        # MegaLinter's base image otherwise points NuGet at a root-only cache,
        # causing dotnet-format restore to fail under UID 10001.
        "DOTNET_CLI_HOME": "/home/quality",
        "NUGET_HTTP_CACHE_PATH": "/home/quality/.cache/NuGet/v3-cache",
        "NUGET_PACKAGES": "/home/quality/.nuget/packages",
        "FILTER_REGEX_EXCLUDE": _megalinter_exclude_regex(root),
        "MEGALINTER_CONFIG": MEGALINTER_TRUSTED_CONFIG,
        # DevSkim is a project-mode analyzer and scans the workspace directly,
        # so MegaLinter's file-list filter does not protect it from reports
        # produced concurrently by other analyzers. Keep gate-owned output out
        # of scope to prevent findings against the generated CycloneDX SBOM.
        "REPOSITORY_DEVSKIM_ARGUMENTS": (
            "--ignore-globs **/.git/**,**/megalinter-reports/**,**/.quality/**"
        ),
        # MegaLinter's activation probe prepends the workspace even when a
        # rules path is absolute. A generated relative path reaches the same
        # root-owned config from arbitrary GitLab checkout locations.
        "JAVASCRIPT_ES_RULES_PATH": _megalinter_rules_path(root),
        "JAVASCRIPT_ES_CONFIG_FILE": "eslint.config.mjs",
        # An explicit absolute --config prevents a project file with the same
        # name from winning MegaLinter's normal workspace-first lookup.
        "JAVASCRIPT_ES_ARGUMENTS": f"--config {ESLINT_TRUSTED_CONFIG} --no-ignore --no-inline-config",
        "TERRAFORM_TFLINT_RULES_PATH": str(MEGALINTER_CONFIG_DIR),
        "TERRAFORM_TFLINT_CONFIG_FILE": Path(TFLINT_TRUSTED_CONFIG).name,
    }
    # The portable flavor retains MegaLinter's language auto-detection. The
    # smaller dotnetweb flavor is deliberately constrained to linters shipped
    # by that base image so a missing analyzer is an operational error rather
    # than an accidental cross-language promise.
    if hardened:
        # jgates ci: a closed list, never MegaLinter's auto-detection, and no linter the list does not verify.
        env.pop("DISABLE_LINTERS", None)
        env.update(megalinter_hardened_env(_quality_gate_flavor()))
    elif _quality_gate_flavor() == "dotnetweb":
        env["ENABLE_LINTERS"] = MEGALINTER_ENABLED_LINTERS
    else:
        # These analyzers run as first-class sidecar tools with normalized
        # findings. Git diff is also incompatible with the metadata-free
        # workspace projection used by the GitLab container contract. Retain
        # automatic language linter discovery in the portable image.
        env["DISABLE_LINTERS"] = MEGALINTER_GENERIC_DUPLICATE_LINTERS
    result = run_command(
        "megalinter",
        command,
        raw_dir,
        cwd=root,
        env=env,
        acceptable_exit_codes={0, 1},
        output_path=raw_dir / "megalinter",
    )
    output_directory = Path(result.output_path or "")
    evidence_logs = _megalinter_evidence_logs(output_directory)
    if result.status not in {"missing", "timeout", "error"} and not evidence_logs:
        result.status = "error"
        result.error = "MegaLinter did not produce the required per-analyzer execution logs."
        result.summary["evidenceValid"] = False
        return result
    if evidence_logs:
        result.summary["evidenceValid"] = True
        result.summary["executedAnalyzers"] = sorted(
            {
                path.stem.removesuffix("-SUCCESS").removesuffix("-ERROR").removesuffix("-suggestions")
                for path in evidence_logs
            }
        )
    if result.exit_code == 1:
        error_logs = _megalinter_error_logs(output_directory)
        fatal_logs = [
            path
            for path in error_logs
            if any(
                marker in _read_text(path)
                for marker in ("Fatal error while calling", "Failed to initialize plugins")
            )
        ]
        if not error_logs:
            result.status = "error"
            result.error = "MegaLinter failed without producing analyzer logs."
        elif fatal_logs:
            result.status = "error"
            result.error = "One or more MegaLinter analyzers could not start."
            result.summary["fatalAnalyzers"] = [path.stem.removesuffix("-ERROR") for path in fatal_logs]
        else:
            result.status = "findings"
        result.summary["failedAnalyzers"] = [path.stem.removesuffix("-ERROR") for path in error_logs]
    return result


def _megalinter_exclude_regex(root: Path) -> str:
    # Match dependency/output directories only below the analyzed root. A
    # plain `tmp/` expression also matched the `/tmp/...` smoke/GitLab mount
    # prefix and silently reduced MegaLinter to a zero-file run. Windows may
    # expose the same temporary directory through short and canonical path
    # spellings, so accept both without broadening the match outside the root.
    root_candidates = {
        (root if root.is_absolute() else root.absolute()).as_posix().rstrip("/") or "/",
        root.resolve().as_posix().rstrip("/") or "/",
    }
    directory_suffix = r"(?:.*?/)?(?:\.quality|node_modules|coverage|dist|tmp)(?:/|$)"
    alternatives = [
        rf"{'' if candidate == '/' else re.escape(candidate)}/{directory_suffix}"
        for candidate in sorted(root_candidates)
    ]
    return rf"^(?:{'|'.join(alternatives)})"


def _megalinter_rules_path(root: Path) -> str:
    """Return a relative config path when the host filesystem permits it."""

    try:
        return os.path.relpath(MEGALINTER_CONFIG_DIR, root)
    except ValueError:
        # Windows cannot express a relative path across drive letters. This
        # branch is useful for source-tree tests/local invocation; the Linux
        # production image always takes the relative-path branch above.
        return str(MEGALINTER_CONFIG_DIR)


def _megalinter_error_logs(output_dir: Path) -> list[Path]:
    logs_dir = output_dir / "linters_logs"
    return sorted(logs_dir.glob("*-ERROR.log")) if logs_dir.is_dir() else []


def _megalinter_evidence_logs(output_dir: Path) -> list[Path]:
    logs_dir = output_dir / "linters_logs"
    if not logs_dir.is_dir() or logs_dir.is_symlink():
        return []
    return sorted(
        path
        for path in logs_dir.glob("*.log")
        if path.is_file() and not path.is_symlink() and path.stat().st_size > 0 and not path.name.endswith("-suggestions.log")
    )


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _run_semgrep(root: Path, raw_dir: Path) -> ToolResult:
    output = raw_dir / "semgrep.json"
    result = run_command(
        "semgrep",
        [
            "semgrep",
            "scan",
            "--config=p/default",
            "--metrics=off",
            "--no-git-ignore",
            "--x-ignore-semgrepignore-files",
            "--disable-nosem",
            "--exclude",
            ".git",
            "--exclude",
            ".quality",
            "--exclude",
            "node_modules",
            "--json",
            "--output",
            str(output),
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )
    result.summary["analysisInput"] = {
        "kind": "ruleset",
        "source": "semgrep-registry:p/default",
        "pinned": False,
        "networkRequired": True,
    }
    return result


def _run_gitleaks(root: Path, raw_dir: Path, *, local: LocalToolOptions | None = None) -> ToolResult:
    output = raw_dir / "gitleaks.json"
    config, config_summary = _config_choice(local, "gitleaks", GITLEAKS_TRUSTED_CONFIG)
    # Only the rules file changes in local mode: redaction, the trusted ignore file and --ignore-gitleaks-allow stay.
    result = run_command(
        "gitleaks",
        [
            "gitleaks",
            "--redact=100",
            "--no-banner",
            "--config",
            config,
            "--gitleaks-ignore-path",
            GITLEAKS_TRUSTED_IGNORE,
            "--ignore-gitleaks-allow",
            "--report-format",
            "json",
            "--report-path",
            str(output),
            "dir",
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )
    result.summary["config"] = config_summary
    return result


def _run_trivy(root: Path, raw_dir: Path, *, enable_secrets: bool, local: LocalToolOptions | None = None) -> ToolResult:
    output = raw_dir / "trivy.json"
    scanners = "vuln,misconfig,secret" if enable_secrets else "vuln,misconfig"
    skipped_directories = [root / name for name in (".git", ".quality", "node_modules", "vendor")]
    skip_args = [argument for directory in skipped_directories for argument in ("--skip-dirs", str(directory))]
    config, config_summary = _config_choice(local, "trivy", TRIVY_TRUSTED_CONFIG)
    result = run_command(
        "trivy",
        [
            "trivy",
            "--config",
            config,
            "fs",
            "--ignorefile",
            TRIVY_TRUSTED_IGNORE,
            "--show-suppressed",
            "--scanners",
            scanners,
            "--format",
            "json",
            "--output",
            str(output),
            "--exit-code",
            "0",
            *skip_args,
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0},
        output_path=output,
    )
    result.summary["analysisInput"] = {
        "kind": "vulnerability-database",
        "source": "ghcr.io/aquasecurity/trivy-db",
        "pinned": False,
        "networkRequired": True,
    }
    result.summary["config"] = config_summary
    return result


def _copy_stdout_to_output(result: ToolResult, output: Path) -> None:
    stdout_path = Path(result.stdout_path) if result.stdout_path else None
    if stdout_path and stdout_path.exists():
        output.write_text(stdout_path.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")


def _run_checkov(root: Path, raw_dir: Path, iac_files: list[str]) -> ToolResult:
    output = raw_dir / "checkov.json"
    result = run_command(
        "checkov",
        [
            "checkov",
            "--config-file",
            CHECKOV_TRUSTED_CONFIG,
            f"--directory={root}",
            "--output",
            "json",
            "--quiet",
            "--skip-download",
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )
    _copy_stdout_to_output(result, output)
    result.summary["iacFiles"] = len(iac_files)
    result.summary["iacFileSamples"] = iac_files[:20]
    return result


def _run_osv_scanner(root: Path, raw_dir: Path, *, local: LocalToolOptions | None = None) -> ToolResult:
    output = raw_dir / "osv-scanner.json"
    config, config_summary = _config_choice(local, "osv-scanner", OSV_TRUSTED_CONFIG)
    result = run_command(
        "osv-scanner",
        [
            "osv-scanner",
            "scan",
            "source",
            "--recursive",
            "--no-ignore",
            "--allow-no-lockfiles",
            "--config",
            config,
            "--format",
            "json",
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output,
    )
    _copy_stdout_to_output(result, output)
    stderr_path = Path(result.stderr_path) if result.stderr_path else None
    stderr_text = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path and stderr_path.exists() else ""
    if result.status == "error" and "No package sources found" in stderr_text:
        output.write_text('{"results":[]}\n', encoding="utf-8")
        result.status = "ok"
        result.exit_code = 0
        result.error = None
    result.summary["analysisInput"] = {
        "kind": "vulnerability-database",
        "source": "osv.dev",
        "pinned": False,
        "networkRequired": True,
    }
    result.summary["config"] = config_summary
    return result


def _run_jscpd(root: Path, raw_dir: Path) -> ToolResult:
    output_dir = raw_dir / "jscpd"
    result = run_command(
        "jscpd",
        [
            "jscpd",
            "--config",
            JSCPD_TRUSTED_CONFIG,
            "--no-gitignore",
            "--silent",
            "--reporters",
            "json",
            "--ignore",
            "**/*.md,**/.quality/**,**/node_modules/**,**/obj/**,**/bin/**,.quality/**,node_modules/**,obj/**,bin/**",
            "--output",
            str(output_dir),
            str(root),
        ],
        raw_dir,
        cwd=MEGALINTER_CONFIG_DIR,
        acceptable_exit_codes={0, 1},
        output_path=output_dir / "jscpd-report.json",
    )
    report = output_dir / "jscpd-report.json"
    # The exact reporter contract is deliberate. Picking an arbitrary JSON
    # file could normalize unrelated or attacker-controlled evidence.
    result.output_path = str(report)
    return result


SUPPORTED_COVERAGE_PATTERNS = [
    "coverage/lcov.info",
    "lcov.info",
    "coverage.xml",
    "coverage/coverage.xml",
    "**/coverage.cobertura.xml",
    "TestResults/**/coverage.cobertura.xml",
    "target/site/jacoco/jacoco.xml",
    "build/reports/jacoco/test/jacocoTestReport.xml",
    "coverage.out",
    "clover.xml",
    "coverage/clover.xml",
]


@dataclass
class CoverageMetrics:
    line_covered: int = 0
    line_total: int = 0
    branch_covered: int = 0
    branch_total: int = 0

    def add(self, other: "CoverageMetrics") -> None:
        self.line_covered += other.line_covered
        self.line_total += other.line_total
        self.branch_covered += other.branch_covered
        self.branch_total += other.branch_total

    @property
    def line_percent(self) -> float | None:
        if self.line_total <= 0:
            return None
        return self.line_covered / self.line_total * 100

    @property
    def branch_percent(self) -> float | None:
        if self.branch_total <= 0:
            return None
        return self.branch_covered / self.branch_total * 100


def run_coverage_check(
    root: Path,
    reports_dir: Path,
    *,
    report_paths: list[str],
    min_line_coverage: float,
    min_branch_coverage: float | None,
) -> tuple[ToolResult, list[Finding]]:
    raw_dir = reports_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    coverage_files = _resolve_coverage_reports(root, report_paths)
    if not coverage_files:
        return (
            ToolResult(
                name="coverage",
                status="missing",
                summary={
                    "reason": "Coverage was enabled, but no supported coverage report was found.",
                    "searched": report_paths or SUPPORTED_COVERAGE_PATTERNS,
                    "expectedFormats": ["lcov", "cobertura", "jacoco", "clover", "go-coverprofile"],
                },
            ),
            [],
        )

    metrics = CoverageMetrics()
    parsed_files: list[str] = []
    errors: list[str] = []
    for report in coverage_files:
        try:
            report_metrics = _parse_coverage_report(report)
        except (OSError, ET.ParseError, ValueError) as error:
            errors.append(f"{_relative(report, root)}: {error}")
            continue
        if report_metrics.line_total > 0 or report_metrics.branch_total > 0:
            metrics.add(report_metrics)
            parsed_files.append(_relative(report, root))

    if errors and not parsed_files:
        return (
            ToolResult(
                name="coverage",
                status="error",
                summary={"reason": "Coverage reports could not be parsed.", "errors": errors},
            ),
            [],
        )
    if metrics.line_percent is None:
        return (
            ToolResult(
                name="coverage",
                status="error",
                summary={"reason": "Coverage reports did not contain line coverage data.", "files": parsed_files, "errors": errors},
            ),
            [],
        )

    summary: dict[str, Any] = {
        "files": parsed_files,
        "lineCoverage": round(metrics.line_percent, 2),
        "lineCovered": metrics.line_covered,
        "lineTotal": metrics.line_total,
        "minLineCoverage": min_line_coverage,
    }
    if metrics.branch_percent is not None:
        summary.update(
            {
                "branchCoverage": round(metrics.branch_percent, 2),
                "branchCovered": metrics.branch_covered,
                "branchTotal": metrics.branch_total,
            }
        )
    if min_branch_coverage is not None:
        summary["minBranchCoverage"] = min_branch_coverage
    if errors:
        summary["parseWarnings"] = errors

    if min_branch_coverage is not None and metrics.branch_percent is None:
        return (
            ToolResult(
                name="coverage",
                status="error",
                summary={
                    **summary,
                    "reason": "Branch coverage threshold was requested, but no branch coverage data was found.",
                },
            ),
            [],
        )

    findings: list[Finding] = []
    if metrics.line_percent < min_line_coverage:
        findings.append(
            Finding(
                tool="coverage",
                rule="coverage.line-threshold",
                severity="high",
                category="coverage",
                message=(
                    f"Line coverage {metrics.line_percent:.2f}% is below required "
                    f"{min_line_coverage:.2f}%."
                ),
                metadata=summary,
            )
        )
    if min_branch_coverage is not None and metrics.branch_percent is not None and metrics.branch_percent < min_branch_coverage:
        findings.append(
            Finding(
                tool="coverage",
                rule="coverage.branch-threshold",
                severity="high",
                category="coverage",
                message=(
                    f"Branch coverage {metrics.branch_percent:.2f}% is below required "
                    f"{min_branch_coverage:.2f}%."
                ),
                metadata=summary,
            )
        )

    return ToolResult(name="coverage", status="findings" if findings else "ok", summary=summary), findings


def _resolve_coverage_reports(root: Path, report_paths: list[str]) -> list[Path]:
    if report_paths:
        candidates = [(root / item).resolve() if not Path(item).is_absolute() else Path(item) for item in report_paths]
    else:
        candidates = []
        for pattern in SUPPORTED_COVERAGE_PATTERNS:
            candidates.extend(root.glob(pattern))

    resolved: list[Path] = []
    for candidate in candidates:
        if not candidate.exists() or candidate.is_dir():
            continue
        try:
            relative_parts = candidate.resolve().relative_to(root.resolve()).parts
        except ValueError:
            relative_parts = candidate.parts
        if any(part in {".git", ".quality", "node_modules", "vendor", "__pycache__"} for part in relative_parts):
            continue
        if candidate not in resolved:
            resolved.append(candidate)
    return sorted(resolved)


def _parse_coverage_report(path: Path) -> CoverageMetrics:
    name = path.name.lower()
    text = path.read_text(encoding="utf-8", errors="replace")
    stripped = text.lstrip()
    if name == "lcov.info" or stripped.startswith("TN:") or "\nDA:" in stripped:
        return _parse_lcov(text)
    if name == "coverage.out" or stripped.startswith("mode: "):
        return _parse_go_coverprofile(text)
    if stripped.startswith("<"):
        return _parse_xml_coverage(path)
    raise ValueError("unsupported coverage report format")


def _parse_lcov(text: str) -> CoverageMetrics:
    metrics = CoverageMetrics()
    current_lines: dict[int, int] = {}
    current_branches: list[int] = []

    def flush() -> None:
        nonlocal current_lines, current_branches
        metrics.line_total += len(current_lines)
        metrics.line_covered += sum(1 for hits in current_lines.values() if hits > 0)
        metrics.branch_total += len(current_branches)
        metrics.branch_covered += sum(1 for hits in current_branches if hits > 0)
        current_lines = {}
        current_branches = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("DA:"):
            parts = line[3:].split(",")
            if len(parts) >= 2:
                current_lines[int(parts[0])] = int(float(parts[1]))
        elif line.startswith("BRDA:"):
            parts = line[5:].split(",")
            if len(parts) >= 4 and parts[3] != "-":
                current_branches.append(int(float(parts[3])))
        elif line == "end_of_record":
            flush()
    flush()
    return metrics


def _parse_go_coverprofile(text: str) -> CoverageMetrics:
    metrics = CoverageMetrics()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("mode:"):
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        statements = int(parts[1])
        hits = int(parts[2])
        metrics.line_total += statements
        if hits > 0:
            metrics.line_covered += statements
    return metrics


def _parse_xml_coverage(path: Path) -> CoverageMetrics:
    root = ET.parse(path).getroot()
    tag = _xml_tag(root)
    if tag == "report":
        return _parse_jacoco_xml(root)
    if tag == "coverage":
        clover = _parse_clover_xml(root)
        if clover.line_total > 0:
            return clover
        return _parse_cobertura_xml(root)
    raise ValueError(f"unsupported XML coverage root: {tag}")


def _parse_jacoco_xml(root: ET.Element) -> CoverageMetrics:
    metrics = CoverageMetrics()
    for counter in root.iter():
        if _xml_tag(counter) != "counter":
            continue
        counter_type = counter.attrib.get("type")
        missed = int(counter.attrib.get("missed", "0"))
        covered = int(counter.attrib.get("covered", "0"))
        if counter_type == "LINE":
            metrics.line_total += missed + covered
            metrics.line_covered += covered
        elif counter_type == "BRANCH":
            metrics.branch_total += missed + covered
            metrics.branch_covered += covered
    return metrics


def _parse_cobertura_xml(root: ET.Element) -> CoverageMetrics:
    metrics = CoverageMetrics()
    lines_valid = _int_attr(root, "lines-valid")
    lines_covered = _int_attr(root, "lines-covered")
    branches_valid = _int_attr(root, "branches-valid")
    branches_covered = _int_attr(root, "branches-covered")

    if lines_valid is not None and lines_covered is not None:
        metrics.line_total = lines_valid
        metrics.line_covered = lines_covered
    elif "line-rate" in root.attrib:
        metrics.line_total = 10000
        metrics.line_covered = int(float(root.attrib["line-rate"]) * metrics.line_total)

    if branches_valid is not None and branches_covered is not None:
        metrics.branch_total = branches_valid
        metrics.branch_covered = branches_covered
    elif "branch-rate" in root.attrib:
        metrics.branch_total = 10000
        metrics.branch_covered = int(float(root.attrib["branch-rate"]) * metrics.branch_total)
    return metrics


def _parse_clover_xml(root: ET.Element) -> CoverageMetrics:
    metrics = CoverageMetrics()
    metrics_nodes = [item for item in root.iter() if _xml_tag(item) == "metrics"]
    if not metrics_nodes:
        return metrics
    node = metrics_nodes[-1]
    statements = _int_attr(node, "statements")
    covered_statements = _int_attr(node, "coveredstatements")
    conditionals = _int_attr(node, "conditionals")
    covered_conditionals = _int_attr(node, "coveredconditionals")
    if statements is not None and covered_statements is not None:
        metrics.line_total = statements
        metrics.line_covered = covered_statements
    if conditionals is not None and covered_conditionals is not None:
        metrics.branch_total = conditionals
        metrics.branch_covered = covered_conditionals
    return metrics


def _xml_tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _int_attr(element: ET.Element, name: str) -> int | None:
    value = element.attrib.get(name)
    return int(value) if value is not None and value != "" else None


def _missing_npm_workspaces(root: Path, package_json: Path) -> list[str]:
    try:
        package = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    workspaces = package.get("workspaces", [])
    patterns = workspaces.get("packages", []) if isinstance(workspaces, dict) else workspaces
    if not isinstance(patterns, list):
        return []

    missing: list[str] = []
    for pattern in patterns:
        if not isinstance(pattern, str):
            continue
        matches = [path for path in root.glob(pattern) if (path / "package.json").is_file()]
        if not matches:
            missing.append(pattern)
    return missing


def _project_test_outcome(result: ToolResult, *, path: str, message: str) -> tuple[ToolResult, list[Finding]]:
    if result.exit_code in {None, 0}:
        return result, []
    result.status = "findings"
    return result, [
        Finding(
            tool="project-tests",
            rule="tests.failed",
            severity="high",
            category="tests",
            path=path,
            message=message,
        )
    ]


def _run_project_tests(root: Path, raw_dir: Path) -> tuple[ToolResult | None, list[Finding]]:
    package_json = root / "package.json"
    if package_json.exists() and shutil.which("npm"):
        missing_workspaces = _missing_npm_workspaces(root, package_json)
        if missing_workspaces:
            scope = os.environ.get("QUALITY_GATE_SCOPE", "full")
            if scope not in {"changed", "paths"}:
                return ToolResult(
                    name="project-tests",
                    status="error",
                    error="Project tests cannot run because npm workspaces are absent from the full checkout.",
                    summary={"missingWorkspaces": missing_workspaces},
                ), []
            return ToolResult(
                name="project-tests",
                status="skipped",
                summary={
                    "reason": "Project tests require npm workspaces absent from the analyzed checkout.",
                    "missingWorkspaces": missing_workspaces,
                },
            ), []
        result = run_command(
            "project-tests",
            ["npm", "test", "--if-present"],
            raw_dir,
            cwd=root,
            acceptable_exit_codes={0, 1},
            inherit_environment=True,
        )
        return _project_test_outcome(result, path="package.json", message="Project test command failed.")

    pyproject = root / "pyproject.toml"
    tests_dir = root / "tests"
    if pyproject.exists() and tests_dir.exists() and shutil.which("python"):
        result = run_command(
            "project-tests",
            ["python", "-m", "unittest", "discover"],
            raw_dir,
            cwd=root,
            acceptable_exit_codes={0, 1},
            inherit_environment=True,
        )
        return _project_test_outcome(result, path="tests", message="Python unittest discovery failed.")

    return None, []


def run_project_tests(root: Path, raw_dir: Path) -> tuple[ToolResult | None, list[Finding]]:
    """Run project-owned tests only after an explicit caller opt-in."""
    return _run_project_tests(root, raw_dir)


def parse_json(path: str | None) -> Any | None:
    """Compatibility helper for callers that do not require evidence proof."""
    payload, _ = _load_json_evidence(path)
    return payload


def _load_json_evidence(path: str | None) -> tuple[Any | None, str | None]:
    if not path:
        return None, "the analyzer did not declare an output path"
    file_path = Path(path)
    if not file_path.is_file() or file_path.is_symlink():
        return None, "the analyzer did not produce the expected regular JSON report"
    try:
        text = file_path.read_text(encoding="utf-8", errors="strict").strip()
    except (OSError, UnicodeError):
        return None, "the analyzer JSON report could not be read as UTF-8"
    if not text:
        return None, "the analyzer JSON report is empty"
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        return None, "the analyzer JSON report is malformed"


def _validate_tool_payload(name: str, payload: Any) -> None:
    if name == "semgrep":
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise ValueError("Semgrep report needs a results array")
    elif name == "gitleaks":
        if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
            raise ValueError("Gitleaks report needs an array of findings")
    elif name == "trivy":
        if not isinstance(payload, dict) or not isinstance(payload.get("Results"), list):
            raise ValueError("Trivy report needs a Results array")
    elif name == "checkov":
        documents = payload if isinstance(payload, list) else [payload]
        if not documents or not all(
            isinstance(item, dict)
            and (
                isinstance(item.get("results"), (dict, list))
                or _is_official_empty_checkov_summary(item)
            )
            for item in documents
        ):
            raise ValueError("Checkov report needs results objects or an official empty summary")
    elif name == "osv-scanner":
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise ValueError("OSV-Scanner report needs a results array")
    elif name == "jscpd":
        if not isinstance(payload, dict) or not isinstance(payload.get("duplicates"), list):
            raise ValueError("jscpd report needs a duplicates array")


def _is_official_empty_checkov_summary(payload: dict[str, Any]) -> bool:
    """Recognize Checkov 3.x's real zero-resource JSON contract.

    Checkov omits ``results`` when no checks apply and emits only counters plus
    its version. Accept that exact empty state without treating arbitrary `{}`
    as successful analyzer evidence.
    """
    if "results" in payload:
        return False
    counters = ("passed", "failed", "skipped", "parsing_errors", "resource_count")
    expected_keys = {*counters, "checkov_version"}
    return (
        set(payload) == expected_keys
        and all(isinstance(payload.get(name), int) and not isinstance(payload.get(name), bool) for name in counters)
        and all(payload[name] == 0 for name in counters)
        and isinstance(payload.get("checkov_version"), str)
        and bool(payload["checkov_version"].strip())
    )


def parse_tool_findings(name: str, result: ToolResult, root: Path) -> list[Finding]:
    if result.status in {"missing", "timeout", "error", "skipped"}:
        return []
    if name == "megalinter":
        return _parse_megalinter(result)
    parsers = {
        "semgrep": _parse_semgrep,
        "gitleaks": _parse_gitleaks,
        "trivy": _parse_trivy,
        "checkov": _parse_checkov,
        "osv-scanner": _parse_osv,
        "jscpd": _parse_jscpd,
    }
    parser = parsers.get(name)
    if parser is None:
        return []
    payload, error = _load_json_evidence(result.output_path)
    if error is None:
        try:
            _validate_tool_payload(name, payload)
        except (TypeError, ValueError) as validation_error:
            error = str(validation_error)
    if error is not None:
        result.status = "error"
        result.error = f"Invalid analyzer evidence: {error}."
        result.summary["evidenceValid"] = False
        return []
    try:
        findings = parser(payload, root)
    except (AttributeError, TypeError, ValueError):
        result.status = "error"
        result.error = "Invalid analyzer evidence: the report shape could not be normalized."
        result.summary["evidenceValid"] = False
        return []
    result.summary["evidenceValid"] = True
    return findings


def _parse_megalinter(result: ToolResult) -> list[Finding]:
    findings: list[Finding] = []
    for log_path in _megalinter_error_logs(Path(result.output_path or "")):
        analyzer = log_path.stem.removesuffix("-ERROR")
        findings.append(
            Finding(
                tool="megalinter",
                rule=f"megalinter.{analyzer.lower().replace('_', '-')}",
                severity="high",
                category="lint",
                path="",
                message=f"MegaLinter analyzer {analyzer} reported one or more blocking errors.",
                metadata={"log": str(log_path)},
            )
        )
    return findings


def _normalize_path(value: str | None, root: Path) -> str:
    if not value:
        return ""
    path = Path(value)
    if path.is_absolute():
        return _relative(path, root)
    return value.replace("\\", "/")


def _parse_semgrep(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for item in (payload or {}).get("results", []):
        extra = item.get("extra", {})
        start = item.get("start", {})
        findings.append(
            Finding(
                tool="semgrep",
                rule=item.get("check_id", "semgrep"),
                severity=extra.get("severity", "medium"),
                category="code",
                path=_normalize_path(item.get("path"), root),
                line=start.get("line"),
                column=start.get("col"),
                message=extra.get("message", "Semgrep finding."),
                metadata={"metadata": extra.get("metadata", {})},
            )
        )
    return findings


def _parse_gitleaks(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for item in payload or []:
        findings.append(
            Finding(
                tool="gitleaks",
                rule=item.get("RuleID", "gitleaks.secret"),
                severity="critical",
                category="secrets",
                path=_normalize_path(item.get("File"), root),
                line=item.get("StartLine"),
                message=item.get("Description") or "Secret detected by Gitleaks.",
                fingerprint=item.get("Fingerprint", ""),
                metadata={"commit": item.get("Commit")},
            )
        )
    return findings


def _parse_trivy(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for result in (payload or {}).get("Results", []):
        target = _normalize_path(result.get("Target"), root)
        for vuln in result.get("Vulnerabilities", []) or []:
            suppressed = _trivy_item_suppressed(vuln)
            findings.append(
                Finding(
                    tool="trivy",
                    rule=vuln.get("VulnerabilityID", "trivy.vulnerability"),
                    severity="high" if suppressed else normalize_severity(vuln.get("Severity")),
                    category="policy-suppression" if suppressed else "vulnerability",
                    path=target,
                    message=(
                        "Project-controlled Trivy suppression is not trusted."
                        if suppressed
                        else vuln.get("Title") or vuln.get("Description") or "Vulnerability detected by Trivy."
                    ),
                    metadata={
                        "package": vuln.get("PkgName"),
                        "installedVersion": vuln.get("InstalledVersion"),
                        "fixedVersion": vuln.get("FixedVersion"),
                        "status": vuln.get("Status"),
                        "suppressedByProject": suppressed,
                    },
                )
            )
        for secret in result.get("Secrets", []) or []:
            suppressed = _trivy_item_suppressed(secret)
            findings.append(
                Finding(
                    tool="trivy",
                    rule=secret.get("RuleID", "trivy.secret"),
                    severity="high" if suppressed else normalize_severity(secret.get("Severity") or "critical"),
                    category="policy-suppression" if suppressed else "secrets",
                    path=target,
                    line=secret.get("StartLine"),
                    message=(
                        "Project-controlled Trivy suppression is not trusted."
                        if suppressed
                        else secret.get("Title") or "Secret detected by Trivy."
                    ),
                    metadata={"status": secret.get("Status"), "suppressedByProject": suppressed},
                )
            )
        for misconfig in result.get("Misconfigurations", []) or []:
            suppressed = _trivy_item_suppressed(misconfig)
            findings.append(
                Finding(
                    tool="trivy",
                    rule=misconfig.get("ID", "trivy.misconfiguration"),
                    severity="high" if suppressed else normalize_severity(misconfig.get("Severity")),
                    category="policy-suppression" if suppressed else "misconfiguration",
                    path=target,
                    message=(
                        "Project-controlled Trivy suppression is not trusted."
                        if suppressed
                        else misconfig.get("Title") or "Misconfiguration detected by Trivy."
                    ),
                    metadata={"status": misconfig.get("Status"), "suppressedByProject": suppressed},
                )
            )
    return findings


def _trivy_item_suppressed(item: dict[str, Any]) -> bool:
    status = str(item.get("Status", "")).upper()
    return status in {"EXCEPTION", "SUPPRESSED"} or item.get("IsSuppressed") is True


def _parse_checkov(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for item in _iter_checkov_failed_checks(payload):
        line_range = item.get("file_line_range") or []
        line = line_range[0] if isinstance(line_range, list) and line_range else None
        findings.append(
            Finding(
                tool="checkov",
                rule=item.get("check_id", "checkov.iac"),
                severity=normalize_severity(item.get("severity") or "medium"),
                category="iac",
                path=_normalize_checkov_path(item, root),
                line=line if isinstance(line, int) else None,
                message=item.get("check_name") or "Infrastructure-as-code issue detected by Checkov.",
                metadata={
                    "resource": item.get("resource"),
                    "guideline": item.get("guideline"),
                    "checkClass": item.get("check_class"),
                },
            )
        )
    for item in _iter_checkov_skipped_checks(payload):
        line_range = item.get("file_line_range") or []
        line = line_range[0] if isinstance(line_range, list) and line_range else None
        findings.append(
            Finding(
                tool="checkov",
                rule=item.get("check_id", "checkov.suppression"),
                severity="high",
                category="policy-suppression",
                path=_normalize_checkov_path(item, root),
                line=line if isinstance(line, int) else None,
                message="Project-controlled Checkov suppression is not trusted.",
                metadata={
                    "resource": item.get("resource"),
                    "suppressedByProject": True,
                    "suppressComment": item.get("suppress_comment"),
                },
            )
        )
    return findings


def _iter_checkov_failed_checks(payload: Any) -> Iterable[dict[str, Any]]:
    if isinstance(payload, list):
        for item in payload:
            yield from _iter_checkov_failed_checks(item)
        return
    if not isinstance(payload, dict):
        return
    results = payload.get("results")
    if isinstance(results, dict):
        failed = results.get("failed_checks") or []
        for item in failed:
            if isinstance(item, dict):
                yield item
    elif isinstance(results, list):
        for item in results:
            yield from _iter_checkov_failed_checks(item)
    failed = payload.get("failed_checks") or []
    for item in failed:
        if isinstance(item, dict):
            yield item


def _iter_checkov_skipped_checks(payload: Any) -> Iterable[dict[str, Any]]:
    if isinstance(payload, list):
        for item in payload:
            yield from _iter_checkov_skipped_checks(item)
        return
    if not isinstance(payload, dict):
        return
    results = payload.get("results")
    if isinstance(results, dict):
        skipped = results.get("skipped_checks") or []
        for item in skipped:
            if isinstance(item, dict):
                yield item
    elif isinstance(results, list):
        for item in results:
            yield from _iter_checkov_skipped_checks(item)
    skipped = payload.get("skipped_checks") or []
    for item in skipped:
        if isinstance(item, dict):
            yield item


def _normalize_checkov_path(item: dict[str, Any], root: Path) -> str:
    absolute = item.get("file_abs_path")
    if isinstance(absolute, str) and absolute:
        return _normalize_path(absolute, root)
    value = item.get("file_path")
    if isinstance(value, str) and value:
        return value.lstrip("/").replace("\\", "/")
    return ""


def _parse_osv(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for result in (payload or {}).get("results", []) or []:
        source = result.get("source", {})
        path = _normalize_path(source.get("path"), root)
        for package in result.get("packages", []) or []:
            package_name = (package.get("package") or {}).get("name")
            for vuln in package.get("vulnerabilities", []) or []:
                findings.append(
                    Finding(
                        tool="osv-scanner",
                        rule=vuln.get("id", "osv.vulnerability"),
                        severity=_osv_severity(vuln),
                        category="vulnerability",
                        path=path,
                        message=vuln.get("summary") or "Vulnerability detected by OSV-Scanner.",
                        metadata={"package": package_name},
                    )
                )
    return findings


def _osv_severity(vuln: dict[str, Any]) -> str:
    severities = vuln.get("severity") or []
    values = " ".join(str(item.get("score", "")) for item in severities if isinstance(item, dict))
    if "CRITICAL" in values.upper():
        return "critical"
    if "HIGH" in values.upper():
        return "high"
    if "LOW" in values.upper():
        return "low"
    return "medium"


def _parse_jscpd(payload: Any, root: Path) -> list[Finding]:
    findings: list[Finding] = []
    duplicates = (payload or {}).get("duplicates", []) or []
    for item in duplicates:
        first = item.get("firstFile") or {}
        second = item.get("secondFile") or {}
        path = _normalize_path(first.get("name") or first.get("path"), root)
        second_path = _normalize_path(second.get("name") or second.get("path"), root)
        lines = item.get("lines") or item.get("fragment", {}).get("lines")
        findings.append(
            Finding(
                tool="jscpd",
                rule="duplication.block",
                severity="medium",
                category="duplication",
                path=path,
                line=_jscpd_line(first),
                message=f"Duplicated code block detected with {second_path}.",
                metadata={"lines": lines, "secondPath": second_path},
            )
        )
    return findings


def _jscpd_line(file_entry: dict[str, Any]) -> int | None:
    start = file_entry.get("start")
    if isinstance(start, int):
        return start
    if isinstance(start, dict):
        line = start.get("line")
        return line if isinstance(line, int) else None

    start_loc = file_entry.get("startLoc")
    if isinstance(start_loc, dict):
        line = start_loc.get("line")
        return line if isinstance(line, int) else None

    return None
