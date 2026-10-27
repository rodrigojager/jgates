from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))

from quality_sidecar.evidence import (  # noqa: E402
    _cycles,
    analyze_dependency_graphs,
    analyze_evidence_reports,
    analyze_test_reports,
)
from quality_sidecar.metrics import (  # noqa: E402
    BUDGET_KEYS,
    analyze_change_requirements,
    analyze_quality_budgets,
    load_quality_policy,
)
from quality_sidecar.findings import Finding  # noqa: E402
from quality_sidecar.policy import evaluate_policy  # noqa: E402


def overrides(**values: int | None) -> dict[str, int | None]:
    result = {key: None for key in BUDGET_KEYS}
    result.update(values)
    return result


class RepositoryBudgetTests(unittest.TestCase):
    def test_file_and_change_budgets_create_blocking_findings(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "large.txt").write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")
            scope = {
                "scope": "changed",
                "selectedFiles": ["large.txt", "second.txt", "third.txt"],
                "selectedFileCount": 3,
                "diff": {
                    "status": "available",
                    "fileCount": 3,
                    "additions": 12,
                    "deletions": 8,
                    "changedLines": 20,
                    "patchBytes": 200,
                    "binaryFiles": 2,
                },
            }

            metrics, findings = analyze_quality_budgets(
                root,
                scope=scope,
                profile="standard",
                policy={},
                overrides=overrides(
                    maxFileLines=3,
                    maxChangedFiles=2,
                    maxChangedLines=10,
                    maxDiffBytes=100,
                    maxBinaryFiles=1,
                    hotspotMinCommits=0,
                    hotspotMinChurn=0,
                ),
            )

            rules = {finding.rule for finding in findings}
            self.assertIn("budget.file-lines", rules)
            self.assertIn("budget.changed-files", rules)
            self.assertIn("budget.changed-lines", rules)
            self.assertIn("budget.diff-bytes", rules)
            self.assertIn("budget.binary-files", rules)
            self.assertEqual(metrics["change"]["changedLines"], 20)

    def test_hotspot_requires_both_history_thresholds(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "core.txt").write_text("core\n", encoding="utf-8")
            scope = {
                "scope": "changed",
                "selectedFiles": ["core.txt"],
                "diff": {"status": "available", "fileCount": 1},
                "history": {"status": "available", "commitLimit": 500, "files": {"core.txt": {"commits": 10, "churn": 200}}},
            }
            _, findings = analyze_quality_budgets(
                root,
                scope=scope,
                profile="standard",
                policy={},
                overrides=overrides(hotspotMinCommits=10, hotspotMinChurn=200),
            )
            self.assertIn("budget.change-hotspot", {finding.rule for finding in findings})

    def test_support_files_are_not_charged_to_changed_scope_budgets(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "source.txt").write_text("selected\n", encoding="utf-8")
            (root / "package-lock.json").write_text("support\n" * 20, encoding="utf-8")
            scope = {
                "scope": "changed",
                "selectedFiles": ["source.txt"],
                "supportFiles": ["package-lock.json"],
                "diff": {"status": "available", "fileCount": 1},
            }

            metrics, findings = analyze_quality_budgets(
                root,
                scope=scope,
                profile="standard",
                policy={"budgets": {"maxFileLines": 2}},
                overrides=overrides(),
            )

            self.assertNotIn("budget.file-lines", {finding.rule for finding in findings})
            self.assertEqual(metrics["totals"]["files"], 1)
            self.assertEqual(metrics["supportFilesExcluded"], 1)

    def test_change_requirement_enforces_companion_file(self) -> None:
        policy = {
            "changeRequirements": [{
                "id": "contract-tests",
                "whenAny": ["contracts/**"],
                "requireAny": ["tests/**", "clients/**"],
                "message": "Contract changes require tests or client updates.",
            }]
        }
        summary, findings = analyze_change_requirements(
            {"scope": "changed", "selectedFiles": ["contracts/api.json"]}, policy
        )
        self.assertEqual(summary["triggered"], 1)
        self.assertEqual(findings[0].rule, "change-requirement.contract-tests")

        summary, findings = analyze_change_requirements(
            {"scope": "changed", "selectedFiles": ["contracts/api.json", "tests/api.test"]}, policy
        )
        self.assertEqual(summary["triggered"], 0)
        self.assertEqual(findings, [])


