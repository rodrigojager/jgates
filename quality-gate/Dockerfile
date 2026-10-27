# syntax=docker/dockerfile:1.7

ARG MEGALINTER_IMAGE=ghcr.io/oxsecurity/megalinter:v9.6.0@sha256:248e30b43bdfa7ce941fd5e410159da4d69716c68c48a459b08d1760c4625ef5
ARG DOTNET_SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0.302-alpine3.23-amd64@sha256:2073294f05c2676f2e11b1782188654435e77e28adaed77a1138b0ca4693dd3b
ARG GITLEAKS_BUILDER_IMAGE=golang:1.25.7-alpine3.23@sha256:724e212d86d79b45b7ace725b44ff3b6c2684bfd3131c43d5d60441de151d98e
ARG GITLEAKS_INSTALL_VERSION=8.30.1
ARG GITLEAKS_SOURCE_COMMIT=83d9cd684c87d95d656c1458ef04895a7f1cbd8e
ARG GITLEAKS_SOURCE_SHA256=6b2638a733b85619dc80bdf28e84e4fed7e526a761ab5c148fbf67695aea2115
ARG EDITORCONFIG_CHECKER_INSTALL_VERSION=3.7.0
ARG EDITORCONFIG_CHECKER_SOURCE_COMMIT=03db2cca9a525b3831377be1e4696c06fdfef07a
ARG EDITORCONFIG_CHECKER_SOURCE_SHA256=407defd8dd12768adc2ff54e99295470db3ef8b7d78c2b3cca400cd96c9078b3
ARG LS_LINT_INSTALL_VERSION=2.3.1
ARG LS_LINT_SOURCE_COMMIT=b530dd769e259aa9fc546cc3c0098e6a0c82870e
ARG LS_LINT_SOURCE_SHA256=c2ca67a4773ef2f3efa676aef3e1b2cd066f651ab453efcafb71e46a68ca2cb4
ARG PROTOLINT_INSTALL_VERSION=0.56.4
ARG PROTOLINT_SOURCE_COMMIT=67278bf4e14fdfc8bdafef823b8e76eb403ed9ba
ARG PROTOLINT_SOURCE_SHA256=ab090cea85d83f8dcf393dac20f4e5caab937d05ac9cc01bcbdf3d38a80a2ec1
ARG PROTOLINT_GRPC_VERSION=1.79.3

FROM ${DOTNET_SDK_IMAGE} AS dotnet-sdk

# Rebuild the released Go tool sources with a Go patch that fixes
# CVE-2025-68121. Protolint also receives a fixed gRPC version.
FROM ${GITLEAKS_BUILDER_IMAGE} AS gitleaks-builder

ARG GITLEAKS_INSTALL_VERSION
ARG GITLEAKS_SOURCE_COMMIT
ARG GITLEAKS_SOURCE_SHA256
ARG EDITORCONFIG_CHECKER_INSTALL_VERSION
ARG EDITORCONFIG_CHECKER_SOURCE_COMMIT
ARG EDITORCONFIG_CHECKER_SOURCE_SHA256
ARG LS_LINT_INSTALL_VERSION
ARG LS_LINT_SOURCE_COMMIT
ARG LS_LINT_SOURCE_SHA256
ARG PROTOLINT_INSTALL_VERSION
ARG PROTOLINT_SOURCE_COMMIT
ARG PROTOLINT_SOURCE_SHA256
ARG PROTOLINT_GRPC_VERSION

