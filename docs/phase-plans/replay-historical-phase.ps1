[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Validator,
  [Parameter(Mandatory = $true)][string]$Manifest,
  [Parameter(Mandatory = $true)][string]$OriginalRepositoryRoot,
  [Parameter(Mandatory = $true)][string]$RelocatedRepositoryRoot,
  [Parameter(Mandatory = $true)][string]$RoadmapDirectory,
  [Parameter(Mandatory = $true)][string]$OriginalBaselineCommit,
  [Parameter(Mandatory = $true)][string]$OriginalArtifactCommit
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

# Relocate only the three verified absolute root values during JSON deserialization.
# Validator source, files, commits, hashes and every assertion remain unchanged.
function ConvertFrom-Json {
  [CmdletBinding()]
  param([Parameter(ValueFromPipeline = $true)][string]$InputObject)
  process {
    $value = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $InputObject
    $isState = $value.lastArtifactCommit -ceq $OriginalArtifactCommit -and $value.completedThrough -eq 0 -and $value.currentPhase -eq 1
    $isBootstrap = $value.startupId -ceq 'phase000-20260908T122425Z' -and $value.initialState.currentPhase -eq 0 -and $value.initialState.completedThrough -eq -1
    if ($value.baselineCommit -ceq $OriginalBaselineCommit -and ($isState -or $isBootstrap)) {
      $suffixes = @{ repositoryRoot = ''; roadmapRoot = "/$RoadmapDirectory"; projectRoot = "/$RoadmapDirectory/project" }
      foreach ($key in @('repositoryRoot', 'roadmapRoot', 'projectRoot')) {
        $expectedOriginal = $OriginalRepositoryRoot.Replace('\', '/').TrimEnd('/') + $suffixes[$key]
        if ($value.PSObject.Properties.Name -contains $key -and $value.$key -ceq $expectedOriginal) {
          $value.$key = $RelocatedRepositoryRoot.Replace('\', '/').TrimEnd('/') + $suffixes[$key]
        }
      }
    }
    $value
  }
}
& $Validator -Manifest $Manifest -CompletedThrough 0 -Strict -Json
exit $LASTEXITCODE
