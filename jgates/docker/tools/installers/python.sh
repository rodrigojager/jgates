#!/bin/sh
# python <lock.txt>: one uv environment per tool at /opt/tools/python/<tool>, only from the hashed lock
# (docker/tools/python/<interpreter>/<tool>.txt, wheels only, no resolution). The interpreter is the image's default
# CPython when the folder names its version, else the private CPython of TOOLS_PYTHON_VERSION under
# UV_PYTHON_INSTALL_DIR (uv-managed, not on PATH). Byte-compiled now: the root filesystem of a step is read-only. Used
# by the image build and by the probe.
set -eu
lock="$1"
version="$(basename "$(dirname "${lock}")")"
tool="$(basename "${lock}" .txt)"
default="$(/usr/local/bin/python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
private="${UV_PYTHON_INSTALL_DIR}/cpython-${TOOLS_PYTHON_VERSION}-linux-x86_64-gnu/bin/python${TOOLS_PYTHON_VERSION%.*}"
if [ "${version}" = "${default}" ]; then interpreter=/usr/local/bin/python3
elif [ "${version}" = "${TOOLS_PYTHON_VERSION%.*}" ]; then interpreter="${private}"
else echo "python: no interpreter for python/${version}" >&2; exit 1; fi
rm -rf "/opt/tools/python/${tool}"
UV_PYTHON_DOWNLOADS=never uv venv --no-cache --python "${interpreter}" "/opt/tools/python/${tool}"
UV_PYTHON_DOWNLOADS=never uv pip install --no-cache --compile-bytecode --require-hashes --no-deps \
  --python "/opt/tools/python/${tool}/bin/python" -r "${lock}"
echo "python: ${tool} (python ${version})"
