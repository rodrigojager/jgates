#!/bin/sh
# fetch <url> <checksum> <file>: downloads <url> to <file> and verifies it against its published checksum (64 hex
# characters: SHA-256, 128: SHA-512). A mismatch, a missing checksum or a failed download fails the build.
set -eu
url="$1"
checksum="$2"
file="$3"
case "${#checksum}" in
  64) tool=sha256sum ;;
  128) tool=sha512sum ;;
  *) echo "fetch: no SHA-256/SHA-512 checksum given for ${url}" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o "${file}" "${url}"
printf '%s  %s\n' "${checksum}" "${file}" | "${tool}" -c -
