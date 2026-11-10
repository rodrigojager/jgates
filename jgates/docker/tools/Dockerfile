# syntax=docker/dockerfile:1
# The JGates tools image (ADR-0005): every check runs in containers of this one image. This is the S0 slice: the
# Python stack only (CPython, uv, ruff, pytest, pytest-cov, coverage) plus git, rsync and tini; later slices add the
# other stacks as their own stages. Built by `npm --prefix jgates run image:build` as jgates-tools:dev, labeled
# org.jgates.dev=true and jproject.project=jgates by the build script.
# Inputs are pinned: the base by digest, uv by its published sha256 (keyed by TARGETARCH), the Python tools by the
# hashes of their lock files (locks/*.txt, generated from locks/*.in with `uv pip compile --generate-hashes`). Every
# tool is smoke-checked against its pin when /etc/jgates/image.json is written. Layers go from the least to the most
# frequently changed.
FROM python:3.15-slim-trixie@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

ARG UV_VERSION=0.13.7
ARG UV_SHA256_AMD64=c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83
ARG RUFF_VERSION=0.17.4
ARG PYTEST_VERSION=9.2.0
ARG PYTEST_COV_VERSION=7.1.0
ARG COVERAGE_VERSION=7.17.2

# One version label per tool, as the earlier tool images did (org.jgates.tool.<tool>.version).
LABEL org.opencontainers.image.title="jgates-tools" \
      org.opencontainers.image.source="https://github.com/rodrigojager/jgates" \
      org.opencontainers.image.licenses="MIT" \
      org.jgates.tool.uv.version="${UV_VERSION}" \
      org.jgates.tool.ruff.version="${RUFF_VERSION}" \
      org.jgates.tool.pytest.version="${PYTEST_VERSION}" \
      org.jgates.tool.pytest-cov.version="${PYTEST_COV_VERSION}" \
      org.jgates.tool.coverage.version="${COVERAGE_VERSION}"

# Shared runtime: git (history scans), rsync (the S0 sync helper), tini (init for in-image mode), curl and
# ca-certificates (verified downloads, dependency installs).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git rsync tini; \
    rm -rf /var/lib/apt/lists/*

# uv: dependency installs in `deps` containers and the isolated environment of every Python tool.
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) triple=x86_64-unknown-linux-gnu; sha="${UV_SHA256_AMD64}" ;; \
      *) echo "jgates-tools: no pinned uv checksum for architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSL -o uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.tar.gz"; \
    printf '%s  %s\n' "${sha}" uv.tar.gz | sha256sum -c -; \
    tar -xzf uv.tar.gz --strip-components=1 -C /usr/local/bin "uv-${triple}/uv" "uv-${triple}/uvx"; \
    rm -f uv.tar.gz; \
    chmod 0555 /usr/local/bin/uv /usr/local/bin/uvx

# Python tools: one environment per tool, installed only from the hashed lock files and byte-compiled at build time
# (the root filesystem of a step is read-only, so no bytecode cache can be written later).
COPY locks/ /opt/jgates/locks/
RUN set -eux; \
    for tool in ruff pytest; do \
      UV_PYTHON_DOWNLOADS=never uv venv --no-cache --python /usr/local/bin/python3 "/opt/jgates/tools/${tool}"; \
      UV_PYTHON_DOWNLOADS=never uv pip install --no-cache --compile-bytecode --require-hashes --no-deps \
        --python "/opt/jgates/tools/${tool}/bin/python" -r "/opt/jgates/locks/${tool}.txt"; \
    done; \
    ln -s /opt/jgates/tools/ruff/bin/ruff /usr/local/bin/ruff; \
    ln -s /opt/jgates/tools/pytest/bin/pytest /usr/local/bin/pytest; \
    ln -s /opt/jgates/tools/pytest/bin/coverage /usr/local/bin/coverage

# Non-root user of the steps on Windows and macOS hosts, and the mount points of the step contract.
RUN set -eux; \
    groupadd --gid 10001 jgates; \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin jgates; \
    mkdir -p /workspace /output /etc/jgates; \
    chown 10001:10001 /workspace /output

ENV PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy

# Changes on every build (version and source revision): last, so the layers above stay cached.
ARG JGATES_VERSION=0.0.0-dev
ARG IMAGE_VERSION=dev
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.jgates.version="${JGATES_VERSION}"
COPY write-image-json.py /opt/jgates/write-image-json.py
RUN JGATES_VERSION="${JGATES_VERSION}" IMAGE_VERSION="${IMAGE_VERSION}" SOURCE_REVISION="${SOURCE_REVISION}" \
    PIN_UV="${UV_VERSION}" PIN_RUFF="${RUFF_VERSION}" PIN_PYTEST="${PYTEST_VERSION}" \
    PIN_PYTEST_COV="${PYTEST_COV_VERSION}" PIN_COVERAGE="${COVERAGE_VERSION}" \
    python3 /opt/jgates/write-image-json.py /etc/jgates/image.json

# No ENTRYPOINT: the runner passes the tool as the first word of the command (one image, every tool).
USER 10001:10001
WORKDIR /workspace
