# Small image with the four security scanners of the sidecar (Gitleaks, Trivy, OSV-Scanner, Checkov) at the versions
# the sidecar image pins (quality-gate/Dockerfile), for the container runner of their adapters and the smoke of
# `npm run test:docker`. The sidecar image itself (MegaLinter based, several GB) works the same way once it carries
# the version labels below; this one exists so the smoke does not have to build MegaLinter.
# Built by the dedicated buildx builder `jgates-dev` and always labeled org.jgates.dev=true. The base is pinned by
# digest; every downloaded binary is checked against its published sha256.
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704

ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG TRIVY_VERSION=0.72.0
ARG TRIVY_SHA256=bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea
ARG OSV_SCANNER_VERSION=2.4.0
ARG OSV_SCANNER_SHA256=15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0
ARG CHECKOV_VERSION=3.3.8

# One version label per tool: the adapters read the one of their tool (org.jgates.tool.<tool>.version).
LABEL org.jgates.dev="true" \
      org.jgates.tool="security-scanners" \
      org.jgates.tool.gitleaks.version="${GITLEAKS_VERSION}" \
      org.jgates.tool.trivy.version="${TRIVY_VERSION}" \
      org.jgates.tool.osv-scanner.version="${OSV_SCANNER_VERSION}" \
      org.jgates.tool.checkov.version="${CHECKOV_VERSION}"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git; \
    rm -rf /var/lib/apt/lists/*; \
    cd /tmp; \
    curl -fsSL -o gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"; \
    printf '%s  %s\n' "${GITLEAKS_SHA256}" gitleaks.tar.gz | sha256sum -c -; \
    tar -xzf gitleaks.tar.gz -C /usr/local/bin gitleaks; \
    curl -fsSL -o trivy.tar.gz "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"; \
    printf '%s  %s\n' "${TRIVY_SHA256}" trivy.tar.gz | sha256sum -c -; \
    tar -xzf trivy.tar.gz -C /usr/local/bin trivy; \
    curl -fsSL -o /usr/local/bin/osv-scanner "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64"; \
    printf '%s  %s\n' "${OSV_SCANNER_SHA256}" /usr/local/bin/osv-scanner | sha256sum -c -; \
    chmod 0555 /usr/local/bin/gitleaks /usr/local/bin/trivy /usr/local/bin/osv-scanner; \
    rm -f /tmp/*.tar.gz; \
    python -m venv /opt/venvs/checkov; \
    /opt/venvs/checkov/bin/pip install --no-cache-dir --disable-pip-version-check "checkov==${CHECKOV_VERSION}"; \
    ln -s /opt/venvs/checkov/bin/checkov /usr/local/bin/checkov; \
    test "$(gitleaks version | head -n 1)" = "${GITLEAKS_VERSION}"; \
    test "$(trivy --version | awk -F ': ' '/^Version:/ {print $2; exit}')" = "${TRIVY_VERSION}"; \
    test "$(osv-scanner --version | awk '/^osv-scanner version:/ {print $3; exit}')" = "${OSV_SCANNER_VERSION}"; \
    test "$(/opt/venvs/checkov/bin/python -c 'import importlib.metadata as m; print(m.version("checkov"))')" = "${CHECKOV_VERSION}"; \
    useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin jgates

# Non-root by default; the runner mounts the workspace read-only at /workspace and a writable /output, and passes
# the scanner itself as the first word of the command (no entrypoint: one image, four tools).
USER 10001:10001
WORKDIR /workspace
