param(
  [Parameter(Mandatory = $true)][string]$LauncherPath,
  [Parameter(Mandatory = $true)][string]$JournalPath,
  [Parameter(Mandatory = $true)][string]$DesiredPath,
  [Parameter(Mandatory = $true)][string]$ExpectedPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$BarrierPath
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($ReadyPath, '{"ready":true}', $utf8)
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (-not [System.IO.File]::Exists($BarrierPath)) {
  if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out waiting for journal commit race barrier.' }
  Start-Sleep -Milliseconds 10
}

& $LauncherPath `
  -JournalCommitPath $JournalPath `
  -JournalCommitDesiredPath $DesiredPath `
  -JournalCommitExpectedPath $ExpectedPath
exit $LASTEXITCODE
