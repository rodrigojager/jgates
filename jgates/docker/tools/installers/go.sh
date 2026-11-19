#!/bin/sh
# go <entry.json>: `go install` of one Go module at its exact version (docker/tools/go/<name>.json) with the image's Go,
# into /opt/tools/go/<name>. go install verifies every module against the Go checksum database. {version} in ldflags
# is replaced. Used by the image build and by the probe.
set -eu
entry="$1"
name="$(basename "$entry" .json)"
version="$(jq -r '.version' "$entry")"
module="$(jq -r '.module' "$entry")"
tags="$(jq -r '.tags // [] | join(",")' "$entry")"
ldflags="$(jq -r '.ldflags // "-s -w"' "$entry" | sed "s/{version}/${version}/g")"
cgo="$(jq -r 'if .cgo == true then "1" else "0" end' "$entry")"
dest="/opt/tools/go/${name}"
rm -rf "${dest}"
mkdir -p "${dest}"
set -- -trimpath
if [ -n "${tags}" ]; then set -- "$@" -tags "${tags}"; fi
GOTOOLCHAIN=local GOBIN="${dest}" CGO_ENABLED="${cgo}" GOPATH=/tmp/jgates-gopath GOCACHE=/tmp/jgates-gocache \
  /usr/local/go/bin/go install "$@" -ldflags="${ldflags}" "${module}@v${version}"
rm -rf /tmp/jgates-gopath /tmp/jgates-gocache
chown -R root:root "${dest}"
chmod -R go-w "${dest}"
echo "go: ${name} ${version} in ${dest}"
