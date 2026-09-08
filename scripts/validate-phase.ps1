[CmdletBinding()]
param(
  [string]$Manifest = '',
  [ValidateRange(1, 137)]
  [int]$CompletedThrough = 1,
  [string]$RepositoryRoot = '',
  [switch]$ProtocolFixture,
  [switch]$Strict,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Split-Path -Parent $PSScriptRoot
}
$validator = Join-Path $PSScriptRoot 'validate-phase.mjs'
$arguments = @($validator, '--repository-root', $RepositoryRoot, '--completed-through', [string]$CompletedThrough)
if (-not [string]::IsNullOrWhiteSpace($Manifest)) { $arguments += @('--manifest', $Manifest) }
if ($Strict) { $arguments += '--strict' }
if ($ProtocolFixture) { $arguments += '--protocol-fixture' }
if ($Json) { $arguments += '--json' }
$previousEncoding = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  & node @arguments
  $validatorExitCode = $LASTEXITCODE
} finally {
  [Console]::OutputEncoding = $previousEncoding
}
exit $validatorExitCode
