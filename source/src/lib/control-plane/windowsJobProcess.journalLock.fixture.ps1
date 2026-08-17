param(
  [Parameter(Mandatory = $true)][string]$JournalPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][int]$HoldMilliseconds
)

$stream = [System.IO.File]::Open(
  $JournalPath,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::Read
)
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($ReadyPath, '{"ready":true}', $utf8)
  Start-Sleep -Milliseconds $HoldMilliseconds
}
finally {
  $stream.Dispose()
}
