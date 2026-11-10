# syntax=docker/dockerfile:1
# The JGates tools image (ADR-0005, PLAN-image.md): every check runs in containers of this one image, which carries the
# Python, TypeScript/JavaScript, Go, Rust and .NET stacks, the cross-stack security, API and runtime tools, and the
# JGates CLI of the same version (in-image mode and helpers). Built only by `npm --prefix jgates run image:build`
# (jgates/scripts/image-build.mjs), which passes the JGates CLI as the named build context `jgates-cli`, the versions as
# build arguments and one org.jgates.tool.<tool>.version label per tool read from the built /etc/jgates/image.json.
#
# Inputs are pinned: the base image by digest; every downloaded archive by its published SHA-256 (SHA-512 for .NET),
# keyed by TARGETARCH (only linux/amd64 is built today: other architectures stop with a message); the Python tools by
# the hashes of their lock files (python/<interpreter>/<tool>.txt, one uv environment per tool); the Node tools by the
# integrity of their package-lock.json (node/<tool>/, one npm prefix per tool); Go tools by module version (verified
# against the Go checksum database); Rust tools with `cargo install --locked`. `update-locks.mjs` regenerates the locks.
# Every tool is smoke-checked against its pin when /etc/jgates/image.json is written (write-image-json.py).
#
# One stage per stack, so a change in one stack only rebuilds its stage; the final stage copies them in from the least
# to the most frequently changed. Never inside: CodeQL, the official Semgrep rules, vulnerability databases, language
# versions other than the defaults, Playwright browsers (PLAN-image.md section 2.6).

ARG BASE_IMAGE=python:3.15-slim-trixie@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

# --- Base and shared runtime (2.1) -----------------------------------------------------------------------------------
# Debian 13 slim + CPython (the default Python). apt verifies every package against Debian's signed archive.
# Packages: sync, history scans and downloads (git, rsync, tini, curl, jq, unzip, xz); native builds of Python, Node and
# Rust dependencies (build-essential, pkg-config, libssl-dev, libffi-dev); shellcheck; the .NET runtime dependencies
# (ICU, Kerberos, zlib); the core libraries of Playwright's Chromium (the full set of the three browsers is added in the
# final stage; browsers come per project, PLAN-dependencies.md).
FROM ${BASE_IMAGE} AS base
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl git rsync tini jq unzip xz-utils \
      build-essential pkg-config libssl-dev libffi-dev \
      shellcheck \
      libicu76 libgssapi-krb5-2 zlib1g \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 \
      libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 libfontconfig1 libfreetype6 fonts-liberation; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /var/log/apt /var/log/dpkg.log

# Downloads happen in stages derived from this one; only the verified results are copied into the final image.
FROM base AS fetch
COPY --chmod=0555 fetch.sh /usr/local/bin/fetch
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in amd64) ;; *) echo "jgates-tools: only linux/amd64 is pinned; no checksums for ${TARGETARCH}" >&2; exit 1 ;; esac

# --- uv (Python installs and the isolated environment of every Python tool) ------------------------------------------
FROM fetch AS uv
ARG UV_VERSION=0.13.7
ARG UV_SHA256_AMD64=c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83
RUN set -eux; \
    triple=x86_64-unknown-linux-gnu; \
    fetch "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.tar.gz" "${UV_SHA256_AMD64}" /tmp/uv.tar.gz; \
    mkdir -p /out; \
    tar -xzf /tmp/uv.tar.gz --strip-components=1 -C /out "uv-${triple}/uv" "uv-${triple}/uvx"; \
    chmod 0555 /out/uv /out/uvx

# --- .NET SDK (current LTS, includes `dotnet format`) ----------------------------------------------------------------
FROM fetch AS dotnet
ARG DOTNET_SDK_VERSION=10.0.403
ARG DOTNET_SDK_SHA512_AMD64=b7b3d8461cf98b07d2552ce9199702fa3ad010ac2671a5f8cd5136f7534e50f6855ba7bbb02b11494563f1d04156276a31cda1103b900e5eecd0d9473dc7b9c5
RUN set -eux; \
    fetch "https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_SDK_VERSION}/dotnet-sdk-${DOTNET_SDK_VERSION}-linux-x64.tar.gz" "${DOTNET_SDK_SHA512_AMD64}" /tmp/dotnet.tar.gz; \
    mkdir -p /usr/share/dotnet; \
    tar -xzf /tmp/dotnet.tar.gz -C /usr/share/dotnet; \
    rm -f /tmp/dotnet.tar.gz; \
    mkdir -p /tmp/dotnet-home; \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 HOME=/tmp/dotnet-home /usr/share/dotnet/dotnet --version; \
    rm -rf /tmp/dotnet-home

