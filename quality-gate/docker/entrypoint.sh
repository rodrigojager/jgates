#!/bin/sh
set -eu
set -f

readonly QUALITY_ENTRYPOINT_PATH_FILE="/etc/jgates/quality-gate-path"

fail_entrypoint() {
  printf 'quality-entrypoint: %s\n' "$1" >&2
  exit 3
}

if [ ! -f "$QUALITY_ENTRYPOINT_PATH_FILE" ] || [ -L "$QUALITY_ENTRYPOINT_PATH_FILE" ]; then
  fail_entrypoint "trusted PATH file is missing, non-regular, or a symlink"
fi
[ "$(/bin/stat -c '%u:%g:%a' "$QUALITY_ENTRYPOINT_PATH_FILE")" = "0:0:444" ] \
  || fail_entrypoint "trusted PATH file must be root:root mode 0444"

exec 3< "$QUALITY_ENTRYPOINT_PATH_FILE"
QUALITY_ENTRYPOINT_PATH=
if ! IFS= read -r QUALITY_ENTRYPOINT_PATH <&3 && [ -z "$QUALITY_ENTRYPOINT_PATH" ]; then
  fail_entrypoint "trusted PATH file is empty"
fi
unexpected_line=
if IFS= read -r unexpected_line <&3 || [ -n "$unexpected_line" ]; then
  fail_entrypoint "trusted PATH file contains more than one line"
fi
exec 3<&-
carriage_return=$(printf '\r')
case "$QUALITY_ENTRYPOINT_PATH" in
  ''|*"$carriage_return"*|:*|*::|*:)
    fail_entrypoint "trusted PATH file is invalid"
    ;;
esac

old_ifs=$IFS
IFS=:
for path_dir in $QUALITY_ENTRYPOINT_PATH; do
  case "$path_dir" in
    /*) ;;
    *) fail_entrypoint "trusted PATH entries must be absolute" ;;
  esac
  case "$path_dir" in
    /root|/root/*) fail_entrypoint "trusted PATH must not traverse /root" ;;
  esac
  [ -d "$path_dir" ] || fail_entrypoint "trusted PATH entry is not a directory"
  [ -x "$path_dir" ] || fail_entrypoint "trusted PATH entry is not traversable"
done
IFS=$old_ifs
readonly QUALITY_ENTRYPOINT_PATH
PATH=$QUALITY_ENTRYPOINT_PATH
export PATH

case "${1:-}" in
  quality-sidecar|quality-gate)
    shift
    ;;
esac

exec /opt/venvs/quality-sidecar/bin/python -m quality_sidecar "$@"
