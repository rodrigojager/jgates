import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))

CORPUS = ROOT.parent / "jgates" / "tests" / "fixtures" / "codecs-toml"

try:
    import tomlkit  # noqa: F401

    HAS_TOMLKIT = True
except ImportError:  # pragma: no cover
    HAS_TOMLKIT = False

if HAS_TOMLKIT:
    from quality_sidecar import toml_edit


def call(request):
    out = io.StringIO()
    code = toml_edit.main(io.StringIO(json.dumps(request)), out)
    return code, json.loads(out.getvalue())


def corpus_files():
    return sorted(p for p in CORPUS.glob("*.toml") if p.name != "broken.toml") if CORPUS.is_dir() else []


def read_text(path):
    return path.read_bytes().decode("utf-8")


@unittest.skipUnless(HAS_TOMLKIT, "tomlkit is not installed")
class TomlEditTests(unittest.TestCase):
    def test_corpus_exists(self):
        self.assertTrue(corpus_files(), "the TOML corpus is missing")

    def test_round_trip_changes_no_byte(self):
        for path in corpus_files():
            with self.subTest(file=path.name):
                text = read_text(path)
                code, res = call({"schemaVersion": 1, "operation": "apply", "text": text, "intents": []})
                self.assertEqual(code, 0, res)
                self.assertEqual(res["text"], text)
                self.assertFalse(res["changed"])

    def test_edit_ruff_keeps_other_sections_byte_for_byte(self):
        text = read_text(CORPUS / "pyproject.toml")
        code, res = call(
            {
                "schemaVersion": 1,
                "operation": "apply",
                "text": text,
                "section": ["tool", "ruff"],
                "intents": [
                    {"path": ["line-length"], "op": "set", "value": 100},
                    {"path": ["preview"], "op": "set", "value": True},
                ],
            }
        )
        self.assertEqual(code, 0, res)
        new = res["text"]
        self.assertTrue(res["changed"])
        self.assertEqual(res["fields"]["line-length"], 100)
        self.assertIn("line-length = 100", new)
        # Everything outside [tool.ruff] (before and after its own keys) is untouched.
        start = text.index("[tool.ruff]")
        end = text.index("[tool.ruff.lint]")
        new_start = new.index("[tool.ruff]")
        new_end = new.index("[tool.ruff.lint]")
        self.assertEqual(new[:new_start], text[:start])
        self.assertEqual(new[new_end:], text[end:])
        for marker in ("[tool.pytest.ini_options]", "[build-system]", "# Ruff settings below.", "# build deps"):
            self.assertIn(marker, new)
        pytest_block = text[text.index("[tool.pytest.ini_options]") : text.index("# Ruff settings below.")]
        self.assertIn(pytest_block, new)
        self.assertIn("# keep it short", new)

    def test_edit_nested_section_and_array_of_tables(self):
        text = read_text(CORPUS / "pyproject.toml")
        code, res = call(
            {
                "schemaVersion": 1,
                "operation": "apply",
                "text": text,
                "section": ["tool", "ruff", "lint"],
                "intents": [{"path": ["select"], "op": "set", "value": ["E", "F", "I"]}, {"path": ["ignore"], "op": "delete"}],
            }
        )
        self.assertEqual(code, 0, res)
        self.assertIn('select = ["E", "F", "I"]', res["text"])
        self.assertNotIn("ignore = []", res["text"])
        self.assertEqual(res["text"].count("[[tool.mypy.overrides]]"), 2)
        self.assertIn('"tests/*" = ["S101"]', res["text"])

    def test_create_missing_section(self):
        text = "[a]\nb = 1\n"
        code, res = call(
            {"schemaVersion": 1, "operation": "apply", "text": text, "section": ["tool", "ruff"], "intents": [{"path": ["line-length"], "op": "set", "value": 99}]}
        )
        self.assertEqual(code, 0, res)
        self.assertTrue(res["text"].startswith(text))
        self.assertEqual(res["fields"], {"line-length": 99})

    def test_read_section(self):
        text = read_text(CORPUS / "pyproject.toml")
        code, res = call({"schemaVersion": 1, "operation": "read", "text": text, "section": ["tool", "ruff"]})
        self.assertEqual(code, 0, res)
        self.assertTrue(res["exists"])
        self.assertEqual(res["fields"]["line-length"], 88)
        code, res = call({"schemaVersion": 1, "operation": "read", "text": text, "section": ["tool", "nope"]})
        self.assertFalse(res["exists"])

    def test_dotted_and_quoted_keys(self):
        text = read_text(CORPUS / "dotted-quoted.toml")
        code, res = call(
            {"schemaVersion": 1, "operation": "apply", "text": text, "intents": [{"path": ["a", "b", "c"], "op": "set", "value": 2}]}
        )
        self.assertEqual(code, 0, res)
        self.assertEqual(res["text"], text.replace("a.b.c = 1", "a.b.c = 2"))
        code, res = call(
            {"schemaVersion": 1, "operation": "apply", "text": text, "section": ["servers", "beta.example"], "intents": [{"path": ["ip"], "op": "set", "value": "10.9.9.9"}]}
        )
        self.assertEqual(code, 0, res)
        self.assertEqual(res["text"], text.replace('ip = "10.0.0.2"', 'ip = "10.9.9.9"'))

    def test_crlf_is_preserved(self):
        text = read_text(CORPUS / "crlf.toml")
        code, res = call(
            {"schemaVersion": 1, "operation": "apply", "text": text, "section": ["tool", "ruff"], "intents": [{"path": ["line-length"], "op": "set", "value": 120}]}
        )
        self.assertEqual(code, 0, res)
        self.assertEqual(res["text"], text.replace("100", "120"))

    def test_syntax_error_is_structured(self):
        code, res = call({"schemaVersion": 1, "operation": "validate", "text": read_text(CORPUS / "broken.toml")})
        self.assertEqual(code, 1)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["code"], "TOML_SYNTAX")
        self.assertIsInstance(res["error"].get("line"), int)

    def test_requests_outside_the_protocol_are_refused(self):
        bad = [
            {"schemaVersion": 1, "operation": "read", "path": "/etc/passwd"},
            {"schemaVersion": 1, "operation": "read", "file": "pyproject.toml"},
            {"schemaVersion": 1, "operation": "read", "text": "/etc/passwd", "path": "/etc/passwd"},
            {"schemaVersion": 2, "operation": "read", "text": ""},
            {"schemaVersion": 1, "operation": "eval", "text": ""},
            {"schemaVersion": 1, "operation": "read", "text": 5},
            {"schemaVersion": 1, "operation": "apply", "text": "", "intents": [{"path": [], "op": "set", "value": 1}]},
            {"schemaVersion": 1, "operation": "apply", "text": "", "intents": [{"path": ["a"], "op": "run"}]},
            {"schemaVersion": 1, "operation": "read", "text": "", "intents": [{"path": ["a"], "op": "delete"}]},
            [],
        ]
        for request in bad:
            with self.subTest(request=request):
                code, res = call(request)
                self.assertEqual(code, 1)
                self.assertFalse(res["ok"])
                self.assertIn(res["error"]["code"], ("BAD_REQUEST", "BAD_INTENT"))

    def test_invalid_json_on_stdin(self):
        out = io.StringIO()
        code = toml_edit.main(io.StringIO("not json"), out)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue())["error"]["code"], "BAD_REQUEST")

    def test_module_runs_as_a_process(self):
        env = dict(os.environ, PYTHONPATH=str(ROOT / "sidecar"))
        proc = subprocess.run(
            [sys.executable, "-m", "quality_sidecar.toml_edit"],
            input=json.dumps({"schemaVersion": 1, "operation": "validate", "text": "a = 1\n"}),
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
