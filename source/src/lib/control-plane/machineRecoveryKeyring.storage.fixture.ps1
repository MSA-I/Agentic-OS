[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)] [byte[]] $Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $sha.Dispose() }
}

function Get-RecoveryKeyId {
    param([Parameter(Mandatory = $true)] [string] $Secret)
    if ([string]::IsNullOrWhiteSpace($Secret) -or $Secret.Length -lt 32 -or $Secret.Contains([char] 0)) {
        throw 'Fixture recovery secret is invalid.'
    }
    $secretBytes = [Text.Encoding]::UTF8.GetBytes($Secret)
    $messageBytes = [Text.Encoding]::UTF8.GetBytes('agent-os/windows-job-recovery/key-id/v1')
    $hmac = [Security.Cryptography.HMACSHA256]::new($secretBytes)
    try { return (($hmac.ComputeHash($messageBytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally {
        $hmac.Dispose()
        [Array]::Clear($secretBytes, 0, $secretBytes.Length)
        [Array]::Clear($messageBytes, 0, $messageBytes.Length)
    }
}

function Get-StoragePath {
    $candidate = [Environment]::GetEnvironmentVariable('AGENT_OS_TEST_KEYRING_STORAGE_PATH')
    if ([string]::IsNullOrWhiteSpace($candidate)) { throw 'Fixture storage path is required.' }
    $resolved = [IO.Path]::GetFullPath($candidate)
    if (-not [IO.Path]::IsPathRooted($resolved) -or $resolved.StartsWith('\\')) {
        throw 'Fixture storage path must be local and absolute.'
    }
    $information = [IO.FileInfo]::new($resolved)
    if (-not $information.Exists -or ($information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Fixture storage file is invalid.'
    }
    return $resolved
}

function Get-Entropy {
    param([Parameter(Mandatory = $true)] [string] $Path)
    return [Text.Encoding]::UTF8.GetBytes("agent-os/windows-job-machine-keyring/v1`0$($Path.ToLowerInvariant())")
}

function Protect-Payload {
    param(
        [Parameter(Mandatory = $true)] [object] $Value,
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [byte[]] $Entropy
    )
    $plaintext = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Compress -Depth 6))
    $ciphertext = [Security.Cryptography.ProtectedData]::Protect(
        $plaintext,
        $Entropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $temporaryPath = "$Path.fixture.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $backupPath = "$Path.fixture.$PID.bak"
    try {
        $stream = [IO.FileStream]::new(
            $temporaryPath,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        try {
            $stream.Write($ciphertext, 0, $ciphertext.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        [IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)
        [IO.File]::Delete($backupPath)
    }
    finally {
        if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
        if ([IO.File]::Exists($backupPath)) { [IO.File]::Delete($backupPath) }
        [Array]::Clear($plaintext, 0, $plaintext.Length)
        [Array]::Clear($ciphertext, 0, $ciphertext.Length)
    }
}

function Read-Payload {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [byte[]] $Entropy
    )
    $ciphertext = [IO.File]::ReadAllBytes($Path)
    $plaintext = $null
    try {
        $plaintext = [Security.Cryptography.ProtectedData]::Unprotect(
            $ciphertext,
            $Entropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [PSCustomObject]@{
            value = ([Text.Encoding]::UTF8.GetString($plaintext) | ConvertFrom-Json)
            ciphertextSha256 = Get-Sha256Hex -Bytes $ciphertext
        }
    }
    finally {
        [Array]::Clear($ciphertext, 0, $ciphertext.Length)
        if ($null -ne $plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
    }
}

$requestJson = [Console]::In.ReadToEnd()
$request = $requestJson | ConvertFrom-Json
if ($request.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string] $request.action)) {
    throw 'Fixture request is invalid.'
}
$path = Get-StoragePath
$entropy = Get-Entropy -Path $path
try {
    if ([string] $request.action -eq 'seed-v1') {
        $primarySecret = [string] $request.primarySecret
        $null = Get-RecoveryKeyId -Secret $primarySecret
        $legacySecrets = [Collections.Generic.List[string]]::new()
        foreach ($candidate in @($request.legacySecrets)) {
            $secret = [string] $candidate
            $null = Get-RecoveryKeyId -Secret $secret
            $null = $legacySecrets.Add($secret)
        }
        $createdAt = [string] $request.createdAt
        $updatedAt = [string] $request.updatedAt
        if ([string]::IsNullOrWhiteSpace($createdAt) -or [string]::IsNullOrWhiteSpace($updatedAt)) {
            throw 'Fixture timestamps are invalid.'
        }
        $payload = [PSCustomObject]@{
            schemaVersion = 1
            primarySecret = $primarySecret
            legacySecrets = [string[]] $legacySecrets.ToArray()
            createdAt = $createdAt
            updatedAt = $updatedAt
        }
        Protect-Payload -Value $payload -Path $path -Entropy $entropy
        [Console]::Out.Write('{"seededSchemaVersion":1}')
    }
    elseif ([string] $request.action -eq 'inspect') {
        $stored = Read-Payload -Path $path -Entropy $entropy
        $value = $stored.value
        $secrets = [Collections.Generic.List[string]]::new()
        $primarySecret = $null
        if ($value.schemaVersion -eq 1) {
            $primarySecret = [string] $value.primarySecret
            $null = $secrets.Add($primarySecret)
            foreach ($candidate in @($value.legacySecrets)) { $null = $secrets.Add([string] $candidate) }
        }
        elseif ($value.schemaVersion -eq 2) {
            foreach ($entry in @($value.keys)) {
                $secret = [string] $entry.secret
                $null = $secrets.Add($secret)
                if ([string] $entry.kind -eq 'primary') { $primarySecret = $secret }
            }
        }
        else { throw 'Fixture found an unsupported storage schema.' }
        if ([string]::IsNullOrWhiteSpace($primarySecret)) { throw 'Fixture found no primary key.' }
        $keyIds = @($secrets | ForEach-Object { Get-RecoveryKeyId -Secret $_ } | Sort-Object -Unique)
        $output = [ordered]@{
            schemaVersion = [int] $value.schemaVersion
            primaryKeyId = Get-RecoveryKeyId -Secret $primarySecret
            keyIds = [string[]] $keyIds
            ciphertextSha256 = [string] $stored.ciphertextSha256
        }
        [Console]::Out.Write(($output | ConvertTo-Json -Compress -Depth 3))
    }
    else { throw 'Fixture action is unsupported.' }
}
finally { [Array]::Clear($entropy, 0, $entropy.Length) }
