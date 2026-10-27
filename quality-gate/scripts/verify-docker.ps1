param(
  [string]$Image = "jgates/quality-sidecar:local",
  [string]$FixturePath = ""
)

$ErrorActionPreference = "Stop"

function FailVerify([string]$Message, [int]$Code = 1) {
  [Console]::Error.WriteLine($Message)
  exit $Code
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  FailVerify "Docker nao foi encontrado." 3
}

$versionJob = Start-Job -ScriptBlock {
  $output = & docker version --format "{{.Server.Version}}" 2>&1
  [pscustomobject]@{
    ExitCode = $LASTEXITCODE
    Output = ($output -join "`n")
  }
}

if (-not (Wait-Job -Job $versionJob -Timeout 15)) {
  Stop-Job -Job $versionJob
  Remove-Job -Job $versionJob -Force
  FailVerify "Docker nao respondeu dentro de 15s." 3
}

$versionResult = Receive-Job -Job $versionJob
Remove-Job -Job $versionJob -Force
if ($versionResult.ExitCode -ne 0 -or -not $versionResult.Output -or ($versionResult.Output -match "Internal Server Error")) {
  FailVerify "Docker foi encontrado, mas o engine nao esta acessivel." 3
}

if (-not $FixturePath) {
  $FixturePath = Join-Path ([System.IO.Path]::GetTempPath()) ("quality-sidecar-fixture-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $FixturePath | Out-Null
  Set-Content -LiteralPath (Join-Path $FixturePath "README.md") -Value "# clean fixture" -Encoding UTF8
}

$fixtureResolved = (Resolve-Path -LiteralPath $FixturePath).Path
$reportsPath = Join-Path $fixtureResolved ".quality/reports"
New-Item -ItemType Directory -Force -Path $reportsPath | Out-Null

docker build -t $Image .
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

docker run --rm `
  -v "${fixtureResolved}:/workspace" `
  -v "${reportsPath}:/workspace/.quality/reports" `
  -w /workspace `
  $Image `
  check /workspace --mode quick --format=json,md

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$reportPath = Join-Path $reportsPath "quality-report.json"
if (-not (Test-Path -LiteralPath $reportPath)) {
  FailVerify "Smoke test nao gerou quality-report.json." 1
}

Write-Output "Docker verification passed for $Image"
Write-Output "Report: $reportPath"
