#!/bin/sh
# cargo <entry.json>: `cargo install --locked` of one crate at its exact version (docker/tools/cargo/<name>.json) into
# /opt/tools/cargo/<name> (binaries in bin/, stripped). Used by the image build and by the probe.
set -eu
entry="$1"
name="$(basename "$entry" .json)"
version="$(jq -r '.version' "$entry")"
crate="$(jq -r '.crate' "$entry")"
features="$(jq -r '.features // [] | join(",")' "$entry")"
dest="/opt/tools/cargo/${name}"
rm -rf "${dest}"
set -- --locked --root "${dest}" --version "${version}"
if [ -n "${features}" ]; then set -- "$@" --features "${features}"; fi
PATH="${CARGO_HOME:-/usr/local/cargo}/bin:${PATH}" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" cargo install "$@" "${crate}"
rm -f "${dest}/.crates.toml" "${dest}/.crates2.json"
for binary in "${dest}"/bin/*; do strip "${binary}"; done
chown -R root:root "${dest}"
chmod -R go-w "${dest}"
echo "cargo: ${name} ${version} in ${dest}"