# --- Rust stable (rustup, minimal profile) + rustfmt + clippy + llvm-tools (cargo-llvm-cov) --------------------------
FROM fetch AS rust
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_INIT_SHA256_AMD64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUST_VERSION=1.99.1
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
RUN set -eux; \
    fetch "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" "${RUSTUP_INIT_SHA256_AMD64}" /tmp/rustup-init; \
    chmod 0755 /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --no-update-default-toolchain --profile minimal \
      --default-toolchain "${RUST_VERSION}" --component rustfmt --component clippy --component llvm-tools-preview; \
    rm -f /tmp/rustup-init; \
    rm -rf "${CARGO_HOME}/registry" "${CARGO_HOME}/git" "${RUSTUP_HOME}/downloads" "${RUSTUP_HOME}/tmp"; \
    "${CARGO_HOME}/bin/rustc" --version

FROM rust AS rust-tools
ARG CARGO_AUDIT_VERSION=0.22.2
ARG CARGO_LLVM_COV_VERSION=0.9.1
RUN set -eux; \
    PATH="${CARGO_HOME}/bin:${PATH}" CARGO_BUILD_JOBS=4 cargo install --locked --root /out --version "${CARGO_AUDIT_VERSION}" cargo-audit; \
    PATH="${CARGO_HOME}/bin:${PATH}" CARGO_BUILD_JOBS=4 cargo install --locked --root /out --version "${CARGO_LLVM_COV_VERSION}" cargo-llvm-cov; \
    rm -f /out/.crates.toml /out/.crates2.json; \
    strip /out/bin/cargo-audit /out/bin/cargo-llvm-cov

# --- Go toolchain (default) and the Go tools -------------------------------------------------------------------------
FROM fetch AS go
ARG GO_VERSION=1.27.3
ARG GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
RUN set -eux; \
    fetch "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" "${GO_SHA256_AMD64}" /tmp/go.tar.gz; \
    tar -xzf /tmp/go.tar.gz -C /usr/local; \
    rm -f /tmp/go.tar.gz; \
    /usr/local/go/bin/go version

# govulncheck by module version: `go install` verifies every module against the Go checksum database (sum.golang.org).
FROM go AS go-tools
ARG GOVULNCHECK_VERSION=1.9.0
# gitleaks 8.30.1 (the newest release) is published built with Go 1.24.11, whose crypto/tls has a critical CVE fixed in
# 1.24.13 (CVE-2025-68121, found by the image scan gate). Built here from the same module version with the image's Go
# (the build flags of its goreleaser file), the binary carries the fixed standard library.
ARG GITLEAKS_VERSION=8.30.1
RUN set -eux; \
    GOTOOLCHAIN=local GOBIN=/out CGO_ENABLED=0 GOPATH=/tmp/gopath GOCACHE=/tmp/gocache \
      /usr/local/go/bin/go install -trimpath -tags gore2regex \
        -ldflags="-s -w -X=github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_VERSION}" \
        "github.com/zricethezav/gitleaks/v8@v${GITLEAKS_VERSION}"; \
    GOTOOLCHAIN=local GOBIN=/out CGO_ENABLED=0 GOPATH=/tmp/gopath GOCACHE=/tmp/gocache \
      /usr/local/go/bin/go install -trimpath -ldflags='-s -w' "golang.org/x/vuln/cmd/govulncheck@v${GOVULNCHECK_VERSION}"; \
    rm -rf /tmp/gopath /tmp/gocache

# golangci-lint is published as a release binary; the project recommends it over `go install`.
FROM fetch AS golangci-lint
ARG GOLANGCI_LINT_VERSION=2.15.0
ARG GOLANGCI_LINT_SHA256_AMD64=9b7fe6a6bf6334b98decf8d86b11415ea7889afdabdd1959fdce23af2a9ebcea
RUN set -eux; \
    fetch "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64.tar.gz" "${GOLANGCI_LINT_SHA256_AMD64}" /tmp/golangci-lint.tar.gz; \
    mkdir -p /out; \
    tar -xzf /tmp/golangci-lint.tar.gz --strip-components=1 -C /out "golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64/golangci-lint"; \
    chmod 0555 /out/golangci-lint

