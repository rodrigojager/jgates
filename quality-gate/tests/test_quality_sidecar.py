from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest.mock import patch

from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))

from quality_sidecar.detectors import detect_iac_files  # noqa: E402
from quality_sidecar.findings import Finding  # noqa: E402
from quality_sidecar.policy import evaluate_policy  # noqa: E402
from quality_sidecar.report import build_report, write_markdown_report  # noqa: E402
from quality_sidecar.tools import (  # noqa: E402
    MEGALINTER_CONFIG_DIR,
    ToolResult,
    _parse_checkov,
    _quality_gate_flavor,
    _parse_megalinter,
    _parse_trivy,
    _prepare_raw_dir,
    _run_checkov,
    _run_gitleaks,
    _run_jscpd,
    _run_megalinter,
    _run_osv_scanner,
    _run_semgrep,
    _run_trivy,
    parse_tool_findings,
    run_command,
    run_external_tools,
    run_project_tests,
)


class QualitySidecarCliTests(unittest.TestCase):
    def run_sidecar(self, target: Path, *args: str) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "PYTHONPATH": str(ROOT / "sidecar")}
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "quality_sidecar",
                "check",
                str(target),
                "--mode",
                "quick",
                "--format",
                "json,md",
                *args,
            ],
            cwd=str(ROOT),
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

    @staticmethod
    def write_privacy_fixture(target: Path) -> None:
        secret = "abcdefghijkl" + "mnopqrstuvwxyz"
        cpf = "123.456" + ".789-09"
        (target / "sample.txt").write_text(
            f"password = '{secret}'\ncpf = '{cpf}'\n",
            encoding="utf-8",
        )

    @staticmethod
    def read_report(target: Path) -> dict[str, object]:
        report_path = target / ".quality" / "reports" / "quality-report.json"
        return json.loads(report_path.read_text(encoding="utf-8"))

    def test_quick_mode_ignores_secret_and_pii_unless_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            self.write_privacy_fixture(target)

            result = self.run_sidecar(target, "--threshold", "99")

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report_path = target / ".quality" / "reports" / "quality-report.json"
            markdown_path = target / ".quality" / "reports" / "quality-report.md"
            self.assertTrue(report_path.exists())
            self.assertTrue(markdown_path.exists())

            report = self.read_report(target)
            self.assertEqual(report["status"], "APPROVED")
            self.assertEqual(report["findings"], [])

    def test_quick_mode_rejects_secret_and_pii_when_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            self.write_privacy_fixture(target)

            result = self.run_sidecar(target, "--threshold", "99", "--enable-secrets", "--enable-pii")

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = self.read_report(target)
            self.assertEqual(report["status"], "REJECTED")
            categories = {finding["category"] for finding in report["findings"]}
            self.assertIn("secrets", categories)
            self.assertIn("pii", categories)

    def test_allow_flags_approve_when_all_findings_are_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            self.write_privacy_fixture(target)

            result = self.run_sidecar(
                target,
                "--threshold",
                "99",
                "--enable-secrets",
                "--enable-pii",
                "--allow-secrets",
                "--allow-pii",
                "--waiver-reason",
                "Synthetic fixture",
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = self.read_report(target)
            self.assertEqual(report["status"], "APPROVED")
            self.assertTrue(all(finding["status"] == "allowed" for finding in report["findings"]))

    def test_coverage_enabled_rejects_when_line_coverage_is_below_threshold(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            coverage_dir = target / "coverage"
            coverage_dir.mkdir()
            (coverage_dir / "lcov.info").write_text(
                "\n".join(
                    [
                        "TN:",
                        "SF:src/app.js",
                        "DA:1,1",
                        "DA:2,0",
                        "LF:2",
                        "LH:1",
                        "end_of_record",
                    ]
                ),
                encoding="utf-8",
            )

            result = self.run_sidecar(target, "--enable-coverage", "--min-line-coverage", "80")

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = self.read_report(target)
            self.assertEqual(report["status"], "REJECTED")
            coverage = next(tool for tool in report["tools"] if tool["name"] == "coverage")
            self.assertEqual(coverage["status"], "findings")
            self.assertEqual(coverage["summary"]["lineCoverage"], 50.0)
            self.assertTrue(any(finding["rule"] == "coverage.line-threshold" for finding in report["findings"]))

    def test_coverage_enabled_without_report_needs_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)

            result = self.run_sidecar(target, "--enable-coverage")

            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            report = self.read_report(target)
            self.assertEqual(report["status"], "NEEDS_CHANGES")
            coverage = next(tool for tool in report["tools"] if tool["name"] == "coverage")
            self.assertEqual(coverage["status"], "missing")
            self.assertIn("Coverage analysis was requested", report["summary"]["reasons"][0])

    def test_coverage_enabled_accepts_cobertura_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "coverage.xml").write_text(
                '<coverage lines-covered="9" lines-valid="10" branches-covered="7" branches-valid="10"></coverage>',
                encoding="utf-8",
            )

            result = self.run_sidecar(
                target,
                "--enable-coverage",
                "--min-line-coverage",
                "80",
                "--min-branch-coverage",
                "60",
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = self.read_report(target)
            coverage = next(tool for tool in report["tools"] if tool["name"] == "coverage")
            self.assertEqual(coverage["summary"]["lineCoverage"], 90.0)
            self.assertEqual(coverage["summary"]["branchCoverage"], 70.0)


class QualityDetectorTests(unittest.TestCase):
    def test_detect_iac_files_finds_common_iac_without_matching_plain_yaml(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / "main.tf").write_text("resource \"aws_s3_bucket\" \"x\" {}\n", encoding="utf-8")
            (target / "deployment.yaml").write_text("apiVersion: apps/v1\nkind: Deployment\n", encoding="utf-8")
            (target / "notes.yaml").write_text("name: just-notes\n", encoding="utf-8")

            files = detect_iac_files(target)

            self.assertIn("main.tf", files)
            self.assertIn("deployment.yaml", files)
            self.assertNotIn("notes.yaml", files)


class QualityPolicyTests(unittest.TestCase):
    @staticmethod
    def create_megalinter_error_log(temp: str, content: str) -> tuple[Path, Path]:
        target = Path(temp)
        raw = target / "raw"
        logs = raw / "megalinter" / "linters_logs"
        logs.mkdir(parents=True)
        (raw / "megalinter" / "mega-linter.log").write_text("MegaLinter fixture\n", encoding="utf-8")
        (logs / "YAML_YAMLLINT-ERROR.log").write_text(content, encoding="utf-8")
        return target, raw

    @staticmethod
    def create_incomplete_npm_workspace(temp: str) -> tuple[Path, Path]:
        target = Path(temp)
        raw = target / "raw"
        raw.mkdir()
        (target / "package.json").write_text(
            json.dumps({"workspaces": ["semantic-gate", "quality-gate"]}),
            encoding="utf-8",
        )
        present_workspace = target / "quality-gate"
        present_workspace.mkdir()
        (present_workspace / "package.json").write_text("{}\n", encoding="utf-8")
        return target, raw

    def test_non_default_output_cleanup_preserves_project_owned_raw_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            raw = Path(temp) / "custom-output" / "raw"
            raw.mkdir(parents=True)
            project_owned = raw / "project-owned.txt"
            project_owned.write_text("preservar\n", encoding="utf-8")

            _prepare_raw_dir(raw)

            self.assertTrue(raw.is_dir())
            self.assertEqual(project_owned.read_text(encoding="utf-8"), "preservar\n")

    def test_raw_evidence_cleanup_removes_only_known_gate_outputs_after_marking(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            raw = Path(temp) / "raw"
            _prepare_raw_dir(raw)
            (raw / "semgrep.json").write_text("{}\n", encoding="utf-8")
            (raw / "megalinter").mkdir()
            (raw / "megalinter" / "result.log").write_text("stale\n", encoding="utf-8")
            project_owned = raw / "project-owned.txt"
            project_owned.write_text("preservar\n", encoding="utf-8")

            _prepare_raw_dir(raw)

            self.assertFalse((raw / "semgrep.json").exists())
            self.assertFalse((raw / "megalinter").exists())
            self.assertEqual(project_owned.read_text(encoding="utf-8"), "preservar\n")

    def test_raw_evidence_cleanup_rejects_known_output_symlink_before_marking(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()
            outside = target / "outside.json"
            outside.write_text("preservar\n", encoding="utf-8")
            try:
                (raw / "semgrep.json").symlink_to(outside)
            except OSError as error:
                self.skipTest(f"Symbolic links are unavailable in this environment: {error}")

            with self.assertRaisesRegex(RuntimeError, "output symlink"):
                _prepare_raw_dir(raw)

            self.assertEqual(outside.read_text(encoding="utf-8"), "preservar\n")

    def test_megalinter_exit_one_becomes_structured_findings(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target, raw = self.create_megalinter_error_log(temp, "invalid YAML\n")

            with (
                patch.dict(os.environ, {"QUALITY_GATE_FLAVOR": "dotnetweb"}),
                patch(
                    "quality_sidecar.tools.run_command",
                    return_value=ToolResult(
                        name="megalinter",
                        status="ok",
                        exit_code=1,
                        output_path=str(raw / "megalinter"),
                    ),
                ) as run_command_mock,
            ):
                result = _run_megalinter(target, raw)

            findings = _parse_megalinter(result)
            environment = run_command_mock.call_args.kwargs["env"]
            self.assertEqual(result.status, "findings")
            self.assertEqual(result.summary["failedAnalyzers"], ["YAML_YAMLLINT"])
            self.assertEqual(len(findings), 1)
            self.assertEqual(findings[0].rule, "megalinter.yaml-yamllint")
            self.assertEqual(findings[0].category, "lint")
            self.assertEqual(findings[0].severity, "high")
            policy = evaluate_policy(
                findings,
                [result],
                profile="standard",
                threshold=90,
                mode="full",
                fail_on_tool_error=True,
            )
            self.assertEqual(policy.status, "REJECTED")
            self.assertEqual(policy.exit_code, 1)
            self.assertIn("CSHARP_DOTNET_FORMAT", environment["ENABLE_LINTERS"])
            self.assertNotIn("REPOSITORY_TRIVY", environment["ENABLE_LINTERS"])
            eslint_rules_path = Path(environment["JAVASCRIPT_ES_RULES_PATH"])
            if target.drive.casefold() == MEGALINTER_CONFIG_DIR.drive.casefold():
                self.assertFalse(eslint_rules_path.is_absolute())
                self.assertEqual((target / eslint_rules_path).resolve(), MEGALINTER_CONFIG_DIR)
            else:
                self.assertEqual(eslint_rules_path, MEGALINTER_CONFIG_DIR)
            self.assertIn("--config", environment["JAVASCRIPT_ES_ARGUMENTS"])
            self.assertIn(str(MEGALINTER_CONFIG_DIR / "eslint.config.mjs"), environment["JAVASCRIPT_ES_ARGUMENTS"])
            self.assertEqual(
                environment["REPOSITORY_DEVSKIM_ARGUMENTS"],
                "--ignore-globs **/.git/**,**/megalinter-reports/**,**/.quality/**",
            )
            exclusion = re.compile(environment["FILTER_REGEX_EXCLUDE"])
            self.assertIsNone(exclusion.search((target / "sample.js").as_posix()))
            self.assertIsNotNone(exclusion.search((target / "src" / "tmp" / "artifact.js").as_posix()))
            self.assertIsNone(exclusion.search((target / "src" / "obj" / "generated.cs").as_posix()))
            self.assertIsNone(exclusion.search((target / "src" / "bin" / "source.js").as_posix()))
            trusted_config = Path(environment["MEGALINTER_CONFIG"])
            self.assertTrue(trusted_config.is_absolute())
            self.assertEqual(trusted_config.name, "megalinter-ci.yml")
            self.assertTrue(trusted_config.is_file())
            self.assertIn("--no-inline-config", environment["JAVASCRIPT_ES_ARGUMENTS"])
            self.assertEqual(environment["TERRAFORM_TFLINT_RULES_PATH"], str(MEGALINTER_CONFIG_DIR))
            self.assertEqual(environment["TERRAFORM_TFLINT_CONFIG_FILE"], "tflint-ci.hcl")
            self.assertEqual(environment["FORMATTERS_DISABLE_ERRORS"], "false")

    def test_generic_flavor_preserves_megalinter_language_auto_detection(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()

            with (
                patch.dict(os.environ, {"QUALITY_GATE_FLAVOR": "generic"}),
                patch(
                    "quality_sidecar.tools.run_command",
                    return_value=ToolResult(name="megalinter", status="ok", exit_code=0),
                ) as run_command_mock,
            ):
                _run_megalinter(target, raw)

            environment = run_command_mock.call_args.kwargs["env"]
            self.assertNotIn("ENABLE_LINTERS", environment)
            self.assertIn("REPOSITORY_TRIVY", environment["DISABLE_LINTERS"])
            self.assertIn("REPOSITORY_SEMGREP", environment["DISABLE_LINTERS"])
            self.assertIn("COPYPASTE_JSCPD", environment["DISABLE_LINTERS"])
            self.assertIn("REPOSITORY_GIT_DIFF", environment["DISABLE_LINTERS"])

    def test_baked_flavor_wins_over_runtime_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            baked_flavor = Path(temp) / "quality-gate-flavor"
            baked_flavor.write_text("dotnetweb\n", encoding="utf-8")

            with (
                patch("quality_sidecar.tools.QUALITY_GATE_FLAVOR_FILE", baked_flavor),
                patch.dict(os.environ, {"QUALITY_GATE_FLAVOR": "generic"}),
            ):
                self.assertEqual(_quality_gate_flavor(), "dotnetweb")

    def test_source_checkout_flavor_fallback_rejects_unknown_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            missing_flavor = Path(temp) / "missing-flavor"

            with (
                patch("quality_sidecar.tools.QUALITY_GATE_FLAVOR_FILE", missing_flavor),
                patch.dict(os.environ, {"QUALITY_GATE_FLAVOR": "untrusted"}),
            ):
                with self.assertRaisesRegex(RuntimeError, "Unsupported quality-gate flavor"):
                    _quality_gate_flavor()

    def test_external_tools_do_not_run_project_tests_without_explicit_opt_in(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            reports = target / "reports"

            with (
                patch(
                    "quality_sidecar.tools.run_command",
                    side_effect=lambda name, *_args, **_kwargs: ToolResult(name=name, status="ok", exit_code=0),
                ),
                patch("quality_sidecar.tools._run_project_tests") as project_tests_mock,
            ):
                results, _ = run_external_tools(target, reports, "full")

            project_tests_mock.assert_not_called()
            self.assertNotIn("project-tests", {result.name for result in results})

    def test_external_tools_run_project_tests_after_explicit_opt_in(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            reports = target / "reports"

            with (
                patch(
                    "quality_sidecar.tools.run_command",
                    side_effect=lambda name, *_args, **_kwargs: ToolResult(name=name, status="ok", exit_code=0),
                ),
                patch(
                    "quality_sidecar.tools._run_project_tests",
                    return_value=(ToolResult(name="project-tests", status="ok"), []),
                ) as project_tests_mock,
            ):
                results, _ = run_external_tools(target, reports, "full", run_project_tests=True)

            project_tests_mock.assert_called_once()
            self.assertIn("project-tests", {result.name for result in results})

    def test_megalinter_fatal_analyzer_error_is_operational_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target, raw = self.create_megalinter_error_log(
                temp,
                "Fatal error while calling yamllint: command not found\n",
            )

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(
                    name="megalinter",
                    status="ok",
                    exit_code=1,
                    output_path=str(raw / "megalinter"),
                ),
            ):
                result = _run_megalinter(target, raw)

            self.assertEqual(result.status, "error")
            self.assertIn("YAML_YAMLLINT", result.summary["fatalAnalyzers"])

    def test_megalinter_plugin_initialization_failure_is_operational_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target, raw = self.create_megalinter_error_log(
                temp,
                'Failed to initialize plugins; Plugin "azurerm" not found.\n',
            )

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(
                    name="megalinter",
                    status="ok",
                    exit_code=1,
                    output_path=str(raw / "megalinter"),
                ),
            ):
                result = _run_megalinter(target, raw)

            self.assertEqual(result.status, "error")
            self.assertIn("YAML_YAMLLINT", result.summary["fatalAnalyzers"])

    def test_megalinter_exit_zero_without_execution_evidence_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()
            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(
                    name="megalinter",
                    status="ok",
                    exit_code=0,
                    output_path=str(raw / "megalinter"),
                ),
            ):
                result = _run_megalinter(target, raw)

            self.assertEqual(result.status, "error")
            self.assertFalse(result.summary["evidenceValid"])

    def test_trivy_skips_gate_reports_and_dependency_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / ".quality" / "reports" / "raw"
            raw.mkdir(parents=True)

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(name="trivy", status="ok", exit_code=0),
            ) as run_command_mock:
                result = _run_trivy(target, raw, enable_secrets=True)

            command = run_command_mock.call_args.args[1]
            self.assertIn("vuln,misconfig,secret", command)
            self.assertIn("--config", command)
            self.assertEqual(Path(command[command.index("--config") + 1]).name, "trivy-ci.yaml")
            self.assertEqual(Path(command[command.index("--ignorefile") + 1]).name, "trivyignore-ci")
            self.assertIn("--show-suppressed", command)
            self.assertEqual(run_command_mock.call_args.kwargs["cwd"], MEGALINTER_CONFIG_DIR)
            for directory in (".git", ".quality", "node_modules", "vendor"):
                expected = str(target / directory)
                index = command.index(expected)
                self.assertEqual(command[index - 1], "--skip-dirs")
            self.assertEqual(
                result.summary["analysisInput"]["source"],
                "ghcr.io/aquasecurity/trivy-db",
            )

    def test_gitleaks_redacts_secrets_in_raw_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(name="gitleaks", status="ok", exit_code=0),
            ) as run_command_mock:
                _run_gitleaks(target, raw)

            command = run_command_mock.call_args.args[1]
            self.assertIn("--redact=100", command)
            self.assertIn("dir", command)
            self.assertNotIn("detect", command)
            self.assertEqual(command[-1], str(target))
            self.assertEqual(Path(command[command.index("--config") + 1]).name, "gitleaks-ci.toml")
            self.assertEqual(
                Path(command[command.index("--gitleaks-ignore-path") + 1]).name,
                "gitleaksignore-ci",
            )
            self.assertIn("--ignore-gitleaks-allow", command)
            self.assertEqual(run_command_mock.call_args.kwargs["cwd"], MEGALINTER_CONFIG_DIR)

    def test_semgrep_skips_gate_outputs_and_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(name="semgrep", status="ok", exit_code=0),
            ) as run_command_mock:
                result = _run_semgrep(target, raw)

            command = run_command_mock.call_args.args[1]
            for directory in (".git", ".quality", "node_modules"):
                index = command.index(directory)
                self.assertEqual(command[index - 1], "--exclude")

            self.assertIn("--no-git-ignore", command)
            self.assertIn("--x-ignore-semgrepignore-files", command)
            self.assertIn("--disable-nosem", command)
            self.assertIn("--config=p/default", command)
            self.assertIn("--metrics=off", command)
            self.assertEqual(run_command_mock.call_args.kwargs["cwd"], MEGALINTER_CONFIG_DIR)

            self.assertEqual(result.summary["analysisInput"]["source"], "semgrep-registry:p/default")
            self.assertFalse(result.summary["analysisInput"]["pinned"])
            self.assertTrue(result.summary["analysisInput"]["networkRequired"])

    def test_osv_scanner_uses_the_v2_source_scan_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(name="osv-scanner", status="ok", exit_code=0),
            ) as run_command_mock:
                result = _run_osv_scanner(target, raw)

            command = run_command_mock.call_args.args[1]
            self.assertEqual(command[:3], ["osv-scanner", "scan", "source"])
            self.assertIn("--recursive", command)
            self.assertIn("--no-ignore", command)
            self.assertIn("--allow-no-lockfiles", command)
            self.assertEqual(Path(command[command.index("--config") + 1]).name, "osv-scanner-ci.toml")
            self.assertEqual(run_command_mock.call_args.kwargs["cwd"], MEGALINTER_CONFIG_DIR)
            self.assertEqual(result.summary["analysisInput"]["source"], "osv.dev")

    def test_checkov_uses_trusted_config_and_blocks_inline_suppressions(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()

            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(name="checkov", status="ok", exit_code=0),
            ) as run_command_mock:
                _run_checkov(target, raw, ["main.tf"])

            command = run_command_mock.call_args.args[1]
            self.assertEqual(Path(command[command.index("--config-file") + 1]).name, "checkov-ci.yml")
            self.assertIn(f"--directory={target}", command)
            self.assertIn("--skip-download", command)
            self.assertEqual(run_command_mock.call_args.kwargs["cwd"], MEGALINTER_CONFIG_DIR)

            findings = _parse_checkov(
                {
                    "results": {
                        "skipped_checks": [
                            {
                                "check_id": "CKV_TEST_1",
                                "file_path": "/main.tf",
                                "file_line_range": [4, 4],
                                "suppress_comment": "checkov:skip=CKV_TEST_1",
                            }
                        ]
                    }
                },
                target,
            )
            self.assertEqual(len(findings), 1)
            self.assertEqual(findings[0].category, "policy-suppression")
            self.assertEqual(findings[0].severity, "high")

    def test_terraform_fixture_yields_a_finding_from_checkov_and_from_trivy(self) -> None:
        target = Path("/workspace")
        checkov = _parse_checkov(
            {
                "results": {
                    "failed_checks": [
                        {
                            "check_id": "CKV_AWS_18",
                            "severity": "HIGH",
                            "file_path": "/infra/terraform/main.tf",
                            "file_line_range": [1, 3],
                            "check_name": "Ensure the S3 bucket has access logging enabled",
                        }
                    ]
                }
            },
            target,
        )
        self.assertEqual([(f.tool, f.rule) for f in checkov], [("checkov", "CKV_AWS_18")])
        trivy = _parse_trivy(
            {
                "Results": [
                    {
                        "Target": "infra/terraform/main.tf",
                        "Misconfigurations": [
                            {"ID": "AVD-AWS-0088", "Severity": "HIGH", "Status": "FAIL", "Title": "Unencrypted bucket"}
                        ],
                    }
                ]
            },
            target,
        )
        self.assertEqual([(f.tool, f.rule) for f in trivy], [("trivy", "AVD-AWS-0088")])

    def test_trivy_suppressed_misconfiguration_remains_blocking(self) -> None:
        findings = _parse_trivy(
            {
                "Results": [
                    {
                        "Target": "main.tf",
                        "Misconfigurations": [
                            {"ID": "AVD-TEST-1", "Severity": "LOW", "Status": "EXCEPTION"}
                        ],
                    }
                ]
            },
            Path("/workspace"),
        )
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].category, "policy-suppression")
        self.assertEqual(findings[0].severity, "high")

    def test_jscpd_uses_trusted_config_outside_the_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()
            with patch(
                "quality_sidecar.tools.run_command",
                return_value=ToolResult(name="jscpd", status="ok", exit_code=0),
            ) as run_command_mock:
                _run_jscpd(target, raw)

            command = run_command_mock.call_args.args[1]
            self.assertEqual(Path(command[command.index("--config") + 1]).name, "jscpd-ci.json")
            self.assertIn("--no-gitignore", command)
            ignore_value = command[command.index("--ignore") + 1]
            self.assertIn("**/obj/**", ignore_value)
            self.assertIn("**/bin/**", ignore_value)
            self.assertEqual(command[-1], str(target))
            self.assertEqual(run_command_mock.call_args.kwargs["cwd"], MEGALINTER_CONFIG_DIR)

    def test_analyzer_subprocess_environment_drops_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temp, patch.dict(
            os.environ,
            {
                "CI_JOB_TOKEN": "synthetic-job-token",
                "AWS_SECRET_ACCESS_KEY": "synthetic-secret",
                "SONAR_TOKEN": "synthetic-sonar-token",
            },
            clear=False,
        ), patch("quality_sidecar.tools._resolve_command", return_value=sys.executable), patch(
            "quality_sidecar.tools.subprocess.run",
            return_value=SimpleNamespace(returncode=0, stdout="", stderr=""),
        ) as subprocess_mock:
            output = Path(temp)
            run_command("fixture", ["python", "--version"], output, cwd=output)

        environment = subprocess_mock.call_args.kwargs["env"]
        self.assertNotIn("CI_JOB_TOKEN", environment)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", environment)
        self.assertNotIn("SONAR_TOKEN", environment)
        self.assertIn("PATH", {name.upper() for name in environment})

    def test_missing_malformed_or_wrong_shape_analyzer_evidence_fails_closed(self) -> None:
        cases = (
            ("semgrep", None, None),
            ("gitleaks", "not-json", None),
            ("trivy", "{}", None),
            ("checkov", "[]", None),
            (
                "checkov",
                '{"passed":0,"failed":1,"skipped":0,"parsing_errors":0,"resource_count":1,"checkov_version":"3.3.8"}',
                None,
            ),
            (
                "checkov",
                '{"passed":0,"failed":0,"skipped":0,"parsing_errors":0,"resource_count":0,"checkov_version":"3.3.8","unexpected":true}',
                None,
            ),
            ("osv-scanner", '{"results":{}}', None),
            ("jscpd", '{"statistics":{}}', None),
        )
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for index, (name, content, _unused) in enumerate(cases):
                with self.subTest(tool=name):
                    output = root / f"evidence-{index}.json"
                    if content is not None:
                        output.write_text(content, encoding="utf-8")
                    result = ToolResult(name=name, status="ok", exit_code=0, output_path=str(output))

                    findings = parse_tool_findings(name, result, root)

                    self.assertEqual(findings, [])
                    self.assertEqual(result.status, "error")
                    self.assertFalse(result.summary["evidenceValid"])

    def test_valid_empty_analyzer_reports_are_accepted(self) -> None:
        reports = {
            "semgrep": {"results": []},
            "gitleaks": [],
            "trivy": {"Results": []},
            "checkov": {"results": {"failed_checks": [], "skipped_checks": []}},
            "checkov-official-empty": {
                "passed": 0,
                "failed": 0,
                "skipped": 0,
                "parsing_errors": 0,
                "resource_count": 0,
                "checkov_version": "3.3.8",
            },
            "osv-scanner": {"results": []},
            "jscpd": {"duplicates": []},
        }
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for index, (name, payload) in enumerate(reports.items()):
                with self.subTest(tool=name):
                    output = root / f"valid-{index}.json"
                    output.write_text(json.dumps(payload), encoding="utf-8")
                    tool_name = "checkov" if name == "checkov-official-empty" else name
                    result = ToolResult(name=tool_name, status="ok", exit_code=0, output_path=str(output))

                    findings = parse_tool_findings(tool_name, result, root)

                    self.assertEqual(findings, [])
                    self.assertEqual(result.status, "ok")
                    self.assertTrue(result.summary["evidenceValid"])

    def test_normalized_reports_hide_runner_paths_and_escape_markdown_cells(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "projection" / "workspace"
            target.mkdir(parents=True)
            outside = Path(temp) / "original-checkout" / ".quality" / "raw" / "semgrep.json"
            tool = ToolResult(
                name="semgrep",
                status="error",
                command=["/opt/venvs/semgrep/bin/semgrep", "scan", str(target)],
                output_path=str(outside),
                stdout_path=str(outside.with_suffix(".stdout.log")),
                stderr_path=str(outside.with_suffix(".stderr.log")),
                error=f"unable to read {outside}",
            )
            finding = Finding(
                tool="fixture",
                rule="unsafe|rule",
                severity="high",
                category="test",
                path="src/file.py\n| forged | row |",
                message="line one\n| forged | table | row |",
            )
            policy = SimpleNamespace(
                status="NEEDS_CHANGES",
                exit_code=2,
                score=0,
                threshold=90,
                counts={},
                reasons=[],
                tool_errors=["semgrep"],
            )

            report = build_report(
                target=target,
                profile="standard",
                mode="full",
                policy=policy,
                stack={},
                findings=[finding],
                tool_results=[tool],
                metrics={},
            )
            markdown = write_markdown_report(report, Path(temp) / "report").read_text(encoding="utf-8")

            serialized = json.dumps(report)
            self.assertEqual(report["target"], ".")
            self.assertNotIn(str(Path(temp)), serialized)
            self.assertEqual(report["tools"][0]["output_path"], "semgrep.json")
            self.assertNotIn("\n| forged |", markdown)
            self.assertIn("\\| forged \\|", markdown)

    def test_project_tests_skip_when_scoped_checkout_omits_npm_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target, raw = self.create_incomplete_npm_workspace(temp)

            with (
                patch.dict(os.environ, {"QUALITY_GATE_SCOPE": "changed"}),
                patch("quality_sidecar.tools.shutil.which", return_value="npm"),
                patch("quality_sidecar.tools.run_command") as run_command_mock,
            ):
                result, findings = run_project_tests(target, raw)

            self.assertIsNotNone(result)
            self.assertEqual(result.status, "skipped")
            self.assertEqual(result.summary["missingWorkspaces"], ["semantic-gate"])
            self.assertEqual(findings, [])
            run_command_mock.assert_not_called()

    def test_project_tests_error_when_full_checkout_omits_npm_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target, raw = self.create_incomplete_npm_workspace(temp)

            with (
                patch.dict(os.environ, {"QUALITY_GATE_SCOPE": "full"}),
                patch("quality_sidecar.tools.shutil.which", return_value="npm"),
                patch("quality_sidecar.tools.run_command") as run_command_mock,
            ):
                result, findings = run_project_tests(target, raw)

            self.assertIsNotNone(result)
            self.assertEqual(result.status, "error")
            self.assertEqual(result.summary["missingWorkspaces"], ["semantic-gate"])
            self.assertEqual(findings, [])
            run_command_mock.assert_not_called()

    def test_full_mode_tool_error_uses_needs_changes_status(self) -> None:
        result = evaluate_policy(
            [],
            [SimpleNamespace(name="semgrep", status="missing")],
            profile="standard",
            threshold=None,
            mode="full",
            fail_on_tool_error=False,
        )

        self.assertEqual(result.status, "NEEDS_CHANGES")
        self.assertEqual(result.exit_code, 2)

    def test_project_test_failure_is_a_finding_not_tool_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            raw = target / "raw"
            raw.mkdir()
            (target / "package.json").write_text(
                json.dumps({"scripts": {"test": "node -e \"process.exit(1)\""}}),
                encoding="utf-8",
            )

            result, findings = run_project_tests(target, raw)

            self.assertIsNotNone(result)
            assert result is not None
            self.assertEqual(result.status, "findings")
            self.assertEqual(len(findings), 1)
            self.assertEqual(findings[0].category, "tests")

    def test_coverage_tool_error_always_needs_changes(self) -> None:
        result = evaluate_policy(
            [],
            [SimpleNamespace(name="coverage", status="missing")],
            profile="standard",
            threshold=None,
            mode="quick",
            fail_on_tool_error=False,
        )

        self.assertEqual(result.status, "NEEDS_CHANGES")
        self.assertEqual(result.exit_code, 2)


if __name__ == "__main__":
    unittest.main()
