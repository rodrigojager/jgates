from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def read_repo(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


class StaticQualityGateContractTests(unittest.TestCase):
    def test_dockerfile_contains_complete_sidecar_toolchain(self) -> None:
        dockerfile = read("Dockerfile")
        required_fragments = [
            "ARG MEGALINTER_IMAGE=ghcr.io/oxsecurity/megalinter:v9.6.0@sha256:248e30b43bdfa7ce941fd5e410159da4d69716c68c48a459b08d1760c4625ef5",
            "ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0.302-alpine3.23-amd64@sha256:2073294f05c2676f2e11b1782188654435e77e28adaed77a1138b0ca4693dd3b",
            "ARG GITLEAKS_BUILDER_IMAGE=golang:1.25.7-alpine3.23@sha256:724e212d86d79b45b7ace725b44ff3b6c2684bfd3131c43d5d60441de151d98e",
            "ARG GITLEAKS_SOURCE_COMMIT=83d9cd684c87d95d656c1458ef04895a7f1cbd8e",
            "ARG GITLEAKS_SOURCE_SHA256=6b2638a733b85619dc80bdf28e84e4fed7e526a761ab5c148fbf67695aea2115",
            "ARG EDITORCONFIG_CHECKER_SOURCE_COMMIT=03db2cca9a525b3831377be1e4696c06fdfef07a",
            "ARG LS_LINT_SOURCE_COMMIT=b530dd769e259aa9fc546cc3c0098e6a0c82870e",
            "ARG PROTOLINT_SOURCE_COMMIT=67278bf4e14fdfc8bdafef823b8e76eb403ed9ba",
            "ARG PROTOLINT_GRPC_VERSION=1.79.3",
            "ARG QUALITY_GATE_FLAVOR=generic",
            '"semgrep==${SEMGREP_INSTALL_VERSION}"',
            '"checkov==${CHECKOV_INSTALL_VERSION}"',
            "/opt/venvs/semgrep/bin/pip check",
            "/opt/venvs/checkov/bin/pip check",
            "/opt/venvs/quality-sidecar/bin/pip check",
            'fetch_source gitleaks gitleaks/gitleaks "${GITLEAKS_SOURCE_COMMIT}" "${GITLEAKS_SOURCE_SHA256}"',
            "go mod download",
            "-tags gore2regex",
            "go1.25.7",
            "RUN --mount=from=gitleaks-builder,source=/out,target=/opt/patched-go-tools,readonly",
            "install -o root -g root -m 0555 /opt/patched-go-tools/gitleaks /usr/local/bin/gitleaks",
            "ARG TRIVY_INSTALL_SHA256=bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea",
            "ARG OSV_SCANNER_INSTALL_SHA256=15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0",
            "aquasecurity/trivy",
            "google/osv-scanner",
            "osv-scanner_linux_${release_arch}",
            'npm install -g "jscpd@${JSCPD_INSTALL_VERSION}"',
            "apk upgrade --no-cache",
            "COPY --from=dotnet-sdk --chown=0:0 /usr/share/dotnet /usr/share/dotnet",
            'test "$(dotnet --version)" = "10.0.302"',
            'test "$(dotnet --list-runtimes | awk',
            "NUGET_HTTP_CACHE_PATH=/home/quality/.cache/NuGet/v3-cache",
            "chmod 0555 /usr/bin/hadolint",
            "chmod 0555 \"${arm_ttk_target}\"",
            "npm pkg delete 'dependencies.gherkin-lint' --prefix /node-deps",
            "/node-deps/node_modules/protobufjs",
            "for unused_binary in editorconfig-checker kubeconform ls-lint protolint",
            "/usr/local/dotnet-tools/.store/tsqllint",
            "ARG WEBSOCKET_DRIVER_INSTALL_VERSION=0.7.5",
            "ARG WEBSOCKET_DRIVER_INSTALL_SHA256=54755bff23a142069c08d2cfee75e38a64e79e49cbe7d1c48857b65482ab0b56",
            "ARG NPM_TAR_INSTALL_VERSION=7.5.19",
            "ARG NPM_TAR_INSTALL_SHA256=191644f88c7dbd61121f913231ab328d1fc621f058e8ca334451b17cad85dfae",
            "test \"${patched_count}\" -eq 2",
            "aa3808d2dbb71e8522c274ace56b86bddbd6e41e8c93e1626fe8c0693c5ab72a",
            "54ccd8bc063777753f3f55b8d61cd85c6fa972c140729ad939225ee60db94d20",
            "tee /dev/stderr",
            "ENV DOTNET_ROOT=/usr/share/dotnet",
            'PATH="/usr/local/bin:${PATH}"',
            "append_trusted_path",
            "case \"${candidate}\" in /*)",
            "[0-7][0145][15]",
            'test "$(command -v jscpd)" = "/usr/local/bin/jscpd"',
            "sha256sum -c -",
            'test "${TARGETARCH}" = "amd64"',
            "USER quality",
            "HEALTHCHECK",
            "ENTRYPOINT [\"/opt/quality-sidecar/entrypoint.sh\"]",
            "CMD [\"check\", \"/workspace\"]",
        ]

        for fragment in required_fragments:
            self.assertIn(fragment, dockerfile)

        self.assertNotIn("INSTALL_VERSION=latest", dockerfile)
        self.assertNotIn('arm64)', dockerfile)

    def test_dockerfile_installs_bash_before_using_bash_shell(self) -> None:
        dockerfile = read("Dockerfile")
        bash_package_index = dockerfile.index("bash")
        shell_index = dockerfile.index("SHELL [\"/bin/bash\"")

        self.assertLess(bash_package_index, shell_index)

    def test_entrypoint_accepts_quality_gate_alias_and_check_command(self) -> None:
        entrypoint = read("docker/entrypoint.sh")

        self.assertTrue(entrypoint.startswith("#!/bin/sh"))
        self.assertIn("/etc/jgates/quality-gate-path", entrypoint)
        self.assertIn("PATH=$QUALITY_ENTRYPOINT_PATH", entrypoint)
        self.assertNotIn("BASH_ENV", entrypoint)
        self.assertIn("quality-sidecar|quality-gate)", entrypoint)
        # The retired command name is spelled in pieces so a repository-wide search for it stays empty.
        self.assertNotIn("quality-" + "check", entrypoint)
        self.assertIn("exec /opt/venvs/quality-sidecar/bin/python -m quality_sidecar", entrypoint)

    def test_image_smokes_prove_jscpd_scans_sources_and_detects_duplicates(self) -> None:
        smoke = read("tests/image-smoke.sh")

        self.assertIn(".statistics.total.sources > 0", smoke)
        self.assertIn(".statistics.total.lines > 0", smoke)
        self.assertIn('.name == \\"jscpd\\"', smoke)
        self.assertIn('.status == \\"findings\\" and .summary.findings > 0', smoke)
        self.assertIn("quality-path-shadow", smoke)
        self.assertIn("pathlib.Path(resolved).is_absolute()", smoke)
        self.assertIn("cargo clippy", smoke)

    def test_image_bakes_immutable_flavor_path_and_config(self) -> None:
        dockerfile = read("Dockerfile")
        tools = read("sidecar/quality_sidecar/tools.py")

        self.assertIn("/etc/jgates/quality-gate-flavor", dockerfile)
        self.assertIn("/etc/jgates/quality-gate-path", dockerfile)
        self.assertIn("/etc/jgates/quality-gate-transport.env", dockerfile)
        self.assertIn("chmod 0444 /etc/jgates/quality-gate-flavor", dockerfile)
        self.assertIn("chmod 0444 /etc/jgates/quality-gate-path", dockerfile)
        self.assertIn("chmod 0444 /etc/jgates/quality-gate-transport.env", dockerfile)
        self.assertNotIn("QUALITY_SIDECAR_CONFIG_DIR=", dockerfile)
        self.assertNotIn("QUALITY_GATE_FLAVOR=${QUALITY_GATE_FLAVOR}", dockerfile)

        self.assertIn('Path("/opt/quality-sidecar/sidecar/config")', tools)
        self.assertIn('Path("/etc/jgates/quality-gate-flavor")', tools)
        self.assertNotIn('os.environ.get(\n        "QUALITY_SIDECAR_CONFIG_DIR"', tools)

    def test_node_wrapper_is_thin_and_docker_first(self) -> None:
        wrapper = read("bin/quality-gate.js")
        forbidden_tool_impls = ["semgrep", "gitleaks", "trivy", "osv-scanner", "megalinter", "jscpd", "checkov"]

        self.assertIn("docker", wrapper)
        self.assertIn("check", wrapper)
        self.assertIn("/workspace", wrapper)
        for tool in forbidden_tool_impls:
            self.assertNotIn(tool, wrapper.lower())

    def test_powershell_wrapper_is_thin_and_docker_first(self) -> None:
        wrapper = read("quality-gate.ps1")

        self.assertIn("& docker @RunArgs", wrapper)
        self.assertIn('"check"', wrapper)
        self.assertIn('"/workspace"', wrapper)
        self.assertIn(".quality/reports", wrapper)
        self.assertIn('$RunArgs.Add("--user")', wrapper)
        self.assertIn('$RunArgs.Add("0")', wrapper)
        self.assertIn('$RunArgs.Add("QUALITY_GATE_SCOPE=full")', wrapper)

    def test_npm_package_includes_bundled_sidecar_build_context(self) -> None:
        package = json.loads(read("package.json"))

        self.assertEqual(package["bin"], {"quality-gate": "bin/quality-gate.js"})
        self.assertEqual(package["name"], "quality-gate")
        for required in ["Dockerfile", "docker/", "sidecar/", "pyproject.toml", "bin/", "quality-gate.ps1", "tests/"]:
            self.assertIn(required, package["files"])

    def test_python_package_does_not_shadow_the_node_command(self) -> None:
        import tomllib

        scripts = tomllib.loads(read("pyproject.toml"))["project"]["scripts"]

        # The sidecar CLI is quality-sidecar; a Python "quality-gate" script would shadow the Node command on the PATH.
        self.assertEqual(scripts, {"quality-sidecar": "quality_sidecar.cli:entrypoint"})

    def test_documentation_keeps_container_first_contract(self) -> None:
        readme = read("README.md")

        self.assertIn("quality-gate . --scope changed", readme)
        self.assertIn("quality-gate . --scope full", readme)
        self.assertIn("quality-gate . --scope paths", readme)
        self.assertIn("runs it through the quality bridge (`jgates run`)", readme)
        self.assertIn("headless `--json --no-interactive` mode for agents", readme)
        self.assertIn("gitignore-style `!path` re-inclusion", readme)

    def test_duplication_scan_targets_source_code_not_markdown_examples(self) -> None:
        tools = read("sidecar/quality_sidecar/tools.py")
        jscpd_policy = read("sidecar/config/jscpd-ci.json")

        self.assertIn('"**/*.md,**/.quality/**', tools)
        self.assertIn("**/obj/**", tools)
        self.assertIn("**/bin/**", tools)
        self.assertIn('"**/obj/**"', jscpd_policy)
        self.assertIn('"**/bin/**"', jscpd_policy)

    def test_megalinter_uses_the_bundled_eslint_policy(self) -> None:
        tools = read("sidecar/quality_sidecar/tools.py")
        eslint_policy = read("sidecar/config/eslint.config.mjs")
        trusted_megalinter_config = read("sidecar/config/megalinter-ci.yml")

        self.assertIn('"JAVASCRIPT_ES"', tools)
        self.assertIn('"JAVASCRIPT_ES_CONFIG_FILE": "eslint.config.mjs"', tools)
        self.assertIn('"MEGALINTER_CONFIG": MEGALINTER_TRUSTED_CONFIG', tools)
        self.assertIn("js.configs.recommended", eslint_policy)
        self.assertIn('createRequire("/node-deps/package.json")', eslint_policy)
        self.assertIn('"TERRAFORM_TFLINT_RULES_PATH"', tools)
        self.assertIn('"TERRAFORM_TFLINT_CONFIG_FILE"', tools)
        self.assertIn("tflint-ci.hcl", tools)
        self.assertIn("{}", trusted_megalinter_config)

    def test_complementary_skill_does_not_duplicate_deterministic_checks_or_privacy_scans(self) -> None:
        quality_skill = read("skill/quality-gate.md")
        semantic_skill = read_repo("use-jgates-semantic/SKILL.md")
        semantic_rubric = read_repo("semantic-gate/templates/semantic-review-skill.md")

        self.assertIn("Complementary Semantic Quality Review", semantic_rubric)
        self.assertIn("semantic-gate run --scope changed", semantic_skill)
        self.assertIn("\"Review architecture, quality, and risks\" | semantic-gate run", semantic_skill)
        self.assertIn("jgates run --cwd . --scope changed --semantic", semantic_skill)
        self.assertIn("--json --no-interactive", semantic_skill)
        self.assertIn("semantic-gate run --ci", semantic_skill)
        self.assertIn("semantic-gate status", semantic_skill)
        self.assertIn(".jgates.ignore", semantic_skill)
        self.assertIn(".quality-gate.ignore", quality_skill)
        self.assertIn(".semantic-gate.ignore", semantic_skill)
        self.assertIn("The deterministic Quality Gate owns", quality_skill)
        self.assertIn("The Semantic Gate owns reasoning", quality_skill)
        self.assertNotIn("semantic-gate run --scope changed", quality_skill)
        self.assertNotIn("npm test", quality_skill + semantic_skill)
        self.assertNotIn("sanitized quality gate summary", semantic_rubric)


if __name__ == "__main__":
    unittest.main()
