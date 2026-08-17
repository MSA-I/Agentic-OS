import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

export interface ArtifactQuota {
  maximumArtifactBytes: number;
  maximumRunBytes: number;
  maximumStoreBytes: number;
  maximumBlobCount: number;
  maximumReferenceCount: number;
  maximumRunReferenceCount: number;
  maximumIntentCount: number;
  maximumMetadataBytes: number;
  maximumDatabaseBytes: number;
}

export interface ArtifactRetentionPolicy {
  maximumReferenceAgeMs: number;
  garbageCollectUnreferencedBlobs: boolean;
}

export interface StoredArtifact {
  id: string;
  runId: string;
  contentHash: string;
  bytes: number;
  label: string;
  createdAt: string;
  deduplicated: boolean;
}

export type ArtifactFaultPoint =
  | "before_database_open"
  | "before_database_close"
  | "after_intent_commit"
  | "after_temp_write"
  | "after_blob_publish_source_pin"
  | "after_rename"
  | "after_file_fsync"
  | "before_blob_insert"
  | "after_blob_insert"
  | "before_commit"
  | "after_commit"
  | "before_wal_checkpoint"
  | "after_wal_checkpoint"
  | "after_gc_ledger_commit"
  | "after_gc_intent_insert"
  | "after_gc_file_delete"
  | "before_backup_parent_open"
  | "after_backup_lock_acquired"
  | "after_backup_database"
  | "after_backup_blob_copy"
  | "before_backup_manifest"
  | "after_backup_manifest"
  | "after_backup_publish_source_pin"
  | "after_backup_publish"
  | "before_restore_parent_open"
  | "after_restore_database_source_pin"
  | "after_restore_database_copy"
  | "after_restore_blob_source_pin"
  | "after_restore_blob_copy"
  | "before_restore_manifest_copy"
  | "after_restore_manifest_source_pin"
  | "after_restore_manifest_copy"
  | "after_restore_publish_source_pin"
  | "after_staging_cleanup_source_pin";

export type ArtifactFaultInjector = (point: ArtifactFaultPoint) => void;
export interface ArtifactBackup {
  schemaVersion: 1;
  bundlePath: string;
  manifestPath: string;
  path: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  blobDirectory: string;
  blobs: Array<{ contentHash: string; relativePath: string; bytes: number }>;
}

interface ArtifactBackupManifest {
  schemaVersion: 1;
  createdAt: string;
  database: { relativePath: string; sha256: string; bytes: number };
  blobs: Array<{ contentHash: string; relativePath: string; bytes: number }>;
  policyHash: string;
  migrations: Array<{ version: number; name: string; checksum: string }>;
}

interface ArtifactBackupLockDocument {
  schemaVersion: 1;
  token: string;
  pid: number;
  createdAt: string;
  leaseExpiresAt: string;
}

interface ArtifactBlobRow {
  content_hash: string;
  bytes: number;
  relative_path: string;
  created_at: string;
}

interface ArtifactReferenceRow {
  id: string;
  run_id: string;
  content_hash: string;
  label: string;
  created_at: string;
}

interface ArtifactWriteIntentRow {
  intent_id: string;
  content_hash: string;
  bytes: number;
  relative_path: string;
  run_id: string;
  label: string;
  reference_id: string;
  created_at: string;
  owner_pid: number;
  lease_expires_at: string;
}

interface ArtifactGcIntentRow {
  content_hash: string;
  bytes: number;
  relative_path: string;
  created_at: string;
}

interface ArtifactPolicyDocument {
  schemaVersion: 1;
  quota: ArtifactQuota;
  retention: ArtifactRetentionPolicy;
  intentLeaseMs: number;
}

interface ArtifactMigration {
  version: number;
  name: string;
  sql: string;
}

interface StagingOwnerLease {
  database: DatabaseSync;
  path: string;
  guardLease: string;
}

interface SchemaEntry {
  type: string;
  name: string;
  tableName: string;
  sql: string | null;
}

const DEFAULT_QUOTA: ArtifactQuota = Object.freeze({
  maximumArtifactBytes: 25 * 1024 * 1024,
  maximumRunBytes: 200 * 1024 * 1024,
  maximumStoreBytes: 2 * 1024 * 1024 * 1024,
  maximumBlobCount: 100_000,
  maximumReferenceCount: 250_000,
  maximumRunReferenceCount: 10_000,
  maximumIntentCount: 1_000,
  maximumMetadataBytes: 128 * 1024 * 1024,
  maximumDatabaseBytes: 512 * 1024 * 1024,
});