# --- Cross-stack security, API and runtime tools (2.5): release binaries --------------------------------------------
FROM fetch AS binaries
ARG TRIVY_VERSION=0.76.2
ARG TRIVY_SHA256_AMD64=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
ARG OSV_SCANNER_VERSION=2.7.1
ARG OSV_SCANNER_SHA256_AMD64=fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8
ARG OASDIFF_VERSION=1.37.0
ARG OASDIFF_SHA256_AMD64=eac87307d31d08c36800c58a409c247f1c5db37fbb72e2544402f22a87cbca3c
ARG HADOLINT_VERSION=2.15.1
ARG HADOLINT_SHA256_AMD64=c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
ARG SQUAWK_VERSION=2.72.0
ARG SQUAWK_SHA256_AMD64=a61661808119a82515565503111099b070c869f73698f61cb1785de5d0c8b11a
RUN set -eux; \
    mkdir -p /out; \
    cd /tmp; \
    fetch "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" "${TRIVY_SHA256_AMD64}" trivy.tar.gz; \
    tar -xzf trivy.tar.gz -C /out trivy; \
    fetch "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64" "${OSV_SCANNER_SHA256_AMD64}" /out/osv-scanner; \
    fetch "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_amd64.tar.gz" "${OASDIFF_SHA256_AMD64}" oasdiff.tar.gz; \
    tar -xzf oasdiff.tar.gz -C /out oasdiff; \
    fetch "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-x86_64" "${HADOLINT_SHA256_AMD64}" /out/hadolint; \
    fetch "https://github.com/sbdchd/squawk/releases/download/v${SQUAWK_VERSION}/squawk-linux-x64" "${SQUAWK_SHA256_AMD64}" /out/squawk; \
    rm -f /tmp/*.tar.gz; \
    chown root:root /out/*; \
    chmod 0555 /out/*

# ZAP and the Java runtime it needs (Eclipse Temurin JRE).
FROM fetch AS zap
ARG JAVA_VERSION=21.0.13
ARG JAVA_BUILD=9
ARG JAVA_SHA256_AMD64=a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd
ARG ZAP_VERSION=2.17.0
ARG ZAP_SHA256=efe799aaa3627db683b43f00c9c210aea0b75c00cc8f0a0f0434d12bb3ddde5a
RUN set -eux; \
    fetch "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${JAVA_VERSION}%2B${JAVA_BUILD}/OpenJDK21U-jre_x64_linux_hotspot_${JAVA_VERSION}_${JAVA_BUILD}.tar.gz" "${JAVA_SHA256_AMD64}" /tmp/jre.tar.gz; \
    mkdir -p /opt/java /opt/zap; \
    tar -xzf /tmp/jre.tar.gz --strip-components=1 -C /opt/java; \
    fetch "https://github.com/zaproxy/zaproxy/releases/download/v${ZAP_VERSION}/ZAP_${ZAP_VERSION}_Linux.tar.gz" "${ZAP_SHA256}" /tmp/zap.tar.gz; \
    tar -xzf /tmp/zap.tar.gz --strip-components=1 -C /opt/zap; \
    rm -f /tmp/*.tar.gz; \
    chown -R root:root /opt/java /opt/zap; \
    chmod -R go-w /opt/java /opt/zap

# --- Node.js (current LTS) -------------------------------------------------------------------------------------------
FROM fetch AS node
ARG NODE_VERSION=26.13.0
ARG NODE_SHA256_AMD64=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
RUN set -eux; \
    fetch "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" "${NODE_SHA256_AMD64}" /tmp/node.tar.xz; \
    mkdir -p /opt/node; \
    tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node; \
    rm -f /tmp/node.tar.xz; \
    rm -rf /opt/node/include /opt/node/share/doc /opt/node/share/man /opt/node/CHANGELOG.md /opt/node/README.md; \
    chown -R root:root /opt/node; \
    /opt/node/bin/node --version
ENV PATH=/opt/node/bin:${PATH}

# Node tools: one npm prefix per tool, installed only from its package-lock.json (integrity-checked by npm ci).
FROM node AS node-tools
COPY node/ /opt/tools/node/
RUN set -eux; \
    for dir in /opt/tools/node/*/; do \
      (cd "${dir}" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=warn); \
    done; \
    rm -rf /root/.npm; \
    chown -R root:root /opt/tools/node; \
    chmod -R go-w /opt/tools/node