ENV GOTOOLCHAIN=local

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eux; \
    apk add --no-cache ca-certificates curl git tar; \
    mkdir -p /src /out; \
    fetch_source() { \
      name="$1"; \
      repository="$2"; \
      commit="$3"; \
      expected_sha256="$4"; \
      archive="/tmp/${name}-source.tar.gz"; \
      curl -sSfL "https://github.com/${repository}/archive/${commit}.tar.gz" -o "${archive}"; \
      printf '%s  %s\n' "${expected_sha256}" "${archive}" | sha256sum -c -; \
      mkdir -p "/src/${name}"; \
      tar -xzf "${archive}" -C "/src/${name}" --strip-components=1; \
    }; \
    fetch_source gitleaks gitleaks/gitleaks "${GITLEAKS_SOURCE_COMMIT}" "${GITLEAKS_SOURCE_SHA256}"; \
    fetch_source editorconfig-checker editorconfig-checker/editorconfig-checker "${EDITORCONFIG_CHECKER_SOURCE_COMMIT}" "${EDITORCONFIG_CHECKER_SOURCE_SHA256}"; \
    fetch_source ls-lint loeffel-io/ls-lint "${LS_LINT_SOURCE_COMMIT}" "${LS_LINT_SOURCE_SHA256}"; \
    fetch_source protolint yoheimuta/protolint "${PROTOLINT_SOURCE_COMMIT}" "${PROTOLINT_SOURCE_SHA256}"; \
    cd /src/gitleaks; \
    go mod download; \
    CGO_ENABLED=0 go build \
      -trimpath \
      -tags gore2regex \
      -ldflags "-s -w -buildid= -X=github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_INSTALL_VERSION}" \
      -o /out/gitleaks \
      ./main.go; \
    test "$(/out/gitleaks version | head -n 1)" = "${GITLEAKS_INSTALL_VERSION}"; \
    cd /src/editorconfig-checker; \
    go mod download; \
    CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o /out/editorconfig-checker ./cmd/editorconfig-checker; \
    test "$(/out/editorconfig-checker --version)" = "v${EDITORCONFIG_CHECKER_INSTALL_VERSION}"; \
    cd /src/ls-lint; \
    go mod download; \
    CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags "-s -w -X=main.Version=v${LS_LINT_INSTALL_VERSION}" \
      -o /out/ls-lint \
      ./cmd/ls_lint; \
    test "$(/out/ls-lint --version | head -n 1)" = "ls-lint v${LS_LINT_INSTALL_VERSION}"; \
    cd /src/protolint; \
    go mod edit -require="google.golang.org/grpc@v${PROTOLINT_GRPC_VERSION}"; \
    go mod tidy; \
    CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags "-s -w -X=github.com/yoheimuta/protolint/internal/cmd.version=v${PROTOLINT_INSTALL_VERSION}" \
      -o /out/protolint \
      ./cmd/protolint; \
    test "$(/out/protolint version)" = "protolint version v${PROTOLINT_INSTALL_VERSION}(latest)"; \
    go version -m /out/protolint | grep -E "dep[[:space:]]+google.golang.org/grpc[[:space:]]+v${PROTOLINT_GRPC_VERSION}"; \
    for binary in gitleaks editorconfig-checker ls-lint protolint; do \
      go version -m "/out/${binary}" | grep -F ': go1.25.7'; \
    done

# The portable image is the default. CI passes the pinned dotnetweb image and
# QUALITY_GATE_FLAVOR=dotnetweb for the narrower .NET/web publication.
FROM ${MEGALINTER_IMAGE}

USER root

ARG TARGETARCH=amd64
ARG QUALITY_GATE_FLAVOR=generic
ARG CHECKOV_INSTALL_VERSION=3.3.8
ARG JSCPD_INSTALL_VERSION=5.0.12
ARG SEMGREP_INSTALL_VERSION=1.170.0
ARG TRIVY_INSTALL_VERSION=0.72.0
ARG TRIVY_INSTALL_SHA256=bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea
ARG GITLEAKS_INSTALL_VERSION
ARG OSV_SCANNER_INSTALL_VERSION=2.4.0
ARG OSV_SCANNER_INSTALL_SHA256=15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0
ARG EDITORCONFIG_CHECKER_INSTALL_VERSION=3.7.0
ARG LS_LINT_INSTALL_VERSION=2.3.1
ARG PROTOLINT_INSTALL_VERSION=0.56.4
ARG PROTOLINT_GRPC_VERSION=1.79.3
ARG WEBSOCKET_DRIVER_INSTALL_VERSION=0.7.5
ARG WEBSOCKET_DRIVER_INSTALL_SHA256=54755bff23a142069c08d2cfee75e38a64e79e49cbe7d1c48857b65482ab0b56
ARG NPM_TAR_INSTALL_VERSION=7.5.19
ARG NPM_TAR_INSTALL_SHA256=191644f88c7dbd61121f913231ab328d1fc621f058e8ca334451b17cad85dfae

LABEL org.opencontainers.image.source="https://github.com/rodrigojager/jgates" \
      org.opencontainers.image.description="Deterministic Quality Gate for local and GitLab CI execution" \
      org.opencontainers.image.licenses="MIT" \
      io.jgates.quality-gate.flavor="${QUALITY_GATE_FLAVOR}" \
      io.jgates.quality-gate.platform="linux/amd64"

