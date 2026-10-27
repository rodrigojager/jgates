"""JSON bridge between the JGates core and the quality sidecar (local mode only).

The core sends one JSON request (stdin or a file) and reads one JSON response on stdout.
Everything human-readable (the legacy `check` summary, logs) goes to stderr.
A request for the governed mode is refused: the governed CI path is `jgates ci`, which pins the policy by hash
and drives this same bridge with it.
"""
from __future__ import annotations

import contextlib
import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

BRIDGE_SCHEMA_VERSION = 1
MODES = ("quick", "offline", "full")
REFUSED_MODES = ("governed", "ci")
PROFILES = ("relaxed", "standard", "strict")

# Same ids as jgates/src/adapters/quality-bridge/manifest.ts, so the core maps them without translation.
SUBCHECK_IDS = (
    "file-size",
    "megalinter",
    "semgrep",
    "gitleaks",
    "trivy",
    "checkov",
    "osv-scanner",
    "jscpd",
    "project-tests",
    "coverage",
)
_FILE_SIZE_RULES = {"budget.file-lines", "budget.file-bytes"}

_REQUEST_KEYS = {
    "schemaVersion", "target", "mode", "outputDir", "profile", "locale", "threshold", "pii", "secrets", "iac",
    "projectTests", "coverage", "coverageReports", "minLineCoverage", "minBranchCoverage", "policyFile",
    "policySha256", "requirePolicy", "failOnToolError", "disableBudgets", "maxFileLines", "maxFileBytes",
    "scopeManifest", "governed", "toolConfigs", "subchecks", "hardened",
}
# Subchecks that are external tools of tools.run_external_tools (the others are built in or driven by their flag).
_EXTERNAL_SUBCHECKS = {"megalinter", "semgrep", "gitleaks", "trivy", "checkov", "osv-scanner", "jscpd", "project-tests"}


