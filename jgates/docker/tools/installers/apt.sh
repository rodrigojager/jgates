#!/bin/sh
# apt <entry.json>...: the Debian packages of the apt entries (docker/tools/apt/<group>.json), from Debian's archive
# (signed; the forbidden-content gate checks that every installed package is in main), then the security updates of
# everything installed. Unpinned: the version is what the probe and image.json record. Used by the image build and by
# the probe.
set -eu
packages=""
for entry in "$@"; do
  [ -e "${entry}" ] || continue
  packages="${packages} $(jq -r '.packages | join(" ")' "${entry}")"
done
apt-get update
if [ -n "$(echo "${packages}" | tr -d ' ')" ]; then
  # shellcheck disable=SC2086
  apt-get install -y --no-install-recommends ${packages}
fi
apt-get upgrade -y --no-install-recommends
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /var/log/apt /var/log/dpkg.log
echo "apt:${packages}"