# One version label per scanner the image carries: `jgates tools prepare` reads org.jgates.tool.<tool>.version to pin
# the image and the version of each JGates adapter that runs in it (Gitleaks, Trivy, OSV-Scanner, Checkov) in
# .jgates/lock.json. The values are the build arguments the install steps below check.
LABEL org.jgates.tool.gitleaks.version="${GITLEAKS_INSTALL_VERSION}" \
      org.jgates.tool.trivy.version="${TRIVY_INSTALL_VERSION}" \
      org.jgates.tool.osv-scanner.version="${OSV_SCANNER_INSTALL_VERSION}" \
      org.jgates.tool.checkov.version="${CHECKOV_INSTALL_VERSION}" \
      org.jgates.tool.semgrep.version="${SEMGREP_INSTALL_VERSION}" \
      org.jgates.tool.jscpd.version="${JSCPD_INSTALL_VERSION}"

RUN set -eux; \
    test "${TARGETARCH}" = "amd64"; \
    case "${QUALITY_GATE_FLAVOR}" in generic|dotnetweb) ;; *) exit 1 ;; esac; \
    mkdir -p /etc/jgates; \
    printf '%s\n' "${QUALITY_GATE_FLAVOR}" > /etc/jgates/quality-gate-flavor; \
    : > /etc/jgates/quality-gate-transport.env; \
    chown root:root /etc/jgates/quality-gate-flavor; \
    chown root:root /etc/jgates/quality-gate-transport.env; \
    chmod 0444 /etc/jgates/quality-gate-flavor; \
    chmod 0444 /etc/jgates/quality-gate-transport.env

RUN apk upgrade --no-cache \
  && apk add --no-cache \
    ca-certificates \
    bash \
    curl \
    git \
    gzip \
    jq \
    nodejs \
    npm \
    python3 \
    py3-pip \
    py3-virtualenv \
    tar \
    unzip \
  && rm -rf /usr/lib/dotnet /usr/share/dotnet \
  && rm -f /usr/bin/dotnet

# Alpine's package repository can briefly expose runtime and SDK packages from
# different servicing trains. Replace that set with Microsoft's coherent,
# digest-pinned SDK/runtime image (SDK 10.0.302 + security runtime 10.0.10).
COPY --from=dotnet-sdk --chown=0:0 /usr/share/dotnet /usr/share/dotnet
RUN set -eux; \
    ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet; \
    test "$(dotnet --version)" = "10.0.302"; \
    test "$(dotnet --list-runtimes | awk '$1 == "Microsoft.NETCore.App" {print $2; exit}')" = "10.0.10"; \
    test "$(dotnet --info | awk -F: '/^[[:space:]]*RID:/ {gsub(/[[:space:]]/, "", $2); print $2; exit}')" = "linux-musl-x64"

# MegaLinter v9.6 ships hadolint as mode 0777. A non-root merge request could
# otherwise replace that executable before another analyzer resolves it.
RUN set -eux; \
    test -f /usr/bin/hadolint; \
    chown root:root /usr/bin/hadolint; \
    chmod 0555 /usr/bin/hadolint; \
    test "$(stat -c '%u:%g:%a' /usr/bin/hadolint)" = "0:0:555"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Gherkin Lint and TSQLLint have no released version that fixes their inherited
# critical dependencies. Remove them from both flavors instead of publishing
# known-vulnerable dormant runtimes. SQLFluff remains available for SQL.
RUN set -eux; \
    test -d /usr/local/dotnet-tools/.store/tsqllint; \
    rm -rf \
      /usr/local/dotnet-tools/.store/tsqllint \
      /usr/local/dotnet-tools/tsqllint; \
    test -d /node-deps/node_modules/gherkin-lint; \
    test -d /node-deps/node_modules/protobufjs; \
    test "$(node -p 'require("/node-deps/node_modules/protobufjs/package.json").version')" = "6.11.6"; \
    npm pkg delete 'dependencies.gherkin-lint' --prefix /node-deps; \
    rm -rf \
      /node-deps/node_modules/gherkin-lint \
      /node-deps/node_modules/gherkin \
      /node-deps/node_modules/cucumber-messages \
      /node-deps/node_modules/protobufjs; \
    node -e 'const p = require("/node-deps/package.json"); if (p.dependencies?.["gherkin-lint"]) process.exit(1)'; \
    test ! -e /usr/local/dotnet-tools/.store/tsqllint; \
    test ! -e /node-deps/node_modules/gherkin-lint; \
    test ! -e /node-deps/node_modules/protobufjs

