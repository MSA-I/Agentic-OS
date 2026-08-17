[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$dpapiSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AgentOsDpapi
{
    private const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    [StructLayout(LayoutKind.Sequential)]
    private struct DATA_BLOB
    {
        public int cbData;
        public IntPtr pbData;
    }

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(
        ref DATA_BLOB dataIn,
        string description,
        ref DATA_BLOB optionalEntropy,
        IntPtr reserved,
        IntPtr prompt,
        int flags,
        out DATA_BLOB dataOut);

    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DATA_BLOB dataIn,
        IntPtr description,
        ref DATA_BLOB optionalEntropy,
        IntPtr reserved,
        IntPtr prompt,
        int flags,
        out DATA_BLOB dataOut);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static byte[] Protect(byte[] plaintext, byte[] entropy)
    {
        return Transform(plaintext, entropy, true);
    }

    public static byte[] Unprotect(byte[] ciphertext, byte[] entropy)
    {
        return Transform(ciphertext, entropy, false);
    }

    private static byte[] Transform(byte[] input, byte[] entropy, bool protect)
    {
        if (input == null || input.Length == 0) throw new ArgumentException("DPAPI input is empty.");
        if (entropy == null || entropy.Length == 0) throw new ArgumentException("DPAPI entropy is empty.");
        DATA_BLOB inputBlob = Allocate(input);
        DATA_BLOB entropyBlob = Allocate(entropy);
        DATA_BLOB outputBlob = new DATA_BLOB();
        try
        {
            bool succeeded = protect
                ? CryptProtectData(ref inputBlob, "AGENT-OS recovery keyring", ref entropyBlob, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out outputBlob)
                : CryptUnprotectData(ref inputBlob, IntPtr.Zero, ref entropyBlob, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out outputBlob);
            if (!succeeded) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] output = new byte[outputBlob.cbData];
            Marshal.Copy(outputBlob.pbData, output, 0, output.Length);
            return output;
        }
        finally
        {
            ClearAndFree(ref inputBlob);
            ClearAndFree(ref entropyBlob);
            ClearAndLocalFree(ref outputBlob);
        }
    }

    private static DATA_BLOB Allocate(byte[] value)
    {
        DATA_BLOB blob = new DATA_BLOB { cbData = value.Length, pbData = Marshal.AllocHGlobal(value.Length) };
        Marshal.Copy(value, 0, blob.pbData, value.Length);
        return blob;
    }

    private static void ClearAndFree(ref DATA_BLOB blob)
    {
        if (blob.pbData == IntPtr.Zero) return;
        Marshal.Copy(new byte[blob.cbData], 0, blob.pbData, blob.cbData);
        Marshal.FreeHGlobal(blob.pbData);
        blob.pbData = IntPtr.Zero;
        blob.cbData = 0;
    }

    private static void ClearAndLocalFree(ref DATA_BLOB blob)
    {
        if (blob.pbData == IntPtr.Zero) return;
        if (blob.cbData > 0) Marshal.Copy(new byte[blob.cbData], 0, blob.pbData, blob.cbData);
        LocalFree(blob.pbData);
        blob.pbData = IntPtr.Zero;
        blob.cbData = 0;
    }
}
'@
$null = Add-Type -TypeDefinition $dpapiSource -Language CSharp

function Get-RecoveryKeyId {
    param([Parameter(Mandatory = $true)] [string] $Secret)
    if ([string]::IsNullOrWhiteSpace($Secret) -or $Secret.Length -lt 32 -or $Secret.Contains([char] 0)) {
        throw 'Machine recovery keyring secret is invalid.'
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

function Test-KeyringTimestamp {
    param([AllowNull()] [object] $Value)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string] $Value)) { return $false }
    $parsed = [DateTime]::MinValue
    return [DateTime]::TryParse(
        [string] $Value,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref] $parsed
    )
}

function Test-ObjectProperty {
    param(
        [Parameter(Mandatory = $true)] [object] $Value,
        [Parameter(Mandatory = $true)] [string] $Name
    )
    return $null -ne $Value.PSObject.Properties[$Name]
}

