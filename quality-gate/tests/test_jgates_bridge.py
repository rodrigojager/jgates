from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "schemas"
SUBCHECKS = [
    "file-size", "megalinter", "semgrep", "gitleaks", "trivy", "checkov",
    "osv-scanner", "jscpd", "project-tests", "coverage",
]

try:
    import jsonschema
except ImportError:  # the bridge itself needs no third-party package
    jsonschema = None


def load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / name).read_text(encoding="utf-8"))


def snapshot(root: Path) -> list[str]:
    return sorted(str(path.relative_to(root)) for path in root.rglob("*"))


class BridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.target = base / "target"
        self.target.mkdir()
        (self.target / "app.py").write_text("print('hello')\n", encoding="utf-8")
        self.out = base / "out"

    def call(self, request: dict | str, extra_env: dict | None = None) -> tuple[subprocess.CompletedProcess, dict]:
        env = {**os.environ, "PYTHONPATH": str(ROOT / "sidecar")}
        env.update(extra_env or {})
        payload = request if isinstance(request, str) else json.dumps(request)
        result = subprocess.run(
            [sys.executable, "-m", "quality_sidecar", "bridge"],
            input=payload, capture_output=True, text=True, env=env, cwd=str(self.target.parent), timeout=120,
        )
        return result, json.loads(result.stdout)

    def validate(self, name: str, document: dict) -> None:
        schema = load_schema(name)
        self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        if jsonschema is not None:
            jsonschema.Draft202012Validator(schema).validate(document)
        else:
            for key in schema["required"]:
                self.assertIn(key, document)
            self.assertLessEqual(set(document), set(schema["properties"]))

    def request(self, **overrides) -> dict:
        return {"schemaVersion": 1, "target": str(self.target), "mode": "quick", "outputDir": str(self.out), **overrides}

    def test_quick_request_returns_single_json_with_subchecks(self) -> None:
        request = self.request()
        self.validate("bridge-request.schema.json", request)
        result, response = self.call(request)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().count("\n"), 0, "stdout must be one JSON line")
        self.validate("bridge-response.schema.json", response)
        self.assertEqual(response["schemaVersion"], 1)
        self.assertTrue(response["ok"])
        self.assertEqual(response["status"], "APPROVED")
        self.assertEqual([item["id"] for item in response["subchecks"]], SUBCHECKS)
        states = {item["id"]: item["status"] for item in response["subchecks"]}
        self.assertEqual(states["file-size"], "ok")
        self.assertEqual(states["semgrep"], "skipped")
        self.assertIn("APPROVED", result.stderr, "human summary goes to stderr")
        self.assertTrue((self.out / "quality-report.json").is_file())
        self.assertEqual(response["report"]["schemaVersion"], "1.0.0")

    def test_output_outside_target_leaves_target_untouched(self) -> None:
        before = snapshot(self.target)
        _, response = self.call(self.request(mode="offline"))
        self.assertTrue(response["ok"])
        self.assertEqual(snapshot(self.target), before)
        self.assertFalse((self.target / ".quality").exists())
        self.assertTrue((self.out / "quality-report.md").is_file())

    def test_file_size_subcheck_reports_findings(self) -> None:
        (self.target / "big.py").write_text("x = 1\n" * 50, encoding="utf-8")
        _, response = self.call(self.request(maxFileLines=10))
        states = {item["id"]: item for item in response["subchecks"]}
        self.assertEqual(states["file-size"]["status"], "findings")
        self.assertGreaterEqual(states["file-size"]["findings"], 1)

    def test_governed_mode_is_refused_with_structured_error(self) -> None:
        for override in ({"mode": "governed"}, {"governed": True}, {"mode": "ci"}):
            request = self.request(**override)
            result, response = self.call(request)
            self.assertEqual(result.returncode, 3)
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], "governed-mode-refused")
            self.validate("bridge-response.schema.json", response)
        self.assertFalse(self.out.exists(), "a refused request writes nothing")

    def test_invalid_requests_return_structured_errors(self) -> None:
        cases = [
            ("not json", "invalid-request"),
            (self.request(schemaVersion=2), "unsupported-version"),
            (self.request(outputDir="relative/out"), "invalid-request"),
            (self.request(mode="turbo"), "invalid-request"),
            (self.request(bogus=1), "invalid-request"),
            (self.request(target=str(self.target / "missing")), "target-missing"),
        ]
        for request, code in cases:
            result, response = self.call(request)
            self.assertEqual(result.returncode, 3, request)
            self.assertEqual(response["error"]["code"], code, request)
            self.validate("bridge-response.schema.json", response)

    def test_external_policy_digest_is_taken_from_loaded_path(self) -> None:
        policy = Path(self.temp.name) / "policy.json"
        policy.write_text(json.dumps({"schemaVersion": 1}), encoding="utf-8")
        _, response = self.call(self.request(policyFile=str(policy)))
        self.assertTrue(response["ok"], response)
        digest = response["report"]["metrics"]["policy"]["sha256"]
        self.assertEqual(len(digest), 64)

    def test_subcheck_ids_match_the_core_manifest(self) -> None:
        manifest = (ROOT.parent / "jgates" / "src" / "adapters" / "quality-bridge" / "manifest.ts").read_text(encoding="utf-8")
        for sub_id in SUBCHECKS:
            self.assertIn(f'id: "{sub_id}"', manifest)