# Salesforce CLI still carries websocket-driver 0.7.4 in the generic base.
# Replace every inherited copy with the fixed, checksum-pinned npm artifact.
RUN set -eux; \
    websocket_archive=/tmp/websocket-driver.tgz; \
    curl -sSfL \
      "https://registry.npmjs.org/websocket-driver/-/websocket-driver-${WEBSOCKET_DRIVER_INSTALL_VERSION}.tgz" \
      -o "${websocket_archive}"; \
    printf '%s  %s\n' "${WEBSOCKET_DRIVER_INSTALL_SHA256}" "${websocket_archive}" | sha256sum -c -; \
    mapfile -t websocket_manifests < <(find /node-deps /usr/local/share/sf -path '*/websocket-driver/package.json' -print 2>/dev/null || true); \
    for manifest in "${websocket_manifests[@]}"; do \
      installed_version="$(node -p 'require(process.argv[1]).version' "${manifest}")"; \
      case "${installed_version}" in \
        "${WEBSOCKET_DRIVER_INSTALL_VERSION}") continue ;; \
        0.7.4) ;; \
        *) echo "Unexpected websocket-driver version ${installed_version} at ${manifest}" >&2; exit 1 ;; \
      esac; \
      package_dir="${manifest%/package.json}"; \
      rm -rf "${package_dir}"; \
      mkdir -p "${package_dir}"; \
      tar -xzf "${websocket_archive}" -C "${package_dir}" --strip-components=1; \
    done; \
    rm "${websocket_archive}"; \
    mapfile -t websocket_manifests < <(find /node-deps /usr/local/share/sf -path '*/websocket-driver/package.json' -print 2>/dev/null || true); \
    for manifest in "${websocket_manifests[@]}"; do \
      test "$(node -p 'require(process.argv[1]).version' "${manifest}")" = "${WEBSOCKET_DRIVER_INSTALL_VERSION}"; \
    done

# Install the rebuilt Go tools only in the portable flavor. The dotnetweb base
# remains deliberately narrow and removes analyzers outside its allowlist.
RUN --mount=from=gitleaks-builder,source=/out,target=/opt/patched-go-tools,readonly \
    set -eux; \
    rm -f /usr/bin/gitleaks; \
    install -o root -g root -m 0555 /opt/patched-go-tools/gitleaks /usr/local/bin/gitleaks; \
    if [[ "${QUALITY_GATE_FLAVOR}" == "dotnetweb" ]]; then \
      for unused_binary in editorconfig-checker kubeconform ls-lint protolint; do \
        rm -f "/usr/bin/${unused_binary}"; \
        ! command -v "${unused_binary}"; \
      done; \
    else \
      for binary in editorconfig-checker ls-lint protolint; do \
        install -o root -g root -m 0555 \
          "/opt/patched-go-tools/${binary}" \
          "/usr/bin/${binary}"; \
      done; \
    fi; \
    test "$(stat -c '%u:%g:%a' /usr/local/bin/gitleaks)" = "0:0:555"

# MegaLinter v9.6's dotnet-format adapter mirrors output to /dev/tty2, which
# is intentionally unavailable to the non-root production user. Both flavors
# can auto-detect C#, so patch the reviewed upstream file in both and refuse to
# continue if its digest or exact source line changes.
RUN set -eux; \
    adapter=/megalinter/linters/DotnetFormatLinter.py; \
    printf '%s  %s\n' \
      'aa3808d2dbb71e8522c274ace56b86bddbd6e41e8c93e1626fe8c0693c5ab72a' \
      "${adapter}" | sha256sum -c -; \
    test "$(grep -Fxc '            dotnet_format_command + " | tee /dev/tty2 2>&1",' "${adapter}")" = "1"; \
    sed -i 's# | tee /dev/tty2 2>&1# | tee /dev/stderr 2>\&1#' "${adapter}"; \
    test "$(grep -Fxc '            dotnet_format_command + " | tee /dev/stderr 2>&1",' "${adapter}")" = "1"; \
    ! grep -F 'tee /dev/tty2' "${adapter}"

ENV DOTNET_ROOT=/usr/share/dotnet \
    PATH="/usr/local/bin:${PATH}"

