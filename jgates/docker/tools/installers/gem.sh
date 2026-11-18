#!/bin/sh
# gem <folder>: the gems of one Ruby tool (docker/tools/gem/<tool>/, copied to /opt/tools/gem/<tool>/) installed by
# Bundler in deployment mode from its Gemfile.lock into the folder, with binstubs in bin/ (they find their Gemfile from
# their own place, so a link to them works). Needs Ruby and Bundler from an apt entry. Used by the image build and by
# the probe.
set -eu
dir="$1"
if ! command -v bundle > /dev/null; then echo "gem: $(basename "${dir}"): Bundler is not in the image (add ruby and bundler through an apt entry)" >&2; exit 1; fi
cd "${dir}"
export BUNDLE_GEMFILE="${dir}/Gemfile" BUNDLE_DEPLOYMENT=true BUNDLE_PATH="${dir}/vendor" BUNDLE_WITHOUT=development:test HOME=/tmp/jgates-gem-home
bundle install --jobs 4
bundle binstubs --all --path "${dir}/bin"
printf '%s\n' '---' 'BUNDLE_DEPLOYMENT: "true"' "BUNDLE_PATH: \"${dir}/vendor\"" 'BUNDLE_WITHOUT: "development:test"' > "${dir}/.bundle-config"
mkdir -p "${dir}/.bundle"
mv "${dir}/.bundle-config" "${dir}/.bundle/config"
rm -rf /tmp/jgates-gem-home "${dir}/vendor/ruby"/*/cache
chown -R root:root "${dir}"
chmod -R go-w "${dir}"
echo "gem: $(basename "${dir}")"
