#!/bin/sh
# Collects the license and notice files of what the image ships into /usr/share/jgates/notices/ (run at image build time,
# after the JGates CLI is copied). Layout:
#   THIRD_PARTY_NOTICES.md   every shipped tool with its license and source URL (the repository file)
#   JGATES-LICENSE           the license of JGates itself
#   python/ node/            license files of the packages of the isolated tool environments, one copy per content
#   tools/                   license files of the other install entries (binaries, go, cargo, gem, parts)
#   debian/<package>         the copyright file of every Debian package
set -eu

dest=/usr/share/jgates/notices
mkdir -p "$dest/python" "$dest/node" "$dest/debian"

cp /opt/jgates/THIRD_PARTY_NOTICES.md "$dest/THIRD_PARTY_NOTICES.md"
cp /opt/jgates/LICENSE "$dest/JGATES-LICENSE"

# Copies a license file once per distinct content: <first 12 hex of the sha256>-<package>-<file name>.
collect() {
  group="$1"; package="$2"; file="$3"
  [ -f "$file" ] || return 0
  sum=$(sha256sum "$file" | cut -c1-12)
  target="$dest/$group/$sum-$package-$(basename "$file")"
  [ -e "$target" ] || cp "$file" "$target"
}

# Python: dist-info folders (license files live in licenses/ or next to METADATA).
find /opt/tools/python /usr/local/lib -type d -name '*.dist-info' 2>/dev/null | while read -r info; do
  package=$(basename "$info" .dist-info)
  find "$info" -maxdepth 2 -type f \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) | while read -r file; do
    collect python "$package" "$file"
  done
done

# Node: the license files at the top of every package folder of the tool prefixes.
find /opt/tools/node -type d -path '*/node_modules/*' 2>/dev/null | while read -r folder; do
  [ -f "$folder/package.json" ] || continue
  package=$(basename "$folder")
  find "$folder" -maxdepth 1 -type f \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) | while read -r file; do
    collect node "$package" "$file"
  done
done

# The other install entries (release archives, Go and Rust tools, gems, parts): the license files in the top two levels
# of each install folder, under the entry's name.
mkdir -p "$dest/tools"
for folder in /opt/tools/binaries/* /opt/tools/go/* /opt/tools/cargo/* /opt/tools/gem/* /opt/tools/parts/*; do
  [ -d "$folder" ] || continue
  entry=$(basename "$folder")
  find "$folder" -maxdepth 2 -type f \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) | while read -r file; do
    collect tools "$entry" "$file"
  done
done

# Debian packages: their copyright files (packages are symlinked folders for some: follow only regular files).
for folder in /usr/share/doc/*; do
  [ -f "$folder/copyright" ] || continue
  cp -L "$folder/copyright" "$dest/debian/$(basename "$folder")" 2>/dev/null || true
done

# What a license file collector must not leave behind: empty folders.
find "$dest" -type d -empty -delete 2>/dev/null || true
test -f "$dest/THIRD_PARTY_NOTICES.md"
echo "notices: $(find "$dest" -type f | wc -l) files, $(du -sh "$dest" | cut -f1)"
