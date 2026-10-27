#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: image-smoke.sh IMAGE [quick|tool-error|full-clean|full-finding|all]}"
scenario="${2:-all}"

run_toolchain_and_non_root_smoke() {
  docker run --rm --entrypoint bash "$image" -ceu '
    test "$(id -u)" = "10001"
    trusted_path="$(< /etc/jgates/quality-gate-path)"
    case "$trusted_path" in
      ""|*"~"*|*"/root/"*|:*|*::*|*:) exit 1 ;;
    esac
    IFS=: read -r -a trusted_path_entries <<< "$trusted_path"
    for path_dir in "${trusted_path_entries[@]}"; do
      case "$path_dir" in /*) ;; *) exit 1 ;; esac
      test -d "$path_dir"
      test "$(/usr/bin/readlink -f "$path_dir")" = "$path_dir"
      test "$(/bin/stat -c "%u:%g" "$path_dir")" = "0:0"
      case "$(/bin/stat -c "%a" "$path_dir")" in [0-7][0145][15]) ;; *) exit 1 ;; esac
      test -x "$path_dir"
      for candidate in "$path_dir"/*; do
        test -e "$candidate" || continue
        test -f "$candidate" || continue
        test -x "$candidate" || continue
        test ! -w "$candidate"
      done
    done
    shadow=/tmp/quality-path-shadow
    mkdir -p "$shadow/~/.raku/bin"
    printf "%s\n" "#!/bin/sh" "exit 97" > "$shadow/~/.raku/bin/java"
    chmod +x "$shadow/~/.raku/bin/java"
    (
      cd "$shadow"
      PATH="$trusted_path" /opt/venvs/quality-sidecar/bin/python -c \
        '"'"'import pathlib, shutil; resolved = shutil.which("java"); assert resolved and pathlib.Path(resolved).is_absolute(); assert "quality-path-shadow" not in resolved'"'"'
    )
    test -r /opt/quality-sidecar/sidecar/config/eslint.config.mjs
    test -r /opt/quality-sidecar/sidecar/config/megalinter-ci.yml
    /opt/venvs/quality-sidecar/bin/pip check
    /opt/venvs/semgrep/bin/pip check
    /opt/venvs/checkov/bin/pip check
    for tool in quality-sidecar semgrep checkov gitleaks trivy osv-scanner jscpd; do
      command -v "$tool" >/dev/null
    done
    test "$(command -v jscpd)" = "/usr/local/bin/jscpd"
    test "$(jscpd --version)" = "cpd 5.0.12"
    test ! -e /usr/local/dotnet-tools/.store/tsqllint
    ! command -v tsqllint
    test ! -e /node-deps/node_modules/gherkin-lint
    test ! -e /node-deps/node_modules/protobufjs
    if test "$(< /etc/jgates/quality-gate-flavor)" = "dotnetweb"; then
      test "$(command -v csharpier)" = "/usr/local/dotnet-tools/csharpier"
      test "$(command -v roslynator)" = "/usr/local/dotnet-tools/roslynator"
      csharpier --version >/dev/null
      roslynator --version >/dev/null
    else
      test "$(editorconfig-checker --version)" = "v3.7.0"
      test "$(ls-lint --version | head -n 1)" = "ls-lint v2.3.1"
      test "$(protolint version)" = "protolint version v0.56.4(latest)"
      go version -m /usr/bin/protolint | grep -E "dep[[:space:]]+google.golang.org/grpc[[:space:]]+v1.79.3"
      for tool in csharpier devskim roslynator; do
        test "$(command -v "$tool")" = "/usr/local/dotnet-tools/$tool"
        "$tool" --version >/dev/null
      done
      for tool in phpcs phpstan psalm phplint php-cs-fixer; do
        test "$(command -v "$tool")" = "/usr/local/composer/vendor/bin/$tool"
        "$tool" --version >/dev/null
      done
      test "$(command -v cargo-clippy)" = "/usr/local/bin/cargo-clippy"
      cargo-clippy --version >/dev/null
      cargo_smoke=/tmp/quality-cargo-smoke
      mkdir -p "$cargo_smoke/src"
      printf "%s\n" \
        "[package]" \
        "name = \"quality-gate-smoke\"" \
        "version = \"0.1.0\"" \
        "edition = \"2024\"" \
        "" \
        "[lib]" \
        "path = \"src/lib.rs\"" > "$cargo_smoke/Cargo.toml"
      printf "%s\n" "pub fn answer() -> u32 { 42 }" > "$cargo_smoke/src/lib.rs"
      PATH="$trusted_path" cargo clippy --manifest-path "$cargo_smoke/Cargo.toml" -- -D warnings >/dev/null
    fi
    test "$(node -e '"'"'const { createRequire } = require("node:module"); const trustedRequire = createRequire("/node-deps/package.json"); process.stdout.write(trustedRequire.resolve("@eslint/js"));'"'"')" = "/node-deps/node_modules/@eslint/js/src/index.js"
    node --input-type=module -e '"'"'await import("/opt/quality-sidecar/sidecar/config/eslint.config.mjs")'"'"'

    test "$(stat -c "%u:%g:%a" /etc/jgates/quality-gate-flavor)" = "0:0:444"
    test "$(stat -c "%u:%g:%a" /etc/jgates/quality-gate-path)" = "0:0:444"
    test "$(stat -c "%u:%g:%a" /etc/jgates/quality-gate-transport.env)" = "0:0:444"
    test "$(stat -c "%u:%g" /opt/quality-sidecar/sidecar/config)" = "0:0"
    test ! -w /opt/quality-sidecar/sidecar/config/megalinter-ci.yml
    if printf "%s\n" "HTTP_PROXY=http://untrusted.invalid" 2>/dev/null > /etc/jgates/quality-gate-transport.env; then
      echo "quality user unexpectedly modified trusted transport" >&2
      exit 1
    fi
    QUALITY_GATE_FLAVOR=invalid QUALITY_SIDECAR_CONFIG_DIR=/tmp/untrusted \
      /opt/venvs/quality-sidecar/bin/python -c "from quality_sidecar.tools import MEGALINTER_CONFIG_DIR, _quality_gate_flavor; assert str(MEGALINTER_CONFIG_DIR) == \"/opt/quality-sidecar/sidecar/config\"; assert _quality_gate_flavor() in {\"generic\", \"dotnetweb\"}"

    printf "%s\n" "const answer = 42;" > /workspace/sample.js
    /opt/quality-sidecar/entrypoint.sh check /workspace \
      --mode quick \
      --format json,md \
      --output /workspace/.quality/reports
    test -s /workspace/.quality/reports/quality-report.json
    test -s /workspace/.quality/reports/quality-report.md
    jq -e ".status == \"APPROVED\"" /workspace/.quality/reports/quality-report.json >/dev/null
  '
}

run_tool_error_smoke() {
  docker run --rm --entrypoint bash "$image" -ceu '
    target=/tmp/quality-tool-error
    mkdir -p "$target"

    set +e
    MEGALINTER_COMMAND=/does-not-exist \
      /opt/quality-sidecar/entrypoint.sh check "$target" \
        --mode full \
        --disable-iac \
        --fail-on-tool-error \
        --format json \
        --output "$target/.quality/reports"
    status=$?
    set -e

    test "$status" = "2"
    report="$target/.quality/reports/quality-report.json"
    jq -e ".status == \"NEEDS_CHANGES\"" "$report" >/dev/null
    jq -e ".summary.toolErrors | index(\"megalinter\") != null" "$report" >/dev/null
  '
}

run_full_finding_smoke() {
  docker run --rm --entrypoint bash "$image" -ceu '
    target=/tmp/quality-full-finding
    flavor=$(cat /etc/jgates/quality-gate-flavor)
    expected_tool_count=7
    mkdir -p "$target/infra/terraform"
    printf "%s\n" "key: [unterminated" > "$target/broken.yaml"
    printf "%s\n" "result = eval(input())" > "$target/sample.py"
    printf "%s\n" \
      "export function summarize (values) {" \
      "  const filtered = values.filter((value) => value > 0)" \
      "  const doubled = filtered.map((value) => value * 2)" \
      "  const total = doubled.reduce((sum, value) => sum + value, 0)" \
      "  const average = doubled.length === 0 ? 0 : total / doubled.length" \
      "  return { count: doubled.length, total, average }" \
      "}" \
      "" \
      "console.log(summarize([1, 2, 3, 4, 5]))" > "$target/duplicate-a.js"
    cp "$target/duplicate-a.js" "$target/duplicate-b.js"
    printf "%s\n" "urllib3==1.26.0" > "$target/requirements.txt"
    printf "%s\n" \
      "resource \"aws_s3_bucket\" \"public\" {" \
      "  bucket = \"quality-gate-smoke-fixture\"" \
      "}" > "$target/infra/terraform/main.tf"
    printf "%s\n" \
      "resource \"aws_s3_bucket_server_side_encryption_configuration\" \"public\" {" \
      "  bucket = aws_s3_bucket.public.id" \
      "  rule {" \
      "    apply_server_side_encryption_by_default {" \
      "      sse_algorithm = \"AES256\"" \
      "    }" \
      "  }" \
      "}" > "$target/infra/terraform/encryption.tf"
    printf "token = \"%s%s\"\n" "ghp_" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" > "$target/synthetic-secret.txt"

    set +e
    /opt/quality-sidecar/entrypoint.sh check "$target" \
      --mode full \
      --enable-secrets \
      --fail-on-tool-error \
      --threshold 100 \
      --format json,md \
      --output "$target/.quality/reports"
    status=$?
    set -e

    test "$status" = "1"
    report="$target/.quality/reports/quality-report.json"
    jq -e ".status == \"REJECTED\"" "$report" >/dev/null
    jq -e ".findings | length > 0" "$report" >/dev/null
    jq -e --argjson expected "$expected_tool_count" "([.tools[] | select(
      .name == \"megalinter\" or
      .name == \"semgrep\" or
      .name == \"gitleaks\" or
      .name == \"trivy\" or
      .name == \"checkov\" or
      .name == \"osv-scanner\" or
      .name == \"jscpd\"
    )] | length) == \$expected" "$report" >/dev/null
    jq -e "[.tools[] | select(.status == \"missing\" or .status == \"error\" or .status == \"timeout\")] | length == 0" "$report" >/dev/null
    jq -e ".tools[] | select(.name == \"jscpd\") | .status == \"findings\" and .summary.findings > 0" "$report" >/dev/null
    jq -e ".findings[] | select(.tool == \"checkov\" and (.path | startswith(\"infra/terraform/\")))" "$report" >/dev/null
  '
}

run_full_clean_smoke() {
  docker run --rm --entrypoint bash "$image" -ceu '
    target=/tmp/quality-full-clean
    flavor=$(cat /etc/jgates/quality-gate-flavor)
    expected_tool_count=7
    mkdir -p "$target/infra/terraform"
    printf "%s\n" "---" "key: value" > "$target/sample.yaml"
    printf "%s\n" \
      "export function summarize (values) {" \
      "  const filtered = values.filter((value) => value > 0)" \
      "  const doubled = filtered.map((value) => value * 2)" \
      "  const total = doubled.reduce((sum, value) => sum + value, 0)" \
      "  const average = doubled.length === 0 ? 0 : total / doubled.length" \
      "  return { count: doubled.length, total, average }" \
      "}" \
      "" \
      "console.log(summarize([1, 2, 3, 4, 5]))" > "$target/sample.js"
    printf "%s\n" "packaging==25.0" > "$target/requirements.txt"
    printf "%s\n" \
      "terraform {" \
      "  required_version = \">= 1.5.0\"" \
      "}" \
      "" \
      "variable \"name\" {" \
      "  type = string" \
      "}" \
      "" \
      "output \"name\" {" \
      "  value = var.name" \
      "}" > "$target/infra/terraform/main.tf"

    printf "%s\n" \
      "<Project Sdk=\"Microsoft.NET.Sdk\">" \
      "  <PropertyGroup>" \
      "    <OutputType>Exe</OutputType>" \
      "    <TargetFramework>net10.0</TargetFramework>" \
      "    <ImplicitUsings>enable</ImplicitUsings>" \
      "    <Nullable>enable</Nullable>" \
      "  </PropertyGroup>" \
      "</Project>" > "$target/Smoke.csproj"
    printf "%s\n" "Console.WriteLine(\"Quality gate smoke.\");" > "$target/Program.cs"

    # DevSkim runs in project mode while other MegaLinter analyzers write
    # reports concurrently. This canary must stay ignored as gate-owned output.
    mkdir -p "$target/.quality"
    printf "%s\n" "http://cyclonedx.org/schema/bom-1.7.schema.json" \
      > "$target/.quality/devskim-ignore-canary.txt"

    set +e
    /opt/quality-sidecar/entrypoint.sh check "$target" \
      --mode full \
      --enable-secrets \
      --fail-on-tool-error \
      --threshold 100 \
      --format json,md \
      --output "$target/.quality/reports"
    gate_status=$?
    set -e

    report="$target/.quality/reports/quality-report.json"
    if test -s "$report"; then
      jq -c ".tools[] | {name, status, exitCode, error, summary}" "$report" >&2 || true
    else
      echo "full-clean did not produce quality-report.json" >&2
    fi
    if test "$gate_status" != "0"; then
      echo "full-clean analyzer diagnostics:" >&2
      find "$target/.quality/reports" -type f -iname "*dotnet*" \
        -print -exec tail -n 200 {} \; >&2 || true
      exit "$gate_status"
    fi
    jq -e ".status == \"APPROVED\" and (.findings | length == 0)" "$report" >/dev/null
    jq -e --argjson expected "$expected_tool_count" "([.tools[] | select(
      .name == \"megalinter\" or
      .name == \"semgrep\" or
      .name == \"gitleaks\" or
      .name == \"trivy\" or
      .name == \"checkov\" or
      .name == \"osv-scanner\" or
      .name == \"jscpd\"
    )] | length) == \$expected" "$report" >/dev/null
    jq -e "[.tools[] | select(.name != \"megalinter\") | .summary.evidenceValid] | all" "$report" >/dev/null
    jq -e "[.tools[] | select(.status == \"missing\" or .status == \"error\" or .status == \"timeout\" or .status == \"skipped\")] | length == 0" "$report" >/dev/null
    jq -e ".statistics.total.sources > 0 and .statistics.total.lines > 0" \
      "$target/.quality/reports/raw/jscpd/jscpd-report.json" >/dev/null
  '
}

case "$scenario" in
  quick)
    run_toolchain_and_non_root_smoke
    ;;
  tool-error)
    run_tool_error_smoke
    ;;
  full-clean)
    run_full_clean_smoke
    ;;
  full-finding)
    run_full_finding_smoke
    ;;
  all)
    run_toolchain_and_non_root_smoke
    run_tool_error_smoke
    run_full_clean_smoke
    run_full_finding_smoke
    ;;
  *)
    echo "Unknown image smoke scenario: $scenario" >&2
    exit 64
    ;;
esac
