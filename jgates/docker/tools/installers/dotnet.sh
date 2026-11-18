#!/bin/sh
# dotnet <entry.json>: one .NET tool (docker/tools/dotnet/<name>.json), fetched by the SHA-256 of its .nupkg and installed
# from that local file only (a nuget.config without any remote source) into the shared tool path /opt/dotnet-tools,
# which is on PATH. A tool already there (the probe, on top of the built image) is replaced. Used by the image build and
# by the probe.
set -eu
entry="$1"
version="$(jq -r '.version' "$entry")"
package="$(jq -r '.package' "$entry")"
sum="$(jq -r '.sha256' "$entry")"
lower="$(printf '%s' "${package}" | tr '[:upper:]' '[:lower:]')"
work="/tmp/jgates-install-dotnet-${lower}"
rm -rf "${work}"
mkdir -p "${work}/nupkgs" "${work}/home" /opt/dotnet-tools
fetch "https://api.nuget.org/v3-flatcontainer/${lower}/${version}/${lower}.${version}.nupkg" "${sum}" "${work}/nupkgs/${lower}.${version}.nupkg"
printf '%s\n' '<?xml version="1.0" encoding="utf-8"?>' '<configuration><packageSources><clear />' \
  "<add key=\"local\" value=\"${work}/nupkgs\" /></packageSources></configuration>" > "${work}/nupkgs/nuget.config"
export HOME="${work}/home" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_ROOT=/usr/share/dotnet NUGET_PACKAGES="${work}/home/nuget"
# A tool already there is removed by hand: `dotnet tool uninstall` moves its files, which fails across the layers of an
# image (EXDEV). Its commands are the paths the entry provides.
if [ -d "/opt/dotnet-tools/.store/${lower}" ]; then
  rm -rf "/opt/dotnet-tools/.store/${lower}"
  jq -r '.provides[] | select(.path != null) | .path' "$entry" | while read -r command; do rm -f "/opt/dotnet-tools/${command}"; done
fi
/usr/share/dotnet/dotnet tool install "${package}" --version "${version}" --tool-path /opt/dotnet-tools --configfile "${work}/nupkgs/nuget.config"
rm -rf "${work}"
chown -R root:root /opt/dotnet-tools
chmod -R go-w /opt/dotnet-tools
echo "dotnet: ${package} ${version} in /opt/dotnet-tools"