class PiiBridgeTests(unittest.TestCase):
    """PII-only request of the bridge (operation "pii"); the composite contract is covered above."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / "target"
        (self.target / "data").mkdir(parents=True)
        # Assembled at run time so the repository gates do not flag this source.
        self.cpf = "123." + "456." + "789-" + "09"
        self.card = "4111 " + "1111 " + "1111 " + "1111"
        (self.target / "data" / "people.txt").write_text(f"name\ncpf {self.cpf}\ncard {self.card}\n", encoding="utf-8")
        (self.target / "app.py").write_text("print('hello')\n", encoding="utf-8")

    def call(self, request: dict) -> tuple[subprocess.CompletedProcess, dict]:
        env = {**os.environ, "PYTHONPATH": str(ROOT / "sidecar")}
        result = subprocess.run(
            [sys.executable, "-m", "quality_sidecar", "bridge"],
            input=json.dumps(request), capture_output=True, text=True, env=env, cwd=self.temp.name, timeout=120,
        )
        return result, json.loads(result.stdout)

    def request(self, **overrides) -> dict:
        return {"schemaVersion": 1, "operation": "pii", "target": str(self.target), **overrides}

    def test_pii_request_returns_findings_without_the_matched_value(self) -> None:
        before = snapshot(self.target)
        result, response = self.call(self.request())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().count("\n"), 0, "stdout must be one JSON line")
        self.assertTrue(response["ok"])
        self.assertEqual(response["operation"], "pii")
        self.assertEqual(response["status"], "FINDINGS")
        rules = {(item["rule"], item["path"], item["line"]) for item in response["findings"]}
        self.assertIn(("pii.cpf", "data/people.txt", 2), rules)
        self.assertIn(("pii.credit-card", "data/people.txt", 3), rules)
        severities = {item["entity"]: item["severity"] for item in response["findings"]}
        self.assertEqual(severities["cpf"], "medium")
        self.assertEqual(severities["credit-card"], "high")
        for text in (result.stdout, result.stderr):
            self.assertNotIn(self.cpf, text)
            self.assertNotIn(self.card, text)
            self.assertNotIn("4111", text)
        self.assertEqual(snapshot(self.target), before, "the request writes nothing in the target")

    def test_entities_and_severity_narrow_and_override(self) -> None:
        _, response = self.call(self.request(entities=["cpf"], severity="low"))
        self.assertEqual({item["entity"] for item in response["findings"]}, {"cpf"})
        self.assertEqual({item["severity"] for item in response["findings"]}, {"low"})
        _, clean = self.call(self.request(entities=["cnpj"]))
        self.assertEqual(clean["status"], "OK")
        self.assertEqual(clean["findings"], [])

    def test_config_turns_entities_on_and_off_one_by_one(self) -> None:
        (self.target / "data" / "phones.txt").write_text("tel (11) " + "91234" + "-" + "5678\n", encoding="utf-8")
        _, default = self.call(self.request(config={"schemaVersion": 1}))
        self.assertEqual({i["entity"] for i in default["findings"]}, {"cpf", "credit-card"})
        _, no_cpf = self.call(self.request(config={"entities": {"cpf": {"enabled": False}}}))
        self.assertEqual({i["entity"] for i in no_cpf["findings"]}, {"credit-card"})
        _, phone = self.call(self.request(config={"entities": {"phone": {"enabled": True, "severity": "low"}}}))
        self.assertEqual({i["entity"] for i in phone["findings"]}, {"cpf", "credit-card", "phone"})
        self.assertEqual([i["severity"] for i in phone["findings"] if i["entity"] == "phone"], ["low"])
        status = {row["entity"]: row["status"] for row in phone["coverage"]}
        self.assertEqual(status["phone"], "run")
        self.assertEqual({row["status"] for row in default["coverage"] if row["entity"] == "phone"}, {"disabled"})
        self.assertNotIn("91234", json.dumps(phone))

    def test_invalid_pii_requests_return_structured_errors(self) -> None:
        cases = [
            (self.request(schemaVersion=2), "unsupported-version"),
            (self.request(bogus=1), "invalid-request"),
            (self.request(entities=["passport"]), "invalid-request"),
            (self.request(config={"entities": {"cpf": {"enabled": "yes"}}}), "invalid-config"),
            (self.request(config={"detection": {"locale": "en-US"}}), "unsupported-option"),
            (self.request(config={"remediation": {"mode": "apply"}}), "unsupported-option"),
            (self.request(config={}, severity="low"), "invalid-request"),
            (self.request(severity="loud"), "invalid-request"),
            (self.request(target=str(self.target / "missing")), "target-missing"),
        ]
        for request, code in cases:
            result, response = self.call(request)
            self.assertEqual(result.returncode, 3, request)
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], code, request)

    def test_composite_requests_still_reject_the_operation_field(self) -> None:
        env = {**os.environ, "PYTHONPATH": str(ROOT / "sidecar")}
        request = {"schemaVersion": 1, "target": str(self.target), "outputDir": str(Path(self.temp.name) / "out"), "operation": "other"}
        result = subprocess.run([sys.executable, "-m", "quality_sidecar", "bridge"], input=json.dumps(request), capture_output=True, text=True, env=env, timeout=120)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "invalid-request")


class ArchitectureBridgeTests(unittest.TestCase):
    """The normalized-graph evaluation of the bridge (operation "architecture")."""

    CONTRACT = {
        "file": ".jgates/architecture.yml",
        "layers": [
            {"id": "domain", "paths": ["api/src/domain/**"]},
            {"id": "infrastructure", "paths": ["api/src/infrastructure/**"]},
        ],
        "rules": [
            {"id": "domain-independent", "kind": "forbidden-dependency", "from": "domain", "to": ["infrastructure"], "severity": "high", "blocking": True},
            {"id": "no-cycles", "kind": "no-cycles"},
        ],
    }

    def graph(self, **extra) -> dict:
        base = {
            "nodes": [
                {"id": "shop.domain.order", "kind": "module", "language": "python", "component": "api", "path": "api/src/domain/order.py"},
                {"id": "shop.infrastructure.db", "kind": "module", "language": "python", "component": "api", "path": "api/src/infrastructure/db.py"},
            ],
            "edges": [{"from": "shop.domain.order", "to": "shop.infrastructure.db", "origin": "api/src/domain/order.py:3"}],
            "unresolved": [],
            "coverage": {"extractor": "test"},
        }
        base.update(extra)
        return base

    def call(self, graph: dict, contract: dict | None = None, **extra) -> tuple[int, dict]:
        from quality_sidecar.bridge import evaluate_architecture

        request = {"schemaVersion": 1, "operation": "architecture", "graph": graph, "architecture": contract or self.CONTRACT, **extra}
        response, code = evaluate_architecture(request)
        return code, response

    def test_domain_to_infrastructure_edge_references_the_declared_rule(self) -> None:
        code, response = self.call(self.graph())
        self.assertEqual(code, 0)
        self.assertEqual(response["status"], "FINDINGS")
        self.assertEqual(len(response["findings"]), 1)
        finding = response["findings"][0]
        self.assertEqual(finding["ruleId"], "domain-independent")
        self.assertEqual(finding["file"], ".jgates/architecture.yml")
        self.assertEqual(finding["path"], "api/src/domain/order.py")
        self.assertTrue(finding["blocking"])
        self.assertTrue(response["verified"])
        self.assertEqual(response["coverage"]["status"], "complete")

    def test_clean_complete_graph_is_verified(self) -> None:
        graph = self.graph(edges=[{"from": "shop.infrastructure.db", "to": "shop.domain.order"}])
        _, response = self.call(graph)
        self.assertEqual(response["findings"], [])
        self.assertTrue(response["verified"])

    def test_unresolved_dependencies_are_a_coverage_gap_not_silence(self) -> None:
        graph = self.graph(edges=[], unresolved=[{"from": "shop.domain.order", "specifier": "requests", "reason": "not-found"}])
        _, response = self.call(graph)
        self.assertEqual(response["findings"], [])
        self.assertFalse(response["verified"])
        self.assertEqual(response["coverage"]["status"], "partial")
        self.assertEqual(response["coverage"]["unresolved"], 1)
        self.assertIn("unresolved-dependencies", [r["code"] for r in response["coverage"]["reasons"]])

    def test_edge_to_unknown_node_is_unresolved(self) -> None:
        _, response = self.call(self.graph(edges=[{"from": "shop.domain.order", "to": "shop.ghost"}]))
        self.assertEqual(response["coverage"]["unresolved"], 1)
        self.assertEqual(response["coverage"]["status"], "partial")

    def test_empty_graph_is_never_verified(self) -> None:
        _, response = self.call({"nodes": [], "edges": [], "unresolved": [], "coverage": {}})
        self.assertEqual(response["coverage"]["status"], "empty")
        self.assertFalse(response["verified"])

    def test_incomplete_extractor_makes_the_graph_partial(self) -> None:
        _, response = self.call(self.graph(edges=[], coverage={"extractor": "test", "complete": False, "reason": "parsed 3 of 9 files"}))
        self.assertEqual(response["coverage"]["status"], "partial")
        self.assertFalse(response["verified"])

    def test_layer_without_nodes_is_a_gap(self) -> None:
        contract = {**self.CONTRACT, "layers": [*self.CONTRACT["layers"], {"id": "presentation", "paths": ["web/**"]}], "rules": [{"id": "ui", "kind": "forbidden-dependency", "from": "presentation", "to": ["domain"]}]}
        _, response = self.call(self.graph(edges=[]), contract)
        self.assertFalse(response["verified"])
        self.assertIn("layer-empty", [r["code"] for r in response["coverage"]["reasons"]])

    def test_cycles_fan_limit_and_component_boundary(self) -> None:
        graph = {
            "nodes": [
                {"id": "a", "kind": "module", "component": "api", "path": "api/a.py"},
                {"id": "b", "kind": "module", "component": "api", "path": "api/b.py"},
                {"id": "c", "kind": "module", "component": "web", "path": "web/c.ts"},
            ],
            "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}, {"from": "a", "to": "c"}, {"from": "b", "to": "c"}],
            "unresolved": [],
            "coverage": {},
        }
        contract = {
            "file": ".jgates/architecture.yml",
            "rules": [
                {"id": "cycles", "kind": "no-cycles", "severity": "medium"},
                {"id": "fan", "kind": "fan-limit", "maxFanIn": 1, "blocking": False},
                {"id": "api-boundary", "kind": "component-boundary", "component": "api", "allowedDependencies": []},
                {"id": "off", "kind": "no-cycles", "enabled": False},
            ],
        }
        _, response = self.call(graph, contract)
        by_rule = {}
        for finding in response["findings"]:
            by_rule.setdefault(finding["ruleId"], []).append(finding)
        self.assertEqual(len(by_rule["cycles"]), 1)
        self.assertEqual(len(by_rule["api-boundary"]), 2)
        self.assertEqual(by_rule["fan"][0]["path"], "web/c.ts")
        self.assertFalse(by_rule["fan"][0]["blocking"])
        self.assertNotIn("off", by_rule)
        self.assertFalse(next(r for r in response["rules"] if r["id"] == "off")["evaluated"])

    def test_through_the_bridge_command_and_bad_requests(self) -> None:
        env = {**os.environ, "PYTHONPATH": str(ROOT / "sidecar")}
        request = {"schemaVersion": 1, "operation": "architecture", "graph": self.graph(), "architecture": self.CONTRACT}
        result = subprocess.run([sys.executable, "-m", "quality_sidecar", "bridge"], input=json.dumps(request), capture_output=True, text=True, env=env, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["findings"][0]["ruleId"], "domain-independent")
        for bad, code in [
            ({"schemaVersion": 2}, "unsupported-version"),
            ({"bogus": 1}, "invalid-request"),
            ({"graph": {"nodes": [{"kind": "module"}]}}, "invalid-request"),
            ({"architecture": {"rules": [{"id": "x", "kind": "nope"}]}}, "invalid-request"),
        ]:
            response, status = __import__("quality_sidecar.bridge", fromlist=["x"]).evaluate_architecture({**request, **bad})
            self.assertEqual(status, 3, bad)
            self.assertEqual(response["error"]["code"], code, bad)


if __name__ == "__main__":
    unittest.main()
