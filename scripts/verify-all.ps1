# Shortcut for `npm run verify`: all of the logic lives in scripts/verify-all.mjs (Node, so it also runs on Linux and
# macOS). Keep this file free of verification steps of its own.
$ErrorActionPreference = "Stop"

node (Join-Path $PSScriptRoot "verify-all.mjs") @args
exit $LASTEXITCODE
