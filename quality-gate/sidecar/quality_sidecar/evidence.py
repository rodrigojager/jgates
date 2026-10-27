from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping

from .detectors import relative_path
from .findings import Finding
from .provenance import json_provenance, junit_provenance, validate_provenance
from .tools import ToolResult


PROFILE_GRAPH_LIMITS = {
    "relaxed": {"maxFanIn": 100, "maxFanOut": 60},
    "standard": {"maxFanIn": 60, "maxFanOut": 40},
    "strict": {"maxFanIn": 40, "maxFanOut": 25},
}


def _path(root: Path, value: str) -> Path:
    candidate = Path(value)
    return candidate if candidate.is_absolute() else root / candidate


def _json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("root value must be an object")
    return payload


def _reject_unknown_keys(value: Mapping[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"unknown {label} keys: {', '.join(unknown)}")


def _configured_paths(cli_paths: list[str], section: dict[str, Any], field: str = "reports") -> list[str]:
    configured = section.get(field) or []
    if not isinstance(configured, list) or not all(isinstance(item, str) for item in configured):
        raise ValueError(f"{field} must be an array of paths")
    return list(dict.fromkeys([*configured, *cli_paths]))


def _required_result(name: str, path: Path, status: str, error: str) -> ToolResult:
    return ToolResult(
        name=name,
        status=status,
        output_path=str(path),
        error=error,
        summary={"required": True, "findings": 0},
    )


def _graph_items(payload: dict[str, Any]) -> Iterable[dict[str, Any]]:
    graphs = payload.get("graphs")
    if graphs is None:
        yield payload
        return
    if not isinstance(graphs, list) or not all(isinstance(item, dict) for item in graphs):
        raise ValueError("graphs must be an array of objects")
    yield from graphs


def _parse_graph(graph: dict[str, Any]) -> tuple[dict[str, str | None], list[tuple[str, str]]]:
    raw_nodes, raw_edges = graph.get("nodes") or [], graph.get("edges") or []
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
        raise ValueError("nodes and edges must be arrays")
    nodes: dict[str, str | None] = {}
    for item in raw_nodes:
        if isinstance(item, str):
            nodes[item] = None
        elif isinstance(item, dict) and item.get("id"):
            _reject_unknown_keys(item, {"id", "layer"}, "dependency graph node")
            nodes[str(item["id"])] = str(item["layer"]) if item.get("layer") is not None else None
        else:
            raise ValueError("each node must be a string or an object with id")
    edges: list[tuple[str, str]] = []
    for item in raw_edges:
        if isinstance(item, list) and len(item) == 2:
            source, target = str(item[0]), str(item[1])
        elif isinstance(item, dict) and item.get("from") is not None and item.get("to") is not None:
            _reject_unknown_keys(item, {"from", "to"}, "dependency graph edge")
            source, target = str(item["from"]), str(item["to"])
        else:
            raise ValueError("each edge must be [from, to] or an object with from and to")
        nodes.setdefault(source, None)
        nodes.setdefault(target, None)
        edges.append((source, target))
    return nodes, edges


def _cycles(nodes: Iterable[str], edges: list[tuple[str, str]]) -> list[list[str]]:
    adjacency: dict[str, list[str]] = defaultdict(list)
    reverse: dict[str, list[str]] = defaultdict(list)
    self_edges: set[str] = set()
    for source, target in edges:
        adjacency[source].append(target)
        reverse[target].append(source)
        if source == target:
            self_edges.add(source)
    ordered_nodes = sorted(nodes)
    visited: set[str] = set()
    finish_order: list[str] = []
    for start in ordered_nodes:
        if start in visited:
            continue
        visited.add(start)
        stack: list[tuple[str, int]] = [(start, 0)]
        while stack:
            node, index = stack[-1]
            neighbors = adjacency[node]
            if index < len(neighbors):
                neighbor = neighbors[index]
                stack[-1] = (node, index + 1)
                if neighbor not in visited:
                    visited.add(neighbor)
                    stack.append((neighbor, 0))
                continue
            finish_order.append(node)
            stack.pop()

    assigned: set[str] = set()
    result: list[list[str]] = []
    for start in reversed(finish_order):
        if start in assigned:
            continue
        component: list[str] = []
        stack = [start]
        assigned.add(start)
        while stack:
            node = stack.pop()
            component.append(node)
            for neighbor in reverse[node]:
                if neighbor not in assigned:
                    assigned.add(neighbor)
                    stack.append(neighbor)
        if len(component) > 1 or component[0] in self_edges:
            result.append(sorted(component))
    return result


def analyze_dependency_graphs(
    root: Path,
    cli_paths: list[str],
    policy: dict[str, Any],
    *,
    profile: str,
    max_fan_in: int | None,
    max_fan_out: int | None,
    allow_cycles: bool,
    require_provenance: bool = False,
    expected_source_commit: str | None = None,
    max_age_seconds: int | None = None,
) -> tuple[list[ToolResult], list[Finding], list[dict[str, Any]]]:
    section = policy.get("dependencyGraph") or {}
    if not isinstance(section, dict):
        raise ValueError("quality policy dependencyGraph must be an object")
    paths = _configured_paths(cli_paths, section)
    defaults = PROFILE_GRAPH_LIMITS.get(profile, PROFILE_GRAPH_LIMITS["standard"])
    fan_in_limit = int(max_fan_in if max_fan_in is not None else section.get("maxFanIn", defaults["maxFanIn"]))
    fan_out_limit = int(max_fan_out if max_fan_out is not None else section.get("maxFanOut", defaults["maxFanOut"]))
    cycles_allowed = allow_cycles or section.get("allowCycles") is True
    if fan_in_limit < 0 or fan_out_limit < 0:
        raise ValueError("dependency fan-in and fan-out limits must be non-negative")
    configured_layer_rules = section.get("forbiddenLayerDependencies") or []
    if not isinstance(configured_layer_rules, list):
        raise ValueError("forbiddenLayerDependencies must be an array")

    results: list[ToolResult] = []
    findings: list[Finding] = []
    summaries: list[dict[str, Any]] = []
    for value in paths:
        report_path = _path(root, value)
        if not report_path.exists():
            results.append(_required_result("dependency-graph", report_path, "missing", f"Dependency graph not found: {report_path}"))
            continue
        try:
            payload = _json(report_path)
            if payload.get("schemaVersion") != 1:
                raise ValueError(f"unsupported schemaVersion {payload.get('schemaVersion')}")
            _reject_unknown_keys(
                payload,
                {"$schema", "schemaVersion", "provenance", "name", "nodes", "edges", "graphs", "forbiddenLayerDependencies"},
                "dependency graph",
            )
            provenance = validate_provenance(
                json_provenance(payload),
                report_path,
                required=require_provenance,
                expected_source_commit=expected_source_commit,
                max_age_seconds=max_age_seconds,
            )
            report_findings: list[Finding] = []
            graph_summaries: list[dict[str, Any]] = []
            if "graphs" not in payload and not {"nodes", "edges"}.issubset(payload):
                raise ValueError("dependency graph needs nodes and edges, or graphs")
            for graph_index, graph in enumerate(_graph_items(payload)):
                graph_keys = {"name", "nodes", "edges", "forbiddenLayerDependencies"}
                if graph is payload:
                    graph_keys.update({"schemaVersion", "provenance", "$schema"})
                _reject_unknown_keys(
                    graph,
                    graph_keys,
                    f"dependency graph[{graph_index}]",
                )
                nodes, edges = _parse_graph(graph)
                inbound: dict[str, set[str]] = defaultdict(set)
                outbound: dict[str, set[str]] = defaultdict(set)
                for source, target in edges:
                    outbound[source].add(target)
                    inbound[target].add(source)
                cycle_items = _cycles(nodes, edges)
                if not cycles_allowed:
                    for cycle in cycle_items:
                        report_findings.append(Finding(
                            tool="dependency-graph",
                            rule="dependency.cycle",
                            severity="high",
                            category="architecture-policy",
                            path=cycle[0],
                            message=f"Dependency cycle detected: {' -> '.join(cycle)}.",
                            metadata={"nodes": cycle, "graph": graph.get("name") or graph_index},
                        ))
                for node in sorted(nodes):
                    fan_in, fan_out = len(inbound[node]), len(outbound[node])
                    if fan_in_limit and fan_in > fan_in_limit:
                        report_findings.append(Finding(tool="dependency-graph", rule="dependency.fan-in", severity="medium", category="architecture-policy", path=node, message=f"Dependency fan-in {fan_in} exceeds limit {fan_in_limit}.", metadata={"observed": fan_in, "limit": fan_in_limit}))
                    if fan_out_limit and fan_out > fan_out_limit:
                        report_findings.append(Finding(tool="dependency-graph", rule="dependency.fan-out", severity="high", category="architecture-policy", path=node, message=f"Dependency fan-out {fan_out} exceeds limit {fan_out_limit}.", metadata={"observed": fan_out, "limit": fan_out_limit}))

                layer_rules = [*configured_layer_rules, *(graph.get("forbiddenLayerDependencies") or [])]
                for rule_index, rule in enumerate(layer_rules):
                    if not isinstance(rule, dict) or rule.get("from") is None or rule.get("to") is None:
                        raise ValueError(f"forbiddenLayerDependencies[{rule_index}] needs from and to")
                    _reject_unknown_keys(
                        rule,
                        {"from", "to", "severity", "message"},
                        f"forbiddenLayerDependencies[{rule_index}]",
                    )
                    source_layer, target_layer = str(rule["from"]), str(rule["to"])
                    for source, target in edges:
                        if nodes[source] == source_layer and nodes[target] == target_layer:
                            report_findings.append(Finding(
                                tool="dependency-graph",
                                rule=f"dependency.layer.{source_layer}-to-{target_layer}",
                                severity=str(rule.get("severity") or "high"),
                                category="architecture-policy",
                                path=source,
                                message=str(rule.get("message") or f"Layer {source_layer} must not depend on {target_layer}."),
                                metadata={"from": source, "to": target, "fromLayer": source_layer, "toLayer": target_layer},
                            ))
                graph_summaries.append({"name": graph.get("name") or f"graph-{graph_index + 1}", "nodes": len(nodes), "edges": len(edges), "cycles": len(cycle_items), "maxFanIn": max((len(inbound[node]) for node in nodes), default=0), "maxFanOut": max((len(outbound[node]) for node in nodes), default=0)})
            findings.extend(report_findings)
            summary = {"required": True, "findings": len(report_findings), "graphs": graph_summaries, "limits": {"maxFanIn": fan_in_limit, "maxFanOut": fan_out_limit, "allowCycles": cycles_allowed}, **provenance}
            results.append(ToolResult(name="dependency-graph", status="findings" if report_findings else "ok", output_path=str(report_path), summary=summary))
            summaries.append({"path": relative_path(report_path, root), **summary})
        except (OSError, ValueError, json.JSONDecodeError) as error:
            results.append(_required_result("dependency-graph", report_path, "error", f"Invalid dependency graph {report_path}: {error}"))
    return results, findings, summaries


def analyze_evidence_reports(
    root: Path,
    cli_paths: list[str],
    policy: dict[str, Any],
    *,
    require_provenance: bool = False,
    expected_source_commit: str | None = None,
    max_age_seconds: int | None = None,
) -> tuple[list[ToolResult], list[Finding], dict[str, Any]]:
    section = policy.get("evidence") or {}
    if not isinstance(section, dict):
        raise ValueError("quality policy evidence must be an object")
    paths = _configured_paths(cli_paths, section)
    required_metrics = section.get("requiredMetrics") or {}
    if not isinstance(required_metrics, dict):
        raise ValueError("evidence.requiredMetrics must be an object")
    results: list[ToolResult] = []
    findings: list[Finding] = []
    observed: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for value in paths:
        report_path = _path(root, value)
        if not report_path.exists():
            results.append(_required_result("quality-evidence", report_path, "missing", f"Evidence report not found: {report_path}"))
            continue
        try:
            payload = _json(report_path)
            if payload.get("schemaVersion") != 1:
                raise ValueError(f"unsupported schemaVersion {payload.get('schemaVersion')}")
            _reject_unknown_keys(
                payload,
                {"$schema", "schemaVersion", "provenance", "metrics", "checks"},
                "quality evidence",
            )
            provenance = validate_provenance(
                json_provenance(payload),
                report_path,
                required=require_provenance,
                expected_source_commit=expected_source_commit,
                max_age_seconds=max_age_seconds,
            )
            if "metrics" not in payload or "checks" not in payload:
                raise ValueError("quality evidence needs metrics and checks")
            metrics = payload["metrics"]
            checks = payload["checks"]
            if not isinstance(metrics, dict) or not isinstance(checks, list):
                raise ValueError("metrics must be an object and checks must be an array")
            report_findings: list[Finding] = []
            for metric_id, raw in metrics.items():
                item = raw if isinstance(raw, dict) else {"value": raw}
                if isinstance(raw, dict):
                    _reject_unknown_keys(raw, {"value", "path"}, f"metric {metric_id}")
                metric_value = item.get("value")
                if isinstance(metric_value, bool) or not isinstance(metric_value, (int, float)):
                    raise ValueError(f"metric {metric_id} value must be numeric")
                observed[str(metric_id)].append({"value": float(metric_value), "path": str(item.get("path") or ""), "report": relative_path(report_path, root)})
            for index, check in enumerate(checks):
                if not isinstance(check, dict) or check.get("id") is None:
                    raise ValueError(f"checks[{index}] needs id")
                _reject_unknown_keys(
                    check,
                    {"id", "status", "severity", "category", "path", "message"},
                    f"checks[{index}]",
                )
                status = str(check.get("status") or "error").lower()
                if status in {"passed", "approved", "ok"}:
                    continue
                if status == "skipped":
                    report_findings.append(Finding(
                        tool="quality-evidence",
                        rule=f"evidence.check.{check['id']}.skipped",
                        severity=str(check.get("severity") or "high"),
                        category=str(check.get("category") or "contract-policy"),
                        path=str(check.get("path") or ""),
                        message=str(check.get("message") or f"Required check {check['id']} was skipped."),
                        metadata={"status": status, "report": relative_path(report_path, root)},
                    ))
                    continue
                if status not in {"failed", "rejected", "needs_changes"}:
                    raise ValueError(f"check {check['id']} has unsupported status {status}")
                report_findings.append(Finding(
                    tool="quality-evidence",
                    rule=f"evidence.check.{check['id']}",
                    severity=str(check.get("severity") or "high"),
                    category=str(check.get("category") or "contract-policy"),
                    path=str(check.get("path") or ""),
                    message=str(check.get("message") or f"Required check {check['id']} failed."),
                    metadata={"status": status, "report": relative_path(report_path, root)},
                ))
            findings.extend(report_findings)
            results.append(ToolResult(name="quality-evidence", status="findings" if report_findings else "ok", output_path=str(report_path), summary={"required": True, "findings": len(report_findings), "metrics": len(metrics), "checks": len(checks), **provenance}))
        except (OSError, ValueError, json.JSONDecodeError) as error:
            results.append(_required_result("quality-evidence", report_path, "error", f"Invalid evidence report {report_path}: {error}"))

    for metric_id, raw_rule in required_metrics.items():
        rule = raw_rule if isinstance(raw_rule, dict) else {"min": raw_rule}
        values = observed.get(str(metric_id), [])
        if not values:
            findings.append(Finding(tool="quality-evidence", rule=f"evidence.metric.{metric_id}.missing", severity="high", category="quality-evidence", message=f"Required metric {metric_id} is missing from evidence reports."))
            continue
        for item in values:
            value = float(item["value"])
            minimum, maximum = rule.get("min"), rule.get("max")
            violated = (minimum is not None and value < float(minimum)) or (maximum is not None and value > float(maximum))
            if violated:
                findings.append(Finding(
                    tool="quality-evidence",
                    rule=f"evidence.metric.{metric_id}",
                    severity=str(rule.get("severity") or "high"),
                    category=str(rule.get("category") or "quality-evidence"),
                    path=str(item["path"]),
                    message=str(rule.get("message") or f"Metric {metric_id} value {value:g} violates its configured threshold."),
                    metadata={"metric": metric_id, "value": value, "min": minimum, "max": maximum, "report": item["report"]},
                ))
    if findings:
        for result in results:
            if result.status == "ok":
                result.status = "findings"
                result.summary["findings"] = len(findings)
    return results, findings, {"reports": len(paths), "metrics": dict(observed), "requiredMetrics": required_metrics}


def _junit_summary(path: Path) -> dict[str, float | int]:
    root = ET.parse(path).getroot()
    cases = list(root.iter("testcase"))
    failures = sum(1 for case in cases if case.find("failure") is not None)
    errors = sum(1 for case in cases if case.find("error") is not None)
    skipped = sum(1 for case in cases if case.find("skipped") is not None)
    duration = sum(float(case.get("time") or 0) for case in cases)
    return {"tests": len(cases), "failures": failures, "errors": errors, "skipped": skipped, "durationSeconds": round(duration, 3)}


def analyze_test_reports(
    root: Path,
    cli_paths: list[str],
    policy: dict[str, Any],
    *,
    min_tests: int | None,
    max_skipped_tests: int | None,
    max_skipped_percent: float | None,
    require_provenance: bool = False,
    expected_source_commit: str | None = None,
    max_age_seconds: int | None = None,
) -> tuple[list[ToolResult], list[Finding], dict[str, Any]]:
    section = policy.get("testQuality") or {}
    if not isinstance(section, dict):
        raise ValueError("quality policy testQuality must be an object")
    paths = _configured_paths(cli_paths, section)
    minimum = int(min_tests if min_tests is not None else section.get("minTests", 1))
    skipped_limit = max_skipped_tests if max_skipped_tests is not None else section.get("maxSkippedTests")
    skipped_percent_limit = max_skipped_percent if max_skipped_percent is not None else section.get("maxSkippedPercent")
    if minimum < 0 or (skipped_limit is not None and int(skipped_limit) < 0) or (skipped_percent_limit is not None and float(skipped_percent_limit) < 0):
        raise ValueError("test quality thresholds must be non-negative")
    results: list[ToolResult] = []
    findings: list[Finding] = []
    total = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0, "durationSeconds": 0.0}
    for value in paths:
        report_path = _path(root, value)
        if not report_path.exists():
            results.append(_required_result("test-quality", report_path, "missing", f"JUnit report not found: {report_path}"))
            continue
        try:
            xml_root = ET.parse(report_path).getroot()
            summary = _junit_summary(report_path)
            provenance = validate_provenance(
                junit_provenance(xml_root),
                report_path,
                required=require_provenance,
                expected_source_commit=expected_source_commit,
                max_age_seconds=max_age_seconds,
            )
            for key in total:
                total[key] += summary[key]
            results.append(ToolResult(name="test-quality", status="ok", output_path=str(report_path), summary={"required": True, "findings": 0, **summary, **provenance}))
        except (OSError, ValueError, ET.ParseError) as error:
            results.append(_required_result("test-quality", report_path, "error", f"Invalid JUnit report {report_path}: {error}"))
    if paths:
        checks = [
            (total["tests"] < minimum, "test-quality.minimum-tests", f"Test count {total['tests']} is below minimum {minimum}."),
            (total["failures"] > 0, "test-quality.failures", f"JUnit evidence contains {total['failures']} failed tests."),
            (total["errors"] > 0, "test-quality.errors", f"JUnit evidence contains {total['errors']} test errors."),
            (skipped_limit is not None and total["skipped"] > int(skipped_limit), "test-quality.skipped", f"Skipped test count {total['skipped']} exceeds limit {int(skipped_limit or 0)}."),
        ]
        skipped_percent = (100.0 * total["skipped"] / total["tests"]) if total["tests"] else 0.0
        checks.append((skipped_percent_limit is not None and skipped_percent > float(skipped_percent_limit), "test-quality.skipped-percent", f"Skipped test percentage {skipped_percent:.2f} exceeds limit {float(skipped_percent_limit or 0):.2f}."))
        for failed, rule, message in checks:
            if failed:
                findings.append(Finding(tool="test-quality", rule=rule, severity="high", category="test-quality", message=message, metadata={**total, "skippedPercent": round(skipped_percent, 2)}))
        if findings:
            for result in results:
                if result.status == "ok":
                    result.status = "findings"
                    result.summary["findings"] = len(findings)
    total["durationSeconds"] = round(float(total["durationSeconds"]), 3)
    return results, findings, {**total, "reports": len(paths)}