# --- Python tools: one uv environment per tool, only from hashed lock files ------------------------------------------
# python/<interpreter>/<tool>.txt: the default CPython for every tool whose dependencies ship wheels for it; a private
# CPython (uv-managed, checksum-verified by uv, not on PATH) for the tools whose dependencies do not support the default
# version yet. Byte-compiled at build time: the root filesystem of a step is read-only. The quality sidecar environment
# (PII, file size, tomlkit helper) imports the sidecar sources of the JGates package copied in later (a .pth file).
FROM base AS python-tools
COPY --from=uv /out/uv /out/uvx /usr/local/bin/
ARG TOOLS_PYTHON_VERSION=3.14.10
ENV UV_PYTHON_INSTALL_DIR=/opt/tools/python-runtime
COPY python/ /opt/tools/locks/python/
RUN set -eux; \
    default="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"; \
    UV_PYTHON_BIN_DIR=/tmp/uv-python-bin uv python install --no-cache "cpython-${TOOLS_PYTHON_VERSION}-linux-x86_64-gnu"; \
    rm -rf /tmp/uv-python-bin; \
    private="${UV_PYTHON_INSTALL_DIR}/cpython-${TOOLS_PYTHON_VERSION}-linux-x86_64-gnu/bin/python${TOOLS_PYTHON_VERSION%.*}"; \
    test "$("${private}" -c 'import platform; print(platform.python_version())')" = "${TOOLS_PYTHON_VERSION}"; \
    for lock in /opt/tools/locks/python/*/*.txt; do \
      version="$(basename "$(dirname "${lock}")")"; \
      tool="$(basename "${lock}" .txt)"; \
      if [ "${version}" = "${default}" ]; then interpreter=/usr/local/bin/python3; \
      elif [ "${version}" = "${TOOLS_PYTHON_VERSION%.*}" ]; then interpreter="${private}"; \
      else echo "jgates-tools: no interpreter for python/${version}" >&2; exit 1; fi; \
      UV_PYTHON_DOWNLOADS=never uv venv --no-cache --python "${interpreter}" "/opt/tools/python/${tool}"; \
      UV_PYTHON_DOWNLOADS=never uv pip install --no-cache --compile-bytecode --require-hashes --no-deps \
        --python "/opt/tools/python/${tool}/bin/python" -r "${lock}"; \
    done; \
    site="$(/opt/tools/python/quality-sidecar/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"; \
    echo /opt/jgates/quality-gate/sidecar > "${site}/jgates-quality-sidecar.pth"; \
    printf '%s\n' '#!/opt/tools/python/quality-sidecar/bin/python' 'import sys' 'from quality_sidecar.cli import entrypoint' 'sys.exit(entrypoint())' \
      > /opt/tools/python/quality-sidecar/bin/quality-sidecar; \
    chmod 0555 /opt/tools/python/quality-sidecar/bin/quality-sidecar; \
    chown -R root:root /opt/tools; \
    chmod -R go-w /opt/tools

# --- The JGates CLI of the same version (in-image mode, internal helpers) --------------------------------------------
# The named context `jgates-cli` holds the workspace manifests and lock, the built jgates package and the quality
# sidecar sources (staged by image-build.mjs); the production dependencies come from the repository's lock.
FROM node AS cli
COPY --from=jgates-cli / /opt/jgates/
RUN set -eux; \
    cd /opt/jgates; \
    npm ci --workspace jgates --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=warn; \
    rm -rf /root/.npm; \
    chmod 0555 /opt/jgates/jgates/dist/cli/main.js; \
    chown -R root:root /opt/jgates; \
    chmod -R go-w /opt/jgates

# --- The final image -------------------------------------------------------------------------------------------------
FROM base AS final
# The system libraries of Playwright's three browsers (Chromium, Firefox, WebKit) and their fonts: the debian13-x64 set
# of `playwright install-deps` (playwright-core registry/nativeDeps.js). The browsers themselves come per project.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      fonts-freefont-ttf fonts-ipafont-gothic fonts-liberation fonts-noto-color-emoji fonts-tlwg-loma-otf fonts-unifont \
      fonts-wqy-zenhei xfonts-scalable xvfb \
      gstreamer1.0-libav gstreamer1.0-plugins-bad gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatomic1 libatspi2.0-0t64 libavif16 libcairo-gobject2 \
      libcairo2 libcups2t64 libdbus-1-3 libdbus-glib-1-2 libdrm2 libegl1 libenchant-2-2 libepoxy0 libevdev2 \
      libevent-2.1-7t64 libfontconfig1 libfreetype6 libgbm1 libgdk-pixbuf-2.0-0 libgles2 libglib2.0-0t64 libglx0 \
      libgstreamer-gl1.0-0 libgstreamer-plugins-base1.0-0 libgstreamer1.0-0 libgtk-3-0t64 libgtk-4-1 libgudev-1.0-0 \
      libharfbuzz-icu0 libharfbuzz0b libhyphen0 libicu76 libjpeg62-turbo liblcms2-2 libmanette-0.2-0 libnotify4 \
      libnspr4 libnss3 libopengl0 libopenjp2-7 libopus0 libpango-1.0-0 libpangocairo-1.0-0 libpng16-16t64 \
      libproxy1v5 libsecret-1-0 libsoup-3.0-0 libwayland-client0 libwayland-egl1 libwayland-server0 libwebp7 \
      libwebpdemux2 libwoff1 libx11-6 libx11-xcb1 libxcb-shm0 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
      libxfixes3 libxi6 libxkbcommon0 libxml2 libxrandr2 libxrender1 libxslt1.1 libxtst6; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /var/log/apt /var/log/dpkg.log
# Least frequently changed first: language toolchains, then the tool binaries, then the tool environments.
COPY --from=dotnet /usr/share/dotnet /usr/share/dotnet
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=go /usr/local/go /usr/local/go
COPY --from=zap /opt/java /opt/java
COPY --from=zap /opt/zap /opt/zap
COPY --from=node /opt/node /opt/node
COPY --from=uv /out/uv /out/uvx /usr/local/bin/
COPY --from=binaries /out/ /usr/local/bin/
COPY --from=golangci-lint /out/golangci-lint /usr/local/bin/golangci-lint
COPY --from=go-tools /out/govulncheck /out/gitleaks /usr/local/bin/
COPY --from=rust-tools /out/bin/cargo-audit /out/bin/cargo-llvm-cov /usr/local/bin/
COPY --from=python-tools /opt/tools /opt/tools
COPY --from=node-tools /opt/tools/node /opt/tools/node

ENV PATH=/usr/local/cargo/bin:/usr/local/go/bin:/opt/node/bin:/usr/share/dotnet:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    GOTOOLCHAIN=local \
    DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false \
    JAVA_HOME=/opt/java \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    SEMGREP_ENABLE_VERSION_CHECK=0 \
    SEMGREP_SEND_METRICS=off \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy

# Commands on PATH, the non-root user of the steps (its home is under /tmp, a tmpfs in steps) and the mount points.
RUN set -eux; \
    link() { ln -s "$1" "/usr/local/bin/$2"; }; \
    # pytest and coverage come from the pytest environment (with pytest-cov and Hypothesis), never from another tool's
    # environment that happens to carry its own pytest (mutmut, schemathesis).
    link /opt/tools/python/pytest/bin/pytest pytest; \
    link /opt/tools/python/pytest/bin/coverage coverage; \
    for tool in ruff mypy pytest coverage mutmut schemathesis st semgrep checkov zizmor; do \
      for env in /opt/tools/python/*/; do \
        if [ -e "${env}bin/${tool}" ] && [ ! -e "/usr/local/bin/${tool}" ]; then link "${env}bin/${tool}" "${tool}"; fi; \
      done; \
    done; \
    link /opt/tools/python/import-linter/bin/lint-imports lint-imports; \
    link /opt/tools/python/quality-sidecar/bin/quality-sidecar quality-sidecar; \
    link /opt/tools/node/typescript/node_modules/.bin/tsc tsc; \
    link /opt/tools/node/pyright/node_modules/.bin/pyright pyright; \
    link /opt/tools/node/pyright/node_modules/.bin/pyright-langserver pyright-langserver; \
    link /opt/tools/node/eslint/node_modules/.bin/eslint eslint; \
    link /opt/tools/node/prettier/node_modules/.bin/prettier prettier; \
    link /opt/tools/node/vitest/node_modules/.bin/vitest vitest; \
    link /opt/tools/node/stryker/node_modules/.bin/stryker stryker; \
    link /opt/tools/node/jscpd/node_modules/.bin/jscpd jscpd; \
    link /opt/tools/node/dependency-cruiser/node_modules/.bin/depcruise depcruise; \
    link /opt/tools/node/corepack/node_modules/.bin/corepack corepack; \
    corepack enable --install-directory /usr/local/bin pnpm yarn; \
    link /opt/zap/zap.sh zap.sh; \
    link /opt/zap/zap.sh zap; \
    link /opt/java/bin/java java; \
    for tool in ruff mypy pytest coverage mutmut schemathesis semgrep checkov zizmor lint-imports quality-sidecar tsc \
                pyright eslint prettier vitest stryker jscpd depcruise corepack pnpm yarn zap.sh java; do \
      test -x "/usr/local/bin/${tool}"; \
    done; \
    groupadd --gid 10001 jgates; \
    useradd --uid 10001 --gid 10001 --home-dir /tmp/home --no-create-home --shell /usr/sbin/nologin jgates; \
    mkdir -p /workspace /output /etc/jgates /usr/share/jgates; \
    chown 10001:10001 /workspace /output