# Preserve the base flavor's analyzer paths without trusting PATH supplied by
# a GitLab job. The launcher reads only this root-owned snapshot.
RUN set -eux; \
    quality_gate_path=""; \
    append_trusted_path() { \
      candidate="$1"; \
      case "${candidate}" in /*) ;; *) return 0 ;; esac; \
      case "${candidate}" in /root|/root/*) return 0 ;; esac; \
      canonical="$(readlink -f "${candidate}")" || return 0; \
      test -d "${canonical}" || return 0; \
      case "${canonical}" in /root|/root/*) return 0 ;; esac; \
      current="${canonical}"; \
      while [[ "${current}" != "/" ]]; do \
        [[ "$(stat -c '%u:%g' "${current}")" == "0:0" ]] || return 0; \
        case "$(stat -c '%a' "${current}")" in [0-7][0145][15]) ;; *) return 0 ;; esac; \
        current="${current%/*}"; \
        [[ -n "${current}" ]] || current="/"; \
      done; \
      case ":${quality_gate_path}:" in *:"${canonical}":*) return 0 ;; esac; \
      quality_gate_path="${quality_gate_path:+${quality_gate_path}:}${canonical}"; \
    }; \
    append_trusted_path /usr/local/bin; \
    append_trusted_path /usr/local/dotnet-tools; \
    append_trusted_path /usr/local/composer/vendor/bin; \
    append_trusted_path /usr/local/cargo/bin; \
    IFS=: read -r -a base_path_entries <<< "${PATH}"; \
    for path_entry in "${base_path_entries[@]}"; do \
      append_trusted_path "${path_entry}"; \
    done; \
    test -n "${quality_gate_path}"; \
    [[ "${quality_gate_path}" != *$'\n'* && "${quality_gate_path}" != *$'\r'* ]]; \
    case ":${quality_gate_path}:" in *:/usr/local/bin:*) ;; *) exit 1 ;; esac; \
    case "${quality_gate_path}" in *'~'*|*'/root/'*) exit 1 ;; esac; \
    printf '%s\n' "${quality_gate_path}" > /etc/jgates/quality-gate-path; \
    chown root:root /etc/jgates/quality-gate-path; \
    chmod 0444 /etc/jgates/quality-gate-path

# Semgrep and Checkov have overlapping but incompatible Python dependency
# graphs. Keep them isolated from one another and from MegaLinter's runtime.
RUN set -eux; \
    python3 -m venv /opt/venvs/semgrep; \
    /opt/venvs/semgrep/bin/pip install --no-cache-dir "semgrep==${SEMGREP_INSTALL_VERSION}"; \
    /opt/venvs/semgrep/bin/pip check; \
    ln -sf /opt/venvs/semgrep/bin/semgrep /usr/local/bin/semgrep

RUN set -eux; \
    python3 -m venv /opt/venvs/checkov; \
    /opt/venvs/checkov/bin/pip install --no-cache-dir "checkov==${CHECKOV_INSTALL_VERSION}"; \
    /opt/venvs/checkov/bin/pip check; \
    ln -sf /opt/venvs/checkov/bin/checkov /usr/local/bin/checkov

RUN set -eux; \
  version="${TRIVY_INSTALL_VERSION#v}"; \
  release_arch="64bit"; \
  artifact="trivy_${version}_Linux-${release_arch}.tar.gz"; \
  curl -sSfL \
    "https://github.com/aquasecurity/trivy/releases/download/v${version}/${artifact}" \
    -o "/tmp/${artifact}"; \
  printf '%s  %s\n' "${TRIVY_INSTALL_SHA256}" "/tmp/${artifact}" | sha256sum -c -; \
  tar -xzf "/tmp/${artifact}" -C /usr/local/bin trivy; \
  chmod +x /usr/local/bin/trivy; \
  rm "/tmp/${artifact}"

RUN set -eux; \
  version="${OSV_SCANNER_INSTALL_VERSION#v}"; \
  release_arch="amd64"; \
  curl -sSfL \
    "https://github.com/google/osv-scanner/releases/download/v${version}/osv-scanner_linux_${release_arch}" \
    -o /usr/local/bin/osv-scanner; \
  printf '%s  %s\n' "${OSV_SCANNER_INSTALL_SHA256}" /usr/local/bin/osv-scanner | sha256sum -c -; \
  chmod +x /usr/local/bin/osv-scanner

RUN set -eux; \
    npm install -g "jscpd@${JSCPD_INSTALL_VERSION}"; \
    npm cache clean --force

WORKDIR /opt/quality-sidecar
COPY pyproject.toml /opt/quality-sidecar/pyproject.toml
COPY sidecar /opt/quality-sidecar/sidecar
COPY docker/entrypoint.sh /opt/quality-sidecar/entrypoint.sh
RUN set -eux; \
    chmod +x /opt/quality-sidecar/entrypoint.sh; \
    python3 -m venv /opt/venvs/quality-sidecar; \
    /opt/venvs/quality-sidecar/bin/pip install --no-cache-dir /opt/quality-sidecar; \
    /opt/venvs/quality-sidecar/bin/pip check; \
    ln -sf /opt/venvs/quality-sidecar/bin/quality-sidecar /usr/local/bin/quality-sidecar; \
    chown -R root:root /opt/quality-sidecar; \
    chmod -R go-w /opt/quality-sidecar

# Salesforce CLI bundles npm tar 7.5.16 twice. Patch both copies from the
# checksum-pinned 7.5.19 package that fixes CVE-2026-59873.
RUN set -eux; \
    if [[ "${QUALITY_GATE_FLAVOR}" == "generic" ]]; then \
      npm_tar_archive=/tmp/npm-tar.tgz; \
      curl -sSfL \
        "https://registry.npmjs.org/tar/-/tar-${NPM_TAR_INSTALL_VERSION}.tgz" \
        -o "${npm_tar_archive}"; \
      printf '%s  %s\n' "${NPM_TAR_INSTALL_SHA256}" "${npm_tar_archive}" | sha256sum -c -; \
      mapfile -t npm_tar_manifests < <(find /node-deps/node_modules/@salesforce/cli -path '*/tar/package.json' -print); \
      patched_count=0; \
      for manifest in "${npm_tar_manifests[@]}"; do \
        installed_version="$(node -p 'require(process.argv[1]).version' "${manifest}")"; \
        case "${installed_version}" in \
          "${NPM_TAR_INSTALL_VERSION}") continue ;; \
          7.5.16) ;; \
          *) continue ;; \
        esac; \
        package_dir="${manifest%/package.json}"; \
        rm -rf "${package_dir}"; \
        mkdir -p "${package_dir}"; \
        tar -xzf "${npm_tar_archive}" -C "${package_dir}" --strip-components=1; \
        patched_count=$((patched_count + 1)); \
      done; \
      test "${patched_count}" -eq 2; \
      rm "${npm_tar_archive}"; \
      test "$(node -p 'require("/node-deps/node_modules/@salesforce/cli/node_modules/tar/package.json").version')" = "${NPM_TAR_INSTALL_VERSION}"; \
      test "$(node -p 'require("/node-deps/node_modules/@salesforce/cli/node_modules/npm/node_modules/tar/package.json").version')" = "${NPM_TAR_INSTALL_VERSION}"; \
    fi

# The generic v9.6 base also carries arm-ttk as mode 0777.
RUN set -eux; \
    if test -f /usr/bin/arm-ttk; then \
      arm_ttk_target="$(readlink -f /usr/bin/arm-ttk)"; \
      chown root:root "${arm_ttk_target}"; \
      chmod 0555 "${arm_ttk_target}"; \
      test "$(stat -c '%u:%g:%a' "${arm_ttk_target}")" = "0:0:555"; \
    fi

# Build-time smoke tests prove that every pinned executable starts and that
# each isolated Python environment is internally consistent.
RUN set -eux; \
    /opt/venvs/quality-sidecar/bin/pip check; \
    /opt/venvs/semgrep/bin/pip check; \
    /opt/venvs/checkov/bin/pip check; \
    quality-sidecar --help >/dev/null; \
    test "$(/opt/venvs/semgrep/bin/python -c 'import importlib.metadata as m; print(m.version("semgrep"))')" = "${SEMGREP_INSTALL_VERSION}"; \
    /opt/venvs/semgrep/bin/semgrep --version >/dev/null; \
    test "$(/opt/venvs/checkov/bin/python -c 'import importlib.metadata as m; print(m.version("checkov"))')" = "${CHECKOV_INSTALL_VERSION}"; \
    /opt/venvs/checkov/bin/checkov --version >/dev/null; \
    test "$(gitleaks version | head -n 1)" = "${GITLEAKS_INSTALL_VERSION}"; \
    test "$(trivy --version | awk -F ': ' '/^Version:/ {print $2; exit}')" = "${TRIVY_INSTALL_VERSION}"; \
    test "$(osv-scanner --version | awk '/^osv-scanner version:/ {print $3; exit}')" = "${OSV_SCANNER_INSTALL_VERSION}"; \
    test "$(node -p 'require("/usr/local/lib/node_modules/jscpd/package.json").version')" = "${JSCPD_INSTALL_VERSION}"; \
    test "$(command -v jscpd)" = "/usr/local/bin/jscpd"; \
    test "$(jscpd --version)" = "cpd ${JSCPD_INSTALL_VERSION}"; \
    printf '%s  %s\n' \
      '54ccd8bc063777753f3f55b8d61cd85c6fa972c140729ad939225ee60db94d20' \
      /megalinter/linters/DotnetFormatLinter.py | sha256sum -c -; \
    test "$(stat -c '%u:%g:%a' /megalinter/linters/DotnetFormatLinter.py)" = "0:0:644"; \
    test ! -e /usr/local/dotnet-tools/.store/tsqllint; \
    test ! -e /node-deps/node_modules/gherkin-lint; \
    test ! -e /node-deps/node_modules/protobufjs; \
    mapfile -t websocket_manifests < <(find /node-deps /usr/local/share/sf -path '*/websocket-driver/package.json' -print 2>/dev/null || true); \
    for manifest in "${websocket_manifests[@]}"; do \
      test "$(node -p 'require(process.argv[1]).version' "${manifest}")" = "${WEBSOCKET_DRIVER_INSTALL_VERSION}"; \
    done; \
    if [[ "${QUALITY_GATE_FLAVOR}" == "dotnetweb" ]]; then \
      test "$(command -v csharpier)" = "/usr/local/dotnet-tools/csharpier"; \
      test "$(command -v roslynator)" = "/usr/local/dotnet-tools/roslynator"; \
      csharpier --version >/dev/null; \
      roslynator --version >/dev/null; \
      for unused_binary in editorconfig-checker kubeconform ls-lint protolint tsqllint; do \
        ! command -v "${unused_binary}"; \
      done; \
    else \
      for tool in csharpier devskim roslynator; do \
        test "$(command -v "${tool}")" = "/usr/local/dotnet-tools/${tool}"; \
        "${tool}" --version >/dev/null; \
      done; \
      for tool in phpcs phpstan psalm phplint php-cs-fixer; do \
        test "$(command -v "${tool}")" = "/usr/local/composer/vendor/bin/${tool}"; \
        "${tool}" --version >/dev/null; \
      done; \
      test "$(command -v cargo-clippy)" = "/usr/local/bin/cargo-clippy"; \
      cargo-clippy --version >/dev/null; \
      test "$(editorconfig-checker --version)" = "v${EDITORCONFIG_CHECKER_INSTALL_VERSION}"; \
      test "$(ls-lint --version | head -n 1)" = "ls-lint v${LS_LINT_INSTALL_VERSION}"; \
      test "$(protolint version)" = "protolint version v${PROTOLINT_INSTALL_VERSION}(latest)"; \
      go version -m /usr/bin/protolint | grep -E "dep[[:space:]]+google.golang.org/grpc[[:space:]]+v${PROTOLINT_GRPC_VERSION}"; \
      for binary in editorconfig-checker ls-lint protolint; do \
        go version -m "/usr/bin/${binary}" | grep -F ': go1.25.7'; \
      done; \
    fi; \
    test "$(stat -c '%u:%g:%a' /node-deps/package.json)" = "0:0:644"; \
    test "$(stat -c '%u:%g:%a' /node-deps/node_modules/@eslint/js/package.json)" = "0:0:644"; \
    test "$(node -e 'const { createRequire } = require("node:module"); const trustedRequire = createRequire("/node-deps/package.json"); process.stdout.write(trustedRequire.resolve("@eslint/js"));')" = "/node-deps/node_modules/@eslint/js/src/index.js"; \
    node --input-type=module -e 'await import("/opt/quality-sidecar/sidecar/config/eslint.config.mjs")'; \
    if [[ "${QUALITY_GATE_FLAVOR}" == "generic" ]]; then \
      tflint_smoke_dir="$(mktemp -d)"; \
      printf '%s\n' 'terraform {' '  required_version = ">= 1.5.0"' '}' > "${tflint_smoke_dir}/main.tf"; \
      tflint --config /opt/quality-sidecar/sidecar/config/tflint-ci.hcl --chdir "${tflint_smoke_dir}" --format compact; \
      rm "${tflint_smoke_dir}/main.tf"; \
      rmdir "${tflint_smoke_dir}"; \
    fi; \
    test -x /entrypoint.sh; \
    test -x /opt/quality-sidecar/entrypoint.sh; \
    test "$(stat -c '%u:%g:%a' /usr/local/bin/gitleaks)" = "0:0:555"; \
    test ! -e /usr/bin/gitleaks; \
    test "$(stat -c '%u:%g:%a' /etc/jgates/quality-gate-flavor)" = "0:0:444"; \
    test "$(stat -c '%u:%g:%a' /etc/jgates/quality-gate-path)" = "0:0:444"; \
    test "$(stat -c '%u:%g:%a' /etc/jgates/quality-gate-transport.env)" = "0:0:444"; \
    test -s /etc/jgates/quality-gate-path; \
    for config in \
      eslint.config.mjs \
      megalinter-ci.yml \
      checkov-ci.yml \
      gitleaks-ci.toml \
      gitleaksignore-ci \
      jscpd-ci.json \
      osv-scanner-ci.toml \
      tflint-ci.hcl \
      trivy-ci.yaml \
      trivyignore-ci; do \
        path="/opt/quality-sidecar/sidecar/config/${config}"; \
        test -r "${path}"; \
        test "$(stat -c '%u:%g' "${path}")" = "0:0"; \
        case "$(stat -c '%a' "${path}")" in [0-7][0145][0145]) ;; *) exit 1 ;; esac; \
    done

