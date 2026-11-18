#!/bin/sh
# binary <entry.json>: installs one release binary or archive (docker/tools/binaries/<name>.json) into
# /opt/tools/binaries/<name>. The download is verified against the entry's checksum by fetch. archive "file" saves the
# download as `save` (default: the entry name); an archive is unpacked (strip removes leading folders) and then either
# the paths of `extract` are moved into the install folder or, without it, everything is. `executable` paths get mode
# 0555. Used by the image build (one entry at a time) and by the probe (npm run image:probe).
set -eu
entry="$1"
name="$(basename "$entry" .json)"
version="$(jq -r '.version' "$entry")"
url="$(jq -r '.url' "$entry" | sed "s/{version}/${version}/g")"
sum="$(jq -r '.sha256' "$entry")"
archive="$(jq -r '.archive // "file"' "$entry")"
strip="$(jq -r '.strip // 0' "$entry")"
dest="/opt/tools/binaries/${name}"
work="/tmp/jgates-install-${name}"
rm -rf "${dest}" "${work}"
mkdir -p "${dest}" "${work}/unpacked"
fetch "${url}" "${sum}" "${work}/download"
case "${archive}" in
  file)
    save="$(jq -r --arg name "${name}" '.save // $name' "$entry")"
    mv "${work}/download" "${dest}/${save}"
    chmod 0555 "${dest}/${save}"
    ;;
  zip)
    unzip -q "${work}/download" -d "${work}/unpacked"
    ;;
  tar.gz|tgz|tar.xz|tar.bz2|tar)
    tar -xf "${work}/download" -C "${work}/unpacked"
    ;;
  *)
    echo "binary: ${name}: unknown archive ${archive}" >&2
    exit 1
    ;;
esac
if [ "${archive}" != "file" ]; then
  root="${work}/unpacked"
  i=0
  while [ "${i}" -lt "${strip}" ]; do
    count="$(find "${root}" -mindepth 1 -maxdepth 1 | wc -l)"
    inner="$(find "${root}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    if [ "${count}" -ne 1 ] || [ -z "${inner}" ]; then echo "binary: ${name}: strip ${strip}: level $((i + 1)) is not a single folder" >&2; exit 1; fi
    root="${inner}"
    i=$((i + 1))
  done
  if jq -e '.extract' "$entry" > /dev/null; then
    jq -r '.extract | to_entries[] | "\(.key)\t\(.value)"' "$entry" | sed "s/{version}/${version}/g" | while IFS="$(printf '\t')" read -r from to; do
      if [ ! -e "${root}/${from}" ]; then echo "binary: ${name}: ${from} is not in the archive" >&2; exit 1; fi
      mkdir -p "$(dirname "${dest}/${to}")"
      mv "${root}/${from}" "${dest}/${to}"
    done
  else
    (cd "${root}" && tar -cf - .) | (cd "${dest}" && tar -xf -)
  fi
fi
jq -r '.executable // [] | .[]' "$entry" | while read -r file; do chmod 0555 "${dest}/${file}"; done
rm -rf "${work}"
chown -R root:root "${dest}"
chmod -R go-w "${dest}"
echo "binary: ${name} ${version} in ${dest}"
