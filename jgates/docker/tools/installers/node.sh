#!/bin/sh
# node <folder>: the npm prefix of one Node tool (docker/tools/node/<tool>/, copied to /opt/tools/node/<tool>/),
# installed only from its package-lock.json (integrity-checked by npm ci), without scripts and dev dependencies. Used
# by the image build and by the probe.
set -eu
dir="$1"
(cd "${dir}" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=warn)
rm -rf /root/.npm
echo "node: $(basename "${dir}")"
