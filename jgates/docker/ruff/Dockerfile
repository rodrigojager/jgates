# Small image that runs Ruff for the container runner (smoke of `npm run test:docker`, and the model of the tool images).
# Built by the dedicated buildx builder `jgates-dev` and always labeled org.jgates.dev=true.
# The base is pinned by digest (python:3.12-slim); Ruff is pinned to the version of jgates/dev-tools/requirements.txt.
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704

ARG RUFF_VERSION=0.17.2
LABEL org.jgates.dev="true" \
      org.jgates.tool="ruff" \
      org.jgates.tool.version="${RUFF_VERSION}"

RUN pip install --no-cache-dir --disable-pip-version-check "ruff==${RUFF_VERSION}" \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin jgates

# Non-root by default; the runner mounts the workspace read-only at /workspace and a writable /output.
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["ruff"]