function New-KeyringEntry {
    param(
        [Parameter(Mandatory = $true)] [string] $Secret,
        [Parameter(Mandatory = $true)] [ValidateSet('primary', 'bootstrap-legacy')] [string] $Kind,
        [Parameter(Mandatory = $true)] [string] $CreatedAt,
        [AllowNull()] [object] $LastReferencedAt
    )
    return [PSCustomObject]@{
        secret = $Secret
        keyId = Get-RecoveryKeyId -Secret $Secret
        kind = $Kind
        createdAt = $CreatedAt
        lastReferencedAt = $LastReferencedAt
    }
}

function Convert-ToBase64Url {
    param([Parameter(Mandatory = $true)] [byte[]] $Bytes)
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Protect-KeyringDirectory {
    param([Parameter(Mandatory = $true)] [string] $Directory)
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $information = [IO.DirectoryInfo]::new($Directory)
    if (($information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Machine recovery keyring directory cannot be reparse-backed.'
    }
    $acl = [IO.Directory]::GetAccessControl($Directory)
    $owner = ([Security.Principal.NTAccount] $acl.Owner).Translate([Security.Principal.SecurityIdentifier])
    if ($owner.Value -ne $current.Value) { throw 'Machine recovery keyring owner is invalid.' }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
        $null = $acl.RemoveAccessRuleSpecific($rule)
    }
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($identity in @($current, $system)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $identity,
            $rights,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $null = $acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($Directory, $acl)

    Assert-KeyringDirectory -Directory $Directory
}

function Assert-KeyringDirectory {
    param([Parameter(Mandatory = $true)] [string] $Directory)
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $information = [IO.DirectoryInfo]::new($Directory)
    if (($information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Machine recovery keyring directory cannot be reparse-backed.'
    }
    $verified = [IO.Directory]::GetAccessControl($Directory)
    if (-not $verified.AreAccessRulesProtected) { throw 'Machine recovery keyring ACL inheritance is enabled.' }
    $owner = ([Security.Principal.NTAccount] $verified.Owner).Translate([Security.Principal.SecurityIdentifier])
    if ($owner.Value -ne $current.Value) { throw 'Machine recovery keyring owner is invalid.' }
    $allowed = @($current.Value, $system.Value)
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    $currentFullControl = $false
    foreach ($rule in $verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($allowed -notcontains $rule.IdentityReference.Value `
            -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            throw 'Machine recovery keyring ACL contains an unexpected principal.'
        }
        if ($rule.IdentityReference.Value -eq $current.Value `
            -and ($rule.FileSystemRights -band $rights) -eq $rights) {
            $currentFullControl = $true
        }
    }
    if (-not $currentFullControl) { throw 'Machine recovery keyring ACL lacks current-user control.' }
}

function Assert-KeyringFile {
    param([Parameter(Mandatory = $true)] [string] $Path)
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $information = [IO.FileInfo]::new($Path)
    if (($information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 `
        -or $information.Length -le 0 `
        -or $information.Length -gt 1048576) {
        throw 'Machine recovery keyring file is invalid.'
    }
    $acl = [IO.File]::GetAccessControl($Path)
    $owner = ([Security.Principal.NTAccount] $acl.Owner).Translate([Security.Principal.SecurityIdentifier])
    if ($owner.Value -ne $current.Value) { throw 'Machine recovery keyring file owner is invalid.' }
    $allowed = @($current.Value, $system.Value)
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($allowed -notcontains $rule.IdentityReference.Value `
            -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            throw 'Machine recovery keyring file ACL contains an unexpected principal.'
        }
    }
}

function Enter-KeyringFileLock {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [int] $TimeoutMilliseconds
    )
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $lockStream = $null
        try {
            $lockStream = [IO.FileStream]::new(
                $Path,
                [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None,
                1,
                [IO.FileOptions]::WriteThrough
            )
            $information = [IO.FileInfo]::new($Path)
            if (($information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Machine recovery keyring lock file cannot be reparse-backed.'
            }
            return $lockStream
        }
        catch [IO.IOException] {
            if ($null -ne $lockStream) { $lockStream.Dispose() }
            if ($timer.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
                throw 'Machine recovery keyring lock timed out.'
            }
            Start-Sleep -Milliseconds 25
        }
        catch {
            if ($null -ne $lockStream) { $lockStream.Dispose() }
            throw
        }
    }
}

function Read-ProtectedKeyring {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [byte[]] $Entropy
    )
    $plaintext = $null
    $ciphertext = $null
    Assert-KeyringFile -Path $Path
    $ciphertext = [IO.File]::ReadAllBytes($Path)
    try {
        $plaintext = [AgentOsDpapi]::Unprotect($ciphertext, $Entropy)
        return [Text.Encoding]::UTF8.GetString($plaintext) | ConvertFrom-Json
    }
    finally {
        if ($null -ne $ciphertext) { [Array]::Clear($ciphertext, 0, $ciphertext.Length) }
        if ($null -ne $plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
    }
}

function Write-ProtectedKeyring {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [byte[]] $Entropy,
        [Parameter(Mandatory = $true)] [object] $Value
    )
    $plaintext = $null
    $ciphertext = $null
    $temporaryPath = $null
    $backupPath = $null
    $stream = $null
    try {
        $plaintext = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Compress -Depth 6))
        if ($plaintext.Length -gt 786432) {
            throw 'Machine recovery keyring payload exceeds the safe storage limit.'
        }
        $ciphertext = [AgentOsDpapi]::Protect($plaintext, $Entropy)
        $temporaryPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
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
        finally {
            $stream.Dispose()
            $stream = $null
        }
        if ($env:NODE_ENV -ceq 'test' `
            -and [Environment]::GetEnvironmentVariable('AGENT_OS_MACHINE_KEYRING_TEST_FAILPOINT') -ceq 'after-temp-flush') {
            [Environment]::FailFast('Machine recovery keyring test crash after durable temporary-file flush.')
        }
        if ([IO.File]::Exists($Path)) {
            $backupPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).bak"
            [IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)
            if ($env:NODE_ENV -ceq 'test' `
                -and [Environment]::GetEnvironmentVariable('AGENT_OS_MACHINE_KEYRING_TEST_FAILPOINT') -ceq 'after-replace') {
                [Environment]::FailFast('Machine recovery keyring test crash after atomic replace.')
            }
            [IO.File]::Delete($backupPath)
        }
        else {
            [IO.File]::Move($temporaryPath, $Path)
            if ($env:NODE_ENV -ceq 'test' `
                -and [Environment]::GetEnvironmentVariable('AGENT_OS_MACHINE_KEYRING_TEST_FAILPOINT') -ceq 'after-replace') {
                [Environment]::FailFast('Machine recovery keyring test crash after atomic move.')
            }
        }
    }
    finally {
        try {
            if ($null -ne $stream) { $stream.Dispose() }
            if ($null -ne $temporaryPath -and [IO.File]::Exists($temporaryPath)) {
                [IO.File]::Delete($temporaryPath)
            }
            if ($null -ne $backupPath -and [IO.File]::Exists($backupPath)) {
                [IO.File]::Delete($backupPath)
            }
        }
        finally {
            if ($null -ne $plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
            if ($null -ne $ciphertext) { [Array]::Clear($ciphertext, 0, $ciphertext.Length) }
        }
    }
}

$directory = [Environment]::GetEnvironmentVariable('AGENT_OS_MACHINE_KEYRING_DIRECTORY')
if ([string]::IsNullOrWhiteSpace($directory)) { throw 'Machine recovery keyring directory is required.' }
$directory = [IO.Path]::GetFullPath($directory)
if (-not [IO.Path]::IsPathRooted($directory) -or $directory.StartsWith('\\')) {
    throw 'Machine recovery keyring directory must be local and absolute.'
}
$requestJson = [Console]::In.ReadToEnd()
$request = $requestJson | ConvertFrom-Json
if ($request.schemaVersion -ne 2 `
    -or -not (Test-ObjectProperty -Value $request -Name 'legacySecret')) {
    throw 'Machine recovery keyring request is invalid.'
}
$legacySecret = [string] $request.legacySecret
$currentLegacyKeyId = $null
if (-not [string]::IsNullOrWhiteSpace($legacySecret)) {
    if ($legacySecret.Length -lt 32 -or $legacySecret.Contains([char] 0)) {
        throw 'Machine recovery keyring legacy secret is invalid.'
    }
    $currentLegacyKeyId = Get-RecoveryKeyId -Secret $legacySecret
}
$directoryParent = [IO.Path]::GetDirectoryName($directory)
if ([string]::IsNullOrWhiteSpace($directoryParent)) { throw 'Machine recovery keyring parent is invalid.' }
$path = [IO.Path]::Combine($directory, 'recovery-keyring.v1.dpapi')
$lockPath = "$directory.recovery-keyring.lock"
$fileLock = $null
$entropy = $null
try {
    $null = [IO.Directory]::CreateDirectory($directoryParent)
    $fileLock = Enter-KeyringFileLock -Path $lockPath -TimeoutMilliseconds 30000
    $directoryExisted = [IO.Directory]::Exists($directory)
    $null = [IO.Directory]::CreateDirectory($directory)
    if ($directoryExisted) { Assert-KeyringDirectory -Directory $directory }
    else { Protect-KeyringDirectory -Directory $directory }
    $entropy = [Text.Encoding]::UTF8.GetBytes("agent-os/windows-job-machine-keyring/v1`0$($path.ToLowerInvariant())")
    $now = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    $keys = [Collections.Generic.List[object]]::new()
    $knownKeyIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    if ([IO.File]::Exists($path)) {
        $storedKeyring = Read-ProtectedKeyring -Path $path -Entropy $entropy
        if (-not (Test-ObjectProperty -Value $storedKeyring -Name 'schemaVersion') `
            -or -not (Test-ObjectProperty -Value $storedKeyring -Name 'createdAt') `
            -or -not (Test-ObjectProperty -Value $storedKeyring -Name 'updatedAt') `
            -or -not (Test-KeyringTimestamp -Value $storedKeyring.createdAt) `
            -or -not (Test-KeyringTimestamp -Value $storedKeyring.updatedAt)) {
            throw 'Machine recovery keyring payload is invalid.'
        }
        $keyringCreatedAt = [string] $storedKeyring.createdAt
        if ($storedKeyring.schemaVersion -eq 1) {
            if (-not (Test-ObjectProperty -Value $storedKeyring -Name 'primarySecret') `
                -or -not (Test-ObjectProperty -Value $storedKeyring -Name 'legacySecrets')) {
                throw 'Machine recovery keyring payload is invalid.'
            }
            $primarySecret = [string] $storedKeyring.primarySecret
            if ([string]::IsNullOrWhiteSpace($primarySecret) -or $primarySecret.Length -lt 32 -or $primarySecret.Contains([char] 0)) {
                throw 'Machine recovery keyring payload is invalid.'
            }
            $primaryEntry = New-KeyringEntry -Secret $primarySecret -Kind 'primary' -CreatedAt $keyringCreatedAt -LastReferencedAt $null
            $null = $keys.Add($primaryEntry)
            $null = $knownKeyIds.Add([string] $primaryEntry.keyId)
            foreach ($candidate in @($storedKeyring.legacySecrets)) {
                $storedLegacySecret = [string] $candidate
                if ([string]::IsNullOrWhiteSpace($storedLegacySecret) `
                    -or $storedLegacySecret.Length -lt 32 `
                    -or $storedLegacySecret.Contains([char] 0)) {
                    throw 'Machine recovery keyring payload is invalid.'
                }
                $entry = New-KeyringEntry -Secret $storedLegacySecret -Kind 'bootstrap-legacy' -CreatedAt $keyringCreatedAt -LastReferencedAt $null
                if ($knownKeyIds.Add([string] $entry.keyId)) { $null = $keys.Add($entry) }
            }
        }
        elseif ($storedKeyring.schemaVersion -eq 2) {
            if (-not (Test-ObjectProperty -Value $storedKeyring -Name 'keys')) {
                throw 'Machine recovery keyring payload is invalid.'
            }
            $primaryCount = 0
            foreach ($storedEntry in @($storedKeyring.keys)) {
                if ($null -eq $storedEntry `
                    -or -not (Test-ObjectProperty -Value $storedEntry -Name 'secret') `
                    -or -not (Test-ObjectProperty -Value $storedEntry -Name 'keyId') `
                    -or -not (Test-ObjectProperty -Value $storedEntry -Name 'kind') `
                    -or -not (Test-ObjectProperty -Value $storedEntry -Name 'createdAt') `
                    -or -not (Test-ObjectProperty -Value $storedEntry -Name 'lastReferencedAt')) {
                    throw 'Machine recovery keyring payload is invalid.'
                }
                $secret = [string] $storedEntry.secret
                $storedKeyId = [string] $storedEntry.keyId
                $kind = [string] $storedEntry.kind
                if ([string]::IsNullOrWhiteSpace($secret) `
                    -or $secret.Length -lt 32 `
                    -or $secret.Contains([char] 0) `
                    -or $storedKeyId -cnotmatch '^[0-9a-f]{64}$' `
                    -or $storedKeyId -ne (Get-RecoveryKeyId -Secret $secret) `
                    -or @('primary', 'bootstrap-legacy') -notcontains $kind `
                    -or -not (Test-KeyringTimestamp -Value $storedEntry.createdAt) `
                    -or ($null -ne $storedEntry.lastReferencedAt -and -not (Test-KeyringTimestamp -Value $storedEntry.lastReferencedAt)) `
                    -or -not $knownKeyIds.Add($storedKeyId)) {
                    throw 'Machine recovery keyring payload is invalid.'
                }
                if ($kind -eq 'primary') { $primaryCount += 1 }
                $null = $keys.Add([PSCustomObject]@{
                    secret = $secret
                    keyId = $storedKeyId
                    kind = $kind
                    createdAt = [string] $storedEntry.createdAt
                    lastReferencedAt = $storedEntry.lastReferencedAt
                })
            }
            if ($primaryCount -ne 1) { throw 'Machine recovery keyring payload is invalid.' }
        }
        else { throw 'Machine recovery keyring payload is invalid.' }
    }
    else {
        $primaryBytes = [byte[]]::new(32)
        try {
            $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($primaryBytes) }
            finally { $rng.Dispose() }
            $keyringCreatedAt = $now
            $primaryEntry = New-KeyringEntry `
                -Secret (Convert-ToBase64Url -Bytes $primaryBytes) `
                -Kind 'primary' `
                -CreatedAt $keyringCreatedAt `
                -LastReferencedAt $null
            $null = $keys.Add($primaryEntry)
            $null = $knownKeyIds.Add([string] $primaryEntry.keyId)
        }
        finally { [Array]::Clear($primaryBytes, 0, $primaryBytes.Length) }
    }

    if ($null -ne $currentLegacyKeyId -and -not $knownKeyIds.Contains($currentLegacyKeyId)) {
        $currentEntry = New-KeyringEntry `
            -Secret $legacySecret `
            -Kind 'bootstrap-legacy' `
            -CreatedAt $now `
            -LastReferencedAt $null
        $null = $keys.Add($currentEntry)
        $null = $knownKeyIds.Add($currentLegacyKeyId)
    }

    # Recovery keys are monotonic. Descriptor discovery cannot be made atomic
    # with this DPAPI file, so deleting an apparently unreferenced key here
    # could make a concurrently-created descriptor unrecoverable. The bounded
    # encrypted payload limit in Write-ProtectedKeyring is the fail-closed cap.
    $primaryEntries = @($keys | Where-Object { [string] $_.kind -eq 'primary' })
    if ($primaryEntries.Count -ne 1) { throw 'Machine recovery keyring payload is invalid.' }
    $keyring = [PSCustomObject]@{
        schemaVersion = 2
        keys = [object[]] $keys.ToArray()
        createdAt = $keyringCreatedAt
        updatedAt = $now
    }
    Write-ProtectedKeyring -Path $path -Entropy $entropy -Value $keyring
    $legacyOutput = @($keys | Where-Object { [string] $_.kind -ne 'primary' } | ForEach-Object { [string] $_.secret })
    $output = [ordered]@{
        schemaVersion = 1
        primarySecret = [string] $primaryEntries[0].secret
        legacySecrets = [string[]] $legacyOutput
    }
    [Console]::Out.Write(($output | ConvertTo-Json -Compress -Depth 4))
}
finally {
    $legacySecret = $null
    if ($null -ne $entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
    if ($null -ne $fileLock) { $fileLock.Dispose() }
}