# The JGates CLI changes with every release: after the tools.
COPY --from=cli /opt/jgates /opt/jgates
RUN set -eux; \
    ln -s /opt/jgates/jgates/dist/cli/main.js /usr/local/bin/jgates; \
    /usr/local/bin/python3 -m compileall -q /opt/jgates/quality-gate/sidecar; \
    PYTHONDONTWRITEBYTECODE= /opt/tools/python/quality-sidecar/bin/python -c 'import quality_sidecar.cli, tomlkit, defusedxml'

# The license and notice files of everything the image ships (license gate of PLAN-image.md section 5).
COPY collect-notices.sh /usr/share/jgates/collect-notices.sh
RUN sh /usr/share/jgates/collect-notices.sh

# Changes on every build (version and source revision): last, so the layers above stay cached. The versions of the
# pinned tools are the build arguments above; write-image-json.py checks each tool against its pin and fails the build
# on any difference.
ARG JGATES_VERSION=0.0.0-dev
ARG IMAGE_VERSION=dev
ARG SOURCE_REVISION=unknown
ARG UV_VERSION=0.13.7
ARG TOOLS_PYTHON_VERSION=3.14.10
ARG DOTNET_SDK_VERSION=10.0.403
ARG RUSTUP_VERSION=1.29.3
ARG RUST_VERSION=1.99.1
ARG CARGO_AUDIT_VERSION=0.22.2
ARG CARGO_LLVM_COV_VERSION=0.9.1
ARG GO_VERSION=1.27.3
ARG GOVULNCHECK_VERSION=1.9.0
ARG GOLANGCI_LINT_VERSION=2.15.0
ARG GITLEAKS_VERSION=8.30.1
ARG TRIVY_VERSION=0.76.2
ARG OSV_SCANNER_VERSION=2.7.1
ARG OASDIFF_VERSION=1.37.0
ARG HADOLINT_VERSION=2.15.1
ARG SQUAWK_VERSION=2.72.0
ARG JAVA_VERSION=21.0.13
ARG ZAP_VERSION=2.17.0
ARG NODE_VERSION=26.13.0
LABEL org.opencontainers.image.title="jgates-tools" \
      org.opencontainers.image.description="JGates tools image: every check of the Python, TypeScript/JavaScript, Go, Rust and .NET stacks" \
      org.opencontainers.image.source="https://github.com/rodrigojager/jgates" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.jgates.version="${JGATES_VERSION}"
COPY write-image-json.py /usr/share/jgates/write-image-json.py
# What the smoke leaves behind is removed in the same step (Java and ZAP write to root's passwd home, not to HOME).
RUN HOME=/tmp/jgates-smoke python3 /usr/share/jgates/write-image-json.py /etc/jgates/image.json; \
    status=$?; \
    rm -rf /tmp/* /tmp/.[!.]* /root/.ZAP /root/.java; \
    exit "${status}"

# No ENTRYPOINT: the runner passes the tool as the first word of the command (one image, every tool).
USER 10001:10001
WORKDIR /workspace

# The image's /etc/jgates/image.json alone, exported by image-build.mjs before the `final` target is loaded: the tool
# versions it records become the org.jgates.tool.<tool>.version labels of the image.
FROM scratch AS image-json
COPY --from=final /etc/jgates/image.json /image.json
