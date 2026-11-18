#!/bin/sh
# links <installs.json>: the PATH links of the install entries (scripts/image-installs.mjs writes the index): every
# program with a link gets /usr/local/bin/<link> pointing at it, and every program with a path must be executable. Used
# by the image build and by the probe (where a link replaces the one of the built image).
set -eu
index="$1"
tab="$(printf '\t')"
jq -r '.entries[].provides[] | select(.link != null) | "\(.link)\t\(.target)"' "${index}" | while IFS="${tab}" read -r link target; do
  ln -sfn "${target}" "/usr/local/bin/${link}"
done
jq -r '.entries[].provides[] | select(.target != null) | .target' "${index}" | while read -r target; do
  if [ ! -x "${target}" ]; then echo "links: ${target} is not an executable file" >&2; exit 1; fi
done
jq -r '.entries[].provides[] | select(.link != null) | .link' "${index}" | while read -r link; do
  if [ ! -x "/usr/local/bin/${link}" ]; then echo "links: /usr/local/bin/${link} does not reach an executable" >&2; exit 1; fi
done
echo "links: $(jq '[.entries[].provides[] | select(.link != null)] | length' "${index}") linked"
