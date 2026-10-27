"""Per-entity PII detector.

Preservation first: a frozen copy of the detector as it was before the per-entity contract is the oracle, and the
default configuration must reproduce it finding for finding. Then the granular contract: each entity on and off by
itself, the phone entity (off by default), optional check-digit and Luhn validation, masking that holds in every
mode, and no run that changes a file.

Every PII-shaped literal here is assembled from parts at run time, so the repository gates do not flag this source.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from functools import partial
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT / "sidecar"))

from quality_sidecar import cli, pii  # noqa: E402
from quality_sidecar.detectors import detect_builtin_findings, iter_source_files, relative_path  # noqa: E402
from quality_sidecar.findings import Finding  # noqa: E402
from quality_sidecar.tools import ToolResult  # noqa: E402

# --- synthetic values (assembled from parts, like tests/fixtures/jgates/pii-fixture.js) -----------------------------

_CPF_W1 = [10, 9, 8, 7, 6, 5, 4, 3, 2]
_CPF_W2 = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]
_CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
_CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]


def _check_digit(digits: list[int], weights: list[int]) -> int:
    rest = sum(d * w for d, w in zip(digits, weights)) % 11
    return 0 if rest < 2 else 11 - rest


def _with_check_digits(base: str, first: list[int], second: list[int]) -> str:
    digits = [int(c) for c in base]
    digits.append(_check_digit(digits, first))
    digits.append(_check_digit(digits, second))
    return "".join(str(d) for d in digits)


def fmt_cpf(d: str) -> str:
    return d[0:3] + "." + d[3:6] + "." + d[6:9] + "-" + d[9:]


def fmt_cnpj(d: str) -> str:
    return d[0:2] + "." + d[2:5] + "." + d[5:8] + "/" + d[8:12] + "-" + d[12:]


VALID_CPF_DIGITS = _with_check_digits("123456" + "789", _CPF_W1, _CPF_W2)
VALID_CPF = fmt_cpf(VALID_CPF_DIGITS)
INVALID_CPF = fmt_cpf(VALID_CPF_DIGITS[:9] + ("00" if VALID_CPF_DIGITS[9:] != "00" else "11"))
REPEATED_CPF = fmt_cpf("1" * 11)  # passes the mod-11 arithmetic, but is not a real CPF
VALID_CNPJ_DIGITS = _with_check_digits("112223" + "330001", _CNPJ_W1, _CNPJ_W2)
VALID_CNPJ = fmt_cnpj(VALID_CNPJ_DIGITS)
INVALID_CNPJ = fmt_cnpj(VALID_CNPJ_DIGITS[:12] + ("00" if VALID_CNPJ_DIGITS[12:] != "00" else "11"))
CARD = " ".join(["4111"] + ["1111"] * 3)
CARD_HYPHEN = "-".join(["4111"] + ["1111"] * 3)
CARD_BAD_LUHN = " ".join(["4111"] + ["1111"] * 2 + ["1112"])
CARD_ZEROS = " ".join(["0000"] * 4)
PHONE = "(11) 9" + "8765" + "-4321"
PHONE_INTL = "+55 11 9" + "8765" + "-4321"
LANDLINE = "11 34" + "56-7890"
BARE_PHONE = "11" + "98765" + "4321"


def privacy_fixture_text() -> str:
    """The fixture of test_quality_sidecar.py (secret + CPF)."""
    secret = "abcdefghijkl" + "mnopqrstuvwxyz"
    return f"password = '{secret}'\ncpf = '{VALID_CPF}'\n"


PII_FILE = "customers/sample.txt"


def pii_fixture_files() -> dict[str, str]:
    """Same files as createPiiFixture() in tests/fixtures/jgates/pii-fixture.js."""
    body = [
        "# synthetic customer record (test fixture)",
        f"cpf = '{VALID_CPF}'",
        f"cnpj = '{VALID_CNPJ}'",
        f"card = '{CARD}'",
        f"phone = '{PHONE}'",
    ]
    return {"README.md": "# PII fixture (synthetic values only)\n", PII_FILE: "\n".join(body) + "\n"}


PII_LINES = {"cpf": 2, "cnpj": 3, "credit-card": 4, "phone": 5}
RAW_VALUES = (VALID_CPF, VALID_CNPJ, CARD, PHONE, VALID_CPF_DIGITS, VALID_CNPJ_DIGITS)


def corpus_lines() -> list[str]:
    """Positive, negative and ambiguous lines for every rule (documented in the test names below)."""
    return [
        f"a {VALID_CPF} b",
        VALID_CPF_DIGITS,
        VALID_CPF_DIGITS[:9] + "-" + VALID_CPF_DIGITS[9:],
        REPEATED_CPF,
        INVALID_CPF,
        VALID_CNPJ,
        VALID_CNPJ_DIGITS,
        INVALID_CNPJ,
        CARD,
        CARD_HYPHEN,
        CARD_BAD_LUHN,
        CARD.replace(" ", ""),
        CARD_ZEROS,
        CARD + " 12/30",
        PHONE,
        PHONE_INTL,
        LANDLINE,
        BARE_PHONE,
        "x " + "1234567890" * 2 + "12",
        "id " + "-".join(["2026", "10", "25", "123456"]),
        "version 1.2.3 build 42",
        f"two {VALID_CPF} and {INVALID_CPF}",
        f"mixed {VALID_CPF} {CARD} {PHONE}",
        "nothing here",
    ]


def write_tree(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode("utf-8"))


def tree_bytes(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


# --- frozen oracle: the detector before the per-entity contract -----------------------------------------------------

_LEGACY_PII_PATTERNS = [
    ("cpf", re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")),
    ("cnpj", re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b")),
    ("credit-card", re.compile(r"\b(?:\d[ -]*?){13,19}\b")),
]


def legacy_pii_findings(root: Path) -> list[Finding]:
    findings = []
    for path in iter_source_files(root):
        rel = relative_path(path, root)
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        for number, line in enumerate(lines, start=1):
            for rule, pattern in _LEGACY_PII_PATTERNS:
                if pattern.search(line):
                    findings.append(Finding(
                        tool="builtin",
                        rule=f"pii.{rule}",
                        severity="high" if rule == "credit-card" else "medium",
                        category="pii",
                        path=rel,
                        line=number,
                        message=f"Possible {rule.upper()} personal data detected.",
                    ))
    return findings


def as_dicts(findings: list[Finding]) -> list[dict]:
    return [item.to_dict() for item in findings]


def pii_only(findings: list[Finding]) -> list[dict]:
    return [item.to_dict() for item in findings if item.category == "pii"]


def config_with(**entities: dict) -> pii.PiiConfig:
    return pii.config_from_dict({"entities": entities})


class FixtureDir(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.base = Path(self._temp.name)
        self.target = self.base / "project"
        self.target.mkdir()
        self.output = self.base / "reports"

    def tearDown(self) -> None:
        self._temp.cleanup()

    def write(self, files: dict[str, str]) -> None:
        write_tree(self.target, files)


class PreservationTests(FixtureDir):
    """The default configuration (no new option) finds exactly what the legacy detector found."""

    def assert_same_as_legacy(self) -> None:
        before = tree_bytes(self.target)
        expected = as_dicts(legacy_pii_findings(self.target))
        self.assertEqual(as_dicts(detect_builtin_findings(self.target, include_pii=True)), expected)
        self.assertEqual(as_dicts(detect_builtin_findings(self.target, include_pii=True, pii_config=None)), expected)
        self.assertEqual(as_dicts(pii.detect_pii(self.target)), expected)
        both = detect_builtin_findings(self.target, include_pii=True, include_secrets=True)
        self.assertEqual(pii_only(both), expected)
        self.assertEqual(detect_builtin_findings(self.target), [])
        self.assertEqual(tree_bytes(self.target), before)

    def test_pii_fixture_matches_the_legacy_detector(self) -> None:
        self.write(pii_fixture_files())
        self.assert_same_as_legacy()
        rules = [(f.rule, f.line) for f in detect_builtin_findings(self.target, include_pii=True)]
        self.assertEqual(rules, [("pii.cpf", 2), ("pii.cnpj", 3), ("pii.credit-card", 4)])

    def test_privacy_fixture_matches_the_legacy_detector(self) -> None:
        self.write({"sample.txt": privacy_fixture_text()})
        self.assert_same_as_legacy()

    def test_corpus_of_positive_negative_and_ambiguous_lines_matches_the_legacy_detector(self) -> None:
        self.write({"corpus.txt": "\n".join(corpus_lines()) + "\n", "nested/data.json": json.dumps(corpus_lines())})
        self.assert_same_as_legacy()

    def test_quality_gate_with_enable_pii_reports_the_legacy_findings(self) -> None:
        self.write(pii_fixture_files())
        before = tree_bytes(self.target)
        env = {**os.environ, "PYTHONPATH": str(ROOT / "sidecar"), "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run(
            [sys.executable, "-B", "-m", "quality_sidecar", "check", str(self.target), "--mode", "quick",
             "--format", "json,md", "--threshold", "99", "--enable-pii", "--output", str(self.output)],
            cwd=str(ROOT), env=env, text=True, encoding="utf-8", capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        report = json.loads((self.output / "quality-report.json").read_text(encoding="utf-8"))
        expected = [{**item, "status": "active"} for item in as_dicts(legacy_pii_findings(self.target))]
        for item in expected:
            item.pop("allowed_reason")
        got = [{k: v for k, v in item.items() if k != "allowed_reason"} for item in report["findings"]]
        self.assertEqual(got, expected)
        self.assertEqual(tree_bytes(self.target), before)

    @unittest.skipUnless(shutil.which("node"), "node is not on PATH; the Python copy of the fixture is used alone")
    def test_python_fixture_is_the_node_fixture(self) -> None:
        script = (
            "const f=require(process.argv[1]);const r=f.createPiiFixture();"
            "process.stdout.write(JSON.stringify({files:r.files,lines:r.lines}));f.removePiiFixture(r.dir);"
        )
        out = subprocess.run(["node", "-e", script, str(REPO / "tests" / "fixtures" / "jgates" / "pii-fixture.js")],
                             capture_output=True, text=True, check=True).stdout
        data = json.loads(out)
        self.assertEqual(data["files"], pii_fixture_files())
        self.assertEqual(data["lines"], {"cpf": 2, "cnpj": 3, "card": 4, "phone": 5})


class EntityToggleTests(FixtureDir):
    def setUp(self) -> None:
        super().setUp()
        self.write(pii_fixture_files())
        self.all_on = as_dicts(pii.detect_pii(self.target))

    def test_turning_one_entity_off_removes_only_its_findings(self) -> None:
        for entity in pii.LEGACY_ENTITIES:
            with self.subTest(entity=entity):
                got = as_dicts(pii.detect_pii(self.target, config_with(**{entity: {"enabled": False}})))
                self.assertEqual(got, [f for f in self.all_on if f["rule"] != f"pii.{entity}"])
                self.assertNotIn(f"pii.{entity}", {f["rule"] for f in got})

    def test_phone_is_off_by_default_and_turning_it_on_adds_only_the_phone_finding(self) -> None:
        self.assertNotIn("pii.phone", {f["rule"] for f in self.all_on})
        got = as_dicts(pii.detect_pii(self.target, config_with(phone={"enabled": True})))
        extra = [f for f in got if f["rule"] == "pii.phone"]
        self.assertEqual([(f["path"], f["line"], f["severity"]) for f in extra], [(PII_FILE, PII_LINES["phone"], "medium")])
        self.assertEqual([f for f in got if f["rule"] != "pii.phone"], self.all_on)

    def test_only_one_entity_on(self) -> None:
        for entity in pii.ENTITIES:
            with self.subTest(entity=entity):
                cfg = pii.config_from_dict({"entities": {name: {"enabled": name == entity} for name in pii.ENTITIES}})
                got = pii.detect_pii(self.target, cfg)
                self.assertEqual([(f.rule, f.line) for f in got], [(f"pii.{entity}", PII_LINES[entity])])

    def test_each_entity_has_its_own_severity(self) -> None:
        cfg = config_with(cpf={"severity": "critical"}, phone={"enabled": True, "severity": "low"})
        got = {f.rule: f.severity for f in pii.detect_pii(self.target, cfg)}
        self.assertEqual(got, {"pii.cpf": "critical", "pii.cnpj": "medium", "pii.credit-card": "high", "pii.phone": "low"})

    def test_detector_off_runs_no_rule_and_coverage_records_the_exclusion(self) -> None:
        cfg = pii.config_from_dict({"enabled": False})
        self.assertEqual(pii.detect_pii(self.target, cfg), [])
        rows = {row["entity"]: row for row in pii.coverage(cfg)}
        self.assertEqual({row["status"] for row in rows.values()}, {"disabled"})
        default_rows = {row["entity"]: row["status"] for row in pii.coverage(pii.default_config())}
        self.assertEqual(default_rows, {"cpf": "run", "cnpj": "run", "credit-card": "run", "phone": "disabled"})

    def test_bridge_request_configuration(self) -> None:
        cfg = pii.config_from_request(["cnpj", "phone"], "low")
        got = [(f.rule, f.severity, f.line) for f in pii.detect_pii(self.target, cfg)]
        self.assertEqual(got, [("pii.cnpj", "low", 3), ("pii.phone", "low", 5)])
        self.assertEqual(as_dicts(pii.detect_pii(self.target, pii.config_from_request())), self.all_on)


class ValidationTests(FixtureDir):
    def test_invalid_cpf_and_card_are_dropped_only_with_validation_on(self) -> None:
        self.write({"data.txt": "\n".join([INVALID_CPF, CARD_BAD_LUHN, INVALID_CNPJ, VALID_CPF, CARD, VALID_CNPJ]) + "\n"})
        plain = [(f.rule, f.line) for f in pii.detect_pii(self.target)]
        self.assertIn(("pii.cpf", 1), plain)
        self.assertIn(("pii.credit-card", 2), plain)
        self.assertIn(("pii.cnpj", 3), plain)
        checked = [(f.rule, f.line) for f in pii.detect_pii(
            self.target, pii.config_from_dict({"detection": {"validateCheckDigits": True}}))]
        self.assertEqual(checked, [("pii.cpf", 4), ("pii.credit-card", 5), ("pii.cnpj", 6)])

    def test_card_after_a_cnpj_on_the_same_line_still_validates(self) -> None:
        # ambiguous: the card regex starts inside the CNPJ and swallows the card's first groups; the overlapping
        # search still finds the card's own span
        self.write({"data.txt": f"{VALID_CNPJ} {CARD}\n"})
        cfg = pii.config_from_dict({"detection": {"validateCheckDigits": True}})
        self.assertEqual([(f.rule, f.line) for f in pii.detect_pii(self.target, cfg)],
                         [("pii.cnpj", 1), ("pii.credit-card", 1)])
        cards = [m for m in pii.scan_line(f"{VALID_CNPJ} {CARD}") if m.entity == "credit-card"]
        self.assertIn(("**** **** **** ****", True), [(m.masked, m.valid) for m in cards])

    def test_fixture_values_pass_validation_so_results_stay_the_same(self) -> None:
        self.write(pii_fixture_files())
        cfg = pii.config_from_dict({"detection": {"validateCheckDigits": True}})
        self.assertEqual(as_dicts(pii.detect_pii(self.target, cfg)), as_dicts(pii.detect_pii(self.target)))

    def test_cpf_rule(self) -> None:
        # positive
        self.assertTrue(pii.is_valid_cpf(VALID_CPF))
        self.assertTrue(pii.is_valid_cpf(VALID_CPF_DIGITS))
        # negative: wrong check digits, a single repeated digit, wrong length
        self.assertFalse(pii.is_valid_cpf(INVALID_CPF))
        self.assertFalse(pii.is_valid_cpf(REPEATED_CPF))
        self.assertFalse(pii.is_valid_cpf(VALID_CPF_DIGITS[:10]))
        # ambiguous: an unpunctuated 11-digit run is a CPF by shape (an id or a bare phone may look the same)
        self.assertEqual([m.entity for m in pii.scan_line(VALID_CPF_DIGITS)], ["cpf"])
        self.assertEqual([m.entity for m in pii.scan_line(BARE_PHONE, config_with(phone={"enabled": True}))], ["cpf"])

    def test_cnpj_rule(self) -> None:
        self.assertTrue(pii.is_valid_cnpj(VALID_CNPJ))
        self.assertTrue(pii.is_valid_cnpj(VALID_CNPJ_DIGITS))
        self.assertFalse(pii.is_valid_cnpj(INVALID_CNPJ))
        self.assertFalse(pii.is_valid_cnpj("1" * 14))
        # ambiguous: 14 bare digits are a CNPJ by shape and also match the legacy credit-card regex
        self.assertEqual({m.entity for m in pii.scan_line(VALID_CNPJ_DIGITS)}, {"cnpj", "credit-card"})

    def test_credit_card_rule(self) -> None:
        self.assertTrue(pii.is_valid_card(CARD))
        self.assertTrue(pii.is_valid_card(CARD_HYPHEN))
        self.assertTrue(pii.is_valid_card(CARD.replace(" ", "")))
        self.assertFalse(pii.is_valid_card(CARD_BAD_LUHN))
        self.assertFalse(pii.is_valid_card(CARD_ZEROS))  # Luhn arithmetic passes, a repeated digit is refused
        # ambiguous: digits right after a card (an expiry month); the card is one valid match and the overlapping
        # search does not report its tail as a second value
        glued = pii.scan_line(CARD + " 12/30")
        self.assertEqual([(m.entity, m.valid, m.column) for m in glued], [("credit-card", True, 1)])
        # ambiguous: digits right before a card are swallowed by the regex; the card's own span still validates
        prefixed = pii.scan_line("id 12 " + CARD)
        self.assertEqual([(m.valid, m.column) for m in prefixed], [(False, 4), (True, 7)])
        # ambiguous: a date with an id is card-shaped; validation drops it
        date_id = "-".join(["2026", "10", "25", "123456"])
        self.assertEqual([(m.entity, m.valid) for m in pii.scan_line(date_id)], [("credit-card", False)])
        # negative: more than 19 digits has no word boundary inside
        self.assertEqual(pii.scan_line("1234567890" * 2 + "12"), [])

    def test_phone_rule(self) -> None:
        on = config_with(phone={"enabled": True})
        only = pii.config_from_dict({"entities": {n: {"enabled": n == "phone"} for n in pii.ENTITIES}})
        for value in (PHONE, PHONE_INTL, LANDLINE, "(21) 3" + "456-7890", "+55 (11) 9" + "8765-4321"):
            with self.subTest(positive=value):
                self.assertEqual([m.entity for m in pii.scan_line(f"tel {value}.", only)], ["phone"])
        for value in (BARE_PHONE, VALID_CPF, VALID_CNPJ, "(10) 9" + "8765-4321", "11 1" + "234-5678",
                      "-".join(["2026", "10", "25"]), "version 1.2.3"):
            with self.subTest(negative=value):
                self.assertEqual(pii.scan_line(value, only), [])
        # ambiguous: with the country code, the legacy credit-card regex also matches (13 digits)
        self.assertEqual({m.entity for m in pii.scan_line(PHONE_INTL, on)}, {"credit-card", "phone"})
        self.assertEqual(pii.scan_line(PHONE_INTL, only)[0].valid, None)


class MaskingTests(FixtureDir):
    def assert_no_raw(self, *texts: str) -> None:
        for text in texts:
            for raw in RAW_VALUES:
                self.assertNotIn(raw, text)

    def test_matches_carry_only_the_masked_value(self) -> None:
        line = f"mixed {VALID_CPF} {CARD} {PHONE}"
        matches = pii.scan_line(line, config_with(phone={"enabled": True}))
        self.assertEqual({m.entity for m in matches}, {"cpf", "credit-card", "phone"})
        for match in matches:
            self.assert_no_raw(repr(match), json.dumps(match.__dict__), match.masked)
            self.assertEqual(len(match.masked), match.length)
        cpf = next(m for m in matches if m.entity == "cpf")
        self.assertEqual(cpf.masked, "***.***.***-**")
        self.assertEqual(line[cpf.column - 1:cpf.column - 1 + cpf.length].count("."), 2)

    def test_redaction_masks_every_entity_even_when_disabled(self) -> None:
        text = f"seen {VALID_CPF} {VALID_CNPJ} {CARD} {PHONE} and {BARE_PHONE}"
        redacted = pii.redact_text(text)
        self.assert_no_raw(redacted)
        self.assertNotIn(BARE_PHONE, redacted)
        self.assertTrue(redacted.startswith("seen ***.***.***-** **.***.***/****-** **** **** **** **** (**) *****-****"))
        self.assertEqual(pii.redact_text("version 1.2.3, line 42"), "version 1.2.3, line 42")
        finding = Finding(tool="semgrep", rule="x", severity="low", category="sast", message=text,
                          metadata={"snippet": [text]})
        fingerprint = finding.fingerprint
        pii.redact_finding(finding, metadata=True)
        self.assert_no_raw(finding.message, json.dumps(finding.metadata))
        self.assertEqual(finding.fingerprint, fingerprint)

    def run_check(self, *argv: str, pii_config: pii.PiiConfig | None = None,
                  external: list[Finding] | None = None) -> tuple[int, dict, str, str, str]:
        args = cli.build_parser().parse_args(
            ["check", str(self.target), "--mode", "quick", "--format", "json,md", "--threshold", "99",
             "--output", str(self.output), *argv])
        out, err = io.StringIO(), io.StringIO()
        detector = partial(detect_builtin_findings, pii_config=pii_config)

        def fake_external(*_args, **_kwargs):
            return ([ToolResult(name="semgrep", status="findings", summary={"findings": len(external or [])})],
                    list(external or []))

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(cli, "detect_builtin_findings", detector))
            if external is not None:
                stack.enter_context(patch.object(cli, "run_external_tools", fake_external))
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            code = cli.run_check(args)
        report_text = (self.output / "quality-report.json").read_text(encoding="utf-8")
        markdown = (self.output / "quality-report.md").read_text(encoding="utf-8")
        return code, json.loads(report_text), report_text + markdown, out.getvalue(), err.getvalue()

    def test_raw_values_never_reach_json_markdown_or_console_in_any_mode(self) -> None:
        self.write(pii_fixture_files())
        before = tree_bytes(self.target)
        phone_on = config_with(phone={"enabled": True})
        modes = [
            ((), None),
            (("--enable-pii",), None),
            (("--enable-pii", "--enable-secrets"), None),
            (("--enable-pii", "--allow-pii", "--waiver-reason", "synthetic"), None),
            (("--enable-pii",), phone_on),
            (("--enable-pii",), pii.config_from_dict({"enabled": False})),
            (("--enable-pii",), pii.config_from_dict({"detection": {"validateCheckDigits": True},
                                                     "entities": {"phone": {"enabled": True}}})),
        ]
        for argv, cfg in modes:
            with self.subTest(argv=argv, config=cfg and cfg.to_dict()):
                _code, report, files_text, out, err = self.run_check(*argv, pii_config=cfg)
                self.assert_no_raw(files_text, out, err)
                if "--enable-pii" in argv and cfg is phone_on:
                    self.assertIn("pii.phone", {f["rule"] for f in report["findings"]})
                self.assertEqual(tree_bytes(self.target), before)

    def test_masking_still_holds_for_other_detectors_with_the_pii_detector_off(self) -> None:
        self.write({"app.py": "print('ok')\n"})
        leaking = Finding(tool="semgrep", rule="semgrep.echo", severity="low", category="sast", path="app.py", line=1,
                          message=f"Matched literal {VALID_CPF} near {PHONE} and {CARD}")
        for cfg in (None, pii.config_from_dict({"enabled": False})):
            with self.subTest(config=cfg and cfg.to_dict()):
                _code, report, files_text, out, err = self.run_check(pii_config=cfg, external=[leaking])
                self.assert_no_raw(files_text, out, err)
                messages = [f["message"] for f in report["findings"] if f["rule"] == "semgrep.echo"]
                self.assertEqual(messages, ["Matched literal ***.***.***-** near (**) *****-**** and **** **** **** ****"])

    def test_sidecar_subprocess_stderr_and_stdout_carry_no_raw_value(self) -> None:
        self.write(pii_fixture_files())
        before = tree_bytes(self.target)
        env = {**os.environ, "PYTHONPATH": str(ROOT / "sidecar"), "PYTHONDONTWRITEBYTECODE": "1"}
        for extra in ((), ("--enable-pii",), ("--enable-pii", "--enable-secrets")):
            with self.subTest(extra=extra):
                result = subprocess.run(
                    [sys.executable, "-B", "-m", "quality_sidecar", "check", str(self.target), "--mode", "quick",
                     "--format", "json,md", "--threshold", "99", "--output", str(self.output), *extra],
                    cwd=str(ROOT), env=env, text=True, encoding="utf-8", capture_output=True, check=False,
                )
                self.assertIn(result.returncode, (0, 1), result.stderr)
                reports = "".join(p.read_text(encoding="utf-8") for p in sorted(self.output.glob("quality-report.*")))
                self.assert_no_raw(result.stdout, result.stderr, reports)
                self.assertEqual(tree_bytes(self.target), before)


class ConfigurationTests(unittest.TestCase):
    def test_defaults_preserve_the_legacy_detector(self) -> None:
        cfg = pii.config_from_dict(None)
        self.assertEqual(cfg, pii.default_config())
        self.assertEqual(cfg.to_dict(), {
            "schemaVersion": 1,
            "entities": {
                "cpf": {"enabled": True, "severity": "medium"},
                "cnpj": {"enabled": True, "severity": "medium"},
                "credit-card": {"enabled": True, "severity": "high"},
                "phone": {"enabled": False, "severity": "medium"},
            },
            "detection": {"locale": "pt-BR", "validateCheckDigits": False},
            "reporting": {"redactMatchedValues": True},
            "remediation": {"mode": "none"},
        })
        self.assertEqual(pii.config_from_dict(cfg.to_dict()), cfg)
        self.assertEqual(pii.config_from_dict({"schemaVersion": 1}), cfg)

    def test_missing_keys_inherit_and_top_level_severity_fills_the_rest(self) -> None:
        cfg = pii.config_from_dict({"severity": "low", "entities": {"credit-card": {"severity": "critical"}}})
        self.assertEqual({n: cfg.entity(n).severity for n in pii.ENTITIES},
                         {"cpf": "low", "cnpj": "low", "credit-card": "critical", "phone": "low"})
        self.assertEqual(cfg.enabled_entities(), pii.LEGACY_ENTITIES)

    def test_invalid_values_are_refused_with_a_pointer(self) -> None:
        cases = [
            ({"entities": {"cpf": {"enabled": None}}}, "invalid-config", "/entities/cpf/enabled"),
            ({"entities": {"cpf": {"severity": "urgent"}}}, "invalid-config", "/entities/cpf/severity"),
            ({"entities": {"email": {"enabled": True}}}, "invalid-config", "/entities/email"),
            ({"entities": {"cpf": {"enabled": True, "mask": True}}}, "invalid-config", "/entities/cpf/mask"),
            ({"detection": {"validateCheckDigits": "yes"}}, "invalid-config", "/detection/validateCheckDigits"),
            ({"schemaVersion": 2}, "invalid-config", "/schemaVersion"),
            ({"unknown": 1}, "invalid-config", "/unknown"),
            ({"enabled": None}, "invalid-config", "/enabled"),
            ([], "invalid-config", "/"),
        ]
        for data, code, path in cases:
            with self.subTest(data=data):
                with self.assertRaises(pii.PiiConfigError) as caught:
                    pii.config_from_dict(data)
                self.assertEqual((caught.exception.code, caught.exception.path), (code, path))

    def test_unsupported_options_are_refused_never_dropped(self) -> None:
        cases = [
            ({"reporting": {"redactMatchedValues": False}}, "/reporting/redactMatchedValues"),
            ({"remediation": {"mode": "fix"}}, "/remediation/mode"),
            ({"detection": {"locale": "en-US"}}, "/detection/locale"),
        ]
        for data, path in cases:
            with self.subTest(data=data):
                with self.assertRaises(pii.PiiConfigError) as caught:
                    pii.config_from_dict(data)
                self.assertEqual(caught.exception.code, "unsupported-option")
                self.assertEqual(caught.exception.to_dict()["path"], path)
        with self.assertRaises(pii.PiiConfigError):
            pii.PiiConfig(redact_matched_values=False)
        with self.assertRaises(pii.PiiConfigError):
            pii.config_from_request(["email"])
        with self.assertRaises(pii.PiiConfigError):
            pii.config_from_request(None, "urgent")

    def test_coverage_lists_every_supported_entity(self) -> None:
        rows = pii.coverage(pii.config_from_dict({"detection": {"validateCheckDigits": True}}))
        self.assertEqual([r["entity"] for r in rows], list(pii.ENTITIES))
        self.assertTrue(all(r["supported"] for r in rows))
        self.assertEqual({r["entity"]: r["validation"] for r in rows},
                         {"cpf": "check-digits", "cnpj": "check-digits", "credit-card": "luhn", "phone": "none"})


if __name__ == "__main__":
    unittest.main()
