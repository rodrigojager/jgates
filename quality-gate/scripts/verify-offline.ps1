param()

$ErrorActionPreference = "Stop"

function RunStep([string]$Name, [scriptblock]$Step) {
  Write-Output "==> $Name"
  & $Step
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

RunStep "npm test" {
  npm test
}

RunStep "git diff --check" {
  git diff --check
}

RunStep "python package dry-run" {
  python -m pip install --dry-run .
}

RunStep "sidecar quick self-check" {
  $env:PYTHONPATH = "sidecar"
  python -m quality_sidecar check . --mode quick --format=json,md --output .quality/reports/offline-self-check
}

RunStep "npm pack dry-run" {
  npm pack --dry-run
}

Write-Output "Offline verification passed."