class BridgeError(Exception):
    def __init__(self, code: str, message: str, *, tool: str | None = None, path: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.tool = tool
        self.path = path


def _optional(request: dict[str, Any], key: str, kinds: tuple[type, ...], default: Any = None) -> Any:
    value = request.get(key, default)
    if value is None:
        return default
    if isinstance(value, bool) and bool not in kinds:
        raise BridgeError("invalid-request", f"{key} has the wrong type")
    if not isinstance(value, kinds):
        raise BridgeError("invalid-request", f"{key} has the wrong type")
    return value


def validate_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise BridgeError("invalid-request", "the request must be a JSON object")
    mode = request.get("mode", "full")
    if request.get("governed") is True or (isinstance(mode, str) and mode in REFUSED_MODES):
        raise BridgeError("governed-mode-refused", "the bridge has no governed mode; the governed CI path is jgates ci")
    if request.get("schemaVersion") != BRIDGE_SCHEMA_VERSION:
        raise BridgeError("unsupported-version", f"schemaVersion must be {BRIDGE_SCHEMA_VERSION}")
    unknown = sorted(set(request) - _REQUEST_KEYS)
    if unknown:
        raise BridgeError("invalid-request", f"unknown request fields: {', '.join(unknown)}")
    if mode not in MODES:
        raise BridgeError("invalid-request", f"mode must be one of {', '.join(MODES)}")
    for key in ("target", "outputDir"):
        if not isinstance(request.get(key), str) or not request[key]:
            raise BridgeError("invalid-request", f"{key} is required")
    if not Path(request["outputDir"]).is_absolute():
        raise BridgeError("invalid-request", "outputDir must be an absolute path")
    profile = request.get("profile", "standard")
    if profile not in PROFILES:
        raise BridgeError("invalid-request", f"profile must be one of {', '.join(PROFILES)}")
    for key in ("pii", "secrets", "iac", "projectTests", "coverage", "requirePolicy", "failOnToolError", "disableBudgets", "hardened"):
        _optional(request, key, (bool,))
    if request.get("hardened") is True and request.get("toolConfigs"):
        # The hardened request of jgates ci never takes a scanner configuration from the analyzed project.
        raise BridgeError("invalid-request", "a hardened request cannot name toolConfigs")
    for key in ("threshold", "maxFileLines", "maxFileBytes"):
        _optional(request, key, (int,))
    for key in ("minLineCoverage", "minBranchCoverage"):
        _optional(request, key, (int, float))
    for key in ("locale", "policyFile", "policySha256", "scopeManifest"):
        _optional(request, key, (str,))
    reports = _optional(request, "coverageReports", (list,), [])
    if not all(isinstance(item, str) for item in reports):
        raise BridgeError("invalid-request", "coverageReports must be a list of strings")
    subchecks = request.get("subchecks")
    if subchecks is not None:
        if not isinstance(subchecks, list) or not all(isinstance(item, str) for item in subchecks):
            raise BridgeError("invalid-request", "subchecks must be a list of subcheck ids")
        unknown_subchecks = sorted(set(subchecks) - set(SUBCHECK_IDS))
        if unknown_subchecks:
            raise BridgeError("invalid-request", f"unknown subchecks: {', '.join(unknown_subchecks)}")
    if request.get("toolConfigs") is not None and not isinstance(request["toolConfigs"], dict):
        raise BridgeError("invalid-request", "toolConfigs must be an object")
    return request


def _local_options(request: dict[str, Any], target: Path) -> Any:
    """The local-only tool options of the request (configuration files and the subchecks to run)."""
    from .tools import LocalToolOptions, ToolConfigError, resolve_local_tool_configs

    try:
        configs = resolve_local_tool_configs(target, request.get("toolConfigs"))
    except ToolConfigError as error:
        raise BridgeError(error.code, error.message, tool=error.tool, path=error.path) from None
    subchecks = request.get("subchecks")
    selected = frozenset(item for item in subchecks if item in _EXTERNAL_SUBCHECKS) if subchecks is not None else None
    return LocalToolOptions(configs=configs, subchecks=selected, hardened=request.get("hardened") is True)


def _wanted(request: dict[str, Any]) -> set[str] | None:
    """The subchecks the request asks for; None runs every subcheck of the mode and flags (legacy requests)."""
    subchecks = request.get("subchecks")
    return set(subchecks) if subchecks is not None else None


def _build_argv(request: dict[str, Any], output_dir: Path) -> list[str]:
    wanted = _wanted(request)
    # A subcheck left out of `subchecks` does not run, whatever its flag says.
    gated = {"projectTests": "project-tests", "coverage": "coverage"}
    effective = dict(request)
    for key, sub_id in gated.items():
        if wanted is not None and sub_id not in wanted:
            effective[key] = False
    if wanted is not None and "file-size" not in wanted:
        effective["disableBudgets"] = True
    request = effective
    argv = [
        "check", request["target"],
        "--mode", request.get("mode", "full"),
        "--profile", request.get("profile", "standard"),
        "--output", str(output_dir),
        "--format", "json,md",
    ]
    flags = (
        ("pii", "--enable-pii"), ("secrets", "--enable-secrets"), ("projectTests", "--run-project-tests"),
        ("coverage", "--enable-coverage"), ("requirePolicy", "--require-policy"),
        ("failOnToolError", "--fail-on-tool-error"), ("disableBudgets", "--disable-budgets"),
    )
    for key, flag in flags:
        if request.get(key):
            argv.append(flag)
    if request.get("iac") is False:
        argv.append("--disable-iac")
    values = (
        ("locale", "--locale"), ("threshold", "--threshold"), ("policyFile", "--policy-file"),
        ("policySha256", "--policy-sha256"), ("scopeManifest", "--scope-manifest"),
        ("minLineCoverage", "--min-line-coverage"), ("minBranchCoverage", "--min-branch-coverage"),
        ("maxFileLines", "--max-file-lines"), ("maxFileBytes", "--max-file-bytes"),
    )
    for key, flag in values:
        if request.get(key) is not None:
            argv.extend([flag, str(request[key])])
    for report in request.get("coverageReports") or []:
        argv.extend(["--coverage-report", report])
    return argv


def _subchecks(report: dict[str, Any], request: dict[str, Any]) -> list[dict[str, Any]]:
    tools = {tool.get("name"): tool for tool in report.get("tools") or []}
    findings = report.get("findings") or []
    mode = request.get("mode", "full")
    wanted = _wanted(request)
    out: list[dict[str, Any]] = []
    for sub_id in SUBCHECK_IDS:
        if wanted is not None and sub_id not in wanted:
            out.append({"id": sub_id, "status": "skipped", "reason": "not requested by the plan"})
            continue
        if sub_id == "file-size":
            if request.get("disableBudgets"):
                out.append({"id": sub_id, "status": "skipped", "reason": "budgets disabled"})
                continue
            count = sum(1 for item in findings if item.get("rule") in _FILE_SIZE_RULES)
            out.append({"id": sub_id, "status": "findings" if count else "ok", "findings": count})
            continue
        tool = tools.get(sub_id)
        if tool is None:
            if mode != "full" and sub_id not in ("project-tests", "coverage"):
                reason = f"mode {mode} runs no external tool"
            elif sub_id == "project-tests":
                reason = "project tests not requested"
            elif sub_id == "coverage":
                reason = "coverage not requested"
            else:
                reason = "tool not run in this flavor"
            out.append({"id": sub_id, "status": "skipped", "reason": reason})
            continue
        summary = tool.get("summary") or {}
        entry: dict[str, Any] = {"id": sub_id, "status": tool.get("status") or "error"}
        if tool.get("exit_code") is not None:
            entry["exitCode"] = tool["exit_code"]
        if isinstance(summary.get("findings"), int):
            entry["findings"] = summary["findings"]
        if summary.get("reason"):
            entry["reason"] = str(summary["reason"])
        if tool.get("error"):
            entry["error"] = str(tool["error"])
        command = tool.get("command")
        if isinstance(command, list) and command:
            # The effective command the sidecar ran (argv, no shell), so the core can show the flags really used.
            entry["command"] = [str(part) for part in command]
        config = summary.get("config")
        if isinstance(config, dict) and config.get("source") in ("project", "package") and isinstance(config.get("path"), str):
            entry["config"] = {"source": config["source"], "path": config["path"]}
        out.append(entry)
    return out


def error_response(
    code: str, message: str, exit_code: int = 3, *, tool: str | None = None, path: str | None = None
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if tool is not None:
        error["tool"] = tool
    if path is not None:
        error["path"] = path
    return {
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "ok": False,
        "status": "ERROR",
        "exitCode": exit_code,
        "error": error,
        "subchecks": [],
    }


def run_bridge(request: Any, check: Callable[[Any], int] | None = None) -> tuple[dict[str, Any], int]:
    """Run one request. Returns (response, exit code). Human output of the legacy check goes to stderr."""
    from . import cli  # local import: cli imports this module's entrypoint wiring

    try:
        request = validate_request(request)
    except BridgeError as error:
        return error_response(error.code, error.message), 3

    target = Path(request["target"])
    if not target.is_dir():
        return error_response("target-missing", f"target is not a directory: {target}"), 3
    try:
        local = _local_options(request, target)
    except BridgeError as error:
        return error_response(error.code, error.message, tool=error.tool, path=error.path), 3
    output_dir = Path(request["outputDir"])
    projections = output_dir / "scopes"
    try:
        projections.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return error_response("output-unwritable", str(error)), 3

    args = cli.build_parser().parse_args(_build_argv(request, output_dir))
    # Not a command-line flag: only this local bridge can hand project configuration files to the scanners.
    args.local_tools = local
    previous_tempdir = tempfile.tempdir
    # Scope projections (e.g. the Terraform projection) go under the output folder, never inside the target.
    tempfile.tempdir = str(projections)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            exit_code = (check or cli.run_check)(args)
    except Exception as error:  # noqa: BLE001 - the bridge always answers with structured JSON.
        return error_response("sidecar-crashed", f"{type(error).__name__}: {error}"), 3
    finally:
        tempfile.tempdir = previous_tempdir

    report_path = output_dir / "quality-report.json"
    if not report_path.is_file():
        return error_response("no-report", f"the sidecar exited with {exit_code} and wrote no report", exit_code or 3), 3
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return error_response("invalid-report", str(error)), 3

    response: dict[str, Any] = {
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "ok": True,
        "status": report.get("status", "ERROR"),
        "exitCode": exit_code,
        "outputDir": str(output_dir),
        "reportPath": str(report_path),
        "subchecks": _subchecks(report, request),
        "report": report,
    }
    markdown = output_dir / "quality-report.md"
    if markdown.is_file():
        response["markdownPath"] = str(markdown)
    return response, exit_code


PII_OPERATION = "pii"
PII_SEVERITIES = ("low", "medium", "high", "critical")
_PII_REQUEST_KEYS = {"schemaVersion", "operation", "target", "entities", "severity", "config"}


def _pii_error(code: str, message: str, *, path: str | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if path is not None:
        error["path"] = path
    return {
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "operation": PII_OPERATION,
        "ok": False,
        "status": "ERROR",
        "exitCode": 3,
        "error": error,
        "findings": [],
    }


def run_pii(request: Any) -> tuple[dict[str, Any], int]:
    """PII-only request: runs the built-in PII detector over the target and answers with normalized findings.

    The request is separate from the composite one (the composite contract is unchanged). It carries either the
    effective ``.jgates/pii.yml`` document (``config``) or the older ``entities``/``severity`` pair. Nothing is written
    in the target, and the answer never carries the matched text: only rule, entity, severity, path, line and a fixed
    message. A configuration the detector cannot honor is refused with a structured error, never dropped.
    """
    from . import pii

    if not isinstance(request, dict):
        return _pii_error("invalid-request", "the request must be a JSON object"), 3
    if request.get("schemaVersion") != BRIDGE_SCHEMA_VERSION:
        return _pii_error("unsupported-version", f"schemaVersion must be {BRIDGE_SCHEMA_VERSION}"), 3
    unknown = sorted(set(request) - _PII_REQUEST_KEYS)
    if unknown:
        return _pii_error("invalid-request", f"unknown request fields: {', '.join(unknown)}"), 3
    target = request.get("target")
    if not isinstance(target, str) or not target:
        return _pii_error("invalid-request", "target is required"), 3
    if "config" in request and ("entities" in request or "severity" in request):
        return _pii_error("invalid-request", "config cannot be combined with entities or severity"), 3
    root = Path(target)
    if not root.is_dir():
        return _pii_error("target-missing", f"target is not a directory: {root}"), 3

    try:
        if "config" in request:
            if not isinstance(request["config"], dict):
                return _pii_error("invalid-request", "config must be an object"), 3
            config = pii.config_from_dict(request["config"])
        else:
            entities = request.get("entities")
            if entities is not None and (not isinstance(entities, list) or not all(isinstance(i, str) for i in entities)):
                return _pii_error("invalid-request", f"entities must be a list of: {', '.join(pii.ENTITIES)}"), 3
            severity = request.get("severity")
            if severity is not None and severity not in PII_SEVERITIES:
                return _pii_error("invalid-request", f"severity must be one of {', '.join(PII_SEVERITIES)}"), 3
            config = pii.config_from_request(entities, severity)
    except pii.PiiConfigError as error:
        detail = error.to_dict()
        code = "invalid-request" if detail["code"] == "invalid-config" and "config" not in request else detail["code"]
        return _pii_error(code, detail["message"], path=detail["path"]), 3

    try:
        raw = pii.detect_pii(root, config)
    except Exception as error:  # noqa: BLE001 - the bridge always answers with structured JSON.
        return _pii_error("sidecar-crashed", f"{type(error).__name__}: {error}"), 3
    findings = [
        {
            "rule": item.rule,
            "entity": item.rule.removeprefix("pii."),
            "severity": item.severity,
            "path": item.path,
            "line": item.line,
            "message": item.message,
        }
        for item in raw
    ]
    findings.sort(key=lambda f: (f["path"], f["line"] or 0, f["rule"]))
    return {
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "operation": PII_OPERATION,
        "ok": True,
        "status": "FINDINGS" if findings else "OK",
        "exitCode": 0,
        "entities": list(config.enabled_entities()),
        "coverage": pii.coverage(config),
        "findings": findings,
    }, 0


ARCHITECTURE_OPERATION = "architecture"
_ARCHITECTURE_REQUEST_KEYS = {"schemaVersion", "operation", "graph", "architecture", "required"}
_RULE_KINDS = ("forbidden-dependency", "component-boundary", "no-cycles", "fan-limit")
_SEVERITIES = ("low", "medium", "high", "critical")


def _architecture_error(code: str, message: str) -> dict[str, Any]:
    return {
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "operation": ARCHITECTURE_OPERATION,
        "ok": False,
        "status": "ERROR",
        "exitCode": 3,
        "error": {"code": code, "message": message},
        "findings": [],
    }


def _glob_regex(pattern: str) -> "re.Pattern[str]":
    """Glob over '/' separated paths or dotted module names: '**' crosses separators, '*' and '?' do not."""
    out: list[str] = []
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if char == "*":
            if pattern[i : i + 2] == "**":
                i += 2
                if pattern[i : i + 1] == "/":
                    i += 1
                    out.append("(?:.*/)?")
                else:
                    out.append(".*")
                continue
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(char))
        i += 1
    return re.compile("".join(out) + r"\Z")


def _matches(patterns: list[str], value: str) -> bool:
    return any(_glob_regex(pattern.replace("\\", "/")).match(value) for pattern in patterns)


def _string_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{field} must be a list of strings")
    return value


def evaluate_architecture(request: Any) -> tuple[dict[str, Any], int]:
    """Evaluates a normalized dependency graph against the declared architecture contract.

    The graph is the one the extractors (dependency-cruiser, Import Linter, ...) normalize into: nodes with identity,
    kind, language, component and path; edges with origin; unresolved dependencies and the coverage of the extractor.
    The checks reuse the sidecar graph policies (cycles by strongly connected components, fan-in/fan-out, forbidden
    layers). Every finding carries the id of the declared rule and the file that declares it. An empty or partial
    graph never proves the absence of violations: the answer says so in ``coverage`` and ``verified``.
    """
    from .evidence import _cycles

    if not isinstance(request, dict):
        return _architecture_error("invalid-request", "the request must be a JSON object"), 3
    if request.get("schemaVersion") != BRIDGE_SCHEMA_VERSION:
        return _architecture_error("unsupported-version", f"schemaVersion must be {BRIDGE_SCHEMA_VERSION}"), 3
    unknown = sorted(set(request) - _ARCHITECTURE_REQUEST_KEYS)
    if unknown:
        return _architecture_error("invalid-request", f"unknown request fields: {', '.join(unknown)}"), 3
    graph, contract = request.get("graph"), request.get("architecture")
    if not isinstance(graph, dict) or not isinstance(contract, dict):
        return _architecture_error("invalid-request", "graph and architecture must be objects"), 3
    declared_file = str(contract.get("file") or ".jgates/architecture.yml")

    try:
        nodes: dict[str, dict[str, Any]] = {}
        for item in graph.get("nodes") or []:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                raise ValueError("every node needs an id")
            nodes[item["id"]] = item
        unresolved: list[dict[str, Any]] = []
        for item in graph.get("unresolved") or []:
            if not isinstance(item, dict) or not isinstance(item.get("from"), str):
                raise ValueError("every unresolved dependency needs from")
            unresolved.append(item)
        edges: list[tuple[str, str]] = []
        for item in graph.get("edges") or []:
            if not isinstance(item, dict) or not isinstance(item.get("from"), str) or not isinstance(item.get("to"), str):
                raise ValueError("every edge needs from and to")
            if item["from"] in nodes and item["to"] in nodes:
                edges.append((item["from"], item["to"]))
            else:
                unresolved.append({"from": item["from"], "specifier": item["to"], "reason": "unknown-node"})
        layers: dict[str, dict[str, Any]] = {}
        for item in contract.get("layers") or []:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                raise ValueError("every layer needs an id")
            _string_list(item.get("paths") or [], f"layer {item['id']} paths")
            _string_list(item.get("modules") or [], f"layer {item['id']} modules")
            layers[item["id"]] = item
        rules = contract.get("rules") or []
        if not isinstance(rules, list):
            raise ValueError("rules must be a list")
        for rule in rules:
            if not isinstance(rule, dict) or not isinstance(rule.get("id"), str) or rule.get("kind") not in _RULE_KINDS:
                raise ValueError("every rule needs an id and a known kind")
            if rule.get("severity", "high") not in _SEVERITIES:
                raise ValueError(f"rule {rule['id']} has an invalid severity")
    except ValueError as error:
        return _architecture_error("invalid-request", str(error)), 3

    def members(layer_id: str) -> set[str]:
        layer = layers.get(layer_id)
        if layer is None:
            return set()
        found: set[str] = set()
        for node_id, node in nodes.items():
            if layer.get("component") and node.get("component") != layer["component"]:
                continue
            if layer.get("language") and node.get("language") != layer["language"]:
                continue
            path = str(node.get("path") or "").replace("\\", "/")
            if (layer.get("paths") and path and _matches(layer["paths"], path)) or (layer.get("modules") and _matches(layer["modules"], node_id)):
                found.add(node_id)
        return found

    layer_nodes = {layer_id: members(layer_id) for layer_id in layers}
    findings: list[dict[str, Any]] = []
    rule_summaries: list[dict[str, Any]] = []
    reasons: list[dict[str, Any]] = []

    def where(node_id: str) -> str:
        return str(nodes[node_id].get("path") or node_id)

    def add(rule: dict[str, Any], message: str, path: str, metadata: dict[str, Any]) -> None:
        findings.append({
            "tool": "architecture",
            "rule": f"architecture.{rule['kind']}",
            "ruleId": rule["id"],
            "file": declared_file,
            "severity": rule.get("severity", "high"),
            "blocking": rule.get("blocking", True) is not False,
            "category": "architecture-policy",
            "path": path,
            "message": str(rule.get("message") or message),
            "metadata": metadata,
        })

    def empty_layer(layer_id: Any, rule: dict[str, Any]) -> None:
        if layer_id and not layer_nodes.get(str(layer_id)):
            reasons.append({"code": "layer-empty", "layer": layer_id, "rule": rule["id"], "message": f"layer {layer_id} matched no node of the graph"})

    for rule in rules:
        if rule.get("enabled") is False:
            rule_summaries.append({"id": rule["id"], "kind": rule["kind"], "evaluated": False, "findings": 0})
            continue
        before = len(findings)
        kind = rule["kind"]
        if kind == "forbidden-dependency":
            sources = layer_nodes.get(str(rule.get("from")), set())
            targets: set[str] = set()
            for target_layer in rule.get("to") or []:
                targets |= layer_nodes.get(target_layer, set())
            for layer_id in [rule.get("from"), *(rule.get("to") or [])]:
                empty_layer(layer_id, rule)
            for source, target in edges:
                if source in sources and target in targets:
                    add(rule, f"Layer {rule.get('from')} must not depend on {', '.join(rule.get('to') or [])}: {where(source)} -> {where(target)}.", where(source), {"from": source, "to": target, "fromLayer": rule.get("from")})
        elif kind == "component-boundary":
            component, allowed = rule.get("component"), set(rule.get("allowedDependencies") or [])
            if not any(node.get("component") == component for node in nodes.values()):
                reasons.append({"code": "component-empty", "component": component, "rule": rule["id"], "message": f"component {component} has no node in the graph"})
            for source, target in edges:
                other = nodes[target].get("component")
                if nodes[source].get("component") == component and other and other != component and other not in allowed:
                    add(rule, f"Component {component} must not depend on {other}: {where(source)} -> {where(target)}.", where(source), {"from": source, "to": target, "toComponent": other})
        elif kind == "no-cycles":
            scope = layer_nodes.get(str(rule["within"]), set()) if rule.get("within") else set(nodes)
            empty_layer(rule.get("within"), rule)
            for cycle in _cycles(scope, [(s, t) for s, t in edges if s in scope and t in scope]):
                add(rule, f"Dependency cycle detected: {' -> '.join(where(node) for node in cycle)}.", where(cycle[0]), {"nodes": cycle})
        else:  # fan-limit
            scope = layer_nodes.get(str(rule["layer"]), set()) if rule.get("layer") else set(nodes)
            empty_layer(rule.get("layer"), rule)
            inbound: dict[str, set[str]] = {}
            outbound: dict[str, set[str]] = {}
            for source, target in edges:
                outbound.setdefault(source, set()).add(target)
                inbound.setdefault(target, set()).add(source)
            for node_id in sorted(scope):
                fan_in, fan_out = len(inbound.get(node_id, ())), len(outbound.get(node_id, ()))
                if rule.get("maxFanIn") and fan_in > rule["maxFanIn"]:
                    add(rule, f"Dependency fan-in {fan_in} exceeds limit {rule['maxFanIn']}.", where(node_id), {"observed": fan_in, "limit": rule["maxFanIn"]})
                if rule.get("maxFanOut") and fan_out > rule["maxFanOut"]:
                    add(rule, f"Dependency fan-out {fan_out} exceeds limit {rule['maxFanOut']}.", where(node_id), {"observed": fan_out, "limit": rule["maxFanOut"]})
        rule_summaries.append({"id": rule["id"], "kind": kind, "evaluated": True, "findings": len(findings) - before})

    extractor = graph.get("coverage") if isinstance(graph.get("coverage"), dict) else {}
    if not nodes:
        reasons.append({"code": "graph-empty", "message": "the graph has no node: nothing was analyzed"})
    if unresolved:
        reasons.append({"code": "unresolved-dependencies", "count": len(unresolved), "message": f"{len(unresolved)} dependencies could not be resolved"})
    if extractor.get("complete") is False:
        reasons.append({"code": "extractor-incomplete", "message": str(extractor.get("reason") or "the extractor reported partial coverage")})
    status = "empty" if not nodes else ("partial" if reasons else "complete")
    coverage = {
        "status": status,
        "extractor": extractor.get("extractor") or graph.get("extractor"),
        "nodes": len(nodes),
        "edges": len(edges),
        "unresolved": len(unresolved),
        "unresolvedSample": unresolved[:20],
        "reasons": reasons,
    }
    findings.sort(key=lambda f: (f["ruleId"], f["path"], f["message"]))
    return {
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "operation": ARCHITECTURE_OPERATION,
        "ok": True,
        "status": "FINDINGS" if findings else "OK",
        "exitCode": 0,
        "verified": status == "complete",
        "required": bool(request.get("required")),
        "coverage": coverage,
        "rules": rule_summaries,
        "findings": findings,
    }, 0


def bridge_main(request_path: str | None) -> int:
    try:
        text = sys.stdin.read() if not request_path or request_path == "-" else Path(request_path).read_text(encoding="utf-8")
        request = json.loads(text)
    except (OSError, ValueError) as error:
        response, code = error_response("invalid-request", f"cannot read the request: {error}"), 3
    else:
        if isinstance(request, dict) and request.get("operation") == PII_OPERATION:
            response, code = run_pii(request)
        elif isinstance(request, dict) and request.get("operation") == ARCHITECTURE_OPERATION:
            response, code = evaluate_architecture(request)
        else:
            response, code = run_bridge(request)
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return code