RUN addgroup -S -g 10001 quality \
  && adduser -S -D -u 10001 -h /home/quality -G quality quality \
  && mkdir -p /home/quality/.cache /workspace \
  && chown -R quality:quality /home/quality /workspace \
  && if [[ "${QUALITY_GATE_FLAVOR}" == "dotnetweb" ]]; then \
       su quality -s /bin/sh -c '/usr/local/dotnet-tools/csharpier --version >/dev/null'; \
       su quality -s /bin/sh -c '/usr/local/dotnet-tools/roslynator --version >/dev/null'; \
     else \
       for tool in csharpier devskim roslynator; do \
         su quality -s /bin/sh -c "/usr/local/dotnet-tools/${tool} --version >/dev/null"; \
       done; \
       for tool in phpcs phpstan psalm phplint php-cs-fixer; do \
         su quality -s /bin/sh -c "/usr/local/composer/vendor/bin/${tool} --version >/dev/null"; \
       done; \
       su quality -s /bin/sh -c '/usr/local/bin/cargo-clippy --version >/dev/null'; \
       su quality -s /bin/sh -c '/usr/bin/editorconfig-checker --version >/dev/null'; \
       su quality -s /bin/sh -c '/usr/bin/ls-lint --version >/dev/null'; \
       su quality -s /bin/sh -c '/usr/bin/protolint version >/dev/null'; \
     fi \
  && su quality -s /bin/sh -c '\
       set -eu; \
       trusted_path="$(cat /etc/jgates/quality-gate-path)"; \
       old_ifs=$IFS; IFS=:; \
       for path_dir in $trusted_path; do \
         test -x "$path_dir"; \
         for candidate in "$path_dir"/*; do \
           test -e "$candidate" || continue; \
           test -f "$candidate" || continue; \
           test -x "$candidate" || continue; \
           if test -w "$candidate"; then \
             echo "Trusted executable is writable by the quality user: $candidate" >&2; \
             exit 1; \
           fi; \
         done; \
       done; \
       IFS=$old_ifs'

ENV HOME=/home/quality \
    XDG_CACHE_HOME=/home/quality/.cache \
    DOTNET_CLI_HOME=/home/quality \
    DOTNET_CLI_TELEMETRY_OPTOUT=true \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false \
    DOTNET_NOLOGO=true \
    DOTNET_RUNNING_IN_CONTAINER=true \
    NUGET_HTTP_CACHE_PATH=/home/quality/.cache/NuGet/v3-cache \
    NUGET_PACKAGES=/home/quality/.nuget/packages

WORKDIR /workspace
USER quality
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD /opt/venvs/quality-sidecar/bin/python -c "import quality_sidecar" || exit 1
ENTRYPOINT ["/opt/quality-sidecar/entrypoint.sh"]
CMD ["check", "/workspace"]