class SchemaContractTests(unittest.TestCase):
    def test_versioned_contract_schemas_and_policy_example_are_loadable(self) -> None:
        schema_dir = ROOT / "schemas"
        names = {
            "quality-policy.schema.json",
            "quality-evidence.schema.json",
            "dependency-graph.schema.json",
            "scope-manifest.schema.json",
            "bridge-request.schema.json",
            "bridge-response.schema.json",
        }
        self.assertEqual({path.name for path in schema_dir.glob("*.json")}, names)
        for name in sorted(names):
            payload = json.loads((schema_dir / name).read_text(encoding="utf-8"))
            self.assertEqual(payload["$schema"], "https://json-schema.org/draft/2020-12/schema")
            self.assertTrue(payload["$id"].endswith(name))

        policy, path = load_quality_policy(ROOT, "examples/quality-gate-policy.example.json")
        self.assertEqual(policy["schemaVersion"], 1)
        self.assertEqual(path, "examples/quality-gate-policy.example.json")

        with tempfile.TemporaryDirectory() as temp:
            external = Path(temp) / "external-policy.json"
            external.write_text('{"schemaVersion":1}\n', encoding="utf-8")
            _, external_path = load_quality_policy(ROOT, str(external))
            self.assertEqual(external_path, "external-policy.json")


