"""The configuration file chosen in JGates reaches the scanner, only through the bridge request (without one, the trusted package configuration is used).

Fake executables stand in for the scanners: they record the argv they receive and write an empty report, so the
tests see exactly the flags the sidecar used without installing anything.
"""
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

from quality_sidecar import tools  # noqa: E402

SCHEMAS = ROOT / "schemas"

try:
    import jsonschema
except ImportError:  # the bridge itself needs no third-party package
    jsonschema = None

FAKE_SCANNER = """#!{python}
import json, sys
from pathlib import Path
here = Path(__file__).resolve().parent
with open(here / "calls.jsonl", "a", encoding="utf-8") as log:
    log.write(json.dumps({{"tool": Path(sys.argv[0]).name, "argv": sys.argv[1:]}}) + "\\n")
args = sys.argv[1:]
if "--report-path" in args:
    Path(args[args.index("--report-path") + 1]).write_text("[]\\n", encoding="utf-8")
if "--output" in args and Path(sys.argv[0]).name == "trivy":
    Path(args[args.index("--output") + 1]).write_text('{{"Results": []}}\\n', encoding="utf-8")
if Path(sys.argv[0]).name == "osv-scanner":
    print('{{"results": []}}')
sys.exit(0)
"""


def make_fake_bin(directory: Path, names: tuple[str, ...]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name in names:
        script = directory / name
        script.write_text(FAKE_SCANNER.format(python=sys.executable), encoding="utf-8")
        script.chmod(0o755)
    return directory


def read_calls(directory: Path) -> list[dict]:
    log = directory / "calls.jsonl"
    if not log.is_file():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]


def flag_value(argv: list[str], flag: str) -> str:
    return argv[argv.index(flag) + 1]


def validate(name: str, document: dict) -> None:
    schema = json.loads((SCHEMAS / name).read_text(encoding="utf-8"))
    if jsonschema is not None:
        jsonschema.Draft202012Validator(schema).validate(document)
    else:
        missing = [key for key in schema["required"] if key not in document]
        assert not missing, f"missing {missing}"
        unknown = set(document) - set(schema["properties"])
        assert not unknown, f"unknown {unknown}"


class LocalBridgeToolConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.target = base / "target"
        self.target.mkdir()
        (self.target / "app.py").write_text("print('hello')\n", encoding="utf-8")
        (self.target / ".gitleaks.toml").write_text('title = "project rules"\n', encoding="utf-8")
        (self.target / "trivy.yaml").write_text("severity: [HIGH]\n", encoding="utf-8")
        (self.target / "osv-scanner.toml").write_text("[[IgnoredVulns]]\nid = \"GHSA-x\"\n", encoding="utf-8")
        self.outside = base / "outside.toml"
        self.outside.write_text('title = "outside"\n', encoding="utf-8")
        self.fake_bin = make_fake_bin(base / "bin", ("gitleaks", "trivy", "osv-scanner", "semgrep", "jscpd"))
        self.out = base / "out"

    def call(self, request: dict) -> tuple[subprocess.CompletedProcess, dict]:
        env = {
            **os.environ,
            "PYTHONPATH": str(ROOT / "sidecar"),
            "PATH": os.pathsep.join([str(self.fake_bin), os.path.dirname(sys.executable), "/usr/bin", "/bin"]),
        }
        result = subprocess.run(
            [sys.executable, "-m", "quality_sidecar", "bridge"],
            input=json.dumps(request), capture_output=True, text=True, env=env, cwd=str(self.target.parent), timeout=120,
        )
        return result, json.loads(result.stdout)

    def request(self, **overrides) -> dict:
        return {
            "schemaVersion": 1,
            "target": str(self.target),
            "outputDir": str(self.out),
            "mode": "full",
            "secrets": True,
            "subchecks": ["file-size", "gitleaks"],
            **overrides,
        }

    def gitleaks_argv(self) -> list[str]:
        calls = [call for call in read_calls(self.fake_bin) if call["tool"] == "gitleaks"]
        self.assertEqual(len(calls), 1, calls)
        return calls[0]["argv"]

    def subcheck(self, response: dict, sub_id: str) -> dict:
        return next(item for item in response["subchecks"] if item["id"] == sub_id)

    def test_chosen_gitleaks_config_reaches_the_argv(self) -> None:
        request = self.request(toolConfigs={"gitleaks": ".gitleaks.toml"})
        validate("bridge-request.schema.json", request)
        result, response = self.call(request)
        self.assertTrue(response["ok"], result.stderr)
        validate("bridge-response.schema.json", response)
        argv = self.gitleaks_argv()
        chosen = str((self.target / ".gitleaks.toml").resolve())
        self.assertEqual(flag_value(argv, "--config"), chosen)
        # Only the rules file changes: redaction, the trusted ignore file and the inline-allow refusal stay.
        self.assertIn("--redact=100", argv)
        self.assertIn("--ignore-gitleaks-allow", argv)
        self.assertEqual(Path(flag_value(argv, "--gitleaks-ignore-path")).name, "gitleaksignore-ci")
        # The response carries the effective command in the public form of the report: workspace files relative to
        # the target, files outside it by name only (no runner path leaks).
        entry = self.subcheck(response, "gitleaks")
        self.assertEqual(entry["config"], {"source": "project", "path": ".gitleaks.toml"})
        self.assertEqual(entry["command"][0], "gitleaks")
        self.assertEqual(flag_value(entry["command"], "--config"), ".gitleaks.toml")
        self.assertEqual(len(entry["command"]), len(argv) + 1)
        self.assertEqual(entry["command"][-1], ".")

    def test_without_a_chosen_config_the_package_file_is_used(self) -> None:
        result, response = self.call(self.request())
        self.assertTrue(response["ok"], result.stderr)
        argv = self.gitleaks_argv()
        self.assertEqual(flag_value(argv, "--config"), tools.GITLEAKS_TRUSTED_CONFIG)
        self.assertEqual(Path(flag_value(argv, "--config")).name, "gitleaks-ci.toml")
        self.assertNotIn(str(self.target / ".gitleaks.toml"), argv)
        self.assertEqual(self.subcheck(response, "gitleaks")["config"], {"source": "package", "path": "gitleaks-ci.toml"})

    def test_trivy_and_osv_configs_reach_their_argv(self) -> None:
        request = self.request(
            subchecks=["trivy", "osv-scanner"],
            toolConfigs={"trivy": "trivy.yaml", "osv-scanner": str(self.target / "osv-scanner.toml")},
        )
        result, response = self.call(request)
        self.assertTrue(response["ok"], result.stderr)
        calls = {call["tool"]: call["argv"] for call in read_calls(self.fake_bin)}
        self.assertEqual(flag_value(calls["trivy"], "--config"), str((self.target / "trivy.yaml").resolve()))
        self.assertEqual(flag_value(calls["osv-scanner"], "--config"), str((self.target / "osv-scanner.toml").resolve()))
        self.assertEqual(Path(flag_value(calls["trivy"], "--ignorefile")).name, "trivyignore-ci")

    def test_config_outside_the_workspace_is_refused_with_a_structured_error(self) -> None:
        link = self.target / "linked.toml"
        link.symlink_to(self.outside)
        for value in ("../outside.toml", str(self.outside), "linked.toml"):
            with self.subTest(path=value):
                result, response = self.call(self.request(toolConfigs={"gitleaks": value}))
                self.assertEqual(result.returncode, 3, result.stderr)
                validate("bridge-response.schema.json", response)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "config-outside-target")
                self.assertEqual(response["error"]["tool"], "gitleaks")
                self.assertEqual(response["error"]["path"], value)
                self.assertEqual(read_calls(self.fake_bin), [], "nothing runs after a refusal")

    def test_missing_or_unsupported_configs_are_refused(self) -> None:
        result, response = self.call(self.request(toolConfigs={"gitleaks": "missing.toml"}))
        self.assertEqual(result.returncode, 3)
        self.assertEqual(response["error"]["code"], "config-missing")
        result, response = self.call(self.request(toolConfigs={"semgrep": ".gitleaks.toml"}))
        self.assertEqual(result.returncode, 3)
        self.assertEqual(response["error"]["code"], "invalid-request")
        self.assertEqual(response["error"]["tool"], "semgrep")
        result, response = self.call(self.request(subchecks=["gitleaks", "nope"]))
        self.assertEqual(response["error"]["code"], "invalid-request")

    def test_a_subcheck_left_out_of_the_request_does_not_run(self) -> None:
        result, response = self.call(self.request(subchecks=["gitleaks"]))
        self.assertTrue(response["ok"], result.stderr)
        ran = sorted({call["tool"] for call in read_calls(self.fake_bin)})
        self.assertEqual(ran, ["gitleaks"], "semgrep, trivy, osv-scanner and jscpd are on PATH but were not requested")
        for sub_id in ("semgrep", "trivy", "osv-scanner", "jscpd", "megalinter", "file-size"):
            entry = self.subcheck(response, sub_id)
            self.assertEqual(entry["status"], "skipped", entry)
            self.assertEqual(entry["reason"], "not requested by the plan")
        self.assertEqual(self.subcheck(response, "gitleaks")["status"], "ok")

    def test_the_package_check_flags_cannot_choose_a_config(self) -> None:
        # quality-gate has no flag for project scanner configs: the namespace attribute exists only via the bridge.
        from quality_sidecar import cli

        args = cli.build_parser().parse_args(["check", str(self.target)])
        self.assertFalse(hasattr(args, "local_tools"))
        self.assertFalse(any("config" in name and name != "policy_file" for name in vars(args)), vars(args))


if __name__ == "__main__":
    unittest.main()
