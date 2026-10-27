from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))

from quality_sidecar.cli import entrypoint as sidecar_main  # noqa: E402


class ExternalPolicySidecarTests(unittest.TestCase):
    """B1 regression: a policy outside the target must be digested from its real path."""

    def test_policy_outside_target_is_accepted_and_digested(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            project = work / "p"
            project.mkdir()
            (project / "a.js").write_text("export const a = 1;\n", encoding="utf-8")
            policy = work / "pol" / "min.json"
            policy.parent.mkdir()
            policy.write_text('{"schemaVersion":1,"budgets":{}}\n', encoding="utf-8")
            digest = hashlib.sha256(policy.read_bytes()).hexdigest()
            code = sidecar_main([
                "check", str(project), "--mode", "quick", "--policy-file", str(policy),
                "--policy-sha256", digest,
            ])
            self.assertEqual(code, 0)
            reports = list(project.rglob("quality-report.json"))
            self.assertTrue(reports)
            policy_metrics = json.loads(reports[0].read_text(encoding="utf-8"))["metrics"]["policy"]
            self.assertEqual(policy_metrics["sha256"], digest)
            self.assertTrue(policy_metrics["digestVerified"])


if __name__ == "__main__":
    unittest.main()
