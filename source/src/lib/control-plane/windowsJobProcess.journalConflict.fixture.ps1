param(
  [Parameter(Mandatory = $true)][string]$JournalPath,
  [Parameter(Mandatory = $true)][string]$ConflictJournalPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath
)

$ErrorActionPreference = 'Stop'
$lockPath = "$JournalPath.lock"
$lock = [System.IO.FileStream]::new(
  $lockPath,
  [System.IO.FileMode]::OpenOrCreate,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::None
)
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($ReadyPath, '{"ready":true}', $utf8)
  $directory = [System.IO.Path]::GetDirectoryName($JournalPath)
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $desired = $null
  $expected = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $desired = [System.IO.Directory]::GetFiles($directory, '.controller-terminal-journal.*.tmp') |
      Where-Object { -not $_.EndsWith('.expected.tmp', [StringComparison]::OrdinalIgnoreCase) } |
      Select-Object -First 1
    $expected = [System.IO.Directory]::GetFiles($directory, '.controller-terminal-journal.*.expected.tmp') |
      Select-Object -First 1
    if ($null -ne $desired -and $null -ne $expected) { break }
    Start-Sleep -Milliseconds 20
  }
  if ($null -eq $desired -or $null -eq $expected) {
    throw 'Timed out waiting for controller journal commit temporaries.'
  }

  $conflictBytes = [System.IO.File]::ReadAllBytes($ConflictJournalPath)
  $journal = [System.IO.FileStream]::new(
    $JournalPath,
    [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::Read
  )
  try {
    $journal.Write($conflictBytes, 0, $conflictBytes.Length)
    $journal.Flush($true)
  }
  finally {
    $journal.Dispose()
  }
  [Console]::Out.Write('{"published":true}')
}
finally {
  $lock.Dispose()
}