class NeutralEvidenceTests(unittest.TestCase):
    def test_custom_evidence_category_still_blocks_by_tool_origin(self) -> None:
        result = evaluate_policy(
            [Finding(tool="quality-evidence", rule="custom", severity="info", category="team-specific", message="failed")],
            [],
            profile="relaxed",
            threshold=1,
            mode="quick",
            fail_on_tool_error=False,
        )
        self.assertEqual(result.status, "REJECTED")
        self.assertEqual(result.exit_code, 1)

    def test_large_dependency_graph_cycle_detection_is_iterative(self) -> None:
        nodes = [f"node-{index}" for index in range(2500)]
        edges = [(nodes[index], nodes[index + 1]) for index in range(len(nodes) - 1)]
        self.assertEqual(_cycles(nodes, edges), [])
        cycles = _cycles(nodes, [*edges, (nodes[-1], nodes[0])])
        self.assertEqual(len(cycles), 1)
        self.assertEqual(len(cycles[0]), len(nodes))

    def test_dependency_graph_detects_cycles_fan_out_and_layer_violation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            graph = root / "graph.json"
            graph.write_text(json.dumps({
                "schemaVersion": 1,
                "nodes": [
                    {"id": "domain/a", "layer": "domain"},
                    {"id": "infra/b", "layer": "infrastructure"},
                    {"id": "domain/c", "layer": "domain"},
                ],
                "edges": [
                    {"from": "domain/a", "to": "infra/b"},
                    {"from": "infra/b", "to": "domain/a"},
                    {"from": "domain/a", "to": "domain/c"},
                ],
                "forbiddenLayerDependencies": [{"from": "domain", "to": "infrastructure"}],
            }), encoding="utf-8")

            results, findings, summaries = analyze_dependency_graphs(
                root,
                ["graph.json"],
                {},
                profile="standard",
                max_fan_in=1,
                max_fan_out=1,
                allow_cycles=False,
            )

            rules = {finding.rule for finding in findings}
            self.assertEqual(results[0].status, "findings")
            self.assertIn("dependency.cycle", rules)
            self.assertIn("dependency.fan-out", rules)
            self.assertIn("dependency.layer.domain-to-infrastructure", rules)
            self.assertEqual(summaries[0]["graphs"][0]["nodes"], 3)

    def test_generic_evidence_applies_metric_and_contract_rules(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = root / "evidence.json"
            report.write_text(json.dumps({
                "schemaVersion": 1,
                "metrics": {
                    "mutation.score": {"value": 70, "path": "src"},
                    "complexity.cyclomatic.max": {"value": 21, "path": "src/core"},
                },
                "checks": [{"id": "api-breaking", "status": "failed", "category": "contract-policy"}],
            }), encoding="utf-8")
            policy = {"evidence": {"requiredMetrics": {
                "mutation.score": {"min": 80},
                "complexity.cyclomatic.max": {"max": 15},
            }}}

            results, findings, summary = analyze_evidence_reports(root, ["evidence.json"], policy)

            rules = {finding.rule for finding in findings}
            self.assertEqual(results[0].status, "findings")
            self.assertIn("evidence.metric.mutation.score", rules)
            self.assertIn("evidence.metric.complexity.cyclomatic.max", rules)
            self.assertIn("evidence.check.api-breaking", rules)
            self.assertIn("mutation.score", summary["metrics"])

    def test_evidence_provenance_must_match_expected_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = root / "evidence.json"
            report.write_text(json.dumps({
                "schemaVersion": 1,
                "provenance": {
                    "sourceCommit": "a" * 40,
                    "producer": "fixture",
                    "producerVersion": "1.0.0",
                    "generatedAt": "2026-07-15T12:00:00Z",
                },
                "metrics": {},
                "checks": [],
            }), encoding="utf-8")

            results, findings, _ = analyze_evidence_reports(
                root,
                ["evidence.json"],
                {},
                require_provenance=True,
                expected_source_commit="b" * 40,
            )

            self.assertEqual(findings, [])
            self.assertEqual(results[0].status, "error")
            self.assertIn("does not match expected commit", results[0].error)

    def test_missing_requested_evidence_is_required_tool_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            results, findings, _ = analyze_evidence_reports(Path(temp), ["missing.json"], {})
            self.assertEqual(findings, [])
            self.assertEqual(results[0].status, "missing")
            self.assertTrue(results[0].summary["required"])

    def test_skipped_required_evidence_check_is_not_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = root / "evidence.json"
            report.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "metrics": {},
                        "checks": [{"id": "mutation", "status": "skipped"}],
                    }
                ),
                encoding="utf-8",
            )

            results, findings, _ = analyze_evidence_reports(root, ["evidence.json"], {})

            self.assertEqual(results[0].status, "findings")
            self.assertEqual(findings[0].rule, "evidence.check.mutation.skipped")

    def test_evidence_requires_versioned_metrics_and_checks_contract(self) -> None:
        invalid_payloads = (
            {"metrics": {}, "checks": []},
            {"schemaVersion": 1, "checks": []},
            {"schemaVersion": 1, "metrics": {}},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                report = root / "evidence.json"
                report.write_text(json.dumps(payload), encoding="utf-8")
                results, findings, _ = analyze_evidence_reports(root, ["evidence.json"], {})
                self.assertEqual(findings, [])
                self.assertEqual(results[0].status, "error")

    def test_junit_quality_counts_failures_and_skips(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = root / "junit.xml"
            report.write_text(
                '<testsuite><testcase name="ok" time="0.1"/><testcase name="skip"><skipped/></testcase>'
                '<testcase name="bad"><failure/></testcase></testsuite>',
                encoding="utf-8",
            )
            results, findings, summary = analyze_test_reports(
                root,
                ["junit.xml"],
                {},
                min_tests=3,
                max_skipped_tests=0,
                max_skipped_percent=10,
            )
            rules = {finding.rule for finding in findings}
            self.assertEqual(results[0].status, "findings")
            self.assertIn("test-quality.failures", rules)
            self.assertIn("test-quality.skipped", rules)
            self.assertIn("test-quality.skipped-percent", rules)
            self.assertEqual(summary["tests"], 3)

    def test_junit_provenance_is_required_when_requested(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "junit.xml").write_text(
                '<testsuite><testcase name="ok"/></testsuite>', encoding="utf-8"
            )

            results, _, _ = analyze_test_reports(
                root,
                ["junit.xml"],
                {},
                min_tests=1,
                max_skipped_tests=None,
                max_skipped_percent=None,
                require_provenance=True,
            )

            self.assertEqual(results[0].status, "error")
            self.assertIn("provenance is required", results[0].error)


class LanguageAgnosticCliTests(unittest.TestCase):
    def run_sidecar(self, target: Path, *args: str) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "PYTHONPATH": str(ROOT / "sidecar"), "PYTHONIOENCODING": "utf-8"}
        return subprocess.run(
            [sys.executable, "-m", "quality_sidecar", "check", str(target), "--mode", "quick", "--format", "json", *args],
            cwd=str(ROOT),
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

    def test_cli_rejects_budget_and_supports_existing_allow_rule(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "large.txt").write_text("one\ntwo\nthree\n", encoding="utf-8")

            rejected = self.run_sidecar(target, "--max-file-lines", "2")
            self.assertEqual(rejected.returncode, 1, rejected.stdout + rejected.stderr)
            report = json.loads((target / ".quality" / "reports" / "quality-report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "REJECTED")
            self.assertEqual(report["metrics"]["budgets"]["maxFileLines"], 2)

            allowed = self.run_sidecar(target, "--max-file-lines", "2", "--allow-rule", "budget.file-lines")
            self.assertEqual(allowed.returncode, 0, allowed.stdout + allowed.stderr)

    def test_cli_localizes_human_output_without_changing_machine_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "source.txt").write_text("source\n", encoding="utf-8")

            result = self.run_sidecar(target, "--locale", "pt-BR", "--format", "json,md")

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Relatórios:", result.stdout)
            report = json.loads((target / ".quality" / "reports" / "quality-report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "APPROVED")
            self.assertEqual(report["locale"], "pt-BR")
            markdown = (target / ".quality" / "reports" / "quality-report.md").read_text(encoding="utf-8")
            self.assertIn("# Relatório do Quality Gate", markdown)

    def test_cli_needs_changes_when_requested_evidence_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "source.txt").write_text("source\n", encoding="utf-8")
            result = self.run_sidecar(target, "--evidence-report", "missing.json")
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            report = json.loads((target / ".quality" / "reports" / "quality-report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "NEEDS_CHANGES")
            self.assertIn("Required deterministic evidence", report["summary"]["reasons"][0])

    def test_cli_fails_closed_when_changed_scope_diff_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "source.txt").write_text("source\n", encoding="utf-8")
            (target / "scope.json").write_text(json.dumps({
                "schemaVersion": 1,
                "scope": "changed",
                "selectedFiles": [],
                "diff": {"status": "unavailable"},
            }), encoding="utf-8")

            result = self.run_sidecar(target, "--scope-manifest", "scope.json")

            self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
            self.assertIn("requires a complete, available Git diff", result.stderr)

    def test_direct_sidecar_does_not_reuse_stale_scope_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "source.txt").write_text("source\n", encoding="utf-8")
            reports = target / ".quality" / "reports"
            reports.mkdir(parents=True)
            (reports / "quality-scope.json").write_text(json.dumps({
                "scope": "changed",
                "selectedFileCount": 999,
                "diff": {"status": "available", "fileCount": 999},
            }), encoding="utf-8")

            result = self.run_sidecar(target, "--max-changed-files", "1")

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads((reports / "quality-report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["metrics"]["scope"], "full")
            self.assertEqual(report["metrics"]["change"]["status"], "unavailable")

    def test_cli_requires_exact_policy_digest_and_rejects_unknown_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "source.txt").write_text("source\n", encoding="utf-8")
            policy = target / "policy.json"
            policy.write_text('{"schemaVersion":1,"unexpected":true}\n', encoding="utf-8")

            unknown = self.run_sidecar(target, "--policy-file", "policy.json")
            self.assertEqual(unknown.returncode, 3, unknown.stdout + unknown.stderr)
            self.assertIn("Unknown quality policy keys", unknown.stderr)

            policy.write_text('{"schemaVersion":1,"budgets":{"maxFileLines":10}}\n', encoding="utf-8")
            mismatch = self.run_sidecar(
                target,
                "--policy-file",
                "policy.json",
                "--policy-sha256",
                "0" * 64,
            )
            self.assertEqual(mismatch.returncode, 3, mismatch.stdout + mismatch.stderr)
            self.assertIn("Policy SHA-256 mismatch", mismatch.stderr)


if __name__ == "__main__":
    unittest.main()
