$ErrorActionPreference = "Stop"

function FailQualityGate([string]$Message, [int]$Code = 3) {
  [Console]::Error.WriteLine($Message)
  exit $Code
}

function TakeValue([string[]]$Items, [int]$Index, [string]$Flag, [bool]$AllowFlagValue = $false) {
  if (($Index + 1) -ge $Items.Count -or ((-not $AllowFlagValue) -and $Items[$Index + 1].StartsWith("--"))) {
    FailQualityGate "Valor ausente para $Flag"
  }
  return $Items[$Index + 1]
}

function NormalizeFormatValue([string]$Value) {
  return (($Value.Trim() -split "[\s,]+") | Where-Object { $_ }) -join ","
}

$RawArgs = @($args)
$Target = "."
$Image = if ($env:QUALITY_SIDECAR_IMAGE) { $env:QUALITY_SIDECAR_IMAGE } else { "jgates/quality-sidecar:latest" }
$Pull = $false
$NoPull = $false
$Build = -not ($env:QUALITY_GATE_AUTO_BUILD -eq "0" -or $env:QUALITY_GATE_NO_BUILD -eq "1")
$DebugDocker = $false
$DockerArgs = New-Object System.Collections.Generic.List[string]
$ContainerArgs = New-Object System.Collections.Generic.List[string]

if ($RawArgs.Count -gt 0 -and -not $RawArgs[0].StartsWith("-")) {
  $Target = $RawArgs[0]
  if ($RawArgs.Count -gt 1) {
    $RawArgs = $RawArgs[1..($RawArgs.Count - 1)]
  } else {
    $RawArgs = @()
  }
}

for ($i = 0; $i -lt $RawArgs.Count; $i++) {
  $arg = $RawArgs[$i]

  if ($arg -in @("--image", "-Image", "-image")) {
    $Image = TakeValue -Items $RawArgs -Index $i -Flag $arg
    $i++
    continue
  }

  if ($arg.StartsWith("--image=")) {
    $Image = $arg.Substring("--image=".Length)
    continue
  }

  if ($arg -in @("--pull", "-Pull", "-pull")) {
    $Pull = $true
    continue
  }

  if ($arg -in @("--no-pull", "-NoPull", "-noPull")) {
    $NoPull = $true
    continue
  }

  if ($arg -in @("--build", "-Build", "-build")) {
    $Build = $true
    continue
  }

  if ($arg -in @("--no-build", "-NoBuild", "-noBuild")) {
    $Build = $false
    continue
  }

  if ($arg -in @("--debug-docker", "-DebugDocker", "-debugDocker")) {
    $DebugDocker = $true
    continue
  }

  if ($arg -in @("--docker-arg", "-DockerArg", "-dockerArg")) {
    $DockerArgs.Add((TakeValue -Items $RawArgs -Index $i -Flag $arg -AllowFlagValue $true))
    $i++
    continue
  }

  if ($arg.StartsWith("--docker-arg=")) {
    $DockerArgs.Add($arg.Substring("--docker-arg=".Length))
    continue
  }

  if ($arg -eq "--format") {
    $ContainerArgs.Add($arg)
    $ContainerArgs.Add((NormalizeFormatValue (TakeValue -Items $RawArgs -Index $i -Flag $arg)))
    $i++
    continue
  }

  if ($arg.StartsWith("--format=")) {
    $ContainerArgs.Add("--format=" + (NormalizeFormatValue $arg.Substring("--format=".Length)))
    continue
  }

  $ContainerArgs.Add($arg)
}

if ($Pull -and $NoPull) {
  $Pull = $false
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  FailQualityGate "Docker nao foi encontrado. Instale/inicie o Docker ou use uma alternativa compativel antes de rodar quality-gate."
}

function TestDockerAvailable {
  $job = Start-Job -ScriptBlock {
    $output = & docker version --format "{{.Server.Version}}" 2>&1
    [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      Output = ($output -join "`n")
    }
  }

  if (-not (Wait-Job -Job $job -Timeout 15)) {
    Stop-Job -Job $job
    Remove-Job -Job $job -Force
    return $false
  }

  $result = Receive-Job -Job $job
  Remove-Job -Job $job -Force
  return ($result.ExitCode -eq 0 -and $result.Output -and ($result.Output -notmatch "Internal Server Error"))
}

if (-not (TestDockerAvailable)) {
  FailQualityGate "Docker foi encontrado, mas nao parece estar iniciado ou acessivel. Abra/inicie o servico Docker e tente novamente."
}

$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function TestBundledBuildContext {
  return (
    (Test-Path -LiteralPath (Join-Path $PackageRoot "Dockerfile") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $PackageRoot "sidecar") -PathType Container) -and
    (Test-Path -LiteralPath (Join-Path $PackageRoot "docker/entrypoint.sh") -PathType Leaf)
  )
}

function TestDockerImage([string]$ImageName) {
  & docker image inspect $ImageName *> $null
  return ($LASTEXITCODE -eq 0)
}

function BuildBundledImage([string]$ImageName) {
  if (-not (TestBundledBuildContext)) {
    FailQualityGate "Imagem Docker $ImageName nao encontrada localmente e esta instalacao nao inclui o contexto de build do sidecar. Use --pull, --image <imagem-existente> ou instale a partir do repositorio/pacote completo."
  }

  [Console]::Error.WriteLine("Imagem Docker $ImageName nao encontrada localmente. Construindo a imagem quality-sidecar embarcada...")
  & docker build -t $ImageName $PackageRoot
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

try {
  $TargetPath = (Resolve-Path -LiteralPath $Target).Path
} catch {
  FailQualityGate "Pasta alvo nao encontrada: $Target"
}

if (-not (Test-Path -LiteralPath $TargetPath -PathType Container)) {
  FailQualityGate "A pasta alvo precisa ser um diretorio: $TargetPath"
}

$ReportsPath = Join-Path $TargetPath ".quality/reports"
New-Item -ItemType Directory -Force -Path $ReportsPath | Out-Null

if ($Pull) {
  & docker pull $Image
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

if ($Build -and -not (TestDockerImage $Image)) {
  BuildBundledImage $Image
}

$RunArgs = New-Object System.Collections.Generic.List[string]
$RunArgs.Add("run")
$RunArgs.Add("--rm")
$RunArgs.Add("--user")
$RunArgs.Add("0")
$RunArgs.Add("-e")
$RunArgs.Add("QUALITY_GATE_SCOPE=full")
foreach ($item in $DockerArgs) { $RunArgs.Add($item) }
$RunArgs.Add("-v")
$RunArgs.Add("${TargetPath}:/workspace")
$RunArgs.Add("-v")
$RunArgs.Add("${ReportsPath}:/workspace/.quality/reports")
$RunArgs.Add("-w")
$RunArgs.Add("/workspace")
$RunArgs.Add($Image)
$RunArgs.Add("check")
$RunArgs.Add("/workspace")
foreach ($item in $ContainerArgs) { $RunArgs.Add($item) }

if ($DebugDocker) {
  Write-Information ("docker " + ($RunArgs -join " ")) -InformationAction Continue
}

& docker @RunArgs
exit $LASTEXITCODE