const DEFAULT_RETENTION: ArtifactRetentionPolicy = Object.freeze({
  maximumReferenceAgeMs: 90 * 24 * 60 * 60 * 1_000,
  garbageCollectUnreferencedBlobs: true,
});

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/u;
const CONTENT_HASH = /^[a-f0-9]{64}$/u;
const DEFAULT_INTENT_LEASE_MS = 30_000;
const POLICY_ID = 1;
const DATABASE_NAME = "artifacts.sqlite3";
const SQLITE_SIDECAR_RESERVE_BYTES = 64 * 1024;
const SQLITE_RECOVERY_RESERVE_BYTES = 64 * 1024;
const SQLITE_MINIMUM_DATABASE_BYTES = 192 * 1024;
const SQLITE_TRANSACTION_RESERVE_BYTES = 64 * 1024;
const RECOVERY_RESERVE_NAME = ".artifact-db-recovery.reserve";
const BACKUP_LOCK_NAME = ".artifact-backup.lock";
const BACKUP_MUTEX_NAME = ".artifact-backup-mutex.sqlite3";
const STAGING_OWNER_SUFFIX = ".owner.sqlite3";
const BACKUP_LOCK_LEASE_MS = 5 * 60 * 1_000;
const GC_BATCH_SIZE = 32;
const RETENTION_BATCH_SIZE = 100;
const BACKUP_MANIFEST_NAME = "manifest.json";
const BACKUP_MANIFEST_MAXIMUM_BYTES = 16 * 1024 * 1024;
const STALE_STAGING_AGE_MS = 10 * 60 * 1_000;
const WINDOWS_REPARSE_IDENTITY_CACHE = new Map<string, string>();
const CHECKPOINT_WAIT_STATE = new Int32Array(new SharedArrayBuffer(4));
const NATIVE_GUARD_RESPONSE_BYTES = 64 * 1024;
const NATIVE_GUARD_TIMEOUT_MS = 30_000;
const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_INITIALIZATION_ATTEMPTS = 3;
const MIGRATION_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS artifact_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;
let EXPECTED_SCHEMA_EVIDENCE: {
  entries: SchemaEntry[];
  hash: string;
  indexes: Record<string, unknown>;
  foreignKeys: Record<string, unknown>;
} | undefined;
const WINDOWS_NATIVE_GUARD_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class ArtifactPathPins
{
    private const uint FILE_READ_ATTRIBUTES = 0x80;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint FILE_SHARE_DELETE = 0x4;
    private const uint CREATE_NEW = 1;
    private const uint OPEN_EXISTING = 3;
    private const uint OPEN_ALWAYS = 4;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x80;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint MOVEFILE_WRITE_THROUGH = 0x8;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME { public uint Low; public uint High; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle handle, StringBuilder path, uint length, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(string existing, string destination, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(
        SafeFileHandle handle, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        SafeFileHandle handle, byte[] buffer, uint bytesToWrite, out uint bytesWritten, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(SafeFileHandle handle);

    private static readonly Dictionary<string, SafeFileHandle> Pins =
        new Dictionary<string, SafeFileHandle>(StringComparer.Ordinal);

    private static Exception Win32(string action)
    {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, action + " (Win32 " + code + ")");
    }

    private static string NormalizeFinalPath(string value)
    {
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            return @"\\" + value.Substring(8);
        if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
            return value.Substring(4);
        return value;
    }

    private static string ExtendedPath(string value)
    {
        string fullPath = Path.GetFullPath(value);
        if (fullPath.StartsWith(@"\\", StringComparison.Ordinal))
            return @"\\?\UNC\" + fullPath.Substring(2);
        return @"\\?\" + fullPath;
    }

    private static bool IsContained(string root, string candidate)
    {
        string canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        string canonicalCandidate = Path.GetFullPath(candidate);
        return canonicalCandidate.Equals(canonicalRoot, StringComparison.OrdinalIgnoreCase)
            || canonicalCandidate.StartsWith(canonicalRoot + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase);
    }

    private static string Describe(SafeFileHandle handle)
    {
        BY_HANDLE_FILE_INFORMATION info;
        if (!GetFileInformationByHandle(handle, out info)) throw Win32("GetFileInformationByHandle failed");
        if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            throw new IOException("Pinned artifact path is a reparse point.");
        StringBuilder finalPath = new StringBuilder(32768);
        uint written = GetFinalPathNameByHandleW(handle, finalPath, (uint)finalPath.Capacity, 0);
        if (written == 0 || written >= finalPath.Capacity) throw Win32("GetFinalPathNameByHandleW failed");
        return NormalizeFinalPath(finalPath.ToString()) + "|" + info.VolumeSerialNumber.ToString("x8") + ":"
            + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
    }

    private static string IdentityKey(string identity)
    {
        int separator = identity.LastIndexOf('|');
        if (separator < 0) throw new IOException("Pinned artifact identity is malformed.");
        return identity.Substring(separator + 1);
    }

    private static string IdentityPath(string identity)
    {
        int separator = identity.LastIndexOf('|');
        if (separator < 0) throw new IOException("Pinned artifact identity is malformed.");
        return identity.Substring(0, separator);
    }

    private static SafeFileHandle RequirePin(string token)
    {
        SafeFileHandle handle;
        if (!Pins.TryGetValue(token, out handle) || handle == null || handle.IsInvalid || handle.IsClosed)
            throw new IOException("Pinned artifact handle is unavailable.");
        return handle;
    }

    private static string Pin(string token, string requestedPath, bool directory, bool shareWrite,
        bool shareDelete, bool createFile, bool readData)
    {
        string fullPath = Path.GetFullPath(requestedPath);
        uint access = FILE_READ_ATTRIBUTES | (directory ? GENERIC_READ : 0)
            | (createFile ? GENERIC_WRITE : 0) | (readData ? GENERIC_READ : 0);
        uint share = FILE_SHARE_READ | (shareWrite ? FILE_SHARE_WRITE : 0)
            | (shareDelete ? FILE_SHARE_DELETE : 0);
        uint flags = FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_ATTRIBUTE_NORMAL);
        SafeFileHandle handle = CreateFileW(ExtendedPath(fullPath), access, share, IntPtr.Zero,
            createFile ? OPEN_ALWAYS : OPEN_EXISTING, flags, IntPtr.Zero);
        if (handle.IsInvalid) throw Win32("CreateFileW failed for pinned artifact path");
        try
        {
            BY_HANDLE_FILE_INFORMATION info;
            if (!GetFileInformationByHandle(handle, out info)) throw Win32("GetFileInformationByHandle failed");
            if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                throw new IOException("Pinned artifact path is a reparse point.");
            bool actualDirectory = (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            if (actualDirectory != directory)
                throw new IOException("Pinned artifact path kind does not match its contract.");
            string identity = Describe(handle);
            string canonicalFinal = IdentityPath(identity);
            if (!canonicalFinal.Equals(fullPath, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Pinned artifact path resolved to a different final path.");
            SafeFileHandle previous;
            if (Pins.TryGetValue(token, out previous)) previous.Dispose();
            Pins[token] = handle;
            handle = null;
            return identity;
        }
        finally
        {
            if (handle != null) handle.Dispose();
        }
    }

    public static string EnsureDirectoryTree(string token, string requestedPath, string containmentRoot)
    {
        string target = Path.GetFullPath(requestedPath);
        if (!String.IsNullOrEmpty(containmentRoot) && !IsContained(containmentRoot, target))
            throw new IOException("Artifact directory target escapes pinned containment root.");
        List<string> missing = new List<string>();
        string cursor = target;
        while (!Directory.Exists(cursor))
        {
            if (File.Exists(cursor)) throw new IOException("Artifact directory target is an existing file.");
            missing.Add(cursor);
            string parent = Path.GetDirectoryName(cursor);
            if (String.IsNullOrEmpty(parent) || parent.Equals(cursor, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Artifact directory has no existing physical ancestor.");
            cursor = parent;
        }
        int pinIndex = 0;
        Pin(token + "|" + pinIndex++, cursor, true, true, false, false, false);
        missing.Reverse();
        foreach (string item in missing)
        {
            Directory.CreateDirectory(item);
            Pin(token + "|" + pinIndex++, item, true, true, false, false, false);
        }
        List<string> ancestors = new List<string>();
        cursor = target;
        while (!String.IsNullOrEmpty(cursor))
        {
            ancestors.Add(cursor);
            string parent = Path.GetDirectoryName(cursor);
            if (String.IsNullOrEmpty(parent) || parent.Equals(cursor, StringComparison.OrdinalIgnoreCase)) break;
            cursor = parent;
        }
        ancestors.Reverse();
        foreach (string item in ancestors)
            Pin(token + "|ancestor|" + pinIndex++, item, true, true, false, false, false);
        return Pin(token + "|final", target, true, true, false, false, false);
    }

    public static string EnsureFile(string token, string requestedPath, string containmentRoot)
    {
        string fullPath = Path.GetFullPath(requestedPath);
        if (!IsContained(containmentRoot, fullPath))
            throw new IOException("Artifact file target escapes pinned containment root.");
        return Pin(token, fullPath, false, true, false, true, false);
    }

    public static string PinExisting(string token, string requestedPath, string containmentRoot,
        bool directory, bool shareWrite)
    {
        string fullPath = Path.GetFullPath(requestedPath);
        if (!IsContained(containmentRoot, fullPath))
            throw new IOException("Artifact path escapes pinned containment root.");
        return Pin(token, fullPath, directory, shareWrite, false, false, false);
    }

    public static string PinRenameSource(string token, string source)
    {
        string sourcePath = Path.GetFullPath(source);
        try { return Pin(token, sourcePath, Directory.Exists(sourcePath), true, true, false, false); }
        catch (Exception error) { throw new IOException("Artifact rename source pin failed for " + sourcePath
            + " (exists=" + File.Exists(sourcePath) + "): " + error.Message, error); }
    }

    public static string RenamePinnedSource(string token, string source, string destination)
    {
        string sourcePath = Path.GetFullPath(source);
        string destinationPath = Path.GetFullPath(destination);
        SafeFileHandle sourceHandle = RequirePin(token);
        string sourceIdentity = Describe(sourceHandle);
        if (!IdentityPath(sourceIdentity).Equals(sourcePath, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Pinned artifact rename source changed path before publication.");
        BY_HANDLE_FILE_INFORMATION sourceInfo;
        if (!GetFileInformationByHandle(sourceHandle, out sourceInfo))
            throw Win32("GetFileInformationByHandle failed for rename source");
        bool directory = (sourceInfo.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (!MoveFileExW(ExtendedPath(sourcePath), ExtendedPath(destinationPath), MOVEFILE_WRITE_THROUGH))
            throw Win32("MoveFileExW with MOVEFILE_WRITE_THROUGH failed");
        string destinationToken = token + "|destination";
        try
        {
            string destinationIdentity = Pin(
                destinationToken, destinationPath, directory, true, true, false, false);
            if (!IdentityKey(sourceIdentity).Equals(IdentityKey(destinationIdentity), StringComparison.Ordinal))
                throw new IOException("Artifact rename destination identity does not match the pinned source.");
            return destinationIdentity;
        }
        catch (Exception error)
        {
            throw new IOException("Artifact rename destination identity verification failed: " + error.Message, error);
        }
        finally { Release(destinationToken); }
    }

    public static string PinCopySource(string token, string source, string containmentRoot)
    {
        string sourcePath = Path.GetFullPath(source);
        if (!IsContained(containmentRoot, sourcePath))
            throw new IOException("Artifact copy source escapes its containment root.");
        return Pin(token, sourcePath, false, false, false, false, true);
    }

    public static string CopyPinnedSource(
        string token, string source, string destination, string containmentRoot)
    {
        string sourcePath = Path.GetFullPath(source);
        string destinationPath = Path.GetFullPath(destination);
        if (!IsContained(containmentRoot, destinationPath))
            throw new IOException("Artifact copy destination escapes its containment root.");
        SafeFileHandle sourceHandle = RequirePin(token);
        string sourceIdentity = Describe(sourceHandle);
        if (!IdentityPath(sourceIdentity).Equals(sourcePath, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Pinned artifact copy source changed path before copy.");
        SafeFileHandle destinationHandle = CreateFileW(
            ExtendedPath(destinationPath), GENERIC_WRITE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
            IntPtr.Zero, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (destinationHandle.IsInvalid) throw Win32("CreateFileW failed for artifact copy destination");
        try
        {
            byte[] buffer = new byte[64 * 1024];
            while (true)
            {
                uint bytesRead;
                if (!ReadFile(sourceHandle, buffer, (uint)buffer.Length, out bytesRead, IntPtr.Zero))
                    throw Win32("ReadFile failed for pinned artifact source");
                if (bytesRead == 0) break;
                uint remaining = bytesRead;
                while (remaining > 0)
                {
                    uint bytesWritten;
                    if (!WriteFile(destinationHandle, buffer, remaining, out bytesWritten, IntPtr.Zero))
                        throw Win32("WriteFile failed for artifact destination");
                    if (bytesWritten == 0) throw new IOException("Artifact copy made no write progress.");
                    remaining -= bytesWritten;
                    if (remaining > 0)
                        Buffer.BlockCopy(buffer, (int)bytesWritten, buffer, 0, (int)remaining);
                }
            }
            if (!FlushFileBuffers(destinationHandle)) throw Win32("FlushFileBuffers failed for artifact destination");
            string destinationIdentity = Describe(destinationHandle);
            if (!IdentityPath(destinationIdentity).Equals(destinationPath, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Artifact copy destination changed identity.");
            return destinationIdentity;
        }
        finally { destinationHandle.Dispose(); }
    }

    public static void Release(string prefix)
    {
        List<string> keys = new List<string>();
        foreach (string key in Pins.Keys)
            if (key.StartsWith(prefix, StringComparison.Ordinal)) keys.Add(key);
        foreach (string key in keys)
        {
            Pins[key].Dispose();
            Pins.Remove(key);
        }
    }

    public static void ReleaseAll()
    {
        foreach (SafeFileHandle handle in Pins.Values) handle.Dispose();
        Pins.Clear();
    }

    public static void WatchParent(int parentPid)
    {
        Thread watcher = new Thread(() => {
            while (true)
            {
                Thread.Sleep(50);
                try
                {
                    System.Diagnostics.Process parent = System.Diagnostics.Process.GetProcessById(parentPid);
                    if (parent.HasExited) Environment.Exit(0);
                }
                catch { Environment.Exit(0); }
            }
        });
        watcher.IsBackground = true;
        watcher.Start();
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[ArtifactPathPins]::WatchParent([int]$env:AGENT_OS_ARTIFACT_PARENT_PID)
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $request = ConvertFrom-Json -InputObject $line
  try {
    $result = switch ([string]$request.op) {
      'ensure-directory' { [ArtifactPathPins]::EnsureDirectoryTree([string]$request.token, [string]$request.path, [string]$request.root) }
      'ensure-file' { [ArtifactPathPins]::EnsureFile([string]$request.token, [string]$request.path, [string]$request.root) }
      'pin-existing' { [ArtifactPathPins]::PinExisting([string]$request.token, [string]$request.path, [string]$request.root, [bool]$request.directory, [bool]$request.shareWrite) }
      'pin-rename-source' { [ArtifactPathPins]::PinRenameSource([string]$request.token, [string]$request.source) }
      'rename-pinned-source' { [ArtifactPathPins]::RenamePinnedSource([string]$request.token, [string]$request.source, [string]$request.destination) }
      'pin-copy-source' { [ArtifactPathPins]::PinCopySource([string]$request.token, [string]$request.source, [string]$request.root) }
      'copy-pinned-source' { [ArtifactPathPins]::CopyPinnedSource([string]$request.token, [string]$request.source, [string]$request.destination, [string]$request.root) }
      'release' { [ArtifactPathPins]::Release([string]$request.token); 'released' }
      'close' { [ArtifactPathPins]::ReleaseAll(); 'closed' }
      default { throw "Unknown artifact native guard operation." }
    }
    $response = @{ id = [string]$request.id; ok = $true; result = $result }
  } catch {
    $outer = $_.Exception
    $exception = $outer
    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
    $response = @{ id = [string]$request.id; ok = $false; error = $outer.Message; hresult = $exception.HResult }
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}
[ArtifactPathPins]::ReleaseAll()
`;

const NATIVE_GUARD_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
let output = "";
let diagnostics = "";
let helperFailure = "";
const pending = new Map();
function finish(message, payload) {
  const state = new Int32Array(message.shared, 0, 2);
  const bytes = new Uint8Array(message.shared, 8);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8");
  if (encoded.byteLength > bytes.byteLength) {
    const fallback = Buffer.from(JSON.stringify({ ok: false, error: "Native guard response exceeded buffer." }), "utf8");
    bytes.set(fallback);
    Atomics.store(state, 1, fallback.byteLength);
    Atomics.store(state, 0, -1);
  } else {
    bytes.set(encoded);
    Atomics.store(state, 1, encoded.byteLength);
    Atomics.store(state, 0, payload.ok ? 1 : -1);
  }
  Atomics.notify(state, 0);
}
function failAll(error) {
  helperFailure = String(error);
  for (const message of pending.values()) finish(message, { ok: false, error });
  pending.clear();
}
const helper = spawn("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-Command",
  "[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); $encoded=[Console]::In.ReadLine(); Invoke-Expression([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded)))",
], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, AGENT_OS_ARTIFACT_PARENT_PID: String(process.pid) },
});
helper.stdout.setEncoding("utf8");
helper.stdout.on("data", (chunk) => {
  output += chunk;
  while (output.includes("\n")) {
    const split = output.indexOf("\n");
    const line = output.slice(0, split).trim();
    output = output.slice(split + 1);
    if (!line) continue;
    let response;
    try { response = JSON.parse(line); } catch { continue; }
    const waiting = pending.get(response.id);
    if (!waiting) continue;
    pending.delete(response.id);
    if (waiting.request.op === "close") helper.stdin.end();
    finish(waiting, response);
  }
});
helper.stderr.setEncoding("utf8");
helper.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4096); });
helper.on("error", (error) => failAll(error.message));
helper.on("exit", (code) => failAll("Native guard exited " + code + ": " + diagnostics));
helper.stdin.write(workerData.encoded + "\n");
parentPort.on("message", (message) => {
  if (helperFailure) {
    finish(message, { ok: false, error: helperFailure });
    return;
  }
  pending.set(message.request.id, message);
  helper.stdin.write(JSON.stringify(message.request) + "\n");
});
`;

class WindowsNativePathGuard {
  private readonly worker: Worker;
  private readonly encodedSource: string;
  private closed = false;

  constructor() {
    if (process.platform !== "win32") throw new Error("Windows native path guard is only available on Windows.");
    this.encodedSource = Buffer.from(WINDOWS_NATIVE_GUARD_SOURCE, "utf16le").toString("base64");
    this.worker = new Worker(NATIVE_GUARD_WORKER_SOURCE, {
      eval: true,
      workerData: { encoded: this.encodedSource },
    });
    this.worker.unref();
  }

  ensureDirectory(candidate: string, containmentRoot: string | undefined, lease: string): string {
    return this.pathFromIdentity(this.identity(this.request({
      op: "ensure-directory", token: lease, path: candidate, root: containmentRoot ?? "",
    })));
  }

  ensureFile(candidate: string, containmentRoot: string, lease: string): string {
    return this.identity(this.request({ op: "ensure-file", token: lease, path: candidate, root: containmentRoot }));
  }

  pinExisting(
    candidate: string,
    containmentRoot: string,
    lease: string,
    directory: boolean,
    shareWrite: boolean,
  ): string {
    return this.identity(this.request({
      op: "pin-existing", token: lease, path: candidate, root: containmentRoot, directory, shareWrite,
    }));
  }

  renameWriteThrough(source: string, destination: string, afterPin?: () => void): void {
    const lease = `rename:${randomUUID()}`;
    this.identity(this.request({ op: "pin-rename-source", token: lease, source }));
    try {
      afterPin?.();
      this.identity(this.request({ op: "rename-pinned-source", token: lease, source, destination }));
    } finally {
      this.release(lease);
    }
  }

  copyPinnedSource(
    source: string,
    sourceRoot: string,
    destination: string,
    destinationRoot: string,
    lease: string,
    afterPin?: () => void,
  ): void {
    this.identity(this.request({ op: "pin-copy-source", token: lease, source, root: sourceRoot }));
    try {
      afterPin?.();
      this.identity(this.request({
        op: "copy-pinned-source", token: lease, source, destination, root: destinationRoot,
      }));
    } finally {
      this.release(lease);
    }
  }

  release(lease: string): void {
    if (!this.closed) this.request({ op: "release", token: lease });
  }

  close(): void {
    if (this.closed) return;
    try { this.request({ op: "close" }); } finally {
      this.closed = true;
      void this.worker.terminate();
    }
  }

  private identity(value: unknown): string {
    if (typeof value !== "string" || !value.includes("|")) {
      throw new ArtifactStoreError("Windows native path identity is malformed.", "containment_failed");
    }
    return value;
  }

  private pathFromIdentity(identity: string): string {
    return identity.slice(0, identity.lastIndexOf("|"));
  }

  private request(input: Record<string, unknown>): unknown {
    if (this.closed) throw new ArtifactStoreError("Windows native path guard is closed.", "containment_failed");
    const id = randomUUID();
    const shared = new SharedArrayBuffer(8 + NATIVE_GUARD_RESPONSE_BYTES);
    const state = new Int32Array(shared, 0, 2);
    this.worker.postMessage({ request: { ...input, id }, shared, encoded: this.encodedSource });
    const wait = Atomics.wait(state, 0, 0, NATIVE_GUARD_TIMEOUT_MS);
    if (wait === "timed-out") {
      void this.worker.terminate();
      this.closed = true;
      throw new ArtifactStoreError("Windows native path guard timed out; refusing filesystem access.", "containment_failed");
    }
    const length = Atomics.load(state, 1);
    let response: { ok?: boolean; result?: unknown; error?: string; hresult?: number };
    try {
      response = JSON.parse(Buffer.from(new Uint8Array(shared, 8, length)).toString("utf8")) as typeof response;
    } catch {
      throw new ArtifactStoreError("Windows native path guard returned invalid JSON.", "containment_failed");
    }
    if (!response.ok) {
      const nativeCode = Number(response.hresult) & 0xffff;
      if (nativeCode === 39 || nativeCode === 112) {
        const error = new Error(response.error ?? "Windows native path guard failed.") as Error & { code?: string };
        error.code = "ENOSPC";
        throw error;
      }
      throw new ArtifactStoreError(
        response.error ?? "Windows native path identity verification failed.",
        "containment_failed",
      );
    }
    return response.result;
  }
}

const MIGRATIONS: readonly ArtifactMigration[] = Object.freeze([
  {
    version: 1,
    name: "artifact-core",
    sql: `
      CREATE TABLE IF NOT EXISTS artifact_blobs (
        content_hash TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL CHECK(bytes >= 0),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_references (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        content_hash TEXT NOT NULL REFERENCES artifact_blobs(content_hash),
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, content_hash, label)
      );
      CREATE INDEX IF NOT EXISTS artifact_references_run_idx
        ON artifact_references(run_id, created_at, id);
    `,
  },
  {
    version: 2,
    name: "artifact-durable-intents-policy",
    sql: `
      CREATE TABLE IF NOT EXISTS artifact_write_intents (
        intent_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes >= 0),
        relative_path TEXT NOT NULL,
        run_id TEXT NOT NULL,
        label TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
        lease_expires_at TEXT NOT NULL,
        UNIQUE(run_id, content_hash, label)
      );
      CREATE INDEX IF NOT EXISTS artifact_write_intents_hash_idx
        ON artifact_write_intents(content_hash, created_at, intent_id);
      CREATE INDEX IF NOT EXISTS artifact_write_intents_run_idx
        ON artifact_write_intents(run_id, created_at, intent_id);
      CREATE TABLE IF NOT EXISTS artifact_store_policy (
        policy_id INTEGER PRIMARY KEY CHECK(policy_id = 1),
        policy_json TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "artifact-durable-garbage-collection",
    sql: `
      CREATE TABLE IF NOT EXISTS artifact_gc_intents (
        content_hash TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL CHECK(bytes >= 0),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `,
  },
]);

const EXPECTED_SCHEMA_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  artifact_schema_migrations: ["version:INTEGER:0:1", "name:TEXT:1:0", "checksum:TEXT:1:0", "applied_at:TEXT:1:0"],
  artifact_blobs: ["content_hash:TEXT:0:1", "bytes:INTEGER:1:0", "relative_path:TEXT:1:0", "created_at:TEXT:1:0"],
  artifact_references: [
    "id:TEXT:0:1", "run_id:TEXT:1:0", "content_hash:TEXT:1:0", "label:TEXT:1:0", "created_at:TEXT:1:0",
  ],
  artifact_write_intents: [
    "intent_id:TEXT:0:1", "content_hash:TEXT:1:0", "bytes:INTEGER:1:0", "relative_path:TEXT:1:0",
    "run_id:TEXT:1:0", "label:TEXT:1:0", "reference_id:TEXT:1:0", "created_at:TEXT:1:0",
    "owner_pid:INTEGER:1:0", "lease_expires_at:TEXT:1:0",
  ],
  artifact_store_policy: [
    "policy_id:INTEGER:0:1", "policy_json:TEXT:1:0", "policy_hash:TEXT:1:0", "updated_at:TEXT:1:0",
  ],
  artifact_gc_intents: ["content_hash:TEXT:0:1", "bytes:INTEGER:1:0", "relative_path:TEXT:1:0", "created_at:TEXT:1:0"],
});

const EXPECTED_EXPLICIT_INDEXES = Object.freeze([
  "artifact_references_run_idx",
  "artifact_write_intents_hash_idx",
  "artifact_write_intents_run_idx",
]);

export class ArtifactStoreError extends Error {
  readonly code:
    | "invalid_artifact"
    | "quota_exceeded"
    | "disk_write_failed"
    | "integrity_failed"
    | "policy_mismatch"
    | "operation_in_progress"
    | "containment_failed";

  constructor(
    message: string,
    code: ArtifactStoreError["code"],
  ) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function scalarNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isUncOrDevice(input: string): boolean {
  const portable = input.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  return portable.startsWith("//") || portable.startsWith("/??/")
    || portable.startsWith("/device/");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return stableStringify(Object.keys(value).sort()) === stableStringify([...expected].sort());
}

function intentMetadataBytes(intent: ArtifactWriteIntentRow): number {
  return Buffer.byteLength(intent.intent_id) + Buffer.byteLength(intent.content_hash)
    + Buffer.byteLength(intent.relative_path) + Buffer.byteLength(intent.run_id)
    + Buffer.byteLength(intent.label) + Buffer.byteLength(intent.reference_id)
    + Buffer.byteLength(intent.created_at) + Buffer.byteLength(intent.lease_expires_at) + 8;
}

function referenceMetadataBytes(intent: ArtifactWriteIntentRow): number {
  return Buffer.byteLength(intent.reference_id) + Buffer.byteLength(intent.run_id)
    + Buffer.byteLength(intent.content_hash) + Buffer.byteLength(intent.label)
    + Buffer.byteLength(intent.created_at);
}

function blobMetadataBytes(contentHash: string, relativePath: string, createdAt: string): number {
  return Buffer.byteLength(contentHash) + Buffer.byteLength(relativePath)
    + Buffer.byteLength(createdAt) + 8;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLocaleLowerCase("en-US") === path.resolve(right).toLocaleLowerCase("en-US")
    : path.resolve(left) === path.resolve(right);
}

function assertNoWindowsReparsePoint(candidate: string): void {
  if (process.platform !== "win32" || !existsSync(candidate)) return;
  const stat = lstatSync(candidate);
  const identity = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.birthtimeMs}:${stat.ctimeMs}`;
  const cacheKey = path.resolve(candidate).toLocaleLowerCase("en-US");
  if (WINDOWS_REPARSE_IDENTITY_CACHE.get(cacheKey) === identity) return;
  const result = spawnSync("fsutil.exe", ["reparsepoint", "query", candidate], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 0) {
    throw new ArtifactStoreError("Artifact path contains a Windows reparse point.", "containment_failed");
  }
  if (result.status === 1 && /not a reparse point/iu.test(output)) {
    if (WINDOWS_REPARSE_IDENTITY_CACHE.size >= 4096) WINDOWS_REPARSE_IDENTITY_CACHE.clear();
    WINDOWS_REPARSE_IDENTITY_CACHE.set(cacheKey, identity);
    return;
  }
  throw new ArtifactStoreError(
    "Windows reparse-point identity could not be verified; refusing the path.",
    "containment_failed",
  );
}

function assertNoReparseComponents(root: string, candidate: string): void {
  const rootStat = lstatSync(root);
  assertNoWindowsReparsePoint(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(realpathSync.native(root), root)) {
    throw new ArtifactStoreError("Artifact root changed identity or became a reparse point.", "containment_failed");
  }
  if (!isContained(root, candidate)) {
    throw new ArtifactStoreError("Artifact path escapes the canonical store root.", "containment_failed");
  }
  const relative = path.relative(root, candidate);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    assertNoWindowsReparsePoint(cursor);
    if (stat.isSymbolicLink() || !samePath(realpathSync.native(cursor), cursor)) {
      throw new ArtifactStoreError("Artifact path contains a link or reparse point.", "containment_failed");
    }
  }
}

function assertSafeCreationTarget(candidate: string, containmentRoot?: string): void {
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(candidate) || isUncOrDevice(candidate)
    || (containmentRoot && !isContained(containmentRoot, resolved))) {
    throw new ArtifactStoreError("Artifact creation target is not a contained local path.", "containment_failed");
  }
  let ancestor = existsSync(resolved) && !lstatSync(resolved).isDirectory()
    ? path.dirname(resolved)
    : resolved;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (samePath(parent, ancestor)) {
      throw new ArtifactStoreError("Artifact creation target has no verifiable ancestor.", "containment_failed");
    }
    ancestor = parent;
  }
  const stat = lstatSync(ancestor);
  assertNoWindowsReparsePoint(ancestor);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync.native(ancestor), ancestor)) {
    throw new ArtifactStoreError("Artifact creation ancestor is not a physical directory.", "containment_failed");
  }
  const root = containmentRoot ?? ancestor;
  assertNoReparseComponents(root, resolved);
}

function ensurePhysicalDirectory(
  candidate: string,
  containmentRoot?: string,
  windowsGuard?: WindowsNativePathGuard,
  lease = `directory:${randomUUID()}`,
): string {
  const resolved = path.resolve(candidate);
  if (process.platform === "win32") {
    if (!windowsGuard) {
      throw new ArtifactStoreError(
        "Windows path creation requires a native handle-pinned containment guard.",
        "containment_failed",
      );
    }
    let pinned = windowsGuard.ensureDirectory(resolved, containmentRoot, lease);
    if (!existsSync(resolved)) {
      // Native guard has already pinned every existing ancestor without FILE_SHARE_DELETE.
      // Node performs creation only inside that pinned chain, then native code pins the result.
      mkdirSync(resolved, { recursive: true });
      pinned = windowsGuard.ensureDirectory(resolved, containmentRoot, lease);
    }
    if (!samePath(pinned, resolved) || !existsSync(pinned) || !lstatSync(pinned).isDirectory()) {
      throw new ArtifactStoreError(
        `Windows native guard did not publish the pinned directory (${pinned} != ${resolved}; exists=${existsSync(pinned)}).`,
        "containment_failed",
      );
    }
    return pinned;
  }
  assertSafeCreationTarget(resolved, containmentRoot);
  mkdirSync(resolved, { recursive: true });
  const stat = lstatSync(resolved);
  assertNoWindowsReparsePoint(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync.native(resolved), resolved)) {
    throw new ArtifactStoreError("Created artifact directory changed identity.", "containment_failed");
  }
  if (containmentRoot) assertNoReparseComponents(containmentRoot, resolved);
  return resolved;
}

function assertPhysicalFile(containmentRoot: string, candidate: string): void {
  assertNoReparseComponents(containmentRoot, candidate);
  const stat = lstatSync(candidate);
  assertNoWindowsReparsePoint(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(realpathSync.native(candidate), candidate)) {
    throw new ArtifactStoreError("Artifact file is not a physical contained file.", "containment_failed");
  }
}

function flushPublishedFile(
  finalPath: string,
  windowsGuard?: WindowsNativePathGuard,
  containmentRoot?: string,
): void {
  const lease = `flush:${randomUUID()}`;
  if (process.platform === "win32") {
    if (!windowsGuard || !containmentRoot) {
      throw new ArtifactStoreError(
        "Windows durable flush requires a native handle-pinned containment guard.",
        "containment_failed",
      );
    }
    windowsGuard.pinExisting(finalPath, containmentRoot, lease, false, true);
  }
  const descriptor = openSync(finalPath, "r+");
  try { fsyncSync(descriptor); } finally {
    try { closeSync(descriptor); } finally { windowsGuard?.release(lease); }
  }
  if (process.platform !== "win32") {
    const directoryDescriptor = openSync(path.dirname(finalPath), "r");
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  }
}

function durableRename(
  source: string,
  destination: string,
  windowsGuard?: WindowsNativePathGuard,
  afterSourcePin?: () => void,
): void {
  if (process.platform === "win32") {
    if (!windowsGuard) {
      throw new ArtifactStoreError(
        "Windows publication requires native MOVEFILE_WRITE_THROUGH support.",
        "containment_failed",
      );
    }
    windowsGuard.renameWriteThrough(source, destination, afterSourcePin);
    return;
  }
  afterSourcePin?.();
  renameSync(source, destination);
  const directoryDescriptor = openSync(path.dirname(destination), "r");
  try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
}

function copyExternalSource(
  source: string,
  sourceRoot: string,
  destination: string,
  destinationRoot: string,
  windowsGuard: WindowsNativePathGuard | undefined,
  lease: string,
  afterSourcePin?: () => void,
): void {
  if (process.platform === "win32") {
    if (!windowsGuard) {
      throw new ArtifactStoreError(
        "Windows restore copy requires a native handle-pinned source.",
        "containment_failed",
      );
    }
    windowsGuard.copyPinnedSource(
      source, sourceRoot, destination, destinationRoot, lease, afterSourcePin,
    );
    return;
  }
  assertNoReparseComponents(sourceRoot, source);
  afterSourcePin?.();
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
}

export class DurableArtifactStore {
  private readonly root: string;
  private readonly blobDirectory: string;
  private readonly databasePath: string;
  private readonly recoveryReservePath: string;
  private readonly backupLockPath: string;
  private readonly backupMutexPath: string;
  private readonly db: DatabaseSync;
  private readonly policy: ArtifactPolicyDocument;
  private readonly faultInjector?: ArtifactFaultInjector;
  private readonly windowsGuard?: WindowsNativePathGuard;
  private readonly rootLease: string;
  private backupMutex?: DatabaseSync;
  private initializing = true;
  private closed = false;

  constructor(
    root: string,
    options: {
      quota?: Partial<ArtifactQuota>;
      retention?: Partial<ArtifactRetentionPolicy>;
      intentLeaseMs?: number;
      faultInjector?: ArtifactFaultInjector;
    } = {},
  ) {
    if (!path.isAbsolute(root) || isUncOrDevice(root)) {
      throw new ArtifactStoreError("Artifact root must be an absolute local path.", "containment_failed");
    }
    const resolvedRoot = path.resolve(root);
    const windowsGuard = process.platform === "win32" ? new WindowsNativePathGuard() : undefined;
    const rootLease = `store-root:${randomUUID()}`;
    let canonicalRoot: string;
    try {
      canonicalRoot = ensurePhysicalDirectory(resolvedRoot, undefined, windowsGuard, rootLease);
    } catch (error) {
      try { windowsGuard?.close(); } catch { /* preserve the first containment or storage failure */ }
      if (DurableArtifactStore.isDiskFailureValue(error)) {
        throw new ArtifactStoreError("Artifact root could not be opened or created.", "disk_write_failed");
      }
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        `Artifact root containment could not be pinned: ${error instanceof Error ? error.message : "unknown"}`,
        "containment_failed",
      );
    }
    if (isUncOrDevice(canonicalRoot)) {
      try { windowsGuard?.close(); } catch { /* preserve the containment failure */ }
      throw new ArtifactStoreError("UNC and device artifact roots are not allowed.", "containment_failed");
    }
    this.root = canonicalRoot;
    this.windowsGuard = windowsGuard;
    this.rootLease = rootLease;
    let policy: ArtifactPolicyDocument;
    try {
      this.blobDirectory = path.join(this.root, "blobs");
      ensurePhysicalDirectory(this.blobDirectory, this.root, this.windowsGuard, `${this.rootLease}:blobs`);
      this.databasePath = path.join(this.root, DATABASE_NAME);
      this.recoveryReservePath = path.join(this.root, RECOVERY_RESERVE_NAME);
      this.backupLockPath = path.join(this.root, BACKUP_LOCK_NAME);
      this.backupMutexPath = path.join(this.root, BACKUP_MUTEX_NAME);
      this.faultInjector = options.faultInjector;
      policy = {
        schemaVersion: 1,
        quota: { ...DEFAULT_QUOTA, ...options.quota },
        retention: { ...DEFAULT_RETENTION, ...options.retention },
        intentLeaseMs: options.intentLeaseMs ?? DEFAULT_INTENT_LEASE_MS,
      };
      this.validatePolicy(policy);
      if (policy.quota.maximumDatabaseBytes < SQLITE_MINIMUM_DATABASE_BYTES) {
        throw new ArtifactStoreError("Artifact database quota is below the durable schema minimum.", "quota_exceeded");
      }
      this.ensureRecoveryReserve();
      if (this.windowsGuard) {
        this.windowsGuard.ensureFile(this.databasePath, this.root, `${this.rootLease}:database`);
        this.windowsGuard.ensureFile(this.backupMutexPath, this.root, `${this.rootLease}:backup-mutex`);
      } else {
        assertSafeCreationTarget(this.databasePath, this.root);
        assertSafeCreationTarget(this.backupMutexPath, this.root);
      }
    } catch (error) {
      try { this.windowsGuard?.close(); } catch { /* preserve the pre-open setup failure */ }
      throw error;
    }
    let database: DatabaseSync | undefined;
    let initializationMutex: DatabaseSync | undefined;
    try {
      this.inject("before_database_open");
      database = new DatabaseSync(this.databasePath, { timeout: SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS });
      initializationMutex = DurableArtifactStore.initializeBackupMutex(this.backupMutexPath);
    } catch (error) {
      try { database?.close(); } catch { /* preserve the database open or mutex initialization failure */ }
      try { this.windowsGuard?.close(); } catch { /* preserve the database open failure */ }
      if (DurableArtifactStore.isDiskFailureValue(error)) {
        throw new ArtifactStoreError("Artifact database open failed because storage is full.", "disk_write_failed");
      }
      if (error instanceof ArtifactStoreError) throw error;
      if (DurableArtifactStore.isSqliteBusyValue(error)) {
        throw new ArtifactStoreError(
          "Artifact store initialization is busy during database_open.",
          "operation_in_progress",
        );
      }
      throw error;
    }
    if (!database) {
      throw new ArtifactStoreError("Artifact database open returned no handle.", "integrity_failed");
    }
    this.db = database;
    let initializationPhase = "database_pragmas";
    try {
      assertPhysicalFile(this.root, this.databasePath);
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1;");
      this.db.exec("PRAGMA journal_size_limit = 0;");
      this.checkedCheckpoint(false, 5_000);
      initializationPhase = "migrations";
      this.applyMigrations();
      initializationPhase = "policy";
      this.policy = this.loadOrCreatePolicy(policy);
      this.configureDatabasePageQuota(this.policy.quota.maximumDatabaseBytes);
      initializationPhase = "integrity_reconciliation";
      this.verifyIntegrity();
      this.reconcileDurableState();
      this.checkedCheckpoint(false, 5_000);
      initializationMutex.exec("COMMIT");
      initializationMutex.close();
      initializationMutex = undefined;
      this.initializing = false;
    } catch (error) {
      if (initializationMutex) {
        try { initializationMutex.exec("ROLLBACK"); } catch { /* preserve the initialization failure */ }
        try { initializationMutex.close(); } catch { /* preserve the initialization failure */ }
        initializationMutex = undefined;
      }
      try { this.db.close(); } catch (closeError) {
        if (DurableArtifactStore.isDiskFailureValue(closeError)) {
          throw new ArtifactStoreError("Artifact database close failed because storage is full.", "disk_write_failed");
        }
      } finally {
        try { this.windowsGuard?.close(); } catch { /* preserve the initialization failure */ }
      }
      if (DurableArtifactStore.isDiskFailureValue(error)) {
        throw new ArtifactStoreError("Artifact database initialization failed because storage is full.", "disk_write_failed");
      }
      if (DurableArtifactStore.isSqliteBusyValue(error)) {
        throw new ArtifactStoreError(
          `Artifact store initialization is busy during ${initializationPhase}.`,
          "operation_in_progress",
        );
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    let failure: unknown;
    try {
      this.checkedCheckpoint(false, 5_000);
      this.inject("before_database_close");
    } catch (error) {
      failure = error;
    } finally {
      try { this.db.close(); } catch (error) { failure ??= error; }
      try { this.backupMutex?.close(); } catch (error) { failure ??= error; }
      this.backupMutex = undefined;
      this.windowsGuard?.close();
      this.closed = true;
    }
    if (failure) {
      if (this.isDiskFailure(failure)) {
        throw new ArtifactStoreError("Artifact database close failed because storage is full.", "disk_write_failed");
      }
      throw failure;
    }
  }

  checkpoint(): void {
    this.assertOpen();
    try {
      this.checkedCheckpoint(true);
    } catch (error) {
      if (this.isDiskFailure(error)) this.throwMutationDiskFailure(error, "checkpoint");
      throw error;
    }
  }

  put(runId: string, label: string, input: Uint8Array): StoredArtifact {
    this.assertOpen();
    this.ensureRecoveryReserve();
    if (typeof runId !== "string" || !SAFE_ID.test(runId) || typeof label !== "string"
      || !label.trim() || label.trim().length > 500 || !(input instanceof Uint8Array)) {
      throw new ArtifactStoreError("Artifact identity is invalid.", "invalid_artifact");
    }
    if (input.byteLength > this.policy.quota.maximumArtifactBytes) {
      throw new ArtifactStoreError("Artifact exceeds the per-artifact quota.", "quota_exceeded");
    }
    this.preflightFreeSpace(
      this.root,
      input.byteLength + SQLITE_TRANSACTION_RESERVE_BYTES + SQLITE_SIDECAR_RESERVE_BYTES,
    );
    const data = Buffer.from(input);
    const contentHash = sha256(data);
    const normalizedLabel = label.trim();
    const relativePath = this.relativePathFor(contentHash);
    const finalPath = this.safeBlobPath(contentHash);
    const createdAt = new Date().toISOString();
    const intent: ArtifactWriteIntentRow = {
      intent_id: randomUUID(),
      content_hash: contentHash,
      bytes: data.byteLength,
      relative_path: relativePath,
      run_id: runId,
      label: normalizedLabel,
      reference_id: randomUUID(),
      created_at: createdAt,
      owner_pid: process.pid,
      lease_expires_at: new Date(Date.now() + this.policy.intentLeaseMs).toISOString(),
    };

    const reservation = this.immediateTransaction(() => {
      this.assertMutationAllowed();
      this.resolveGarbageCollectionForHash(contentHash);
      this.validateAllPendingIntents();
      const blob = this.blob(contentHash);
      const reference = this.reference(runId, contentHash, normalizedLabel);
      if (blob && reference) {
        this.assertBlobAvailable(blob);
        return { complete: this.stored(reference, blob, true), intent: null, deduplicated: true };
      }
      const existingIntent = this.intent(runId, contentHash, normalizedLabel);
      if (existingIntent) {
        this.validateIntent(existingIntent);
        if (this.isVerifiedBlob(finalPath, contentHash, existingIntent.bytes)) {
          this.db.prepare(`
            INSERT OR IGNORE INTO artifact_blobs (content_hash, bytes, relative_path, created_at)
            VALUES (?, ?, ?, ?)
          `).run(contentHash, existingIntent.bytes, existingIntent.relative_path, existingIntent.created_at);
          const recoveredBlob = this.blob(contentHash);
          if (!recoveredBlob) {
            throw new ArtifactStoreError("Verified pending artifact could not be ledgered.", "integrity_failed");
          }
          this.finalizeIntentsForBlob(contentHash, recoveredBlob);
          const recoveredReference = this.reference(runId, contentHash, normalizedLabel);
          if (!recoveredReference) {
            throw new ArtifactStoreError("Verified pending artifact reference could not be finalized.", "integrity_failed");
          }
          return { complete: this.stored(recoveredReference, recoveredBlob, true), intent: null, deduplicated: true };
        }
        if (!this.isIntentAbandoned(existingIntent)) {
          throw new ArtifactStoreError("Artifact write for this identity is already active.", "operation_in_progress");
        }
        if (existsSync(finalPath)) this.safeDelete(finalPath, false);
        this.db.prepare("DELETE FROM artifact_write_intents WHERE intent_id = ?").run(existingIntent.intent_id);
      }
      this.enforcePutQuota(runId, normalizedLabel, data.byteLength, contentHash, Boolean(blob));
      this.db.prepare(`
        INSERT INTO artifact_write_intents (
          intent_id, content_hash, bytes, relative_path, run_id, label,
          reference_id, created_at, owner_pid, lease_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        intent.intent_id, intent.content_hash, intent.bytes, intent.relative_path,
        intent.run_id, intent.label, intent.reference_id, intent.created_at, intent.owner_pid, intent.lease_expires_at,
      );
      return { complete: null, intent, deduplicated: Boolean(blob || this.pendingHashCount(contentHash) > 1) };
    });
    if (reservation.complete) {
      this.checkpointForQuota();
      return reservation.complete;
    }
    const activeIntent = reservation.intent;
    if (!activeIntent) throw new ArtifactStoreError("Artifact reservation failed.", "integrity_failed");

    try {
      this.inject("after_intent_commit");
      const result = this.immediateTransaction(() => {
        this.assertMutationAllowed();
        const currentIntent = this.intentById(activeIntent.intent_id);
        if (!currentIntent) {
          const recovered = this.reference(runId, contentHash, normalizedLabel);
          const recoveredBlob = this.blob(contentHash);
          if (!recovered || !recoveredBlob) {
            throw new ArtifactStoreError("Artifact reservation disappeared.", "integrity_failed");
          }
          return this.stored(recovered, recoveredBlob, true);
        }
        this.validateIntent(currentIntent);
        let blob = this.blob(contentHash);
        let publishedBefore = false;
        if (blob) {
          this.assertBlobAvailable(blob);
        } else {
          this.ensureShard(contentHash);
          if (existsSync(finalPath)) {
            if (!this.isVerifiedBlob(finalPath, contentHash, data.byteLength)) {
              this.safeDelete(finalPath, false);
            } else {
              publishedBefore = true;
            }
          }
          if (!existsSync(finalPath)) this.publishBlob(finalPath, contentHash, data);
          if (!this.isVerifiedBlob(finalPath, contentHash, data.byteLength)) {
            throw new ArtifactStoreError("Artifact publish verification failed.", "disk_write_failed");
          }
          this.inject("before_blob_insert");
          this.db.prepare(`
            INSERT INTO artifact_blobs (content_hash, bytes, relative_path, created_at)
            VALUES (?, ?, ?, ?)
          `).run(contentHash, data.byteLength, relativePath, currentIntent.created_at);
          this.inject("after_blob_insert");
          blob = this.blob(contentHash);
        }
        if (!blob) throw new ArtifactStoreError("Artifact blob ledger insert failed.", "integrity_failed");
        this.finalizeIntentsForBlob(contentHash, blob);
        const reference = this.reference(runId, contentHash, normalizedLabel);
        if (!reference) throw new ArtifactStoreError("Artifact reference was not finalized.", "integrity_failed");
        this.enforceResourceQuotas();
        this.enforceDatabaseQuota();
        this.inject("before_commit");
        return this.stored(reference, blob, reservation.deduplicated || publishedBefore);
      });
      this.inject("after_commit");
      this.checkpointForQuota();
      return result;
    } catch (error) {
      if (this.isDiskFailure(error)) {
        const recoveryErrors: string[] = [];
        try { this.releaseRecoveryReserveForRecovery(); } catch (recoveryError) {
          recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
        }
        try { this.compensateFailedWrite(activeIntent); } catch (recoveryError) {
          recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
        }
        try { this.checkedCheckpoint(false); } catch (recoveryError) {
          recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
        }
        try { this.restoreRecoveryReserveAfterFailure(); } catch (recoveryError) {
          recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
        }
        const recovery = recoveryErrors.length > 0 ? ` Recovery: ${recoveryErrors.join(" | ")}` : "";
        throw new ArtifactStoreError(
          `Artifact persistence failed closed: ${error instanceof Error ? error.message : "unknown error"}.${recovery}`,
          "disk_write_failed",
        );
      }
      this.compensateFailedWrite(activeIntent);
      throw error;
    }
  }

  deleteReference(referenceId: string): boolean {
    this.assertOpen();
    this.ensureRecoveryReserve();
    if (!SAFE_ID.test(referenceId)) throw new ArtifactStoreError("Artifact reference is invalid.", "invalid_artifact");
    try {
      const deleted = this.immediateTransaction(() => {
        this.assertMutationAllowed();
        const result = this.db.prepare("DELETE FROM artifact_references WHERE id = ?").run(referenceId);
        return Number(result.changes) === 1;
      });
      if (deleted && this.policy.retention.garbageCollectUnreferencedBlobs) this.garbageCollect();
      else this.checkpointForQuota();
      return deleted;
    } catch (error) {
      if (this.isDiskFailure(error)) this.throwMutationDiskFailure(error, "reference deletion");
      throw error;
    }
  }

  applyRetention(now = Date.now()): { referencesDeleted: number; blobsDeleted: number } {
    this.assertOpen();
    this.ensureRecoveryReserve();
    if (!Number.isFinite(now)) throw new Error("Retention clock must be finite.");
    try {
      const cutoff = new Date(now - this.policy.retention.maximumReferenceAgeMs).toISOString();
      let referencesDeleted = 0;
      while (true) {
        const deleted = this.immediateTransaction(() => {
          this.assertMutationAllowed();
          return Number(this.db.prepare(`
            DELETE FROM artifact_references WHERE id IN (
              SELECT id FROM artifact_references WHERE created_at < ?
              ORDER BY created_at, id LIMIT ?
            )
          `).run(cutoff, RETENTION_BATCH_SIZE).changes);
        });
        referencesDeleted += deleted;
        this.checkpointForQuota();
        if (deleted < RETENTION_BATCH_SIZE) break;
      }
      const blobsDeleted = this.policy.retention.garbageCollectUnreferencedBlobs ? this.garbageCollect() : 0;
      return { referencesDeleted, blobsDeleted };
    } catch (error) {
      if (this.isDiskFailure(error)) this.throwMutationDiskFailure(error, "retention");
      throw error;
    }
  }

  garbageCollect(): number {
    this.assertOpen();
    this.ensureRecoveryReserve();
    try {
      let total = 0;
      while (true) {
        const ledgered = this.immediateTransaction(() => {
          this.assertMutationAllowed();
          const candidates = this.db.prepare(`
            SELECT b.content_hash, b.bytes, b.relative_path, b.created_at
            FROM artifact_blobs b
            LEFT JOIN artifact_references r ON r.content_hash = b.content_hash
            LEFT JOIN artifact_write_intents i ON i.content_hash = b.content_hash
            WHERE r.id IS NULL AND i.intent_id IS NULL
            ORDER BY b.created_at, b.content_hash LIMIT ?
          `).all(GC_BATCH_SIZE) as unknown as ArtifactBlobRow[];
          for (const blob of candidates) {
            this.validateBlobRow(blob);
            this.db.prepare(`
              INSERT INTO artifact_gc_intents (content_hash, bytes, relative_path, created_at)
              VALUES (?, ?, ?, ?)
            `).run(blob.content_hash, blob.bytes, blob.relative_path, new Date().toISOString());
            this.inject("after_gc_intent_insert");
            this.db.prepare("DELETE FROM artifact_blobs WHERE content_hash = ?").run(blob.content_hash);
          }
          return candidates.length;
        });
        if (ledgered === 0) break;
        total += ledgered;
        this.inject("after_gc_ledger_commit");
        this.drainGarbageCollection();
        this.checkpointForQuota();
        if (ledgered < GC_BATCH_SIZE) break;
      }
      return total;
    } catch (error) {
      if (this.isDiskFailure(error)) this.throwMutationDiskFailure(error, "garbage collection");
      throw error;
    }
  }

  backup(destination: string): ArtifactBackup {
    this.assertOpen();
    if (!path.isAbsolute(destination) || isUncOrDevice(destination)) {
      throw new ArtifactStoreError("Backup path must be an absolute local path.", "containment_failed");
    }
    const resolved = path.resolve(destination);
    if (isContained(this.root, resolved)) {
      throw new ArtifactStoreError("Backup must be outside the live artifact root.", "containment_failed");
    }
    const pathLease = `backup-path:${randomUUID()}`;
    let parent: string;
    let lockToken: string;
    try {
      this.inject("before_backup_parent_open");
      parent = ensurePhysicalDirectory(
        path.dirname(resolved), undefined, this.windowsGuard, `${pathLease}:parent`,
      );
      assertNoReparseComponents(parent, resolved);
      if (existsSync(resolved)) {
        throw new ArtifactStoreError("Artifact backup destination already exists.", "containment_failed");
      }
      lockToken = this.acquireBackupLock();
    } catch (error) {
      this.windowsGuard?.release(pathLease);
      if (this.isDiskFailure(error)) {
        throw new ArtifactStoreError(
          `Artifact backup parent setup failed closed: ${error instanceof Error ? error.message : "unknown error"}`,
          "disk_write_failed",
        );
      }
      throw error;
    }
    DurableArtifactStore.cleanupBackupStaging(
      parent,
      `.${path.basename(resolved)}.`,
      ".tmp",
      this.windowsGuard,
      () => this.inject("after_staging_cleanup_source_pin"),
    );
    const token = lockToken;
    const temporaryBundle = path.join(parent, `.${path.basename(resolved)}.${token}.tmp`);
    const temporaryDatabase = path.join(temporaryBundle, DATABASE_NAME);
    const temporaryBlobDirectory = path.join(temporaryBundle, "blobs");
    const temporaryManifest = path.join(temporaryBundle, BACKUP_MANIFEST_NAME);
    let published = false;
    let stagingOwner: StagingOwnerLease | undefined;
    try {
      stagingOwner = DurableArtifactStore.createStagingOwner(parent, temporaryBundle, this.windowsGuard);
      this.settleForBackup();
      this.renewBackupLock(lockToken);
      this.checkedCheckpoint(true);
      this.verifyIntegrity();
      this.preflightFreeSpace(parent, this.estimatedBackupBytes());
      ensurePhysicalDirectory(temporaryBundle, parent, this.windowsGuard, `${pathLease}:bundle`);
      const escaped = temporaryDatabase.replaceAll("'", "''");
      this.db.exec(`VACUUM INTO '${escaped}'`);
      assertPhysicalFile(temporaryBundle, temporaryDatabase);
      flushPublishedFile(temporaryDatabase, this.windowsGuard, temporaryBundle);
      this.inject("after_backup_database");
      ensurePhysicalDirectory(
        temporaryBlobDirectory, temporaryBundle, this.windowsGuard, `${pathLease}:blobs`,
      );
      const blobs = this.allBlobs()
        .sort((left, right) => left.content_hash.localeCompare(right.content_hash))
        .map((blob) => {
        this.assertBlobAvailable(blob);
        const target = path.join(temporaryBlobDirectory, blob.relative_path);
        ensurePhysicalDirectory(
          path.dirname(target), temporaryBundle, this.windowsGuard,
          `${pathLease}:blob-shard:${blob.content_hash.slice(0, 2)}`,
        );
        copyFileSync(this.safeBlobPath(blob.content_hash), target);
        assertPhysicalFile(temporaryBundle, target);
        flushPublishedFile(target, this.windowsGuard, temporaryBundle);
        this.inject("after_backup_blob_copy");
        this.renewBackupLock(lockToken);
        if (!this.isVerifiedExternalBlob(target, blob.content_hash, blob.bytes)) {
          throw new ArtifactStoreError("Artifact backup blob verification failed.", "integrity_failed");
        }
          return { contentHash: blob.content_hash, relativePath: blob.relative_path, bytes: blob.bytes };
        });
      const backupData = readFileSync(temporaryDatabase);
      const createdAt = new Date().toISOString();
      const stagedDatabase = new DatabaseSync(temporaryDatabase, { readOnly: true });
      let policyHash: string;
      let migrations: ArtifactBackupManifest["migrations"];
      try {
        DurableArtifactStore.verifyDatabaseContract(stagedDatabase, true);
        const policyRow = stagedDatabase.prepare(`
          SELECT policy_hash FROM artifact_store_policy WHERE policy_id = ?
        `).get(POLICY_ID) as { policy_hash?: string } | undefined;
        if (typeof policyRow?.policy_hash !== "string" || !CONTENT_HASH.test(policyRow.policy_hash)) {
          throw new ArtifactStoreError("Artifact backup policy evidence is invalid.", "integrity_failed");
        }
        policyHash = policyRow.policy_hash;
        migrations = stagedDatabase.prepare(`
          SELECT version, name, checksum FROM artifact_schema_migrations ORDER BY version
        `).all() as unknown as ArtifactBackupManifest["migrations"];
      } finally {
        stagedDatabase.close();
      }
      const manifest: ArtifactBackupManifest = {
        schemaVersion: 1,
        createdAt,
        database: { relativePath: DATABASE_NAME, sha256: sha256(backupData), bytes: backupData.byteLength },
        blobs,
        policyHash,
        migrations,
      };
      this.inject("before_backup_manifest");
      writeFileSync(temporaryManifest, stableStringify(manifest), { flag: "wx", flush: true });
      assertPhysicalFile(temporaryBundle, temporaryManifest);
      flushPublishedFile(temporaryManifest, this.windowsGuard, temporaryBundle);
      this.inject("after_backup_manifest");
      const staged: ArtifactBackup = {
        schemaVersion: 1,
        bundlePath: temporaryBundle,
        manifestPath: temporaryManifest,
        path: temporaryDatabase,
        sha256: sha256(backupData),
        bytes: backupData.byteLength,
        createdAt,
        blobDirectory: temporaryBlobDirectory,
        blobs,
      };
      DurableArtifactStore.verifyBackup(staged);
      this.renewBackupLock(lockToken);
      this.windowsGuard?.release(`${pathLease}:blob-shard:`);
      this.windowsGuard?.release(`${pathLease}:blobs`);
      this.windowsGuard?.release(`${pathLease}:bundle`);
      durableRename(
        temporaryBundle,
        resolved,
        this.windowsGuard,
        () => this.inject("after_backup_publish_source_pin"),
      );
      published = true;
      assertNoReparseComponents(parent, resolved);
      const backup: ArtifactBackup = {
        ...staged,
        bundlePath: resolved,
        manifestPath: path.join(resolved, BACKUP_MANIFEST_NAME),
        path: path.join(resolved, DATABASE_NAME),
        blobDirectory: path.join(resolved, "blobs"),
      };
      this.inject("after_backup_publish");
      DurableArtifactStore.verifyBackup(backup);
      return backup;
    } catch (error) {
      this.windowsGuard?.release(`${pathLease}:blob-shard:`);
      this.windowsGuard?.release(`${pathLease}:blobs`);
      this.windowsGuard?.release(`${pathLease}:bundle`);
      if (existsSync(temporaryBundle)) {
        DurableArtifactStore.removeExternalStaging(parent, temporaryBundle, this.windowsGuard);
      }
      if (published && existsSync(resolved)) {
        DurableArtifactStore.removeExternalStaging(parent, resolved, this.windowsGuard);
      }
      if (this.isDiskFailure(error)) {
        throw new ArtifactStoreError(
          `Artifact backup failed closed: ${error instanceof Error ? error.message : "unknown error"}`,
          "disk_write_failed",
        );
      }
      throw error;
    } finally {
      try {
        DurableArtifactStore.releaseStagingOwner(parent, stagingOwner, this.windowsGuard);
      } finally {
        try { this.releaseBackupLock(lockToken); } finally { this.windowsGuard?.release(pathLease); }
      }
    }
  }

  static verifyBackup(backup: ArtifactBackup): void {
    if (!backup || backup.schemaVersion !== 1
      || !path.isAbsolute(backup.bundlePath) || isUncOrDevice(backup.bundlePath)
      || !path.isAbsolute(backup.manifestPath) || isUncOrDevice(backup.manifestPath)
      || !path.isAbsolute(backup.path) || isUncOrDevice(backup.path)
      || !path.isAbsolute(backup.blobDirectory) || isUncOrDevice(backup.blobDirectory)) {
      throw new ArtifactStoreError("Backup path is not a local absolute path.", "containment_failed");
    }
    if (!isCanonicalIsoTimestamp(backup.createdAt) || !Number.isSafeInteger(backup.bytes) || backup.bytes < 0) {
      throw new ArtifactStoreError("Artifact backup metadata is malformed.", "integrity_failed");
    }
    const bundlePath = path.resolve(backup.bundlePath);
    if (!existsSync(bundlePath)) {
      throw new ArtifactStoreError("Artifact backup bundle is missing.", "integrity_failed");
    }
    const windowsGuard = process.platform === "win32" ? new WindowsNativePathGuard() : undefined;
    const guardLease = `verify-backup:${randomUUID()}`;
    try {
    const bundleParent = windowsGuard
      ? windowsGuard.ensureDirectory(path.dirname(bundlePath), undefined, `${guardLease}:parent`)
      : realpathSync.native(path.dirname(bundlePath));
    windowsGuard?.pinExisting(bundlePath, bundleParent, `${guardLease}:bundle`, true, true);
    assertNoReparseComponents(bundleParent, bundlePath);
    const bundleStat = lstatSync(bundlePath);
    if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()
      || !samePath(realpathSync.native(bundlePath), bundlePath)) {
      throw new ArtifactStoreError("Artifact backup bundle is not a physical directory.", "containment_failed");
    }
    const databasePath = path.resolve(backup.path);
    const blobDirectory = path.resolve(backup.blobDirectory);
    const manifestPath = path.resolve(backup.manifestPath);
    if (!samePath(databasePath, path.join(bundlePath, DATABASE_NAME))
      || !samePath(blobDirectory, path.join(bundlePath, "blobs"))
      || !samePath(manifestPath, path.join(bundlePath, BACKUP_MANIFEST_NAME))) {
      throw new ArtifactStoreError("Artifact backup paths do not match the bundle contract.", "containment_failed");
    }
    if (!existsSync(databasePath) || !existsSync(blobDirectory) || !existsSync(manifestPath)) {
      throw new ArtifactStoreError("Artifact backup bundle is incomplete.", "integrity_failed");
    }
    windowsGuard?.pinExisting(databasePath, bundlePath, `${guardLease}:database`, false, false);
    windowsGuard?.pinExisting(blobDirectory, bundlePath, `${guardLease}:blobs`, true, true);
    windowsGuard?.pinExisting(manifestPath, bundlePath, `${guardLease}:manifest`, false, false);
    assertPhysicalFile(bundlePath, databasePath);
    assertNoReparseComponents(bundlePath, blobDirectory);
    const blobStat = lstatSync(blobDirectory);
    if (!blobStat.isDirectory() || blobStat.isSymbolicLink()
      || !samePath(realpathSync.native(blobDirectory), blobDirectory)) {
      throw new ArtifactStoreError("Artifact backup blob root is not a physical directory.", "containment_failed");
    }
    assertPhysicalFile(bundlePath, manifestPath);
    const topLevel = readdirSync(bundlePath, { withFileTypes: true });
    if (stableStringify(topLevel.map((entry) => entry.name).sort())
      !== stableStringify([BACKUP_MANIFEST_NAME, DATABASE_NAME, "blobs"].sort())) {
      throw new ArtifactStoreError("Artifact backup bundle contains unexpected entries.", "integrity_failed");
    }
    const manifestStat = statSync(manifestPath);
    if (manifestStat.size <= 0 || manifestStat.size > BACKUP_MANIFEST_MAXIMUM_BYTES) {
      throw new ArtifactStoreError("Artifact backup manifest size is invalid.", "integrity_failed");
    }
    let manifest: ArtifactBackupManifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactBackupManifest; } catch {
      throw new ArtifactStoreError("Artifact backup manifest JSON is malformed.", "integrity_failed");
    }
    if (!manifest || manifest.schemaVersion !== 1
      || !exactKeys(manifest, ["schemaVersion", "createdAt", "database", "blobs", "policyHash", "migrations"])
      || !manifest.database || !exactKeys(manifest.database, ["relativePath", "sha256", "bytes"])
      || manifest.database.relativePath !== DATABASE_NAME || manifest.createdAt !== backup.createdAt
      || manifest.database.sha256 !== backup.sha256 || manifest.database.bytes !== backup.bytes
      || !CONTENT_HASH.test(manifest.policyHash) || !Array.isArray(manifest.blobs)
      || !Array.isArray(manifest.migrations)
      || stableStringify(manifest.blobs) !== stableStringify(backup.blobs)) {
      throw new ArtifactStoreError("Artifact backup manifest contract is invalid.", "integrity_failed");
    }
    if (manifest.blobs.some((item) => !item || !exactKeys(item, ["contentHash", "relativePath", "bytes"]))) {
      throw new ArtifactStoreError("Artifact backup blob manifest fields are invalid.", "integrity_failed");
    }
    const data = readFileSync(databasePath);
    if (data.byteLength !== backup.bytes || sha256(data) !== backup.sha256) {
      throw new ArtifactStoreError("Artifact backup hash or size mismatch.", "integrity_failed");
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      DurableArtifactStore.verifyDatabaseContract(database, true);
      const policyRow = database.prepare(`
        SELECT policy_hash FROM artifact_store_policy WHERE policy_id = ?
      `).get(POLICY_ID) as { policy_hash?: string } | undefined;
      const migrations = database.prepare(`
        SELECT version, name, checksum FROM artifact_schema_migrations ORDER BY version
      `).all() as unknown as ArtifactBackupManifest["migrations"];
      if (policyRow?.policy_hash !== manifest.policyHash
        || stableStringify(migrations) !== stableStringify(manifest.migrations)) {
        throw new ArtifactStoreError("Artifact backup policy or migration evidence mismatch.", "integrity_failed");
      }
      const databaseBlobs = database.prepare(`
        SELECT content_hash, bytes, relative_path FROM artifact_blobs ORDER BY content_hash
      `).all() as unknown as Array<{ content_hash: string; bytes: number; relative_path: string }>;
      const blobManifest = [...backup.blobs].sort((left, right) => left.contentHash.localeCompare(right.contentHash));
      if (databaseBlobs.length !== blobManifest.length) {
        throw new ArtifactStoreError("Artifact backup blob manifest count mismatch.", "integrity_failed");
      }
      for (let index = 0; index < databaseBlobs.length; index += 1) {
        const row = databaseBlobs[index];
        const item = blobManifest[index];
        const blobPath = path.join(blobDirectory, row.relative_path);
        assertNoReparseComponents(blobDirectory, blobPath);
        if (!item || item.contentHash !== row.content_hash || item.relativePath !== row.relative_path
          || item.bytes !== row.bytes || !CONTENT_HASH.test(row.content_hash)
          || row.relative_path !== path.join(row.content_hash.slice(0, 2), row.content_hash)
          || !DurableArtifactStore.isVerifiedBackupBlob(
            blobPath, row.content_hash, row.bytes, windowsGuard, blobDirectory,
          )) {
          throw new ArtifactStoreError("Artifact backup blob manifest is inconsistent.", "integrity_failed");
        }
      }
      const files = DurableArtifactStore.listBackupBlobFiles(blobDirectory, windowsGuard, guardLease);
      if (stableStringify(files) !== stableStringify(blobManifest.map((item) => item.relativePath).sort())) {
        throw new ArtifactStoreError("Artifact backup contains missing or untracked blob files.", "integrity_failed");
      }
    } finally {
      database.close();
    }
    } finally {
      try { windowsGuard?.release(guardLease); } finally { windowsGuard?.close(); }
    }
  }

  private static isVerifiedBackupBlob(
    filePath: string,
    contentHash: string,
    bytes: number,
    windowsGuard?: WindowsNativePathGuard,
    containmentRoot?: string,
  ): boolean {
    const lease = `verify-file:${randomUUID()}`;
    try {
      if (windowsGuard && containmentRoot) {
        windowsGuard.pinExisting(filePath, containmentRoot, lease, false, false);
      }
      const stat = lstatSync(filePath);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === bytes
        && sha256(readFileSync(filePath)) === contentHash;
    } catch {
      return false;
    } finally {
      windowsGuard?.release(lease);
    }
  }

  private static listBackupBlobFiles(
    blobDirectory: string,
    windowsGuard?: WindowsNativePathGuard,
    leasePrefix = `backup-list:${randomUUID()}`,
  ): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
      windowsGuard?.pinExisting(
        directory, blobDirectory, `${leasePrefix}:directory:${files.length}:${randomUUID()}`, true, true,
      );
      assertNoReparseComponents(blobDirectory, directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new ArtifactStoreError("Artifact backup blob tree contains a symbolic link.", "containment_failed");
        }
        assertNoReparseComponents(blobDirectory, absolute);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) files.push(path.relative(blobDirectory, absolute));
        else throw new ArtifactStoreError("Artifact backup blob tree contains a special file.", "containment_failed");
      }
    };
    visit(blobDirectory);
    return files.sort();
  }

  private static cleanupStaleStaging(
    parent: string,
    prefix: string,
    suffix: string,
    windowsGuard?: WindowsNativePathGuard,
    afterSourcePin?: () => void,
  ): void {
    assertNoReparseComponents(parent, parent);
    const cutoff = Date.now() - STALE_STAGING_AGE_MS;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
      const candidate = path.join(parent, entry.name);
      const stat = lstatSync(candidate);
      if (stat.mtimeMs > cutoff) continue;
      DurableArtifactStore.cleanupOwnedStaging(parent, candidate, windowsGuard, afterSourcePin);
    }
    DurableArtifactStore.cleanupOrphanStagingOwners(
      parent, prefix, suffix, cutoff, windowsGuard, afterSourcePin,
    );
  }

  private static cleanupBackupStaging(
    parent: string,
    prefix: string,
    suffix: string,
    windowsGuard?: WindowsNativePathGuard,
    afterSourcePin?: () => void,
  ): void {
    assertNoReparseComponents(parent, parent);
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
      DurableArtifactStore.cleanupOwnedStaging(
        parent, path.join(parent, entry.name), windowsGuard, afterSourcePin,
      );
    }
    DurableArtifactStore.cleanupOrphanStagingOwners(
      parent, prefix, suffix, undefined, windowsGuard, afterSourcePin,
    );
  }

  private static cleanupOrphanStagingOwners(
    parent: string,
    prefix: string,
    suffix: string,
    cutoff: number | undefined,
    windowsGuard?: WindowsNativePathGuard,
    afterSourcePin?: () => void,
  ): void {
    const ownerSuffix = `${suffix}${STAGING_OWNER_SUFFIX}`;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(ownerSuffix) || !entry.isFile()) continue;
      const ownerPath = path.join(parent, entry.name);
      if (cutoff !== undefined && lstatSync(ownerPath).mtimeMs > cutoff) continue;
      const candidate = ownerPath.slice(0, -STAGING_OWNER_SUFFIX.length);
      if (existsSync(candidate)) continue;
      DurableArtifactStore.cleanupOwnedStaging(parent, candidate, windowsGuard, afterSourcePin);
    }
  }

  private static createStagingOwner(
    parent: string,
    staging: string,
    windowsGuard?: WindowsNativePathGuard,
  ): StagingOwnerLease {
    const ownerPath = `${staging}${STAGING_OWNER_SUFFIX}`;
    const guardLease = `staging-owner:${randomUUID()}`;
    try {
      if (windowsGuard) windowsGuard.ensureFile(ownerPath, parent, guardLease);
      else assertSafeCreationTarget(ownerPath, parent);
      const database = new DatabaseSync(ownerPath, { timeout: SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS });
      database.exec(`PRAGMA busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS};`);
      database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
      database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
      return { database, path: ownerPath, guardLease };
    } catch (error) {
      windowsGuard?.release(guardLease);
      if (DurableArtifactStore.isDiskFailureValue(error)) {
        throw new ArtifactStoreError("Artifact staging owner could not be persisted.", "disk_write_failed");
      }
      throw error;
    }
  }

  private static releaseStagingOwner(
    parent: string,
    owner: StagingOwnerLease | undefined,
    windowsGuard?: WindowsNativePathGuard,
  ): void {
    if (!owner) return;
    let failure: unknown;
    try { owner.database.exec("COMMIT"); } catch (error) { failure = error; }
    try { owner.database.close(); } catch (error) { failure ??= error; }
    windowsGuard?.release(owner.guardLease);
    try {
      if (existsSync(owner.path)) {
        DurableArtifactStore.removeExternalStaging(parent, owner.path, windowsGuard);
      }
    } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }

  private static cleanupOwnedStaging(
    parent: string,
    candidate: string,
    windowsGuard?: WindowsNativePathGuard,
    afterSourcePin?: () => void,
  ): void {
    const ownerPath = `${candidate}${STAGING_OWNER_SUFFIX}`;
    if (!existsSync(ownerPath)) return;
    const guardLease = `staging-cleanup:${randomUUID()}`;
    let database: DatabaseSync | undefined;
    let acquired = false;
    try {
      windowsGuard?.pinExisting(ownerPath, parent, guardLease, false, true);
      database = new DatabaseSync(ownerPath);
      database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
      acquired = true;
      if (existsSync(candidate)) {
        DurableArtifactStore.removeExternalStaging(parent, candidate, windowsGuard, afterSourcePin);
      }
      database.exec("COMMIT");
      database.close();
      database = undefined;
      windowsGuard?.release(guardLease);
      if (existsSync(ownerPath)) {
        DurableArtifactStore.removeExternalStaging(parent, ownerPath, windowsGuard, afterSourcePin);
      }
    } catch (error) {
      if (DurableArtifactStore.isSqliteBusyValue(error)) return;
      if (DurableArtifactStore.isDiskFailureValue(error)) {
        throw new ArtifactStoreError("Artifact staging cleanup failed because storage is full.", "disk_write_failed");
      }
      throw error;
    } finally {
      if (database) {
        if (acquired) try { database.exec("ROLLBACK"); } catch { /* best effort */ }
        try { database.close(); } catch { /* best effort */ }
      }
      windowsGuard?.release(guardLease);
    }
  }

  private static removeExternalStaging(
    parent: string,
    candidate: string,
    windowsGuard?: WindowsNativePathGuard,
    afterSourcePin?: () => void,
  ): void {
    const resolvedParent = path.resolve(parent);
    const resolved = path.resolve(candidate);
    if (samePath(resolvedParent, resolved) || !isContained(resolvedParent, resolved)) {
      throw new ArtifactStoreError("Refused broad or escaping staging cleanup.", "containment_failed");
    }
    assertNoReparseComponents(resolvedParent, path.dirname(resolved));
    if (!existsSync(resolved)) return;
    if (process.platform === "win32") {
      if (!windowsGuard) {
        throw new ArtifactStoreError(
          "Windows staging cleanup requires native rename identity verification.",
          "containment_failed",
        );
      }
      const quarantine = path.join(
        resolvedParent,
        `.${path.basename(resolved)}.${randomUUID()}.quarantine`,
      );
      windowsGuard.renameWriteThrough(resolved, quarantine, afterSourcePin);
      assertNoReparseComponents(resolvedParent, quarantine);
      rmSync(quarantine, { recursive: true, force: true });
      return;
    }
    if (lstatSync(resolved).isSymbolicLink()) {
      unlinkSync(resolved);
      return;
    }
    assertNoReparseComponents(resolvedParent, resolved);
    rmSync(resolved, { recursive: true, force: true });
  }

  private static initializeBackupMutex(mutexPath: string): DatabaseSync {
    let lastBusy: unknown;
    for (let attempt = 1; attempt <= SQLITE_INITIALIZATION_ATTEMPTS; attempt += 1) {
      let mutex: DatabaseSync | undefined;
      let acquired = false;
      try {
        mutex = new DatabaseSync(mutexPath, { timeout: SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS });
        mutex.exec(`PRAGMA busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS};`);
        mutex.exec("PRAGMA journal_mode = DELETE;");
        mutex.exec("PRAGMA synchronous = FULL;");
        mutex.exec("BEGIN EXCLUSIVE;");
        acquired = true;
        return mutex;
      } catch (error) {
        if (!DurableArtifactStore.isSqliteBusyValue(error)) throw error;
        lastBusy = error;
      } finally {
        if (!acquired) try { mutex?.close(); } catch { /* preserve initialization result */ }
      }
      if (attempt < SQLITE_INITIALIZATION_ATTEMPTS) {
        Atomics.wait(CHECKPOINT_WAIT_STATE, 0, 0, 25 * attempt);
      }
    }
    throw new ArtifactStoreError(
      `Artifact store initialization is busy during backup_mutex_initialization after ${SQLITE_INITIALIZATION_ATTEMPTS} attempts: ${lastBusy instanceof Error ? lastBusy.message : "database is locked"}`,
      "operation_in_progress",
    );
  }

  private static isDiskFailureValue(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const record = error as Error & { code?: unknown; errcode?: unknown; cause?: unknown };
    const code = String(record.code ?? "");
    if (["ENOSPC", "EDQUOT", "SQLITE_FULL", "ERROR_DISK_FULL", "ERROR_HANDLE_DISK_FULL"].includes(code)) {
      return true;
    }
    if (code === "ERR_SQLITE_ERROR" && Number(record.errcode) === 13) return true;
    if (/database or disk is full|no space left on device/iu.test(error.message)) return true;
    return record.cause !== undefined && DurableArtifactStore.isDiskFailureValue(record.cause);
  }

  private static isSqliteBusyValue(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const record = error as Error & { code?: unknown; errcode?: unknown; cause?: unknown };
    if (String(record.code ?? "") === "SQLITE_BUSY" || Number(record.errcode) === 5
      || /database is locked/iu.test(error.message)) return true;
    return record.cause !== undefined && DurableArtifactStore.isSqliteBusyValue(record.cause);
  }

  static restoreBackup(
    backup: ArtifactBackup,
    destinationRoot: string,
    faultInjector?: ArtifactFaultInjector,
  ): void {
    DurableArtifactStore.verifyBackup(backup);
    if (!path.isAbsolute(destinationRoot) || isUncOrDevice(destinationRoot)) {
      throw new ArtifactStoreError("Restore root must be an absolute local path.", "containment_failed");
    }
    const destination = path.resolve(destinationRoot);
    const windowsGuard = process.platform === "win32" ? new WindowsNativePathGuard() : undefined;
    const pathLease = `restore-path:${randomUUID()}`;
    let parent = path.dirname(destination);
    let staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.restore`);
    let stagingOwner: StagingOwnerLease | undefined;
    try {
      faultInjector?.("before_restore_parent_open");
      parent = ensurePhysicalDirectory(parent, undefined, windowsGuard, `${pathLease}:parent`);
      assertNoReparseComponents(parent, destination);
      if (existsSync(destination)) {
        throw new ArtifactStoreError("Restore root must not already exist.", "containment_failed");
      }
      DurableArtifactStore.cleanupStaleStaging(
        parent,
        `.${path.basename(destination)}.`,
        ".restore",
        windowsGuard,
        () => faultInjector?.("after_staging_cleanup_source_pin"),
      );
      staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.restore`);
      assertNoReparseComponents(parent, staging);
      DurableArtifactStore.preflightExternalFreeSpace(parent, DurableArtifactStore.estimatedRestoreBytes(backup));
      stagingOwner = DurableArtifactStore.createStagingOwner(parent, staging, windowsGuard);
      ensurePhysicalDirectory(staging, parent, windowsGuard, `${pathLease}:staging`);
      const stagedDatabase = path.join(staging, DATABASE_NAME);
      copyExternalSource(
        backup.path,
        backup.bundlePath,
        stagedDatabase,
        staging,
        windowsGuard,
        `${pathLease}:copy-database`,
        () => faultInjector?.("after_restore_database_source_pin"),
      );
      assertPhysicalFile(staging, stagedDatabase);
      flushPublishedFile(stagedDatabase, windowsGuard, staging);
      faultInjector?.("after_restore_database_copy");
      const blobRoot = path.join(staging, "blobs");
      ensurePhysicalDirectory(blobRoot, staging, windowsGuard, `${pathLease}:blobs`);
      for (const blob of backup.blobs) {
        const target = path.join(blobRoot, blob.relativePath);
        ensurePhysicalDirectory(
          path.dirname(target), staging, windowsGuard, `${pathLease}:shard:${blob.contentHash.slice(0, 2)}`,
        );
        copyExternalSource(
          path.join(backup.blobDirectory, blob.relativePath),
          backup.bundlePath,
          target,
          staging,
          windowsGuard,
          `${pathLease}:copy-blob:${blob.contentHash}`,
          () => faultInjector?.("after_restore_blob_source_pin"),
        );
        assertPhysicalFile(staging, target);
        flushPublishedFile(target, windowsGuard, staging);
        faultInjector?.("after_restore_blob_copy");
      }
      const stagedManifest = path.join(staging, BACKUP_MANIFEST_NAME);
      faultInjector?.("before_restore_manifest_copy");
      copyExternalSource(
        backup.manifestPath,
        backup.bundlePath,
        stagedManifest,
        staging,
        windowsGuard,
        `${pathLease}:copy-manifest`,
        () => faultInjector?.("after_restore_manifest_source_pin"),
      );
      assertPhysicalFile(staging, stagedManifest);
      flushPublishedFile(stagedManifest, windowsGuard, staging);
      faultInjector?.("after_restore_manifest_copy");
      DurableArtifactStore.verifyBackup({
        ...backup,
        bundlePath: staging,
        manifestPath: stagedManifest,
        path: stagedDatabase,
        blobDirectory: blobRoot,
      });
      windowsGuard?.release(`${pathLease}:shard:`);
      windowsGuard?.release(`${pathLease}:blobs`);
      windowsGuard?.release(`${pathLease}:staging`);
      durableRename(
        staging,
        destination,
        windowsGuard,
        () => faultInjector?.("after_restore_publish_source_pin"),
      );
      assertNoReparseComponents(parent, destination);
      DurableArtifactStore.verifyBackup({
        ...backup,
        bundlePath: destination,
        manifestPath: path.join(destination, BACKUP_MANIFEST_NAME),
        path: path.join(destination, DATABASE_NAME),
        blobDirectory: path.join(destination, "blobs"),
      });
    } catch (error) {
      windowsGuard?.release(`${pathLease}:shard:`);
      windowsGuard?.release(`${pathLease}:blobs`);
      windowsGuard?.release(`${pathLease}:staging`);
      if (existsSync(staging)) {
        DurableArtifactStore.removeExternalStaging(parent, staging, windowsGuard);
      }
      if (DurableArtifactStore.isDiskFailureValue(error)) {
        throw new ArtifactStoreError(
          `Artifact restore failed closed: ${error instanceof Error ? error.message : "unknown error"}`,
          "disk_write_failed",
        );
      }
      throw error;
    } finally {
      try {
        DurableArtifactStore.releaseStagingOwner(parent, stagingOwner, windowsGuard);
      } finally {
        try { windowsGuard?.release(pathLease); } finally { windowsGuard?.close(); }
      }
    }
  }

  counts(): { blobs: number; references: number; intents: number; bytes: number; metadataBytes: number } {
    this.assertOpen();
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM artifact_blobs)
          + (SELECT COUNT(*) FROM artifact_gc_intents) AS blobs,
        (SELECT COUNT(*) FROM artifact_references) AS refs,
        (SELECT COUNT(*) FROM artifact_write_intents) AS intents,
        (SELECT COALESCE(SUM(bytes), 0) FROM artifact_blobs)
          + (SELECT COALESCE(SUM(bytes), 0) FROM artifact_gc_intents) AS bytes,
        (
          SELECT COALESCE(SUM(length(CAST(content_hash AS BLOB)) + length(CAST(relative_path AS BLOB))
            + length(CAST(created_at AS BLOB)) + 8), 0)
          FROM artifact_blobs
        ) + (
          SELECT COALESCE(SUM(length(CAST(id AS BLOB)) + length(CAST(run_id AS BLOB))
            + length(CAST(content_hash AS BLOB)) + length(CAST(label AS BLOB))
            + length(CAST(created_at AS BLOB))), 0)
          FROM artifact_references
        ) + (
          SELECT COALESCE(SUM(length(CAST(intent_id AS BLOB)) + length(CAST(content_hash AS BLOB))
            + length(CAST(relative_path AS BLOB)) + length(CAST(run_id AS BLOB))
            + length(CAST(label AS BLOB)) + length(CAST(reference_id AS BLOB))
            + length(CAST(created_at AS BLOB)) + length(CAST(lease_expires_at AS BLOB)) + 8), 0)
          FROM artifact_write_intents
        ) + (
          SELECT COALESCE(SUM(length(CAST(content_hash AS BLOB))
            + length(CAST(relative_path AS BLOB)) + length(CAST(created_at AS BLOB)) + 8), 0)
          FROM artifact_gc_intents
        ) AS metadata_bytes
    `).get() as { blobs: number; refs: number; intents: number; bytes: number; metadata_bytes: number };
    return {
      blobs: Number(row.blobs),
      references: Number(row.refs),
      intents: Number(row.intents),
      bytes: Number(row.bytes),
      metadataBytes: Number(row.metadata_bytes),
    };
  }

  private validatePolicy(policy: ArtifactPolicyDocument): void {
    DurableArtifactStore.validatePolicyDocument(policy);
  }

  private static validatePolicyDocument(policy: ArtifactPolicyDocument): void {
    if (!policy || policy.schemaVersion !== 1 || !policy.quota || !policy.retention) {
      throw new Error("Artifact policy schema is invalid.");
    }
    const quotaKeys = Object.keys(DEFAULT_QUOTA).sort();
    if (stableStringify(Object.keys(policy.quota).sort()) !== stableStringify(quotaKeys)) {
      throw new Error("Artifact quota fields are incomplete or unknown.");
    }
    for (const [name, value] of Object.entries(policy.quota)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
    }
    if (!Number.isSafeInteger(policy.intentLeaseMs) || policy.intentLeaseMs <= 0) {
      throw new Error("intentLeaseMs must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(policy.retention.maximumReferenceAgeMs)
      || policy.retention.maximumReferenceAgeMs <= 0) {
      throw new Error("maximumReferenceAgeMs must be a positive safe integer.");
    }
    if (typeof policy.retention.garbageCollectUnreferencedBlobs !== "boolean"
      || Object.keys(policy.retention).length !== Object.keys(DEFAULT_RETENTION).length) {
      throw new Error("Artifact retention policy is invalid.");
    }
  }

  private applyMigrations(): void {
    this.immediateTransaction(() => {
      this.db.exec(MIGRATION_LEDGER_SQL);
      DurableArtifactStore.verifyMigrationLedger(this.db);
      for (const migration of MIGRATIONS) {
        const existing = this.db.prepare(`
          SELECT name, checksum FROM artifact_schema_migrations WHERE version = ?
        `).get(migration.version) as { name?: string; checksum?: string } | undefined;
        const checksum = sha256(migration.sql);
        if (existing) {
          if (existing.name !== migration.name || existing.checksum !== checksum) {
            throw new ArtifactStoreError("Artifact migration ledger checksum mismatch.", "integrity_failed");
          }
          continue;
        }
        const maximum = scalarNumber((this.db.prepare(
          "SELECT COALESCE(MAX(version), 0) AS value FROM artifact_schema_migrations",
        ).get() as { value?: number } | undefined)?.value);
        if (migration.version !== maximum + 1) {
          throw new ArtifactStoreError("Artifact migrations must be forward-only and contiguous.", "integrity_failed");
        }
        this.db.exec(migration.sql);
        this.db.prepare(`
          INSERT INTO artifact_schema_migrations (version, name, checksum, applied_at)
          VALUES (?, ?, ?, ?)
        `).run(migration.version, migration.name, checksum, new Date().toISOString());
        const reread = this.db.prepare(`
          SELECT name, checksum FROM artifact_schema_migrations WHERE version = ?
        `).get(migration.version) as { name?: string; checksum?: string } | undefined;
        if (reread?.name !== migration.name || reread.checksum !== checksum) {
          throw new ArtifactStoreError("Artifact migration ledger reread failed.", "integrity_failed");
        }
      }
      DurableArtifactStore.verifyMigrationLedger(this.db, true);
    });
    DurableArtifactStore.verifyMigrationLedger(this.db, true);
  }

  private static verifyMigrationLedger(database: DatabaseSync, requireComplete = false): void {
    const table = database.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'artifact_schema_migrations'
    `).get() as { present?: number } | undefined;
    if (!table) return;
    const rows = database.prepare(`
      SELECT version, name, checksum FROM artifact_schema_migrations ORDER BY version
    `).all() as unknown as Array<{ version: number; name: string; checksum: string }>;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const migration = MIGRATIONS[index];
      if (!migration || row.version !== index + 1 || row.name !== migration.name
        || row.checksum !== sha256(migration.sql)) {
        throw new ArtifactStoreError("Artifact migration ledger is unknown, sparse, or modified.", "integrity_failed");
      }
    }
    if (requireComplete && rows.length !== MIGRATIONS.length) {
      throw new ArtifactStoreError("Artifact migration ledger is incomplete.", "integrity_failed");
    }
  }

  private static schemaEntries(database: DatabaseSync): SchemaEntry[] {
    return (database.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all() as unknown as Array<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>).map((row) => ({
      type: row.type,
      name: row.name,
      tableName: row.tbl_name,
      sql: row.sql,
    }));
  }

  private static schemaIndexEvidence(database: DatabaseSync, tables: readonly string[]): Record<string, unknown> {
    const evidence: Record<string, unknown> = {};
    for (const table of tables) {
      const escapedTable = table.replaceAll("'", "''");
      const indexes = database.prepare(`PRAGMA index_list('${escapedTable}')`).all() as unknown as Array<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>;
      evidence[table] = indexes.map((index) => {
        const escapedIndex = index.name.replaceAll("'", "''");
        const columns = database.prepare(`PRAGMA index_xinfo('${escapedIndex}')`).all() as unknown as Array<{
          seqno: number;
          cid: number;
          name: string | null;
          desc: number;
          coll: string;
          key: number;
        }>;
        return {
          name: index.name,
          unique: Number(index.unique),
          origin: index.origin,
          partial: Number(index.partial),
          columns: columns.map((column) => ({
            seqno: Number(column.seqno),
            cid: Number(column.cid),
            name: column.name,
            desc: Number(column.desc),
            coll: column.coll,
            key: Number(column.key),
          })),
        };
      }).sort((left, right) => left.name.localeCompare(right.name));
    }
    return evidence;
  }

  private static schemaForeignKeyEvidence(database: DatabaseSync, tables: readonly string[]): Record<string, unknown> {
    const evidence: Record<string, unknown> = {};
    for (const table of tables) {
      const escapedTable = table.replaceAll("'", "''");
      evidence[table] = (database.prepare(`PRAGMA foreign_key_list('${escapedTable}')`).all() as unknown as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>).map((row) => ({
        id: Number(row.id),
        seq: Number(row.seq),
        table: row.table,
        from: row.from,
        to: row.to,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
        match: row.match,
      }));
    }
    return evidence;
  }

  private static expectedSchemaEvidence(): NonNullable<typeof EXPECTED_SCHEMA_EVIDENCE> {
    if (EXPECTED_SCHEMA_EVIDENCE) return EXPECTED_SCHEMA_EVIDENCE;
    const canonical = new DatabaseSync(":memory:");
    try {
      canonical.exec("PRAGMA foreign_keys = ON;");
      canonical.exec(MIGRATION_LEDGER_SQL);
      for (const migration of MIGRATIONS) canonical.exec(migration.sql);
      const entries = DurableArtifactStore.schemaEntries(canonical);
      const tables = Object.keys(EXPECTED_SCHEMA_COLUMNS).sort();
      EXPECTED_SCHEMA_EVIDENCE = {
        entries,
        hash: sha256(stableStringify(entries)),
        indexes: DurableArtifactStore.schemaIndexEvidence(canonical, tables),
        foreignKeys: DurableArtifactStore.schemaForeignKeyEvidence(canonical, tables),
      };
      return EXPECTED_SCHEMA_EVIDENCE;
    } finally {
      canonical.close();
    }
  }

  private static verifySchema(database: DatabaseSync): void {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all() as unknown as Array<{ name: string }>;
    const expectedTables = Object.keys(EXPECTED_SCHEMA_COLUMNS).sort();
    if (stableStringify(tables.map((row) => row.name)) !== stableStringify(expectedTables)) {
      throw new ArtifactStoreError("Artifact database table schema is unknown or incomplete.", "integrity_failed");
    }
    for (const table of expectedTables) {
      const columns = database.prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`).all() as unknown as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
      const actual = columns.map((column) => (
        `${column.name}:${String(column.type).toUpperCase()}:${Number(column.notnull)}:${Number(column.pk)}`
      ));
      if (stableStringify(actual) !== stableStringify(EXPECTED_SCHEMA_COLUMNS[table])) {
        throw new ArtifactStoreError(`Artifact table ${table} has an unexpected column contract.`, "integrity_failed");
      }
    }
    const expectedEvidence = DurableArtifactStore.expectedSchemaEvidence();
    const actualEntries = DurableArtifactStore.schemaEntries(database);
    const actualHash = sha256(stableStringify(actualEntries));
    if (actualHash !== expectedEvidence.hash
      || stableStringify(actualEntries) !== stableStringify(expectedEvidence.entries)) {
      throw new ArtifactStoreError(
        `Artifact canonical schema DDL hash mismatch (${actualHash}).`,
        "integrity_failed",
      );
    }
    const indexEvidence = DurableArtifactStore.schemaIndexEvidence(database, expectedTables);
    if (stableStringify(indexEvidence) !== stableStringify(expectedEvidence.indexes)) {
      throw new ArtifactStoreError("Artifact index_list/index_xinfo contract is invalid.", "integrity_failed");
    }
    const foreignKeyEvidence = DurableArtifactStore.schemaForeignKeyEvidence(database, expectedTables);
    if (stableStringify(foreignKeyEvidence) !== stableStringify(expectedEvidence.foreignKeys)) {
      throw new ArtifactStoreError("Artifact foreign-key DDL contract is invalid.", "integrity_failed");
    }
    const indexes = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name
    `).all() as unknown as Array<{ name: string }>;
    if (stableStringify(indexes.map((row) => row.name))
      !== stableStringify([...EXPECTED_EXPLICIT_INDEXES].sort())) {
      throw new ArtifactStoreError("Artifact database index contract is unknown or incomplete.", "integrity_failed");
    }
    const foreignKeys = database.prepare("PRAGMA foreign_key_list('artifact_references')").all() as unknown as Array<{
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }>;
    if (foreignKeys.length !== 1 || foreignKeys[0]?.table !== "artifact_blobs"
      || foreignKeys[0]?.from !== "content_hash" || foreignKeys[0]?.to !== "content_hash"
      || foreignKeys[0]?.on_update !== "NO ACTION" || foreignKeys[0]?.on_delete !== "NO ACTION") {
      throw new ArtifactStoreError("Artifact foreign-key schema is invalid.", "integrity_failed");
    }
    const executableSchema = database.prepare(`
      SELECT COUNT(*) AS value FROM sqlite_master WHERE type IN ('trigger', 'view')
    `).get() as { value?: number } | undefined;
    if (scalarNumber(executableSchema?.value) !== 0) {
      throw new ArtifactStoreError("Unexpected executable artifact schema was found.", "integrity_failed");
    }
  }

  private static readAndValidatePolicy(database: DatabaseSync): ArtifactPolicyDocument {
    const rows = database.prepare(`
      SELECT policy_id, policy_json, policy_hash, updated_at FROM artifact_store_policy
    `).all() as unknown as Array<{
      policy_id: number;
      policy_json: string;
      policy_hash: string;
      updated_at: string;
    }>;
    const row = rows[0];
    if (rows.length !== 1 || row?.policy_id !== POLICY_ID || typeof row.policy_json !== "string"
      || typeof row.policy_hash !== "string" || sha256(row.policy_json) !== row.policy_hash
      || !isCanonicalIsoTimestamp(row.updated_at)) {
      throw new ArtifactStoreError("Durable artifact policy row is invalid.", "integrity_failed");
    }
    let policy: ArtifactPolicyDocument;
    try { policy = JSON.parse(row.policy_json) as ArtifactPolicyDocument; } catch {
      throw new ArtifactStoreError("Durable artifact policy JSON is malformed.", "integrity_failed");
    }
    try { DurableArtifactStore.validatePolicyDocument(policy); } catch (error) {
      throw new ArtifactStoreError(
        `Durable artifact policy contract failed: ${error instanceof Error ? error.message : "unknown"}`,
        "integrity_failed",
      );
    }
    return policy;
  }

  private static verifyDatabaseInvariants(
    database: DatabaseSync,
    policy: ArtifactPolicyDocument,
    requireSettled: boolean,
  ): void {
    const conflicts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM artifact_gc_intents g
          JOIN artifact_blobs b ON b.content_hash = g.content_hash) AS gc_blobs,
        (SELECT COUNT(*) FROM artifact_gc_intents g
          JOIN artifact_references r ON r.content_hash = g.content_hash) AS gc_refs,
        (SELECT COUNT(*) FROM artifact_gc_intents g
          JOIN artifact_write_intents i ON i.content_hash = g.content_hash) AS gc_writes,
        (SELECT COUNT(*) FROM artifact_write_intents i
          JOIN artifact_references r ON r.run_id = i.run_id
            AND r.content_hash = i.content_hash AND r.label = i.label) AS finalized_writes
    `).get() as Record<string, number>;
    if (Object.values(conflicts).some((value) => scalarNumber(value) !== 0)) {
      throw new ArtifactStoreError("Artifact ledger contains conflicting durable states.", "integrity_failed");
    }
    const blobs = database.prepare(`
      SELECT content_hash, bytes, relative_path, created_at FROM artifact_blobs
    `).all() as unknown as ArtifactBlobRow[];
    for (const blob of blobs) {
      if (typeof blob.content_hash !== "string" || !CONTENT_HASH.test(blob.content_hash)
        || !Number.isSafeInteger(blob.bytes) || blob.bytes < 0 || blob.bytes > policy.quota.maximumArtifactBytes
        || blob.relative_path !== path.join(blob.content_hash.slice(0, 2), blob.content_hash)
        || !isCanonicalIsoTimestamp(blob.created_at)) {
        throw new ArtifactStoreError("Artifact blob invariant failed.", "integrity_failed");
      }
    }
    const references = database.prepare(`
      SELECT id, run_id, content_hash, label, created_at FROM artifact_references
    `).all() as unknown as ArtifactReferenceRow[];
    for (const reference of references) {
      if (typeof reference.id !== "string" || !SAFE_ID.test(reference.id)
        || typeof reference.run_id !== "string" || !SAFE_ID.test(reference.run_id)
        || typeof reference.content_hash !== "string" || !CONTENT_HASH.test(reference.content_hash)
        || typeof reference.label !== "string" || !reference.label.trim()
        || reference.label !== reference.label.trim() || reference.label.length > 500
        || !isCanonicalIsoTimestamp(reference.created_at)) {
        throw new ArtifactStoreError("Artifact reference invariant failed.", "integrity_failed");
      }
    }
    const writes = database.prepare(`
      SELECT intent_id, content_hash, bytes, relative_path, run_id, label,
             reference_id, created_at, owner_pid, lease_expires_at FROM artifact_write_intents
    `).all() as unknown as ArtifactWriteIntentRow[];
    for (const intent of writes) {
      if (typeof intent.intent_id !== "string" || !SAFE_ID.test(intent.intent_id)
        || typeof intent.content_hash !== "string" || !CONTENT_HASH.test(intent.content_hash)
        || !Number.isSafeInteger(intent.bytes) || intent.bytes < 0 || intent.bytes > policy.quota.maximumArtifactBytes
        || intent.relative_path !== path.join(intent.content_hash.slice(0, 2), intent.content_hash)
        || typeof intent.run_id !== "string" || !SAFE_ID.test(intent.run_id)
        || typeof intent.reference_id !== "string" || !SAFE_ID.test(intent.reference_id)
        || typeof intent.label !== "string" || !intent.label.trim() || intent.label !== intent.label.trim()
        || intent.label.length > 500 || !Number.isSafeInteger(intent.owner_pid) || intent.owner_pid <= 0
        || !isCanonicalIsoTimestamp(intent.created_at) || !isCanonicalIsoTimestamp(intent.lease_expires_at)) {
        throw new ArtifactStoreError("Artifact write-intent invariant failed.", "integrity_failed");
      }
    }
    const gcIntents = database.prepare(`
      SELECT content_hash, bytes, relative_path, created_at FROM artifact_gc_intents
    `).all() as unknown as ArtifactGcIntentRow[];
    for (const intent of gcIntents) {
      if (typeof intent.content_hash !== "string" || !CONTENT_HASH.test(intent.content_hash)
        || !Number.isSafeInteger(intent.bytes) || intent.bytes < 0 || intent.bytes > policy.quota.maximumArtifactBytes
        || intent.relative_path !== path.join(intent.content_hash.slice(0, 2), intent.content_hash)
        || !isCanonicalIsoTimestamp(intent.created_at)) {
        throw new ArtifactStoreError("Artifact GC-intent invariant failed.", "integrity_failed");
      }
    }
    if (requireSettled && (writes.length !== 0 || gcIntents.length !== 0)) {
      throw new ArtifactStoreError("Artifact snapshot contains unsettled intents.", "integrity_failed");
    }
    const usage = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM artifact_blobs)
          + (SELECT COUNT(*) FROM artifact_gc_intents) AS blobs,
        (SELECT COUNT(*) FROM artifact_references) AS refs,
        (SELECT COUNT(*) FROM artifact_write_intents) AS intents,
        (SELECT COALESCE(SUM(bytes), 0) FROM artifact_blobs)
          + (SELECT COALESCE(SUM(bytes), 0) FROM artifact_gc_intents) AS bytes
    `).get() as { blobs: number; refs: number; intents: number; bytes: number };
    if (Number(usage.blobs) > policy.quota.maximumBlobCount
      || Number(usage.refs) > policy.quota.maximumReferenceCount
      || Number(usage.intents) > policy.quota.maximumIntentCount
      || Number(usage.bytes) > policy.quota.maximumStoreBytes) {
      throw new ArtifactStoreError("Artifact global durable quota invariant failed.", "quota_exceeded");
    }
    const blobHashes = new Set(blobs.map((blob) => blob.content_hash));
    const reservedBlobHashes = new Set<string>();
    const durableMetadataBytes = blobs.reduce((total, blob) => (
      total + blobMetadataBytes(blob.content_hash, blob.relative_path, blob.created_at)
    ), 0) + references.reduce((total, reference) => (
      total + Buffer.byteLength(reference.id) + Buffer.byteLength(reference.run_id)
        + Buffer.byteLength(reference.content_hash) + Buffer.byteLength(reference.label)
        + Buffer.byteLength(reference.created_at)
    ), 0) + gcIntents.reduce((total, intent) => (
      total + blobMetadataBytes(intent.content_hash, intent.relative_path, intent.created_at)
    ), 0) + writes.reduce((total, intent) => {
      const optionalBlobBytes = !blobHashes.has(intent.content_hash) && !reservedBlobHashes.has(intent.content_hash)
        ? blobMetadataBytes(intent.content_hash, intent.relative_path, intent.created_at)
        : 0;
      reservedBlobHashes.add(intent.content_hash);
      return total + Math.max(
        intentMetadataBytes(intent),
        referenceMetadataBytes(intent) + optionalBlobBytes,
      );
    }, 0);
    if (durableMetadataBytes > policy.quota.maximumMetadataBytes) {
      throw new ArtifactStoreError("Artifact durable metadata quota invariant failed.", "quota_exceeded");
    }
    const runs = database.prepare(`
      SELECT run_id, SUM(bytes) AS bytes, SUM(refs) AS refs FROM (
        SELECT r.run_id AS run_id, b.bytes AS bytes, 1 AS refs
        FROM artifact_references r JOIN artifact_blobs b ON b.content_hash = r.content_hash
        UNION ALL SELECT run_id, bytes, 1 AS refs FROM artifact_write_intents
      ) GROUP BY run_id
    `).all() as unknown as Array<{ run_id: string; bytes: number; refs: number }>;
    if (runs.some((run) => !SAFE_ID.test(run.run_id) || Number(run.bytes) > policy.quota.maximumRunBytes
      || Number(run.refs) > policy.quota.maximumRunReferenceCount)) {
      throw new ArtifactStoreError("Artifact per-run durable quota invariant failed.", "quota_exceeded");
    }
  }

  private static verifyDatabaseContract(database: DatabaseSync, requireSettled: boolean): ArtifactPolicyDocument {
    const integrity = database.prepare("PRAGMA integrity_check").all() as unknown as Array<{
      integrity_check?: string;
    }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new ArtifactStoreError("Artifact database integrity check failed.", "integrity_failed");
    }
    const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length !== 0) {
      throw new ArtifactStoreError("Artifact database foreign-key check failed.", "integrity_failed");
    }
    DurableArtifactStore.verifyMigrationLedger(database, true);
    DurableArtifactStore.verifySchema(database);
    const policy = DurableArtifactStore.readAndValidatePolicy(database);
    DurableArtifactStore.verifyDatabaseInvariants(database, policy, requireSettled);
    return policy;
  }

  private loadOrCreatePolicy(requested: ArtifactPolicyDocument): ArtifactPolicyDocument {
    return this.immediateTransaction(() => {
      const row = this.db.prepare(`
        SELECT policy_json, policy_hash FROM artifact_store_policy WHERE policy_id = ?
      `).get(POLICY_ID) as { policy_json?: string; policy_hash?: string } | undefined;
      const requestedJson = stableStringify(requested);
      const requestedHash = sha256(requestedJson);
      if (!row) {
        this.db.prepare(`
          INSERT INTO artifact_store_policy (policy_id, policy_json, policy_hash, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(POLICY_ID, requestedJson, requestedHash, new Date().toISOString());
        return requested;
      }
      if (typeof row.policy_json !== "string" || sha256(row.policy_json) !== row.policy_hash) {
        throw new ArtifactStoreError("Durable artifact policy integrity failed.", "integrity_failed");
      }
      if (row.policy_hash !== requestedHash || row.policy_json !== requestedJson) {
        throw new ArtifactStoreError("Artifact process policy does not match durable policy.", "policy_mismatch");
      }
      let parsed: ArtifactPolicyDocument;
      try { parsed = JSON.parse(row.policy_json) as ArtifactPolicyDocument; } catch {
        throw new ArtifactStoreError("Durable artifact policy is malformed.", "integrity_failed");
      }
      this.validatePolicy(parsed);
      return parsed;
    });
  }

  private verifyIntegrity(): void {
    const durablePolicy = DurableArtifactStore.verifyDatabaseContract(this.db, false);
    if (stableStringify(durablePolicy) !== stableStringify(this.policy)) {
      throw new ArtifactStoreError("Artifact live policy changed unexpectedly.", "policy_mismatch");
    }
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  private publishBlob(finalPath: string, contentHash: string, data: Uint8Array): void {
    const temporaryPath = this.safeTemporaryPath(contentHash);
    try {
      writeFileSync(temporaryPath, data, { flag: "wx", flush: true });
      this.inject("after_temp_write");
      assertNoReparseComponents(this.root, temporaryPath);
      assertNoReparseComponents(this.root, finalPath);
      durableRename(
        temporaryPath,
        finalPath,
        this.windowsGuard,
        () => this.inject("after_blob_publish_source_pin"),
      );
      this.inject("after_rename");
      assertPhysicalFile(this.root, finalPath);
      flushPublishedFile(finalPath, this.windowsGuard, this.root);
      this.inject("after_file_fsync");
    } catch (error) {
      if (existsSync(temporaryPath)) this.safeDelete(temporaryPath, false);
      throw error;
    }
  }

  private enforcePutQuota(
    runId: string,
    label: string,
    bytes: number,
    contentHash: string,
    blobExists: boolean,
  ): void {
    const quota = this.policy.quota;
    const usage = this.counts();
    const run = this.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(b.bytes), 0)
         FROM artifact_references r JOIN artifact_blobs b ON b.content_hash = r.content_hash
         WHERE r.run_id = ?)
        + (SELECT COALESCE(SUM(bytes), 0) FROM artifact_write_intents WHERE run_id = ?) AS bytes,
        (SELECT COUNT(*) FROM artifact_references WHERE run_id = ?)
        + (SELECT COUNT(*) FROM artifact_write_intents WHERE run_id = ?) AS refs
    `).get(runId, runId, runId, runId) as { bytes?: number; refs?: number } | undefined;
    const reserved = this.db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(bytes), 0) FROM artifact_blobs)
        + (SELECT COALESCE(SUM(bytes), 0) FROM artifact_gc_intents)
        + (SELECT COALESCE(SUM(bytes), 0) FROM (
            SELECT i.content_hash, MAX(i.bytes) AS bytes
            FROM artifact_write_intents i
            LEFT JOIN artifact_blobs b ON b.content_hash = i.content_hash
            WHERE b.content_hash IS NULL
            GROUP BY i.content_hash
          )) AS bytes,
        (SELECT COUNT(*) FROM artifact_blobs)
        + (SELECT COUNT(*) FROM artifact_gc_intents)
        + (SELECT COUNT(*) FROM (
            SELECT i.content_hash
            FROM artifact_write_intents i
            LEFT JOIN artifact_blobs b ON b.content_hash = i.content_hash
            WHERE b.content_hash IS NULL
            GROUP BY i.content_hash
          )) AS blobs
    `).get() as { bytes?: number; blobs?: number } | undefined;
    const pendingUnique = this.pendingHashCount(contentHash) === 0;
    const metadataBytes = Math.max(
      intentMetadataBytes({
        intent_id: "0".repeat(36), content_hash: contentHash, bytes,
        relative_path: this.relativePathFor(contentHash), run_id: runId, label,
        reference_id: "0".repeat(36), created_at: "0".repeat(24), owner_pid: process.pid,
        lease_expires_at: "0".repeat(24),
      }),
      Buffer.byteLength(runId) + Buffer.byteLength(label) + Buffer.byteLength(contentHash)
        + 36 + 24 + (!blobExists && pendingUnique
          ? blobMetadataBytes(contentHash, this.relativePathFor(contentHash), "0".repeat(24))
          : 0),
    );
    if (scalarNumber(run?.bytes) + bytes > quota.maximumRunBytes) this.quotaError("run bytes");
    if (scalarNumber(run?.refs) + 1 > quota.maximumRunReferenceCount) this.quotaError("run references");
    if (usage.references + usage.intents + 1 > quota.maximumReferenceCount) this.quotaError("references");
    if (usage.intents + 1 > quota.maximumIntentCount) this.quotaError("intents");
    if (!blobExists && pendingUnique && scalarNumber(reserved?.blobs) + 1 > quota.maximumBlobCount) {
      this.quotaError("blobs");
    }
    if (!blobExists && pendingUnique && scalarNumber(reserved?.bytes) + bytes > quota.maximumStoreBytes) {
      this.quotaError("store bytes");
    }
    if (this.reservedMetadataBytes() + metadataBytes > quota.maximumMetadataBytes) {
      this.quotaError("metadata bytes");
    }
    this.enforceDatabaseAdmissionQuota(metadataBytes + 4096);
  }

  private enforceDatabaseQuota(additionalBytes = 0): void {
    const databaseBytes = this.databaseFootprintBytes();
    if (databaseBytes + additionalBytes > this.policy.quota.maximumDatabaseBytes) {
      this.quotaError("database bytes");
    }
  }

  private preflightFreeSpace(target: string, requiredBytes: number): void {
    DurableArtifactStore.preflightExternalFreeSpace(target, requiredBytes);
  }

  private estimatedBackupBytes(): number {
    const blobs = this.allBlobs();
    const migrations = this.db.prepare(`
      SELECT version, name, checksum FROM artifact_schema_migrations ORDER BY version
    `).all() as unknown as ArtifactBackupManifest["migrations"];
    const policy = this.db.prepare(`
      SELECT policy_hash FROM artifact_store_policy WHERE policy_id = ?
    `).get(POLICY_ID) as { policy_hash?: string } | undefined;
    const manifest: ArtifactBackupManifest = {
      schemaVersion: 1,
      createdAt: new Date(0).toISOString(),
      database: { relativePath: DATABASE_NAME, sha256: "0".repeat(64), bytes: statSync(this.databasePath).size },
      blobs: blobs.map((blob) => ({
        contentHash: blob.content_hash,
        relativePath: blob.relative_path,
        bytes: blob.bytes,
      })),
      policyHash: typeof policy?.policy_hash === "string" ? policy.policy_hash : "0".repeat(64),
      migrations,
    };
    return statSync(this.databasePath).size
      + blobs.reduce((total, blob) => total + blob.bytes, 0)
      + Buffer.byteLength(stableStringify(manifest))
      + SQLITE_TRANSACTION_RESERVE_BYTES;
  }

  private static estimatedRestoreBytes(backup: ArtifactBackup): number {
    const manifestBytes = existsSync(backup.manifestPath) ? statSync(backup.manifestPath).size : 0;
    return backup.bytes + backup.blobs.reduce((total, blob) => total + blob.bytes, 0)
      + manifestBytes + SQLITE_TRANSACTION_RESERVE_BYTES;
  }

  private static preflightExternalFreeSpace(target: string, requiredBytes: number): void {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
      throw new ArtifactStoreError("Artifact free-space estimate is invalid.", "integrity_failed");
    }
    try {
      const filesystem = statfsSync(target, { bigint: true });
      const available = filesystem.bavail * filesystem.bsize;
      if (BigInt(requiredBytes) > available) {
        throw new ArtifactStoreError("Artifact operation lacks required free storage.", "disk_write_failed");
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      if (DurableArtifactStore.isDiskFailureValue(error)) {
        throw new ArtifactStoreError("Artifact free-space preflight found full storage.", "disk_write_failed");
      }
      throw new ArtifactStoreError(
        `Artifact free-space preflight failed closed: ${error instanceof Error ? error.message : "unknown"}`,
        "disk_write_failed",
      );
    }
  }

  private enforceDatabaseAdmissionQuota(additionalBytes = 0): void {
    const databaseBytes = this.databaseFootprintBytes();
    if (databaseBytes + additionalBytes + SQLITE_TRANSACTION_RESERVE_BYTES
      > this.policy.quota.maximumDatabaseBytes) {
      this.quotaError("database bytes");
    }
  }

  private configureDatabasePageQuota(maximumDatabaseBytes: number): void {
    const pageSize = scalarNumber((this.db.prepare("PRAGMA page_size").get() as {
      page_size?: number;
    } | undefined)?.page_size);
    const pageCount = scalarNumber((this.db.prepare("PRAGMA page_count").get() as {
      page_count?: number;
    } | undefined)?.page_count);
    const sidecarReserve = Math.max(SQLITE_SIDECAR_RESERVE_BYTES, this.databaseSidecarBytes());
    const maximumPages = Math.floor((maximumDatabaseBytes - sidecarReserve) / pageSize);
    if (!Number.isSafeInteger(maximumPages) || maximumPages < pageCount || maximumPages < 1) {
      this.quotaError("database bytes");
    }
    const row = this.db.prepare(`PRAGMA max_page_count = ${maximumPages}`).get() as {
      max_page_count?: number;
    } | undefined;
    if (scalarNumber(row?.max_page_count) > maximumPages
      || scalarNumber(row?.max_page_count) < pageCount) {
      throw new ArtifactStoreError("SQLite page quota could not be enforced.", "integrity_failed");
    }
  }

  private checkpointForQuota(): void {
    this.checkedCheckpoint(false);
  }

  private checkedCheckpoint(injectFaults: boolean, busyRetryMs = 0): void {
    if (injectFaults) this.inject("before_wal_checkpoint");
    const deadline = Date.now() + busyRetryMs;
    while (true) {
      const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        busy?: number;
        log?: number;
        checkpointed?: number;
      } | undefined;
      const busy = scalarNumber(row?.busy);
      const log = scalarNumber(row?.log);
      const checkpointed = scalarNumber(row?.checkpointed);
      if (busy === 0 && log === checkpointed) break;
      if (Date.now() >= deadline) {
        throw new ArtifactStoreError("SQLite WAL checkpoint did not fully settle.", "operation_in_progress");
      }
      Atomics.wait(CHECKPOINT_WAIT_STATE, 0, 0, Math.min(20, Math.max(1, deadline - Date.now())));
    }
    if (injectFaults) this.inject("after_wal_checkpoint");
    if (this.policy) this.enforceDatabaseQuota();
  }

  private ensureRecoveryReserve(): void {
    try {
      if (!existsSync(this.recoveryReservePath)) {
        try {
          writeFileSync(this.recoveryReservePath, Buffer.alloc(SQLITE_RECOVERY_RESERVE_BYTES), {
            flag: "wx",
            flush: true,
          });
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || String(error.code) !== "EEXIST") throw error;
        }
      }
      assertPhysicalFile(this.root, this.recoveryReservePath);
      if (statSync(this.recoveryReservePath).size !== SQLITE_RECOVERY_RESERVE_BYTES) {
        throw new ArtifactStoreError("Artifact recovery reserve has an invalid size.", "integrity_failed");
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      if (DurableArtifactStore.isDiskFailureValue(error)) {
        throw new ArtifactStoreError("Artifact recovery reserve could not be created.", "disk_write_failed");
      }
      throw error;
    }
  }

  private releaseRecoveryReserveForRecovery(): void {
    if (existsSync(this.recoveryReservePath)) this.safeDelete(this.recoveryReservePath, false);
  }

  private restoreRecoveryReserveAfterFailure(): void {
    this.ensureRecoveryReserve();
  }

  private reservedMetadataBytes(): number {
    const blobs = this.db.prepare(`
      SELECT content_hash, bytes, relative_path, created_at FROM artifact_blobs
    `).all() as unknown as ArtifactBlobRow[];
    const references = this.db.prepare(`
      SELECT id, run_id, content_hash, label, created_at FROM artifact_references
    `).all() as unknown as ArtifactReferenceRow[];
    const writes = this.db.prepare(`
      SELECT intent_id, content_hash, bytes, relative_path, run_id, label,
             reference_id, created_at, owner_pid, lease_expires_at FROM artifact_write_intents
      ORDER BY created_at, intent_id
    `).all() as unknown as ArtifactWriteIntentRow[];
    const gcIntents = this.db.prepare(`
      SELECT content_hash, bytes, relative_path, created_at FROM artifact_gc_intents
    `).all() as unknown as ArtifactGcIntentRow[];
    const blobHashes = new Set(blobs.map((blob) => blob.content_hash));
    const reservedBlobHashes = new Set<string>();
    return blobs.reduce((total, blob) => (
      total + blobMetadataBytes(blob.content_hash, blob.relative_path, blob.created_at)
    ), 0) + references.reduce((total, reference) => (
      total + Buffer.byteLength(reference.id) + Buffer.byteLength(reference.run_id)
        + Buffer.byteLength(reference.content_hash) + Buffer.byteLength(reference.label)
        + Buffer.byteLength(reference.created_at)
    ), 0) + gcIntents.reduce((total, intent) => (
      total + blobMetadataBytes(intent.content_hash, intent.relative_path, intent.created_at)
    ), 0) + writes.reduce((total, intent) => {
      this.validateIntent(intent);
      const optionalBlobBytes = !blobHashes.has(intent.content_hash) && !reservedBlobHashes.has(intent.content_hash)
        ? blobMetadataBytes(intent.content_hash, intent.relative_path, intent.created_at)
        : 0;
      reservedBlobHashes.add(intent.content_hash);
      return total + Math.max(
        intentMetadataBytes(intent),
        referenceMetadataBytes(intent) + optionalBlobBytes,
      );
    }, 0);
  }

  private assertMutationAllowed(): void {
    if (this.initializing) return;
    if (this.backupMutex) return;
    let probe: DatabaseSync | undefined;
    try {
      probe = new DatabaseSync(this.backupMutexPath);
      probe.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK;");
    } catch (error) {
      if (DurableArtifactStore.isSqliteBusyValue(error)) {
        throw new ArtifactStoreError("Artifact backup currently serializes mutations.", "operation_in_progress");
      }
      if (this.isDiskFailure(error)) this.throwMutationDiskFailure(error, "backup mutex probe");
      throw error;
    } finally {
      probe?.close();
    }
    const lock = this.readBackupLock();
    if (lock) {
      const reread = this.readBackupLock();
      if (reread && reread.token === lock.token) this.safeDelete(this.backupLockPath, false);
    }
  }

  private acquireBackupLock(): string {
    const token = randomUUID();
    const createdAt = new Date().toISOString();
    const document: ArtifactBackupLockDocument = {
      schemaVersion: 1,
      token,
      pid: process.pid,
      createdAt,
      leaseExpiresAt: new Date(Date.now() + BACKUP_LOCK_LEASE_MS).toISOString(),
    };
    let mutex: DatabaseSync | undefined;
    let ownsMutex = false;
    try {
      mutex = new DatabaseSync(this.backupMutexPath);
      mutex.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
      ownsMutex = true;
      this.backupMutex = mutex;
      mutex = undefined;
      if (existsSync(this.backupLockPath)) this.safeDelete(this.backupLockPath, false);
      writeFileSync(this.backupLockPath, stableStringify(document), { flag: "wx", flush: true });
      assertPhysicalFile(this.root, this.backupLockPath);
      const reread = this.readBackupLock();
      if (!reread || reread.token !== token) {
        throw new ArtifactStoreError("Artifact backup lock publication was not durable.", "integrity_failed");
      }
      this.inject("after_backup_lock_acquired");
      return token;
    } catch (error) {
      try {
        if (ownsMutex && existsSync(this.backupLockPath)) this.safeDelete(this.backupLockPath, false);
      } catch { /* best effort; preserve the lock-acquisition failure */ }
      try { mutex?.close(); } catch { /* best effort before normalization */ }
      if (this.backupMutex) {
        try { this.backupMutex.exec("ROLLBACK"); } catch { /* best effort */ }
        try { this.backupMutex.close(); } catch { /* best effort */ }
        this.backupMutex = undefined;
      }
      if (DurableArtifactStore.isSqliteBusyValue(error)) {
        throw new ArtifactStoreError("Artifact backup is already in progress.", "operation_in_progress");
      }
      if (DurableArtifactStore.isDiskFailureValue(error)) {
        throw new ArtifactStoreError("Artifact backup lock could not be persisted.", "disk_write_failed");
      }
      throw error;
    }
  }

  private renewBackupLock(token: string): void {
    if (!this.backupMutex) {
      throw new ArtifactStoreError("Artifact backup OS mutex is not held.", "integrity_failed");
    }
    const current = this.readBackupLock();
    if (!current || current.token !== token || current.pid !== process.pid) {
      throw new ArtifactStoreError("Artifact backup lock cannot be renewed by this process.", "integrity_failed");
    }
  }

  private releaseBackupLock(token: string): void {
    const mutex = this.backupMutex;
    if (!mutex) throw new ArtifactStoreError("Artifact backup OS mutex disappeared.", "integrity_failed");
    if (!existsSync(this.backupLockPath)) {
      throw new ArtifactStoreError("Artifact backup lock disappeared before release.", "integrity_failed");
    }
    const lock = this.readBackupLock();
    if (!lock || lock.token !== token || lock.pid !== process.pid) {
      throw new ArtifactStoreError("Artifact backup lock ownership changed.", "integrity_failed");
    }
    let failure: unknown;
    try { this.safeDelete(this.backupLockPath, false); } catch (error) { failure = error; }
    try { mutex.exec("COMMIT"); } catch (error) { failure ??= error; }
    try { mutex.close(); } catch (error) { failure ??= error; }
    this.backupMutex = undefined;
    if (failure) throw failure;
  }

  private readBackupLock(): ArtifactBackupLockDocument | undefined {
    if (!existsSync(this.backupLockPath)) return undefined;
    assertPhysicalFile(this.root, this.backupLockPath);
    const stat = statSync(this.backupLockPath);
    if (stat.size <= 0 || stat.size > 4096) {
      throw new ArtifactStoreError("Artifact backup lock size is invalid.", "integrity_failed");
    }
    let value: ArtifactBackupLockDocument;
    try { value = JSON.parse(readFileSync(this.backupLockPath, "utf8")) as ArtifactBackupLockDocument; } catch {
      throw new ArtifactStoreError("Artifact backup lock JSON is malformed.", "integrity_failed");
    }
    if (!value || value.schemaVersion !== 1
      || !exactKeys(value, ["schemaVersion", "token", "pid", "createdAt", "leaseExpiresAt"])
      || typeof value.token !== "string" || !SAFE_ID.test(value.token)
      || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || !isCanonicalIsoTimestamp(value.createdAt) || !isCanonicalIsoTimestamp(value.leaseExpiresAt)
      || Date.parse(value.leaseExpiresAt) < Date.parse(value.createdAt)) {
      throw new ArtifactStoreError("Artifact backup lock contract is invalid.", "integrity_failed");
    }
    return value;
  }

  private isBackupLockStale(lock: ArtifactBackupLockDocument): boolean {
    return !DurableArtifactStore.isProcessAlive(lock.pid);
  }

  private isIntentAbandoned(intent: ArtifactWriteIntentRow): boolean {
    return Date.parse(intent.lease_expires_at) <= Date.now()
      || !DurableArtifactStore.isProcessAlive(intent.owner_pid);
  }

  private static isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error instanceof Error && "code" in error && String(error.code) === "EPERM";
    }
  }

  private resolveGarbageCollectionForHash(contentHash: string): void {
    const current = this.db.prepare(`
      SELECT content_hash, bytes, relative_path, created_at
      FROM artifact_gc_intents WHERE content_hash = ?
    `).get(contentHash) as unknown as ArtifactGcIntentRow | undefined;
    if (!current) return;
    this.validateGcIntent(current);
    this.assertGcIntentHasNoLiveState(current.content_hash);
    const finalPath = this.safeBlobPath(current.content_hash);
    if (existsSync(finalPath)) this.safeDelete(finalPath, false);
    this.inject("after_gc_file_delete");
    this.db.prepare("DELETE FROM artifact_gc_intents WHERE content_hash = ?").run(current.content_hash);
  }

  private compensateFailedWrite(intent: ArtifactWriteIntentRow): void {
    this.immediateTransaction(() => {
      const current = this.intentById(intent.intent_id);
      if (current) {
        this.validateIntent(current);
        if (current.owner_pid !== process.pid || current.content_hash !== intent.content_hash
          || current.reference_id !== intent.reference_id) {
          throw new ArtifactStoreError("Artifact write compensation does not own the intent.", "integrity_failed");
        }
        this.db.prepare("DELETE FROM artifact_write_intents WHERE intent_id = ?").run(current.intent_id);
      }
      const state = this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM artifact_blobs WHERE content_hash = ?) AS blobs,
          (SELECT COUNT(*) FROM artifact_references WHERE content_hash = ?) AS refs,
          (SELECT COUNT(*) FROM artifact_write_intents WHERE content_hash = ?) AS writes,
          (SELECT COUNT(*) FROM artifact_gc_intents WHERE content_hash = ?) AS gc
      `).get(intent.content_hash, intent.content_hash, intent.content_hash, intent.content_hash) as Record<string, number>;
      if (Object.values(state).every((value) => scalarNumber(value) === 0)) {
        const finalPath = this.safeBlobPath(intent.content_hash);
        if (existsSync(finalPath)) this.safeDelete(finalPath, false);
      }
    });
  }

  private settleForBackup(): void {
    while (this.immediateTransaction(() => this.drainGarbageCollectionBatch(GC_BATCH_SIZE)) > 0) {
      this.checkedCheckpoint(false);
    }
    while (true) {
      const result = this.immediateTransaction(() => this.reconcileWriteIntentsForBackupBatch(GC_BATCH_SIZE));
      if (result.unresolved > 0) {
        throw new ArtifactStoreError("Artifact backup found active unsettled writes.", "operation_in_progress");
      }
      if (result.processed === 0) break;
      this.checkedCheckpoint(false);
    }
    this.immediateTransaction(() => {
      const pending = this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM artifact_write_intents) AS writes,
          (SELECT COUNT(*) FROM artifact_gc_intents) AS gc
      `).get() as { writes?: number; gc?: number } | undefined;
      if (scalarNumber(pending?.writes) !== 0 || scalarNumber(pending?.gc) !== 0) {
        throw new ArtifactStoreError("Artifact backup settlement did not reach a fixed point.", "integrity_failed");
      }
    });
  }

  private reconcileWriteIntentsForBackupBatch(limit: number): { processed: number; unresolved: number } {
    const hashes = this.db.prepare(`
      SELECT content_hash, MIN(created_at) AS created_at
      FROM artifact_write_intents GROUP BY content_hash
      ORDER BY created_at, content_hash LIMIT ?
    `).all(limit) as unknown as Array<{ content_hash: string }>;
    let unresolved = 0;
    let processed = 0;
    for (const row of hashes) {
      if (!CONTENT_HASH.test(row.content_hash)) {
        throw new ArtifactStoreError("Artifact backup found an invalid intent hash.", "integrity_failed");
      }
      const intents = this.db.prepare(`
        SELECT intent_id, content_hash, bytes, relative_path, run_id, label,
               reference_id, created_at, owner_pid, lease_expires_at
        FROM artifact_write_intents WHERE content_hash = ? ORDER BY created_at, intent_id
      `).all(row.content_hash) as unknown as ArtifactWriteIntentRow[];
      for (const intent of intents) this.validateIntent(intent);
      const first = intents[0];
      if (!first || !intents.every((intent) => intent.bytes === first.bytes
        && intent.relative_path === first.relative_path)) {
        throw new ArtifactStoreError("Artifact backup found disagreeing write intents.", "integrity_failed");
      }
      const finalPath = this.safeBlobPath(first.content_hash);
      if (this.isVerifiedBlob(finalPath, first.content_hash, first.bytes)) {
        this.db.prepare(`
          INSERT OR IGNORE INTO artifact_blobs (content_hash, bytes, relative_path, created_at)
          VALUES (?, ?, ?, ?)
        `).run(first.content_hash, first.bytes, first.relative_path, first.created_at);
        const blob = this.blob(first.content_hash);
        if (!blob) throw new ArtifactStoreError("Artifact backup could not settle a verified blob.", "integrity_failed");
        this.finalizeIntentsForBlob(first.content_hash, blob);
        processed += 1;
      } else if (intents.every((intent) => this.isIntentAbandoned(intent))) {
        if (existsSync(finalPath)) this.safeDelete(finalPath, false);
        this.db.prepare("DELETE FROM artifact_write_intents WHERE content_hash = ?").run(first.content_hash);
        processed += 1;
      } else {
        unresolved += 1;
      }
    }
    return { processed, unresolved };
  }

  private databaseFootprintBytes(): number {
    let bytes = 0;
    for (const file of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(file)) {
        assertNoReparseComponents(this.root, file);
        bytes += statSync(file).size;
      }
    }
    return bytes;
  }

  private databaseSidecarBytes(): number {
    let bytes = 0;
    for (const file of [`${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(file)) {
        assertNoReparseComponents(this.root, file);
        bytes += statSync(file).size;
      }
    }
    return bytes;
  }

  private validateAllPendingIntents(): void {
    const intents = this.db.prepare(`
      SELECT intent_id, content_hash, bytes, relative_path, run_id, label,
             reference_id, created_at, owner_pid, lease_expires_at
      FROM artifact_write_intents
    `).all() as unknown as ArtifactWriteIntentRow[];
    for (const intent of intents) this.validateIntent(intent);
    const gcIntents = this.db.prepare(`
      SELECT content_hash, bytes, relative_path, created_at FROM artifact_gc_intents
    `).all() as unknown as ArtifactGcIntentRow[];
    for (const intent of gcIntents) this.validateGcIntent(intent);
  }

  private validateIntent(intent: ArtifactWriteIntentRow): void {
    if (typeof intent.intent_id !== "string" || !SAFE_ID.test(intent.intent_id)
      || typeof intent.content_hash !== "string" || !CONTENT_HASH.test(intent.content_hash)
      || !Number.isSafeInteger(intent.bytes) || intent.bytes < 0
      || intent.bytes > this.policy.quota.maximumArtifactBytes
      || typeof intent.relative_path !== "string"
      || intent.relative_path !== this.relativePathFor(intent.content_hash)
      || typeof intent.run_id !== "string" || !SAFE_ID.test(intent.run_id)
      || typeof intent.reference_id !== "string" || !SAFE_ID.test(intent.reference_id)
      || typeof intent.label !== "string" || !intent.label.trim()
      || intent.label !== intent.label.trim() || intent.label.length > 500
      || !Number.isSafeInteger(intent.owner_pid) || intent.owner_pid <= 0
      || !isCanonicalIsoTimestamp(intent.created_at) || !isCanonicalIsoTimestamp(intent.lease_expires_at)) {
      throw new ArtifactStoreError("Artifact write intent is malformed or inconsistent.", "integrity_failed");
    }
    this.safeBlobPath(intent.content_hash);
  }

  private validateBlobRow(blob: ArtifactBlobRow): void {
    if (typeof blob.content_hash !== "string" || !CONTENT_HASH.test(blob.content_hash)
      || !Number.isSafeInteger(blob.bytes) || blob.bytes < 0
      || blob.bytes > this.policy.quota.maximumArtifactBytes
      || typeof blob.relative_path !== "string"
      || blob.relative_path !== this.relativePathFor(blob.content_hash)
      || !isCanonicalIsoTimestamp(blob.created_at)) {
      throw new ArtifactStoreError("Artifact blob ledger row is malformed.", "integrity_failed");
    }
  }

  private validateGcIntent(intent: ArtifactGcIntentRow): void {
    if (typeof intent.content_hash !== "string" || !CONTENT_HASH.test(intent.content_hash)
      || !Number.isSafeInteger(intent.bytes) || intent.bytes < 0
      || intent.bytes > this.policy.quota.maximumArtifactBytes
      || typeof intent.relative_path !== "string"
      || intent.relative_path !== this.relativePathFor(intent.content_hash)
      || !isCanonicalIsoTimestamp(intent.created_at)) {
      throw new ArtifactStoreError("Artifact garbage-collection intent is malformed.", "integrity_failed");
    }
    this.safeBlobPath(intent.content_hash);
  }

  private validateReferenceRow(reference: ArtifactReferenceRow): void {
    if (typeof reference.id !== "string" || !SAFE_ID.test(reference.id)
      || typeof reference.run_id !== "string" || !SAFE_ID.test(reference.run_id)
      || typeof reference.content_hash !== "string" || !CONTENT_HASH.test(reference.content_hash)
      || typeof reference.label !== "string" || !reference.label.trim()
      || reference.label !== reference.label.trim() || reference.label.length > 500
      || !isCanonicalIsoTimestamp(reference.created_at)) {
      throw new ArtifactStoreError("Artifact reference row is malformed.", "integrity_failed");
    }
  }

  private reconcileDurableState(): void {
    this.drainGarbageCollection();
    this.immediateTransaction(() => {
      this.assertMutationAllowed();
      this.validateAllPendingIntents();
      const intents = this.db.prepare(`
        SELECT intent_id, content_hash, bytes, relative_path, run_id, label,
               reference_id, created_at, owner_pid, lease_expires_at
        FROM artifact_write_intents ORDER BY created_at, intent_id
      `).all() as unknown as ArtifactWriteIntentRow[];
      const hashes = [...new Set(intents.map((intent) => intent.content_hash))];
      for (const contentHash of hashes) {
        const matching = intents.filter((intent) => intent.content_hash === contentHash);
        const first = matching[0];
        if (!first) continue;
        if (!matching.every((intent) => intent.bytes === first.bytes
          && intent.relative_path === first.relative_path)) {
          throw new ArtifactStoreError("Artifact intents disagree on hash metadata.", "integrity_failed");
        }
        const finalPath = this.safeBlobPath(contentHash);
        if (this.isVerifiedBlob(finalPath, contentHash, first.bytes)) {
          this.db.prepare(`
            INSERT OR IGNORE INTO artifact_blobs (content_hash, bytes, relative_path, created_at)
            VALUES (?, ?, ?, ?)
          `).run(contentHash, first.bytes, first.relative_path, first.created_at);
          const blob = this.blob(contentHash);
          if (!blob) throw new ArtifactStoreError("Recovered artifact blob insert failed.", "integrity_failed");
          this.finalizeIntentsForBlob(contentHash, blob);
          continue;
        }
        const expired = matching.every((intent) => this.isIntentAbandoned(intent));
        if (expired) {
          if (existsSync(finalPath)) this.safeDelete(finalPath, false);
          this.db.prepare("DELETE FROM artifact_write_intents WHERE content_hash = ?").run(contentHash);
        }
      }
      const references = this.db.prepare(`
        SELECT id, run_id, content_hash, label, created_at FROM artifact_references
      `).all() as unknown as ArtifactReferenceRow[];
      for (const reference of references) this.validateReferenceRow(reference);
      for (const blob of this.allBlobs()) this.assertBlobAvailable(blob);
      this.removeUntrackedFiles(this.blobDirectory, this.knownRelativePaths());
      this.enforceResourceQuotas();
    });
  }

  private drainGarbageCollection(): void {
    while (true) {
      const drained = this.immediateTransaction(() => {
        this.assertMutationAllowed();
        return this.drainGarbageCollectionBatch(GC_BATCH_SIZE);
      });
      if (drained === 0) break;
      this.checkpointForQuota();
    }
  }

  private drainGarbageCollectionBatch(limit: number): number {
    const pending = this.db.prepare(`
      SELECT content_hash, bytes, relative_path, created_at
      FROM artifact_gc_intents ORDER BY created_at, content_hash LIMIT ?
    `).all(limit) as unknown as ArtifactGcIntentRow[];
    for (const current of pending) {
      this.validateGcIntent(current);
      this.assertGcIntentHasNoLiveState(current.content_hash);
      const finalPath = this.safeBlobPath(current.content_hash);
      if (existsSync(finalPath)) this.safeDelete(finalPath, false);
      this.inject("after_gc_file_delete");
      this.db.prepare("DELETE FROM artifact_gc_intents WHERE content_hash = ?").run(current.content_hash);
    }
    return pending.length;
  }

  private assertGcIntentHasNoLiveState(contentHash: string): void {
    const conflict = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM artifact_blobs WHERE content_hash = ?) AS blobs,
        (SELECT COUNT(*) FROM artifact_references WHERE content_hash = ?) AS refs,
        (SELECT COUNT(*) FROM artifact_write_intents WHERE content_hash = ?) AS writes
    `).get(contentHash, contentHash, contentHash) as {
      blobs?: number;
      refs?: number;
      writes?: number;
    } | undefined;
    if (scalarNumber(conflict?.blobs) !== 0 || scalarNumber(conflict?.refs) !== 0
      || scalarNumber(conflict?.writes) !== 0) {
      throw new ArtifactStoreError("Artifact GC intent conflicts with live ledger state.", "integrity_failed");
    }
  }

  private enforceResourceQuotas(): void {
    const usage = this.counts();
    const quota = this.policy.quota;
    if (usage.blobs > quota.maximumBlobCount || usage.references > quota.maximumReferenceCount
      || usage.intents > quota.maximumIntentCount || usage.bytes > quota.maximumStoreBytes
      || usage.metadataBytes > quota.maximumMetadataBytes) {
      this.quotaError("durable state");
    }
    const runs = this.db.prepare(`
      SELECT run_id, SUM(bytes) AS bytes, SUM(refs) AS refs
      FROM (
        SELECT r.run_id AS run_id, b.bytes AS bytes, 1 AS refs
        FROM artifact_references r
        JOIN artifact_blobs b ON b.content_hash = r.content_hash
        UNION ALL
        SELECT run_id, bytes, 1 AS refs FROM artifact_write_intents
      ) GROUP BY run_id
    `).all() as unknown as Array<{ run_id: string; bytes: number; refs: number }>;
    if (runs.some((run) => !SAFE_ID.test(run.run_id) || scalarNumber(run.bytes) > quota.maximumRunBytes
      || scalarNumber(run.refs) > quota.maximumRunReferenceCount)) {
      this.quotaError("per-run durable state");
    }
  }

  private finalizeIntentsForBlob(contentHash: string, blob: ArtifactBlobRow): void {
    this.validateBlobRow(blob);
    const intents = this.db.prepare(`
      SELECT intent_id, content_hash, bytes, relative_path, run_id, label,
             reference_id, created_at, owner_pid, lease_expires_at
      FROM artifact_write_intents WHERE content_hash = ? ORDER BY created_at, intent_id
    `).all(contentHash) as unknown as ArtifactWriteIntentRow[];
    for (const intent of intents) {
      this.validateIntent(intent);
      if (intent.bytes !== blob.bytes || intent.relative_path !== blob.relative_path) {
        throw new ArtifactStoreError("Artifact intent does not match verified blob.", "integrity_failed");
      }
      this.db.prepare(`
        INSERT INTO artifact_references (id, run_id, content_hash, label, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, content_hash, label) DO NOTHING
      `).run(intent.reference_id, intent.run_id, intent.content_hash, intent.label, intent.created_at);
    }
    this.db.prepare("DELETE FROM artifact_write_intents WHERE content_hash = ?").run(contentHash);
  }

  private removeUntrackedFiles(directory: string, knownRelativePaths: ReadonlySet<string>): void {
    assertNoReparseComponents(this.root, directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        this.safeDelete(absolute, false);
        continue;
      }
      assertNoReparseComponents(this.root, absolute);
      if (entry.isDirectory()) {
        this.removeUntrackedFiles(absolute, knownRelativePaths);
        continue;
      }
      const relative = path.relative(this.blobDirectory, absolute);
      if (!knownRelativePaths.has(relative)) this.safeDelete(absolute, false);
    }
  }

  private safeDelete(candidate: string, recursive: boolean): void {
    const resolved = path.resolve(candidate);
    if (samePath(resolved, this.root) || samePath(resolved, this.blobDirectory)
      || !isContained(this.root, resolved)) {
      throw new ArtifactStoreError("Refused broad or escaping artifact deletion.", "containment_failed");
    }
    const parent = path.dirname(resolved);
    assertNoReparseComponents(this.root, parent);
    if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
      unlinkSync(resolved);
      return;
    }
    rmSync(resolved, { recursive, force: true });
  }

  private ensureShard(contentHash: string): void {
    const shard = path.join(this.blobDirectory, contentHash.slice(0, 2));
    ensurePhysicalDirectory(
      shard,
      this.root,
      this.windowsGuard,
      `${this.rootLease}:shard:${contentHash.slice(0, 2)}`,
    );
  }

  private safeBlobPath(contentHash: string): string {
    if (!CONTENT_HASH.test(contentHash)) throw new ArtifactStoreError("Artifact hash is invalid.", "integrity_failed");
    const candidate = path.join(this.blobDirectory, this.relativePathFor(contentHash));
    assertNoReparseComponents(this.root, candidate);
    return candidate;
  }

  private safeTemporaryPath(contentHash: string): string {
    const candidate = path.join(path.dirname(this.safeBlobPath(contentHash)), `.${contentHash}.${randomUUID()}.tmp`);
    assertNoReparseComponents(this.root, candidate);
    return candidate;
  }

  private relativePathFor(contentHash: string): string {
    return path.join(contentHash.slice(0, 2), contentHash);
  }

  private isVerifiedBlob(filePath: string, contentHash: string, bytes: number): boolean {
    const lease = `verify-live:${randomUUID()}`;
    try {
      assertNoReparseComponents(this.root, filePath);
      this.windowsGuard?.pinExisting(filePath, this.root, lease, false, false);
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes) return false;
      return sha256(readFileSync(filePath)) === contentHash;
    } catch {
      return false;
    } finally {
      this.windowsGuard?.release(lease);
    }
  }

  private isVerifiedExternalBlob(filePath: string, contentHash: string, bytes: number): boolean {
    return DurableArtifactStore.isVerifiedBackupBlob(
      filePath, contentHash, bytes, this.windowsGuard, path.dirname(filePath),
    );
  }

  private assertBlobAvailable(blob: ArtifactBlobRow): void {
    this.validateBlobRow(blob);
    if (!this.isVerifiedBlob(this.safeBlobPath(blob.content_hash), blob.content_hash, blob.bytes)) {
      throw new ArtifactStoreError("Artifact ledger points to a missing or invalid blob.", "integrity_failed");
    }
  }

  private allBlobs(): ArtifactBlobRow[] {
    return this.db.prepare(`
      SELECT content_hash, bytes, relative_path, created_at FROM artifact_blobs
    `).all() as unknown as ArtifactBlobRow[];
  }

  private knownRelativePaths(): Set<string> {
    const paths = new Set(this.allBlobs().map((blob) => blob.relative_path));
    const intents = this.db.prepare("SELECT relative_path FROM artifact_write_intents").all() as unknown as Array<{
      relative_path: string;
    }>;
    for (const intent of intents) paths.add(intent.relative_path);
    return paths;
  }

  private blob(contentHash: string): ArtifactBlobRow | undefined {
    return this.db.prepare(`
      SELECT content_hash, bytes, relative_path, created_at FROM artifact_blobs WHERE content_hash = ?
    `).get(contentHash) as unknown as ArtifactBlobRow | undefined;
  }

  private reference(runId: string, contentHash: string, label: string): ArtifactReferenceRow | undefined {
    return this.db.prepare(`
      SELECT id, run_id, content_hash, label, created_at FROM artifact_references
      WHERE run_id = ? AND content_hash = ? AND label = ?
    `).get(runId, contentHash, label) as unknown as ArtifactReferenceRow | undefined;
  }

  private intent(runId: string, contentHash: string, label: string): ArtifactWriteIntentRow | undefined {
    return this.db.prepare(`
      SELECT intent_id, content_hash, bytes, relative_path, run_id, label,
             reference_id, created_at, owner_pid, lease_expires_at
      FROM artifact_write_intents WHERE run_id = ? AND content_hash = ? AND label = ?
    `).get(runId, contentHash, label) as unknown as ArtifactWriteIntentRow | undefined;
  }

  private intentById(intentId: string): ArtifactWriteIntentRow | undefined {
    return this.db.prepare(`
      SELECT intent_id, content_hash, bytes, relative_path, run_id, label,
             reference_id, created_at, owner_pid, lease_expires_at
      FROM artifact_write_intents WHERE intent_id = ?
    `).get(intentId) as unknown as ArtifactWriteIntentRow | undefined;
  }

  private pendingHashCount(contentHash: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS value FROM artifact_write_intents WHERE content_hash = ?
    `).get(contentHash) as { value?: number } | undefined;
    return scalarNumber(row?.value);
  }

  private stored(reference: ArtifactReferenceRow, blob: ArtifactBlobRow, deduplicated: boolean): StoredArtifact {
    this.validateReferenceRow(reference);
    this.validateBlobRow(blob);
    if (reference.content_hash !== blob.content_hash) {
      throw new ArtifactStoreError("Artifact reference does not match its blob.", "integrity_failed");
    }
    return {
      id: reference.id,
      runId: reference.run_id,
      contentHash: reference.content_hash,
      bytes: blob.bytes,
      label: reference.label,
      createdAt: reference.created_at,
      deduplicated,
    };
  }

  private inject(point: ArtifactFaultPoint): void {
    this.faultInjector?.(point);
  }

  private quotaError(resource: string): never {
    throw new ArtifactStoreError(`Artifact ${resource} quota is exhausted.`, "quota_exceeded");
  }

  private isDiskFailure(error: unknown): boolean {
    return DurableArtifactStore.isDiskFailureValue(error);
  }

  private throwMutationDiskFailure(error: unknown, operation: string): never {
    const recoveryErrors: string[] = [];
    try { this.releaseRecoveryReserveForRecovery(); } catch (recoveryError) {
      recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
    }
    try { this.checkedCheckpoint(false); } catch (recoveryError) {
      recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
    }
    try { this.restoreRecoveryReserveAfterFailure(); } catch (recoveryError) {
      recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
    }
    const recovery = recoveryErrors.length > 0 ? ` Recovery: ${recoveryErrors.join(" | ")}` : "";
    throw new ArtifactStoreError(
      `Artifact ${operation} failed closed: ${error instanceof Error ? error.message : "unknown error"}.${recovery}`,
      "disk_write_failed",
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Artifact store is closed.");
  }
}
