[CmdletBinding()]
param(
    [string] $SpecificationPath,
    [string] $ProbeJobName,
    [switch] $TerminateProbe,
    [string] $JournalCommitPath,
    [string] $JournalCommitDesiredPath,
    [string] $JournalCommitExpectedPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-ExactBytes {
    param(
        [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [byte[]] $Left,
        [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [byte[]] $Right
    )
    if ($Left.Length -ne $Right.Length) { return $false }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index += 1) {
        $difference = $difference -bor ([int] $Left[$index] -bxor [int] $Right[$index])
    }
    return $difference -eq 0
}

function Test-SharingViolation {
    param([Parameter(Mandatory = $true)] [Exception] $ErrorValue)
    if ($ErrorValue -is [ComponentModel.Win32Exception]) {
        return $ErrorValue.NativeErrorCode -eq 32 -or $ErrorValue.NativeErrorCode -eq 33
    }
    if ($null -ne $ErrorValue.InnerException -and (Test-SharingViolation -ErrorValue $ErrorValue.InnerException)) {
        return $true
    }
    if ($ErrorValue -isnot [IO.IOException]) { return $false }
    $nativeCode = $ErrorValue.HResult -band 0xffff
    return $nativeCode -eq 32 -or $nativeCode -eq 33
}

function Open-JournalCommitLock {
    param(
        [Parameter(Mandatory = $true)] [string] $LockPath,
        [int] $TimeoutMs = 5000
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ($true) {
        try {
            if ([IO.File]::Exists($LockPath)) {
                $information = [IO.FileInfo]::new($LockPath)
                if (($information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw 'Windows Job journal commit lock cannot be reparse-backed.'
                }
            }
            return [IO.FileStream]::new(
                $LockPath,
                [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None,
                1,
                [IO.FileOptions]::WriteThrough
            )
        }
        catch {
            if (-not (Test-SharingViolation -ErrorValue $_.Exception)) { throw }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw [TimeoutException]::new('Windows Job journal commit lock remained busy.')
            }
            Start-Sleep -Milliseconds 20
        }
    }
}

function Assert-JournalCommitFile {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [string] $ExpectedDirectory,
        [Parameter(Mandatory = $true)] [string] $ExpectedNamePattern
    )
    $canonical = [IO.Path]::GetFullPath($Path)
    if (-not [IO.Path]::IsPathRooted($canonical) `
        -or $canonical.StartsWith('\\') `
        -or -not [string]::Equals([IO.Path]::GetDirectoryName($canonical), $ExpectedDirectory, [StringComparison]::OrdinalIgnoreCase) `
        -or [IO.Path]::GetFileName($canonical) -notmatch $ExpectedNamePattern `
        -or -not [IO.File]::Exists($canonical)) {
        throw 'Windows Job journal commit temporary path is invalid.'
    }
    $information = [IO.FileInfo]::new($canonical)
    if (($information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Windows Job journal commit temporary cannot be reparse-backed.'
    }
    return $canonical
}

function Write-DurableBytes {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [byte[]] $Bytes
    )
    $stream = [IO.FileStream]::new(
        $Path,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::Read,
        4096,
        [IO.FileOptions]::WriteThrough
    )
    try {
        if ($Bytes.Length -gt 0) { $stream.Write($Bytes, 0, $Bytes.Length) }
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
}

function Invoke-JournalCommitLocked {
    param(
        [Parameter(Mandatory = $true)] [string] $TargetPath,
        [Parameter(Mandatory = $true)] [string] $DesiredPath,
        [Parameter(Mandatory = $true)] [string] $ExpectedPath,
        [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [byte[]] $DesiredBytes,
        [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [byte[]] $ExpectedBytes
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds(5000)
    while ($true) {
        try {
            [byte[]] $currentBytes = [byte[]]::new(0)
            if ([IO.File]::Exists($TargetPath)) {
                $currentBytes = [IO.File]::ReadAllBytes($TargetPath)
            }
            if (Test-ExactBytes -Left $currentBytes -Right $DesiredBytes) {
                $durable = [IO.FileStream]::new(
                    $TargetPath,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::ReadWrite,
                    [IO.FileShare]::Read
                )
                try { $durable.Flush($true) }
                finally { $durable.Dispose() }
                return 0
            }
            if (-not (Test-ExactBytes -Left $currentBytes -Right $ExpectedBytes)) { return 73 }
            [IO.File]::Delete($ExpectedPath)
            if ([IO.File]::Exists($TargetPath)) {
                [IO.File]::Replace($DesiredPath, $TargetPath, $ExpectedPath, $true)
            }
            else {
                [IO.File]::Move($DesiredPath, $TargetPath)
            }
            continue
        }
        catch {
            if (-not (Test-SharingViolation -ErrorValue $_.Exception)) { throw }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw [TimeoutException]::new('Windows Job journal target remained busy during durable commit.')
            }
            Start-Sleep -Milliseconds 20
        }
    }
}

function Invoke-JournalCommit {
    param(
        [Parameter(Mandatory = $true)] [string] $TargetPath,
        [Parameter(Mandatory = $true)] [string] $DesiredPath,
        [Parameter(Mandatory = $true)] [string] $ExpectedPath
    )
    $target = [IO.Path]::GetFullPath($TargetPath)
    $directory = [IO.Path]::GetDirectoryName($target)
    if (-not [IO.Path]::IsPathRooted($target) `
        -or $target.StartsWith('\\') `
        -or [IO.Path]::GetFileName($target) -ne 'status.journal.jsonl') {
        throw 'Windows Job journal commit target is invalid.'
    }
    $desired = Assert-JournalCommitFile -Path $DesiredPath -ExpectedDirectory $directory -ExpectedNamePattern '^\.controller-terminal-journal\.[a-f0-9-]+\.tmp$'
    $expected = Assert-JournalCommitFile -Path $ExpectedPath -ExpectedDirectory $directory -ExpectedNamePattern '^\.controller-terminal-journal\.[a-f0-9-]+\.expected\.tmp$'
    $desiredBytes = [IO.File]::ReadAllBytes($desired)
    $expectedBytes = [IO.File]::ReadAllBytes($expected)
    $lockPath = "$target.lock"
    $commitLock = Open-JournalCommitLock -LockPath $lockPath -TimeoutMs 5000
    try {
        return Invoke-JournalCommitLocked `
            -TargetPath $target `
            -DesiredPath $desired `
            -ExpectedPath $expected `
            -DesiredBytes $desiredBytes `
            -ExpectedBytes $expectedBytes
    }
    finally { $commitLock.Dispose() }
}

if (-not [string]::IsNullOrWhiteSpace($JournalCommitPath)) {
    if ([string]::IsNullOrWhiteSpace($JournalCommitDesiredPath) -or [string]::IsNullOrWhiteSpace($JournalCommitExpectedPath)) {
        exit 76
    }
    try { exit (Invoke-JournalCommit -TargetPath $JournalCommitPath -DesiredPath $JournalCommitDesiredPath -ExpectedPath $JournalCommitExpectedPath) }
    catch [TimeoutException] { exit 75 }
    catch { exit 76 }
}

$recoveryAuthenticationKey = $null
if ([Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_HELPER') -eq '1') {
    try {
        $encodedRecoveryKey = [Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_AUTH_KEY')
        [Environment]::SetEnvironmentVariable('AGENT_OS_RECOVERY_AUTH_KEY', $null, 'Process')
        if ([string]::IsNullOrWhiteSpace($encodedRecoveryKey)) { throw 'Windows Job recovery authentication key is required.' }
        $recoveryAuthenticationKey = [Convert]::FromBase64String($encodedRecoveryKey)
        $encodedRecoveryKey = $null
        if ($recoveryAuthenticationKey.Length -ne 32) { throw 'Windows Job recovery authentication key is invalid.' }
    }
    catch { exit 2 }
    try {
        [Native.Kernel32]::SetConsoleCtrlHandler($null, $true)
    }
    catch {
        $consoleControlSource = @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class AgentOsConsoleControl
{
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);
    public static void IgnoreControlEvents() { SetConsoleCtrlHandler(IntPtr.Zero, true); }
}
'@
        Add-Type -TypeDefinition $consoleControlSource -Language CSharp
        [AgentOsConsoleControl]::IgnoreControlEvents()
    }
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class AgentOsWindowsJobSession : IDisposable
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000D);
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint STD_INPUT_HANDLE = unchecked((uint)-10);
    private const uint STD_OUTPUT_HANDLE = unchecked((uint)-11);
    private const uint STD_ERROR_HANDLE = unchecked((uint)-12);
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
    private const uint JOB_OBJECT_QUERY = 0x0004;
    private const uint JOB_OBJECT_TERMINATE = 0x0008;
    private const uint OPEN_EXISTING = 3;
    private const int ERROR_FILE_NOT_FOUND = 2;
    private const int ERROR_ALREADY_EXISTS = 183;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

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

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int infoType,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr hJob,
        int infoType,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION lpJobObjectInfo,
        uint cbJobObjectInfoLength,
        IntPtr lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr processHandle, IntPtr jobHandle, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr lpAttributeList,
        int dwAttributeCount,
        int dwFlags,
        ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList,
        uint dwFlags,
        IntPtr attribute,
        IntPtr lpValue,
        IntPtr cbSize,
        IntPtr lpPreviousValue,
        IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        IntPtr hProcess,
        out FILETIME creationTime,
        out FILETIME exitTime,
        out FILETIME kernelTime,
        out FILETIME userTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObject(uint dwDesiredAccess, bool bInheritHandle, string lpName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributes(string lpFileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(
        string lpFileName,
        string lpExistingFileName,
        IntPtr lpSecurityAttributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        IntPtr hFile,
        StringBuilder lpszFilePath,
        uint cchFilePath,
        uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        IntPtr hFile,
        out BY_HANDLE_FILE_INFORMATION lpFileInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(uint nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        ref SECURITY_ATTRIBUTES lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out IntPtr hReadPipe,
        out IntPtr hWritePipe,
        ref SECURITY_ATTRIBUTES lpPipeAttributes,
        uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    private IntPtr job;
    private IntPtr process;
    private IntPtr parent;
    private OutputCapture outputCapture;
    private List<FileStream> executableIdentityLeases;
    private bool disposed;
    private readonly object terminationLock = new object();

    public string JobName { get; private set; }
    public int RootProcessId { get; private set; }
    public string RootProcessStartedAtFileTime { get; private set; }
    public bool AssignmentVerified { get; private set; }

    private AgentOsWindowsJobSession() { }

    private static Win32Exception LastError(string operation)
    {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, operation + " failed with Win32 error " + code.ToString(CultureInfo.InvariantCulture));
    }

    public static void PublishHardLinkExclusive(string finalPath, string durableTemporaryPath)
    {
        if (!CreateHardLink(finalPath, durableTemporaryPath, IntPtr.Zero))
        {
            throw LastError("CreateHardLink");
        }
    }

    private static IntPtr OpenInheritedInput(string inputPath)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = true;
        IntPtr handle = CreateFile(
            inputPath,
            GENERIC_READ,
            FILE_SHARE_READ,
            ref attributes,
            OPEN_EXISTING,
            0,
            IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE) throw LastError("CreateFile(input)");
        return handle;
    }

    private static void CreateOutputPipe(out IntPtr readHandle, out IntPtr writeHandle)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = true;
        if (!CreatePipe(out readHandle, out writeHandle, ref attributes, 0)) throw LastError("CreatePipe(output)");
        if (!SetHandleInformation(readHandle, HANDLE_FLAG_INHERIT, 0))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(readHandle);
            CloseHandle(writeHandle);
            readHandle = IntPtr.Zero;
            writeHandle = IntPtr.Zero;
            throw new Win32Exception(error, "SetHandleInformation(output read handle) failed with Win32 error " + error.ToString(CultureInfo.InvariantCulture));
        }
    }

    private static void CreateInputPipe(out IntPtr readHandle, out IntPtr writeHandle)
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = true;
        if (!CreatePipe(out readHandle, out writeHandle, ref attributes, 0)) throw LastError("CreatePipe(input)");
        if (!SetHandleInformation(writeHandle, HANDLE_FLAG_INHERIT, 0))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(readHandle);
            CloseHandle(writeHandle);
            readHandle = IntPtr.Zero;
            writeHandle = IntPtr.Zero;
            throw new Win32Exception(error, "SetHandleInformation(input write handle) failed with Win32 error " + error.ToString(CultureInfo.InvariantCulture));
        }
    }

    private sealed class InputWriter
    {
        private readonly Thread thread;

        public InputWriter(IntPtr writeHandle, byte[] input)
        {
            thread = new Thread(delegate()
            {
                try
                {
                    using (SafeFileHandle safeHandle = new SafeFileHandle(writeHandle, true))
                    using (FileStream output = new FileStream(safeHandle, FileAccess.Write, 16384, false))
                    {
                        output.Write(input, 0, input.Length);
                        output.Flush();
                    }
                }
                catch (IOException)
                {
                    // Provider exit/cancellation may close stdin before all bytes are consumed.
                }
            });
            thread.IsBackground = true;
        }

        public void Start() { thread.Start(); }
    }

    private static IntPtr CreateAttributeList(IntPtr[] handles, IntPtr jobHandle, out IntPtr handleValues, out IntPtr jobValue)
    {
        handleValues = IntPtr.Zero;
        jobValue = IntPtr.Zero;
        if (handles == null || handles.Length != 3) throw new ArgumentException("Exactly three standard handles are required.");
        IntPtr attributeBytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
        if (attributeBytes == IntPtr.Zero) throw LastError("InitializeProcThreadAttributeList(size)");

        IntPtr attributeList = Marshal.AllocHGlobal(attributeBytes);
        bool initialized = false;
        try
        {
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeBytes))
            {
                throw LastError("InitializeProcThreadAttributeList");
            }
            initialized = true;
            handleValues = Marshal.AllocHGlobal(checked(IntPtr.Size * handles.Length));
            for (int index = 0; index < handles.Length; index++)
            {
                Marshal.WriteIntPtr(handleValues, checked(index * IntPtr.Size), handles[index]);
            }
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handleValues,
                new IntPtr(checked(IntPtr.Size * handles.Length)),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw LastError("UpdateProcThreadAttribute(handle list)");
            }
            jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobValue, jobHandle);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobValue,
                new IntPtr(IntPtr.Size),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw LastError("UpdateProcThreadAttribute(job list)");
            }
            return attributeList;
        }
        catch
        {
            if (handleValues != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(handleValues);
                handleValues = IntPtr.Zero;
            }
            if (jobValue != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(jobValue);
                jobValue = IntPtr.Zero;
            }
            if (initialized) DeleteProcThreadAttributeList(attributeList);
            Marshal.FreeHGlobal(attributeList);
            throw;
        }
    }

    private sealed class OutputCapture
    {
        private static readonly byte[] EncryptedFileMagic = Encoding.ASCII.GetBytes("AGOSENC1");
        private readonly object sync = new object();
        private readonly IntPtr jobHandle;
        private readonly byte[] recoveryAuthenticationKey;
        private readonly Thread standardOutputThread;
        private readonly Thread standardErrorThread;
        private long remainingBytes;
        private bool limitExceeded;
        private string failure;

        public OutputCapture(
            IntPtr job,
            IntPtr outputReadHandle,
            string outputPath,
            IntPtr errorReadHandle,
            string errorPath,
            long maxOutputBytes,
            byte[] authenticationKey)
        {
            jobHandle = job;
            recoveryAuthenticationKey = authenticationKey;
            remainingBytes = maxOutputBytes;
            standardOutputThread = ReaderThread(outputReadHandle, outputPath, "stdout");
            standardErrorThread = ReaderThread(errorReadHandle, errorPath, "stderr");
        }

        private Thread ReaderThread(IntPtr readHandle, string outputPath, string streamName)
        {
            Thread thread = new Thread(delegate()
            {
                Capture(readHandle, outputPath, streamName);
            });
            thread.IsBackground = false;
            return thread;
        }

        public void Start()
        {
            standardOutputThread.Start();
            standardErrorThread.Start();
        }

        private void Capture(IntPtr readHandle, string outputPath, string streamName)
        {
            try
            {
                using (SafeFileHandle safeHandle = new SafeFileHandle(readHandle, true))
                using (FileStream input = new FileStream(safeHandle, FileAccess.Read, 16384, false))
                {
                    if (recoveryAuthenticationKey == null)
                    {
                        using (FileStream output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                        {
                            CopyWithQuota(input, output);
                            output.Flush(true);
                        }
                    }
                    else
                    {
                        CaptureEncrypted(input, outputPath, streamName);
                    }
                }
            }
            catch (Exception exception)
            {
                lock (sync)
                {
                    if (failure == null) failure = streamName + " capture failed: " + exception.Message;
                }
                TerminateJobObject(jobHandle, 124);
            }
        }

        private void CopyWithQuota(Stream input, Stream output)
        {
            byte[] buffer = new byte[16384];
            for (;;)
            {
                int count = input.Read(buffer, 0, buffer.Length);
                if (count == 0) break;
                bool exceeded = false;
                lock (sync)
                {
                    int allowed = (int)Math.Min((long)count, remainingBytes);
                    if (allowed > 0)
                    {
                        output.Write(buffer, 0, allowed);
                        remainingBytes -= allowed;
                    }
                    if (allowed != count)
                    {
                        limitExceeded = true;
                        exceeded = true;
                    }
                }
                if (exceeded)
                {
                    TerminateJobObject(jobHandle, 124);
                    break;
                }
            }
        }

        private static byte[] PurposeKey(byte[] authenticationKey, string purpose)
        {
            using (HMACSHA256 hmac = new HMACSHA256(authenticationKey))
            {
                byte[] prefix = Encoding.UTF8.GetBytes("agent-os/windows-job-recovery/purpose-key/v1");
                byte[] purposeBytes = Encoding.UTF8.GetBytes(purpose);
                byte[] authenticated = new byte[prefix.Length + 1 + purposeBytes.Length];
                Buffer.BlockCopy(prefix, 0, authenticated, 0, prefix.Length);
                Buffer.BlockCopy(purposeBytes, 0, authenticated, prefix.Length + 1, purposeBytes.Length);
                return hmac.ComputeHash(authenticated);
            }
        }

        private void CaptureEncrypted(Stream input, string outputPath, string purpose)
        {
            byte[] iv = new byte[16];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(iv);
            byte[] encryptionKey = PurposeKey(recoveryAuthenticationKey, "encryption/" + purpose);
            using (FileStream output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            {
                output.Write(EncryptedFileMagic, 0, EncryptedFileMagic.Length);
                output.Write(iv, 0, iv.Length);
                using (Aes aes = Aes.Create())
                {
                    aes.KeySize = 256;
                    aes.Mode = CipherMode.CBC;
                    aes.Padding = PaddingMode.PKCS7;
                    aes.Key = encryptionKey;
                    aes.IV = iv;
                    using (ICryptoTransform encryptor = aes.CreateEncryptor())
                    using (CryptoStream encrypted = new CryptoStream(output, encryptor, CryptoStreamMode.Write, true))
                    {
                        CopyWithQuota(input, encrypted);
                        encrypted.FlushFinalBlock();
                    }
                }
                output.Flush(true);
            }
            byte[] persisted = File.ReadAllBytes(outputPath);
            int ciphertextOffset = EncryptedFileMagic.Length + iv.Length;
            byte[] ciphertext = new byte[persisted.Length - ciphertextOffset];
            Buffer.BlockCopy(persisted, ciphertextOffset, ciphertext, 0, ciphertext.Length);
            byte[] macKey = PurposeKey(recoveryAuthenticationKey, "mac/" + purpose);
            byte[] purposeBytes = Encoding.UTF8.GetBytes(purpose);
            byte[] authenticated = new byte[purposeBytes.Length + 1 + iv.Length + ciphertext.Length];
            Buffer.BlockCopy(purposeBytes, 0, authenticated, 0, purposeBytes.Length);
            Buffer.BlockCopy(iv, 0, authenticated, purposeBytes.Length + 1, iv.Length);
            Buffer.BlockCopy(ciphertext, 0, authenticated, purposeBytes.Length + 1 + iv.Length, ciphertext.Length);
            byte[] tag;
            using (HMACSHA256 hmac = new HMACSHA256(macKey)) tag = hmac.ComputeHash(authenticated);
            using (FileStream append = new FileStream(outputPath, FileMode.Append, FileAccess.Write, FileShare.Read))
            {
                append.Write(tag, 0, tag.Length);
                append.Flush(true);
            }
        }

        public bool LimitExceeded
        {
            get { lock (sync) { return limitExceeded; } }
        }

        public string Failure
        {
            get { lock (sync) { return failure; } }
        }

        public void Wait()
        {
            standardOutputThread.Join();
            standardErrorThread.Join();
        }
    }

    private static string QuoteArgument(string value)
    {
        if (value == null) throw new ArgumentNullException("value");
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static StringBuilder CommandLine(string executable, string[] arguments)
    {
        StringBuilder result = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments)
        {
            result.Append(' ');
            result.Append(QuoteArgument(argument));
        }
        if (result.Length > 32767) throw new ArgumentException("Windows command line exceeds 32767 characters.");
        return result;
    }

    private static IntPtr EnvironmentBlock(IDictionary<string, string> environment)
    {
        List<KeyValuePair<string, string>> values = new List<KeyValuePair<string, string>>(environment);
        values.Sort(delegate(KeyValuePair<string, string> left, KeyValuePair<string, string> right)
        {
            return StringComparer.OrdinalIgnoreCase.Compare(left.Key, right.Key);
        });
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> item in values)
        {
            if (String.IsNullOrEmpty(item.Key) || item.Key.IndexOf('\0') >= 0 || item.Key.IndexOf('=') >= 0)
            {
                throw new ArgumentException("Child environment contains an invalid variable name.");
            }
            if (item.Value == null || item.Value.IndexOf('\0') >= 0)
            {
                throw new ArgumentException("Child environment contains an invalid variable value.");
            }
            block.Append(item.Key);
            block.Append('=');
            block.Append(item.Value);
            block.Append('\0');
        }
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static void ConfigureLimits(
        IntPtr jobHandle,
        uint activeProcessLimit,
        ulong jobMemoryLimitBytes,
        long cpuTimeLimitMs)
    {
        if (activeProcessLimit == 0) throw new ArgumentException("Active process limit must be positive.");
        if (jobMemoryLimitBytes == 0) throw new ArgumentException("Job memory limit must be positive.");
        if (cpuTimeLimitMs <= 0) throw new ArgumentException("CPU time limit must be positive.");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_JOB_TIME | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
        information.BasicLimitInformation.PerJobUserTimeLimit = checked(cpuTimeLimitMs * 10000L);
        information.BasicLimitInformation.ActiveProcessLimit = activeProcessLimit;
        information.JobMemoryLimit = new UIntPtr(jobMemoryLimitBytes);
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation, pointer, (uint)size))
            {
                throw LastError("SetInformationJobObject");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static uint QueryActiveProcesses(IntPtr jobHandle)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
        uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        if (!QueryInformationJobObject(
            jobHandle,
            JobObjectBasicAccountingInformation,
            out information,
            size,
            IntPtr.Zero))
        {
            throw LastError("QueryInformationJobObject");
        }
        return information.ActiveProcesses;
    }

    private static void WaitUntilProcessExit(IntPtr processHandle)
    {
        while (WaitForSingleObject(processHandle, 1000) != WAIT_OBJECT_0) { }
    }

    private static void TerminateUnassignedProcessAndWait(IntPtr processHandle)
    {
        TerminateProcess(processHandle, 125);
        WaitUntilProcessExit(processHandle);
    }

    private static void TerminateJobAndWait(IntPtr jobHandle)
    {
        TerminateJobObject(jobHandle, 124);
        for (;;)
        {
            try
            {
                if (QueryActiveProcesses(jobHandle) == 0) return;
            }
            catch
            {
                // Query failure is not proof of termination. Retain the job handle and retry.
            }
            Thread.Sleep(1000);
        }
    }

    private static string ProcessCreationTime(IntPtr processHandle)
    {
        FILETIME creation;
        FILETIME exit;
        FILETIME kernel;
        FILETIME user;
        if (!GetProcessTimes(processHandle, out creation, out exit, out kernel, out user))
        {
            throw LastError("GetProcessTimes");
        }
        ulong value = ((ulong)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
        return value.ToString(CultureInfo.InvariantCulture);
    }

    private static string NormalizeFinalPath(string value)
    {
        if (value.StartsWith("\\\\?\\", StringComparison.Ordinal)) return value.Substring(4);
        return value;
    }

    private static IntPtr VerifyWorkingDirectory(
        string expectedPathValue,
        uint expectedVolumeSerialNumber,
        ulong expectedFileId)
    {
        string expectedPath = Path.GetFullPath(expectedPathValue);
        uint attributes = GetFileAttributes(expectedPath);
        if (attributes == INVALID_FILE_ATTRIBUTES) throw LastError("GetFileAttributes(working directory identity)");
        if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            throw new InvalidOperationException("Working directory identity is not a canonical directory.");
        }
        SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
        security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        IntPtr handle = CreateFile(
            expectedPath,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ref security,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE) throw LastError("CreateFile(working directory identity)");
        try
        {
            StringBuilder finalPath = new StringBuilder(32768);
            uint finalLength = GetFinalPathNameByHandle(handle, finalPath, (uint)finalPath.Capacity, 0);
            if (finalLength == 0 || finalLength >= finalPath.Capacity)
            {
                throw LastError("GetFinalPathNameByHandle(working directory identity)");
            }
            string observedPath = Path.GetFullPath(NormalizeFinalPath(finalPath.ToString()));
            if (!String.Equals(observedPath, expectedPath, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Working directory canonical identity changed before CreateProcess.");
            }
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                throw LastError("GetFileInformationByHandle(working directory identity)");
            }
            ulong observedFileId = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
            if (information.VolumeSerialNumber != expectedVolumeSerialNumber || observedFileId != expectedFileId)
            {
                throw new InvalidOperationException("Working directory volume or file identity changed before CreateProcess.");
            }
            IntPtr lease = handle;
            handle = IntPtr.Zero;
            return lease;
        }
        finally
        {
            if (handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        }
    }

    private static List<FileStream> VerifyExecutableFiles(
        string[] expectedPaths,
        string[] expectedSha256,
        long[] expectedSizeBytes)
    {
        if (expectedPaths == null || expectedSha256 == null || expectedSizeBytes == null
            || expectedPaths.Length == 0
            || expectedPaths.Length != expectedSha256.Length
            || expectedPaths.Length != expectedSizeBytes.Length)
        {
            throw new ArgumentException("Executable identity arrays are missing or inconsistent.");
        }
        List<FileStream> leases = new List<FileStream>();
        try
        {
            for (int index = 0; index < expectedPaths.Length; index += 1)
            {
                string expectedPath = Path.GetFullPath(expectedPaths[index]);
                string expectedHash = expectedSha256[index];
                long expectedSize = expectedSizeBytes[index];
                if (expectedHash == null || expectedHash.Length != 64 || expectedSize < 0)
                {
                    throw new InvalidOperationException("Executable identity metadata is invalid.");
                }
                uint attributes = GetFileAttributes(expectedPath);
                if (attributes == INVALID_FILE_ATTRIBUTES) throw LastError("GetFileAttributes(executable identity)");
                if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                {
                    throw new InvalidOperationException("Executable identity path is reparse-backed.");
                }
                SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
                security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                IntPtr handle = CreateFile(
                    expectedPath,
                    GENERIC_READ,
                    FILE_SHARE_READ,
                    ref security,
                    OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT,
                    IntPtr.Zero);
                if (handle == INVALID_HANDLE_VALUE) throw LastError("CreateFile(executable identity)");
                FileStream stream = null;
                try
                {
                    stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read);
                    handle = IntPtr.Zero;
                    StringBuilder finalPath = new StringBuilder(32768);
                    uint finalLength = GetFinalPathNameByHandle(
                        stream.SafeFileHandle.DangerousGetHandle(),
                        finalPath,
                        (uint)finalPath.Capacity,
                        0);
                    if (finalLength == 0 || finalLength >= finalPath.Capacity)
                    {
                        throw LastError("GetFinalPathNameByHandle(executable identity)");
                    }
                    string observedPath = Path.GetFullPath(NormalizeFinalPath(finalPath.ToString()));
                    if (!String.Equals(observedPath, expectedPath, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("Executable canonical identity changed before CreateProcess.");
                    }
                    if (stream.Length != expectedSize)
                    {
                        throw new InvalidOperationException("Executable size changed before CreateProcess.");
                    }
                    string observedHash;
                    using (SHA256 sha = SHA256.Create())
                    {
                        observedHash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                    }
                    if (!String.Equals(observedHash, expectedHash, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("Executable hash changed before CreateProcess.");
                    }
                    leases.Add(stream);
                    stream = null;
                }
                finally
                {
                    if (stream != null) stream.Dispose();
                    if (handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
                }
            }
            return leases;
        }
        catch
        {
            foreach (FileStream lease in leases) lease.Dispose();
            throw;
        }
    }

    public static int InspectNamedJob(string jobName, bool terminate)
    {
        if (String.IsNullOrWhiteSpace(jobName) || !jobName.StartsWith("Local\\AgentOS-", StringComparison.Ordinal))
        {
            throw new ArgumentException("Windows Job probe name is invalid.");
        }
        uint access = JOB_OBJECT_QUERY | (terminate ? JOB_OBJECT_TERMINATE : 0);
        IntPtr handle = OpenJobObject(access, false, jobName);
        if (handle == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_FILE_NOT_FOUND) return -1;
            throw new Win32Exception(error, "OpenJobObject failed with Win32 error " + error.ToString(CultureInfo.InvariantCulture));
        }
        try
        {
            if (terminate && QueryActiveProcesses(handle) != 0)
            {
                if (!TerminateJobObject(handle, 124) && QueryActiveProcesses(handle) != 0)
                {
                    throw LastError("TerminateJobObject(probe)");
                }
                DateTime deadline = DateTime.UtcNow.AddSeconds(15);
                while (QueryActiveProcesses(handle) != 0)
                {
                    if (DateTime.UtcNow >= deadline)
                    {
                        throw new TimeoutException("Windows Job probe did not reach ACTIVE_PROCESS_ZERO.");
                    }
                    Thread.Sleep(25);
                }
            }
            return checked((int)QueryActiveProcesses(handle));
        }
        finally { CloseHandle(handle); }
    }

    public static AgentOsWindowsJobSession Start(
        string executable,
        string[] arguments,
        string cwd,
        uint expectedWorkingDirectoryDevice,
        ulong expectedWorkingDirectoryInode,
        IDictionary<string, string> environment,
        byte[] inputBytes,
        string outputPath,
        string errorPath,
        string jobId,
        int parentPid,
        string parentProcessStartedAtFileTime,
        string[] expectedExecutablePaths,
        string[] expectedExecutableSha256,
        long[] expectedExecutableSizeBytes,
        uint activeProcessLimit,
        ulong jobMemoryLimitBytes,
        long cpuTimeLimitMs,
        long maxOutputBytes,
        byte[] recoveryKey)
    {
        if (String.IsNullOrWhiteSpace(executable)) throw new ArgumentException("Executable is required.");
        if (String.IsNullOrWhiteSpace(cwd)) throw new ArgumentException("Working directory is required.");
        if (arguments == null) throw new ArgumentNullException("arguments");
        if (environment == null) throw new ArgumentNullException("environment");
        if (inputBytes == null) throw new ArgumentNullException("inputBytes");
        if (String.IsNullOrWhiteSpace(outputPath)) throw new ArgumentException("Output path is required.");
        if (String.IsNullOrWhiteSpace(errorPath)) throw new ArgumentException("Error path is required.");
        if (String.IsNullOrWhiteSpace(jobId)) throw new ArgumentException("Job ID is required.");
        if (parentPid <= 0) throw new ArgumentException("Parent PID must be positive.");
        if (String.IsNullOrWhiteSpace(parentProcessStartedAtFileTime)) throw new ArgumentException("Parent process creation time is required.");
        if (maxOutputBytes < 0) throw new ArgumentException("Output byte limit must be non-negative.");

        string jobName = "Local\\AgentOS-" + jobId;
        IntPtr parentHandle = IntPtr.Zero;
        IntPtr jobHandle = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        IntPtr inputHandle = IntPtr.Zero;
        IntPtr inputWriteHandle = IntPtr.Zero;
        IntPtr outputReadHandle = IntPtr.Zero;
        IntPtr outputWriteHandle = IntPtr.Zero;
        IntPtr errorReadHandle = IntPtr.Zero;
        IntPtr errorWriteHandle = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleValues = IntPtr.Zero;
        IntPtr jobValue = IntPtr.Zero;
        IntPtr workingDirectoryHandle = IntPtr.Zero;
        OutputCapture capture = null;
        InputWriter inputWriter = null;
        List<FileStream> verifiedExecutableFiles = null;
        PROCESS_INFORMATION created = new PROCESS_INFORMATION();
        bool processCreated = false;
        bool processAssigned = false;

        try
        {
            parentHandle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)parentPid);
            if (parentHandle == IntPtr.Zero) throw LastError("OpenProcess(parent)");
            if (!String.Equals(ProcessCreationTime(parentHandle), parentProcessStartedAtFileTime, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Control-plane parent process identity changed before native spawn.");
            }

            Marshal.GetLastWin32Error();
            jobHandle = CreateJobObject(IntPtr.Zero, jobName);
            int createJobError = Marshal.GetLastWin32Error();
            if (jobHandle == IntPtr.Zero) throw LastError("CreateJobObject");
            if (createJobError == ERROR_ALREADY_EXISTS) throw new InvalidOperationException("Windows Job identity already exists.");
            ConfigureLimits(jobHandle, activeProcessLimit, jobMemoryLimitBytes, cpuTimeLimitMs);

            CreateInputPipe(out inputHandle, out inputWriteHandle);
            CreateOutputPipe(out outputReadHandle, out outputWriteHandle);
            CreateOutputPipe(out errorReadHandle, out errorWriteHandle);
            attributeList = CreateAttributeList(
                new IntPtr[] { inputHandle, outputWriteHandle, errorWriteHandle },
                jobHandle,
                out handleValues,
                out jobValue);
            environmentBlock = EnvironmentBlock(environment);

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = inputHandle;
            startup.StartupInfo.hStdOutput = outputWriteHandle;
            startup.StartupInfo.hStdError = errorWriteHandle;
            startup.lpAttributeList = attributeList;

            verifiedExecutableFiles = VerifyExecutableFiles(
                expectedExecutablePaths,
                expectedExecutableSha256,
                expectedExecutableSizeBytes);
            workingDirectoryHandle = VerifyWorkingDirectory(
                cwd,
                expectedWorkingDirectoryDevice,
                expectedWorkingDirectoryInode);
            if (!CreateProcess(
                executable,
                CommandLine(executable, arguments),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                environmentBlock,
                cwd,
                ref startup,
                out created))
            {
                throw LastError("CreateProcess");
            }
            processCreated = true;

            bool inJob;
            if (!IsProcessInJob(created.hProcess, jobHandle, out inJob)) throw LastError("IsProcessInJob");
            if (!inJob) throw new InvalidOperationException("Process assignment to Windows Job could not be verified.");
            processAssigned = true;
            CloseHandle(workingDirectoryHandle);
            workingDirectoryHandle = IntPtr.Zero;
            string creationTime = ProcessCreationTime(created.hProcess);

            capture = new OutputCapture(
                jobHandle,
                outputReadHandle,
                outputPath,
                errorReadHandle,
                errorPath,
                maxOutputBytes,
                recoveryKey);
            outputReadHandle = IntPtr.Zero;
            errorReadHandle = IntPtr.Zero;
            capture.Start();

            if (ResumeThread(created.hThread) == INFINITE) throw LastError("ResumeThread");
            inputWriter = new InputWriter(inputWriteHandle, inputBytes);
            inputWriteHandle = IntPtr.Zero;
            inputWriter.Start();
            CloseHandle(created.hThread);
            created.hThread = IntPtr.Zero;
            CloseHandle(outputWriteHandle);
            outputWriteHandle = IntPtr.Zero;
            CloseHandle(errorWriteHandle);
            errorWriteHandle = IntPtr.Zero;

            AgentOsWindowsJobSession result = new AgentOsWindowsJobSession();
            result.job = jobHandle;
            result.process = created.hProcess;
            result.parent = parentHandle;
            result.outputCapture = capture;
            result.executableIdentityLeases = verifiedExecutableFiles;
            result.JobName = jobName;
            result.RootProcessId = checked((int)created.dwProcessId);
            result.RootProcessStartedAtFileTime = creationTime;
            result.AssignmentVerified = true;
            jobHandle = IntPtr.Zero;
            created.hProcess = IntPtr.Zero;
            parentHandle = IntPtr.Zero;
            verifiedExecutableFiles = null;
            return result;
        }
        catch
        {
            if (processCreated)
            {
                if (created.hProcess != IntPtr.Zero) TerminateUnassignedProcessAndWait(created.hProcess);
                if (processAssigned && jobHandle != IntPtr.Zero) TerminateJobAndWait(jobHandle);
            }
            if (outputWriteHandle != IntPtr.Zero && outputWriteHandle != INVALID_HANDLE_VALUE)
            {
                CloseHandle(outputWriteHandle);
                outputWriteHandle = IntPtr.Zero;
            }
            if (errorWriteHandle != IntPtr.Zero && errorWriteHandle != INVALID_HANDLE_VALUE)
            {
                CloseHandle(errorWriteHandle);
                errorWriteHandle = IntPtr.Zero;
            }
            if (capture != null) capture.Wait();
            throw;
        }
        finally
        {
            if (created.hThread != IntPtr.Zero) CloseHandle(created.hThread);
            if (created.hProcess != IntPtr.Zero) CloseHandle(created.hProcess);
            if (inputHandle != IntPtr.Zero && inputHandle != INVALID_HANDLE_VALUE) CloseHandle(inputHandle);
            if (inputWriteHandle != IntPtr.Zero && inputWriteHandle != INVALID_HANDLE_VALUE) CloseHandle(inputWriteHandle);
            if (outputReadHandle != IntPtr.Zero && outputReadHandle != INVALID_HANDLE_VALUE) CloseHandle(outputReadHandle);
            if (outputWriteHandle != IntPtr.Zero && outputWriteHandle != INVALID_HANDLE_VALUE) CloseHandle(outputWriteHandle);
            if (errorReadHandle != IntPtr.Zero && errorReadHandle != INVALID_HANDLE_VALUE) CloseHandle(errorReadHandle);
            if (errorWriteHandle != IntPtr.Zero && errorWriteHandle != INVALID_HANDLE_VALUE) CloseHandle(errorWriteHandle);
            if (handleValues != IntPtr.Zero) Marshal.FreeHGlobal(handleValues);
            if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (workingDirectoryHandle != IntPtr.Zero && workingDirectoryHandle != INVALID_HANDLE_VALUE) CloseHandle(workingDirectoryHandle);
            if (jobHandle != IntPtr.Zero) CloseHandle(jobHandle);
            if (parentHandle != IntPtr.Zero) CloseHandle(parentHandle);
            if (verifiedExecutableFiles != null)
            {
                foreach (FileStream lease in verifiedExecutableFiles) lease.Dispose();
            }
        }
    }

    public uint ActiveProcesses()
    {
        if (disposed) throw new ObjectDisposedException("AgentOsWindowsJobSession");
        return QueryActiveProcesses(job);
    }

    public bool ParentExited()
    {
        uint result = WaitForSingleObject(parent, 0);
        if (result == WAIT_OBJECT_0) return true;
        if (result == WAIT_TIMEOUT) return false;
        throw LastError("WaitForSingleObject(parent)");
    }

    public bool RootExited()
    {
        uint result = WaitForSingleObject(process, 0);
        if (result == WAIT_OBJECT_0) return true;
        if (result == WAIT_TIMEOUT) return false;
        throw LastError("WaitForSingleObject(process)");
    }

    public int RootExitCode()
    {
        uint code;
        if (!GetExitCodeProcess(process, out code)) throw LastError("GetExitCodeProcess");
        return unchecked((int)code);
    }

    public bool OutputLimitExceeded()
    {
        if (disposed) throw new ObjectDisposedException("AgentOsWindowsJobSession");
        return outputCapture.LimitExceeded;
    }

    public string OutputFailure()
    {
        if (disposed) throw new ObjectDisposedException("AgentOsWindowsJobSession");
        return outputCapture.Failure;
    }

    public void WaitForOutput()
    {
        if (disposed) throw new ObjectDisposedException("AgentOsWindowsJobSession");
        outputCapture.Wait();
        if (executableIdentityLeases != null)
        {
            foreach (FileStream lease in executableIdentityLeases) lease.Dispose();
            executableIdentityLeases = null;
        }
    }

    public void RequestTermination()
    {
        lock (terminationLock)
        {
            if (ActiveProcesses() == 0) return;
            if (!TerminateJobObject(job, 124) && ActiveProcesses() != 0) throw LastError("TerminateJobObject");
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        if (QueryActiveProcesses(job) != 0)
        {
            throw new InvalidOperationException("Cannot release Windows Job handle before ACTIVE_PROCESS_ZERO.");
        }
        outputCapture.Wait();
        disposed = true;
        if (process != IntPtr.Zero) CloseHandle(process);
        if (parent != IntPtr.Zero) CloseHandle(parent);
        if (job != IntPtr.Zero) CloseHandle(job);
        process = IntPtr.Zero;
        parent = IntPtr.Zero;
        job = IntPtr.Zero;
    }
}
'@

if (-not [string]::IsNullOrWhiteSpace($ProbeJobName)) {
    if (-not [string]::IsNullOrWhiteSpace($SpecificationPath)) { throw 'Windows Job probe cannot accept a launch specification.' }
    $null = Add-Type -TypeDefinition $nativeSource -Language CSharp
    [AgentOsWindowsJobSession]::InspectNamedJob($ProbeJobName, [bool] $TerminateProbe)
    exit 0
}

$sequence = 0
$previousSnapshotDigestSha256 = '0' * 64
$previousJournalDigestSha256 = '0' * 64
$specification = $null
$session = $null
$nativeStartAttempted = $false
$claimAcquired = $false
$terminationRequestedAt = $null
$terminationDeadlineAt = $null
$helperProcessStartedAtFileTime = ([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc()).ToString([Globalization.CultureInfo]::InvariantCulture)

function Get-RecoveryHmac {
    param(
        [Parameter(Mandatory = $true)] [string] $Purpose,
        [Parameter(Mandatory = $true)] [byte[]] $Payload
    )
    if ($null -eq $script:recoveryAuthenticationKey) { throw 'Windows Job recovery authentication key is unavailable.' }
    $purposeBytes = [Text.Encoding]::UTF8.GetBytes($Purpose)
    $authenticated = [byte[]]::new($purposeBytes.Length + 1 + $Payload.Length)
    [Array]::Copy($purposeBytes, 0, $authenticated, 0, $purposeBytes.Length)
    [Array]::Copy($Payload, 0, $authenticated, $purposeBytes.Length + 1, $Payload.Length)
    $hmac = [Security.Cryptography.HMACSHA256]::new($script:recoveryAuthenticationKey)
    try { return (($hmac.ComputeHash($authenticated) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $hmac.Dispose() }
}

function Test-FixedHexEquals {
    param([string] $Left, [string] $Right)
    if ($Left -notmatch '^[a-f0-9]{64}$' -or $Right -notmatch '^[a-f0-9]{64}$') { return $false }
    $difference = 0
    for ($index = 0; $index -lt 64; $index += 1) {
        $difference = $difference -bor ([int] $Left[$index] -bxor [int] $Right[$index])
    }
    return $difference -eq 0
}

function Get-RecoveryPurposeKey {
    param([Parameter(Mandatory = $true)] [string] $Purpose)
    if ($null -eq $script:recoveryAuthenticationKey) { throw 'Windows Job recovery authentication key is unavailable.' }
    $prefixBytes = [Text.Encoding]::UTF8.GetBytes('agent-os/windows-job-recovery/purpose-key/v1')
    $purposeBytes = [Text.Encoding]::UTF8.GetBytes($Purpose)
    $authenticated = [byte[]]::new($prefixBytes.Length + 1 + $purposeBytes.Length)
    [Array]::Copy($prefixBytes, 0, $authenticated, 0, $prefixBytes.Length)
    [Array]::Copy($purposeBytes, 0, $authenticated, $prefixBytes.Length + 1, $purposeBytes.Length)
    $hmac = [Security.Cryptography.HMACSHA256]::new($script:recoveryAuthenticationKey)
    try { return $hmac.ComputeHash($authenticated) }
    finally { $hmac.Dispose() }
}

function Get-RecoveryCiphertextHmac {
    param(
        [Parameter(Mandatory = $true)] [string] $Purpose,
        [Parameter(Mandatory = $true)] [byte[]] $InitializationVector,
        [Parameter(Mandatory = $true)] [byte[]] $Ciphertext
    )
    $macKey = Get-RecoveryPurposeKey -Purpose "mac/$Purpose"
    $purposeBytes = [Text.Encoding]::UTF8.GetBytes($Purpose)
    $authenticated = [byte[]]::new($purposeBytes.Length + 1 + $InitializationVector.Length + $Ciphertext.Length)
    [Array]::Copy($purposeBytes, 0, $authenticated, 0, $purposeBytes.Length)
    [Array]::Copy($InitializationVector, 0, $authenticated, $purposeBytes.Length + 1, $InitializationVector.Length)
    [Array]::Copy($Ciphertext, 0, $authenticated, $purposeBytes.Length + 1 + $InitializationVector.Length, $Ciphertext.Length)
    $hmac = [Security.Cryptography.HMACSHA256]::new($macKey)
    try { return (($hmac.ComputeHash($authenticated) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $hmac.Dispose() }
}

function ConvertFrom-RecoveryCiphertext {
    param(
        [Parameter(Mandatory = $true)] [string] $Purpose,
        [Parameter(Mandatory = $true)] [byte[]] $InitializationVector,
        [Parameter(Mandatory = $true)] [byte[]] $Ciphertext,
        [Parameter(Mandatory = $true)] [string] $HmacSha256
    )
    if ($InitializationVector.Length -ne 16 -or $Ciphertext.Length -lt 16 -or ($Ciphertext.Length % 16) -ne 0) {
        throw 'Windows Job encrypted recovery payload has invalid ciphertext dimensions.'
    }
    $expected = Get-RecoveryCiphertextHmac -Purpose $Purpose -InitializationVector $InitializationVector -Ciphertext $Ciphertext
    if (-not (Test-FixedHexEquals -Left $HmacSha256 -Right $expected)) {
        throw 'Windows Job encrypted recovery payload authentication failed.'
    }
    $aes = [Security.Cryptography.Aes]::Create()
    try {
        $aes.KeySize = 256
        $aes.Mode = [Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
        $aes.Key = Get-RecoveryPurposeKey -Purpose "encryption/$Purpose"
        $aes.IV = $InitializationVector
        $decryptor = $aes.CreateDecryptor()
        try {
            [byte[]] $plaintext = $decryptor.TransformFinalBlock($Ciphertext, 0, $Ciphertext.Length)
            return ,$plaintext
        }
        finally { $decryptor.Dispose() }
    }
    finally { $aes.Dispose() }
}

function Read-EncryptedRecoveryPayloadJson {
    param(
        [Parameter(Mandatory = $true)] [string] $EnvelopeJson,
        [Parameter(Mandatory = $true)] [string] $Purpose
    )
    $envelope = $EnvelopeJson | ConvertFrom-Json
    if ($envelope.schemaVersion -ne 1 `
        -or [string] $envelope.authenticationScheme -ne 'hkdf-sha256+hmac-sha256' `
        -or [string] $envelope.encryptionScheme -ne 'aes-256-cbc+hmac-sha256' `
        -or [string] $envelope.purpose -ne $Purpose) {
        throw 'Windows Job encrypted recovery envelope metadata is invalid.'
    }
    $initializationVector = [Convert]::FromBase64String([string] $envelope.ivBase64)
    $ciphertext = [Convert]::FromBase64String([string] $envelope.ciphertextBase64)
    if ([Convert]::ToBase64String($initializationVector) -ne [string] $envelope.ivBase64 `
        -or [Convert]::ToBase64String($ciphertext) -ne [string] $envelope.ciphertextBase64) {
        throw 'Windows Job encrypted recovery envelope encoding is invalid.'
    }
    $payloadBytes = ConvertFrom-RecoveryCiphertext `
        -Purpose $Purpose `
        -InitializationVector $initializationVector `
        -Ciphertext $ciphertext `
        -HmacSha256 ([string] $envelope.hmacSha256)
    return [Text.UTF8Encoding]::new($false, $true).GetString($payloadBytes)
}

function Read-EncryptedRecoveryFileBytes {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [string] $Purpose
    )
    $persisted = [IO.File]::ReadAllBytes($Path)
    $magic = [Text.Encoding]::ASCII.GetBytes('AGOSENC1')
    if ($persisted.Length -lt ($magic.Length + 16 + 16 + 32)) {
        throw 'Windows Job encrypted recovery file is truncated.'
    }
    for ($index = 0; $index -lt $magic.Length; $index += 1) {
        if ($persisted[$index] -ne $magic[$index]) { throw 'Windows Job encrypted recovery file magic is invalid.' }
    }
    $initializationVector = [byte[]]::new(16)
    [Array]::Copy($persisted, $magic.Length, $initializationVector, 0, 16)
    $ciphertextLength = $persisted.Length - $magic.Length - 16 - 32
    $ciphertext = [byte[]]::new($ciphertextLength)
    [Array]::Copy($persisted, $magic.Length + 16, $ciphertext, 0, $ciphertextLength)
    $tag = [byte[]]::new(32)
    [Array]::Copy($persisted, $persisted.Length - 32, $tag, 0, 32)
    [byte[]] $plaintext = ConvertFrom-RecoveryCiphertext `
        -Purpose $Purpose `
        -InitializationVector $initializationVector `
        -Ciphertext $ciphertext `
        -HmacSha256 (($tag | ForEach-Object { $_.ToString('x2') }) -join '')
    return ,$plaintext
}

function ConvertTo-SignedRecoveryEnvelopeJson {
    param(
        [Parameter(Mandatory = $true)] [string] $Purpose,
        [Parameter(Mandatory = $true)] [string] $PayloadJson
    )
    $payloadBytes = [Text.Encoding]::UTF8.GetBytes($PayloadJson)
    $envelope = [ordered]@{
        schemaVersion = 1
        authenticationScheme = 'hkdf-sha256+hmac-sha256'
        purpose = $Purpose
        payloadBase64 = [Convert]::ToBase64String($payloadBytes)
        hmacSha256 = Get-RecoveryHmac -Purpose $Purpose -Payload $payloadBytes
    }
    return ($envelope | ConvertTo-Json -Compress)
}

function Write-SpawnClaim {
    if ($null -eq $script:recoveryAuthenticationKey) { return }
    $claimPayload = [ordered]@{
        schemaVersion = 1
        kind = 'helper'
        runId = [string] $script:specification.runId
        jobId = [string] $script:specification.jobId
        launchAuthorizationId = [string] $script:specification.launchAuthorizationId
        launchGeneration = [int] $script:specification.launchGeneration
        launchAttempt = [int] $script:specification.launchAttempt
        journalGeneration = [string] $script:specification.journalGeneration
        descriptorHmacSha256 = [string] $script:specification.descriptorHmacSha256
        helperProcessId = $PID
        helperProcessStartedAtFileTime = $script:helperProcessStartedAtFileTime
        createdAt = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    }
    $claimJson = ConvertTo-SignedRecoveryEnvelopeJson `
        -Purpose 'spawn-claim' `
        -PayloadJson ($claimPayload | ConvertTo-Json -Compress)
    $claimBytes = [Text.UTF8Encoding]::new($false).GetBytes($claimJson)
    $claimTemporaryPath = [IO.Path]::Combine(
        [IO.Path]::GetDirectoryName([string] $script:specification.claimPath),
        ".spawn-claim.$([Guid]::NewGuid().ToString('D')).tmp"
    )
    $claimStream = [IO.FileStream]::new(
        $claimTemporaryPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None,
        4096,
        [IO.FileOptions]::WriteThrough
    )
    try {
        $claimStream.Write($claimBytes, 0, $claimBytes.Length)
        $claimStream.Flush($true)
    }
    finally { $claimStream.Dispose() }
    try {
        [AgentOsWindowsJobSession]::PublishHardLinkExclusive(
            [string] $script:specification.claimPath,
            $claimTemporaryPath
        )
        $script:claimAcquired = $true
    }
    finally {
        try { [IO.File]::Delete($claimTemporaryPath) } catch { }
    }
}

function Read-SignedRecoveryPayloadJson {
    param(
        [Parameter(Mandatory = $true)] [string] $EnvelopeJson,
        [Parameter(Mandatory = $true)] [string] $Purpose
    )
    $envelope = $EnvelopeJson | ConvertFrom-Json
    if ($envelope.schemaVersion -ne 1 `
        -or [string] $envelope.authenticationScheme -ne 'hkdf-sha256+hmac-sha256' `
        -or [string] $envelope.purpose -ne $Purpose) {
        throw 'Windows Job recovery envelope metadata is invalid.'
    }
    $payloadBytes = [Convert]::FromBase64String([string] $envelope.payloadBase64)
    if ([Convert]::ToBase64String($payloadBytes) -ne [string] $envelope.payloadBase64) {
        throw 'Windows Job recovery envelope encoding is invalid.'
    }
    $expected = Get-RecoveryHmac -Purpose $Purpose -Payload $payloadBytes
    if (-not (Test-FixedHexEquals -Left ([string] $envelope.hmacSha256) -Right $expected)) {
        throw 'Windows Job recovery envelope authentication failed.'
    }
    return [Text.Encoding]::UTF8.GetString($payloadBytes)
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)] [AllowEmptyCollection()] [byte[]] $Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $sha.Dispose() }
}

function Get-FileSha256Hex {
    param([Parameter(Mandatory = $true)] [string] $Path)
    if (-not [IO.File]::Exists($Path)) {
        return Get-Sha256Hex -Bytes ([byte[]]::new(0))
    }
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Get-EncryptedArtifactEvidence {
    param([Parameter(Mandatory = $true)] [string] $Path)
    if (-not [IO.File]::Exists($Path)) {
        return [ordered]@{
            bytes = 0
            digestSha256 = Get-Sha256Hex -Bytes ([byte[]]::new(0))
        }
    }
    $information = [IO.FileInfo]::new($Path)
    if (($information.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Windows Job encrypted output artifact cannot be reparse-backed.'
    }
    return [ordered]@{
        bytes = [long] $information.Length
        digestSha256 = Get-FileSha256Hex -Path $Path
    }
}

function Get-NativeTerminalDigest {
    param([Parameter(Mandatory = $true)] [Collections.IDictionary] $Payload)
    # Keys are deliberately lexicographic. TypeScript verifies the same flat
    # canonical JSON before accepting this helper-authenticated terminal fact.
    $facts = [ordered]@{
        assignmentVerified = [bool] $Payload.assignmentVerified
        cleanup = [string] $Payload.cleanup
        encryptedStderrBytes = [long] $Payload.encryptedStderrBytes
        encryptedStderrDigestSha256 = [string] $Payload.encryptedStderrDigestSha256
        encryptedStdoutBytes = [long] $Payload.encryptedStdoutBytes
        encryptedStdoutDigestSha256 = [string] $Payload.encryptedStdoutDigestSha256
        exitCode = $Payload.exitCode
        helperProcessId = $Payload.helperProcessId
        helperProcessStartedAtFileTime = $Payload.helperProcessStartedAtFileTime
        jobId = [string] $Payload.jobId
        jobName = $Payload.jobName
        journalGeneration = [string] $Payload.journalGeneration
        rootProcessId = $Payload.rootProcessId
        rootProcessStartedAtFileTime = $Payload.rootProcessStartedAtFileTime
        runId = [string] $Payload.runId
        state = [string] $Payload.status
        terminationDeadlineAt = $Payload.terminationDeadlineAt
        terminationRequestedAt = $Payload.terminationRequestedAt
        terminationVerified = [bool] $Payload.terminationVerified
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($facts | ConvertTo-Json -Compress))
    return Get-Sha256Hex -Bytes $bytes
}

function Write-ControlStatus {
    param(
        [Parameter(Mandatory = $true)] [string] $Status,
        [Parameter(Mandatory = $true)] [string] $Cleanup,
        [Parameter(Mandatory = $true)] [bool] $TerminationVerified,
        [AllowNull()] [Nullable[int]] $ExitCode,
        [AllowNull()] [string] $Reason
    )
    if ($Status -eq 'stopping' -and $null -eq $script:terminationRequestedAt) {
        $requestedAt = [DateTime]::UtcNow
        $script:terminationRequestedAt = $requestedAt.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        $script:terminationDeadlineAt = $requestedAt.AddMilliseconds(60000).ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    }
    $previousSequence = $script:sequence
    $script:sequence += 1
    $payload = [ordered]@{
        schemaVersion = 2
        sequence = $script:sequence
        previousSequence = $previousSequence
        previousSnapshotDigestSha256 = $script:previousSnapshotDigestSha256
        previousJournalDigestSha256 = $script:previousJournalDigestSha256
        journalGeneration = [string] $script:specification.journalGeneration
        runId = [string] $script:specification.runId
        jobId = [string] $script:specification.jobId
        status = $Status
        jobName = if ($null -ne $script:session) { [string] $script:session.JobName } else { $null }
        helperProcessId = $PID
        helperProcessStartedAtFileTime = $script:helperProcessStartedAtFileTime
        rootProcessId = if ($null -ne $script:session) { [int] $script:session.RootProcessId } else { $null }
        rootProcessStartedAtFileTime = if ($null -ne $script:session) { [string] $script:session.RootProcessStartedAtFileTime } else { $null }
        assignmentVerified = if ($null -ne $script:session) { [bool] $script:session.AssignmentVerified } else { $false }
        exitCode = $ExitCode
        cleanup = $Cleanup
        terminationVerified = $TerminationVerified
        reason = $Reason
        terminationRequestedAt = $script:terminationRequestedAt
        terminationDeadlineAt = $script:terminationDeadlineAt
        encryptedStdoutBytes = $null
        encryptedStdoutDigestSha256 = $null
        encryptedStderrBytes = $null
        encryptedStderrDigestSha256 = $null
        nativeTerminalDigestSha256 = $null
    }
    $terminal = $TerminationVerified -and $Cleanup -ne 'pending' -and @('exited', 'cancelled', 'blocked') -contains $Status
    if ($terminal) {
        $stdout = Get-EncryptedArtifactEvidence -Path ([string] $script:specification.outputPath)
        $stderr = Get-EncryptedArtifactEvidence -Path ([string] $script:specification.errorPath)
        $payload.encryptedStdoutBytes = [long] $stdout.bytes
        $payload.encryptedStdoutDigestSha256 = [string] $stdout.digestSha256
        $payload.encryptedStderrBytes = [long] $stderr.bytes
        $payload.encryptedStderrDigestSha256 = [string] $stderr.digestSha256
        $payload.nativeTerminalDigestSha256 = Get-NativeTerminalDigest -Payload $payload
    }
    if ($null -eq $script:recoveryAuthenticationKey) {
        $payload['token'] = [string] $script:specification.token
    }
    $statusPath = [string] $script:specification.statusPath
    $temporaryPath = "$statusPath.$PID.$($script:sequence).tmp"
    $payloadJson = $payload | ConvertTo-Json -Compress
    $json = if ($null -ne $script:recoveryAuthenticationKey) {
        ConvertTo-SignedRecoveryEnvelopeJson -Purpose 'status' -PayloadJson $payloadJson
    } else { $payloadJson }
    $journalCommitLock = $null
    $journalDesiredPath = $null
    $journalExpectedPath = $null
    $backupPath = $null
    if ($null -ne $script:recoveryAuthenticationKey) {
        $journalPath = [string] $script:specification.statusJournalPath
        $journalCommitLock = Open-JournalCommitLock -LockPath "$journalPath.lock" -TimeoutMs 5000
    }
    try {
        if ($null -ne $script:recoveryAuthenticationKey) {
            [byte[]] $currentJournalBytes = [byte[]]::new(0)
            if ([IO.File]::Exists($journalPath)) {
                $currentJournalBytes = [IO.File]::ReadAllBytes($journalPath)
            }
            $currentJournalDigestSha256 = if ($currentJournalBytes.Length -eq 0) {
                '0' * 64
            } else {
                Get-Sha256Hex -Bytes $currentJournalBytes
            }
            if (-not (Test-FixedHexEquals -Left $currentJournalDigestSha256 -Right $script:previousJournalDigestSha256)) {
                throw 'Windows Job journal advanced outside the helper commit lock.'
            }
            [byte[]] $journalEntryBytes = [Text.UTF8Encoding]::new($false).GetBytes("$json`n")
            [byte[]] $desiredJournalBytes = $currentJournalBytes + $journalEntryBytes
            $journalCommitId = [Guid]::NewGuid().ToString('D')
            $journalDesiredPath = [IO.Path]::Combine(
                [IO.Path]::GetDirectoryName($journalPath),
                ".controller-terminal-journal.$journalCommitId.tmp"
            )
            $journalExpectedPath = [IO.Path]::Combine(
                [IO.Path]::GetDirectoryName($journalPath),
                ".controller-terminal-journal.$journalCommitId.expected.tmp"
            )
            Write-DurableBytes -Path $journalDesiredPath -Bytes $desiredJournalBytes
            Write-DurableBytes -Path $journalExpectedPath -Bytes $currentJournalBytes
            $commitResult = Invoke-JournalCommitLocked `
                -TargetPath $journalPath `
                -DesiredPath $journalDesiredPath `
                -ExpectedPath $journalExpectedPath `
                -DesiredBytes $desiredJournalBytes `
                -ExpectedBytes $currentJournalBytes
            if ($commitResult -ne 0) {
                throw 'Windows Job journal changed during helper durable commit.'
            }
            $script:previousJournalDigestSha256 = Get-FileSha256Hex -Path $journalPath
        }
        [byte[]] $snapshotBytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
        Write-DurableBytes -Path $temporaryPath -Bytes $snapshotBytes
        if ([IO.File]::Exists($statusPath)) {
            $backupPath = "$statusPath.$PID.bak"
            [IO.File]::Replace($temporaryPath, $statusPath, $backupPath, $true)
        }
        else {
            [IO.File]::Move($temporaryPath, $statusPath)
        }
        $durableSnapshot = [IO.FileStream]::new(
            $statusPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::Read
        )
        try { $durableSnapshot.Flush($true) }
        finally { $durableSnapshot.Dispose() }
        if ($null -ne $backupPath) { [IO.File]::Delete($backupPath) }
        $script:previousSnapshotDigestSha256 = Get-Sha256Hex -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($payloadJson))
        if ($null -eq $script:recoveryAuthenticationKey) {
            $script:previousJournalDigestSha256 = $script:previousSnapshotDigestSha256
        }
    }
    finally {
        if ($null -ne $journalDesiredPath) { [IO.File]::Delete($journalDesiredPath) }
        if ($null -ne $journalExpectedPath) { [IO.File]::Delete($journalExpectedPath) }
        if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
        if ($null -ne $backupPath -and [IO.File]::Exists($backupPath)) { [IO.File]::Delete($backupPath) }
        if ($null -ne $journalCommitLock) { $journalCommitLock.Dispose() }
    }
}

function Assert-ControlSpecification {
    param([Parameter(Mandatory = $true)] [object] $Value)
    if ($Value.schemaVersion -ne 1) { throw 'Windows Job protocol version is invalid.' }
    $requiredNames = @('runId', 'jobId', 'journalGeneration', 'executable', 'cwd', 'statusPath', 'cancelPath', 'inputPath', 'outputPath', 'errorPath', 'parentProcessStartedAtFileTime')
    if ($null -eq $script:recoveryAuthenticationKey) { $requiredNames += 'token' }
    else { $requiredNames += @('launchAuthorizationId', 'descriptorHmacSha256') }
    foreach ($name in $requiredNames) {
        if ([string]::IsNullOrWhiteSpace([string] $Value.$name)) { throw "Windows Job $name is required." }
    }
    if ([string] $Value.runId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'Windows Job runId is invalid.' }
    if ([string] $Value.jobId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'Windows Job jobId is invalid.' }
    if ([string] $Value.journalGeneration -notmatch '^[A-Za-z0-9_-]{22,128}$') { throw 'Windows Job journal generation is invalid.' }
    if ([Convert]::ToInt32($Value.parentPid) -le 0) { throw 'Windows Job parentPid is invalid.' }
    if ([string] $Value.parentProcessStartedAtFileTime -notmatch '^\d+$') { throw 'Windows Job parent process creation time is invalid.' }
    if ([Convert]::ToInt32($Value.descendantGraceMs) -le 0) { throw 'Windows Job descendantGraceMs is invalid.' }
    if ($null -eq $Value.limits) { throw 'Windows Job resource limits are required.' }
    if ([Convert]::ToUInt32($Value.limits.activeProcessLimit) -le 0) { throw 'Windows Job activeProcessLimit is invalid.' }
    if ([Convert]::ToUInt64($Value.limits.jobMemoryLimitBytes) -le 0) { throw 'Windows Job jobMemoryLimitBytes is invalid.' }
    if ([Convert]::ToInt64($Value.limits.cpuTimeLimitMs) -le 0) { throw 'Windows Job cpuTimeLimitMs is invalid.' }
    if ([Convert]::ToInt64($Value.limits.outputLimitBytes) -lt 0) { throw 'Windows Job outputLimitBytes is invalid.' }
    if ($null -eq $Value.expectedWorkingDirectory) { throw 'Windows Job expected working-directory identity is required.' }
    $canonicalCwd = [IO.Path]::GetFullPath([string] $Value.cwd)
    $canonicalExpectedCwd = [IO.Path]::GetFullPath([string] $Value.expectedWorkingDirectory.absolutePath)
    if (-not [IO.Path]::IsPathRooted($canonicalCwd) `
        -or $canonicalCwd.StartsWith('\\') `
        -or -not [string]::Equals($canonicalCwd, $canonicalExpectedCwd, [StringComparison]::OrdinalIgnoreCase) `
        -or [Convert]::ToUInt64($Value.expectedWorkingDirectory.device) -gt [UInt32]::MaxValue `
        -or [Convert]::ToUInt64($Value.expectedWorkingDirectory.inode) -lt 0) {
        throw 'Windows Job expected working-directory identity is invalid.'
    }
    $expectedExecutableFiles = @($Value.expectedExecutableFiles)
    if ($expectedExecutableFiles.Count -eq 0) { throw 'Windows Job expected executable identity is required.' }
    $launchIdentityPresent = $false
    foreach ($file in $expectedExecutableFiles) {
        if ([string]::IsNullOrWhiteSpace([string] $file.absolutePath) `
            -or [string] $file.sha256 -notmatch '^[a-fA-F0-9]{64}$' `
            -or [Convert]::ToInt64($file.sizeBytes) -lt 0) {
            throw 'Windows Job expected executable identity is invalid.'
        }
        $expectedPath = [IO.Path]::GetFullPath([string] $file.absolutePath)
        if (-not [IO.Path]::IsPathRooted($expectedPath) -or $expectedPath.StartsWith('\\')) {
            throw 'Windows Job expected executable path must be local and absolute.'
        }
        if ([string]::Equals($expectedPath, [IO.Path]::GetFullPath([string] $Value.executable), [StringComparison]::OrdinalIgnoreCase)) {
            $launchIdentityPresent = $true
        }
    }
    if (-not $launchIdentityPresent) { throw 'Windows Job launch executable is absent from expected identity.' }
    $controlRoot = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName([string] $Value.statusPath))
    $controlPaths = @([string] $Value.statusPath, [string] $Value.cancelPath, [string] $Value.inputPath, [string] $Value.outputPath, [string] $Value.errorPath)
    if ([Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_HELPER') -eq '1') {
        if ([string]::IsNullOrWhiteSpace($SpecificationPath) `
            -or [string]::IsNullOrWhiteSpace([string] $Value.specificationPath) `
            -or [string]::IsNullOrWhiteSpace([string] $Value.statusJournalPath) `
            -or [string]::IsNullOrWhiteSpace([string] $Value.claimPath)) {
            throw 'Windows Job recovery specification path is required.'
        }
        if ($Value.encryptedControlFiles -ne $true) { throw 'Windows Job recovery control files must be encrypted.' }
        if ([string] $Value.launchAuthorizationId -notmatch '^[A-Za-z0-9_.-]{16,128}$' `
            -or [Convert]::ToInt32($Value.launchGeneration) -le 0 `
            -or [Convert]::ToInt32($Value.launchAttempt) -le 0 `
            -or [string] $Value.descriptorHmacSha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Windows Job recovery launch authorization binding is invalid.'
        }
        $canonicalSpecificationPath = [IO.Path]::GetFullPath($SpecificationPath)
        if (-not [IO.Path]::IsPathRooted($canonicalSpecificationPath) -or $canonicalSpecificationPath.StartsWith('\\')) {
            throw 'Windows Job recovery specification path must be local and absolute.'
        }
        if (-not [string]::Equals($canonicalSpecificationPath, [IO.Path]::GetFullPath([string] $Value.specificationPath), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Windows Job recovery specification locator does not match its authenticated payload.'
        }
        if ([IO.Path]::GetFileName($canonicalSpecificationPath) -ne 'launch-specification.json') {
            throw 'Windows Job recovery specification locator is invalid.'
        }
        if ($null -ne $Value.PSObject.Properties['token']) {
            throw 'Windows Job recovery specification must not persist a bearer token.'
        }
        $controlPaths += @($canonicalSpecificationPath, [string] $Value.statusJournalPath, [string] $Value.claimPath)
    }
    elseif (-not [string]::IsNullOrWhiteSpace($SpecificationPath)) {
        throw 'Windows Job specification file is valid only for a recovery helper.'
    }
    foreach ($controlPath in $controlPaths) {
        $canonicalControlPath = [IO.Path]::GetFullPath($controlPath)
        if (-not [IO.Path]::IsPathRooted($canonicalControlPath) `
            -or $canonicalControlPath.StartsWith('\\') `
            -or -not [string]::Equals([IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($canonicalControlPath)), $controlRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Windows Job control paths must share one directory.'
        }
    }
    $expectedFileNames = @{
        statusPath = 'status.json'
        cancelPath = 'cancel.json'
        inputPath = 'stdin.txt'
        outputPath = 'stdout.bin'
        errorPath = 'stderr.bin'
    }
    if ($null -ne $script:recoveryAuthenticationKey) {
        $expectedFileNames['statusJournalPath'] = 'status.journal.jsonl'
        $expectedFileNames['claimPath'] = 'spawn.claim.json'
    }
    foreach ($entry in $expectedFileNames.GetEnumerator()) {
        $property = $Value.PSObject.Properties[[string] $entry.Key]
        if ($null -eq $property -or [IO.Path]::GetFileName([string] $property.Value) -ne $entry.Value) {
            throw "Windows Job $($entry.Key) locator is invalid."
        }
    }
}

function Read-CancellationRequest {
    if (-not [IO.File]::Exists([string] $script:specification.cancelPath)) { return $null }
    try {
        $requestJson = [IO.File]::ReadAllText([string] $script:specification.cancelPath, [Text.Encoding]::UTF8)
        if ($null -ne $script:recoveryAuthenticationKey) {
            $requestJson = Read-SignedRecoveryPayloadJson -EnvelopeJson $requestJson -Purpose 'cancel'
        }
        $request = $requestJson | ConvertFrom-Json
        $matches = $request.schemaVersion -eq 1 `
            -and [string] $request.runId -eq [string] $script:specification.runId `
            -and [string] $request.jobId -eq [string] $script:specification.jobId
        if ($matches -and $null -eq $script:recoveryAuthenticationKey) {
            $matches = [string] $request.token -eq [string] $script:specification.token
        }
        elseif ($matches -and $null -ne $request.PSObject.Properties['token']) {
            $matches = $false
        }
        if ($matches -and $null -ne $script:session) {
            $hasRootProcessId = $null -ne $request.PSObject.Properties['rootProcessId']
            $hasRootStartedAt = $null -ne $request.PSObject.Properties['rootProcessStartedAtFileTime']
            if ($hasRootProcessId -or $hasRootStartedAt) {
                $matches = $hasRootProcessId `
                    -and $hasRootStartedAt `
                    -and [Convert]::ToInt32($request.rootProcessId) -eq [int] $script:session.RootProcessId `
                    -and [string] $request.rootProcessStartedAtFileTime -eq [string] $script:session.RootProcessStartedAtFileTime
            }
        }
        if (-not $matches) { throw 'Cancellation identity does not match the assigned Windows Job process.' }
        return [PSCustomObject]@{ Valid = $true; Reason = $null }
    }
    catch {
        return [PSCustomObject]@{ Valid = $false; Reason = $_.Exception.Message }
    }
}

try {
    if ([Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_HELPER') -eq '1') {
        if ([string]::IsNullOrWhiteSpace($SpecificationPath)) { throw 'Windows Job recovery specification path is required.' }
        $rawEnvelope = [IO.File]::ReadAllText([IO.Path]::GetFullPath($SpecificationPath), [Text.Encoding]::UTF8)
        $rawSpecification = Read-EncryptedRecoveryPayloadJson -EnvelopeJson $rawEnvelope -Purpose 'launch-specification'
    }
    else {
        $rawSpecification = [Console]::In.ReadToEnd()
    }
    $specification = $rawSpecification | ConvertFrom-Json
    Assert-ControlSpecification -Value $specification
    $null = Add-Type -TypeDefinition $nativeSource -Language CSharp
    Write-SpawnClaim
    if ($null -ne $script:recoveryAuthenticationKey) {
        [byte[]] $inputBytes = Read-EncryptedRecoveryFileBytes -Path ([string] $specification.inputPath) -Purpose 'stdin'
        [IO.File]::Delete([string] $specification.inputPath)
    }
    else {
        [byte[]] $inputBytes = [IO.File]::ReadAllBytes([string] $specification.inputPath)
        [IO.File]::Delete([string] $specification.inputPath)
    }
    $preSpawnCancellation = Read-CancellationRequest
    if ($null -ne $preSpawnCancellation) {
        $preSpawnReason = if ($preSpawnCancellation.Valid) { 'Spawn cancelled before process creation.' } else { [string] $preSpawnCancellation.Reason }
        Write-ControlStatus -Status 'blocked' -Cleanup 'no_process_created' -TerminationVerified $true -ExitCode $null -Reason $preSpawnReason
        exit 0
    }
    $environment = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($property in $specification.environment.PSObject.Properties) {
        $environment[[string] $property.Name] = [string] $property.Value
    }
    [string[]] $arguments = @($specification.args | ForEach-Object { [string] $_ })
    [string[]] $expectedExecutablePaths = @($specification.expectedExecutableFiles | ForEach-Object { [string] $_.absolutePath })
    [string[]] $expectedExecutableSha256 = @($specification.expectedExecutableFiles | ForEach-Object { [string] $_.sha256 })
    [long[]] $expectedExecutableSizeBytes = @($specification.expectedExecutableFiles | ForEach-Object { [Convert]::ToInt64($_.sizeBytes) })
    $preSpawnCancellation = Read-CancellationRequest
    if ($null -ne $preSpawnCancellation) {
        $preSpawnReason = if ($preSpawnCancellation.Valid) { 'Spawn cancelled before process creation.' } else { [string] $preSpawnCancellation.Reason }
        Write-ControlStatus -Status 'blocked' -Cleanup 'no_process_created' -TerminationVerified $true -ExitCode $null -Reason $preSpawnReason
        exit 0
    }
    Write-ControlStatus -Status 'starting' -Cleanup 'pending' -TerminationVerified $false -ExitCode $null -Reason $null
    $nativeStartAttempted = $true
    $session = [AgentOsWindowsJobSession]::Start(
        [string] $specification.executable,
        $arguments,
        [string] $specification.cwd,
        [Convert]::ToUInt32($specification.expectedWorkingDirectory.device),
        [Convert]::ToUInt64($specification.expectedWorkingDirectory.inode),
        $environment,
        $inputBytes,
        [string] $specification.outputPath,
        [string] $specification.errorPath,
        [string] $specification.jobId,
        [Convert]::ToInt32($specification.parentPid),
        [string] $specification.parentProcessStartedAtFileTime,
        $expectedExecutablePaths,
        $expectedExecutableSha256,
        $expectedExecutableSizeBytes,
        [Convert]::ToUInt32($specification.limits.activeProcessLimit),
        [Convert]::ToUInt64($specification.limits.jobMemoryLimitBytes),
        [Convert]::ToInt64($specification.limits.cpuTimeLimitMs),
        [Convert]::ToInt64($specification.limits.outputLimitBytes),
        [byte[]] $script:recoveryAuthenticationKey
    )

    Write-ControlStatus -Status 'ready' -Cleanup 'pending' -TerminationVerified $false -ExitCode $null -Reason $null
    $rootExitedAt = $null
    $rootExitCode = $null
    $terminalStatus = $null
    $terminalReason = $null
    $terminationRequested = $false

    while ($true) {
        if (-not $terminationRequested) {
            $cancellation = $null
            if ($session.OutputLimitExceeded()) {
                $terminalStatus = 'blocked'
                $terminalReason = 'Provider output exceeded the configured byte limit.'
                $session.RequestTermination()
                $terminationRequested = $true
                Write-ControlStatus -Status 'stopping' -Cleanup 'pending' -TerminationVerified $false -ExitCode $null -Reason $terminalReason
            }
            elseif (-not [string]::IsNullOrWhiteSpace($session.OutputFailure())) {
                $terminalStatus = 'blocked'
                $terminalReason = [string] $session.OutputFailure()
                $session.RequestTermination()
                $terminationRequested = $true
                Write-ControlStatus -Status 'stopping' -Cleanup 'pending' -TerminationVerified $false -ExitCode $null -Reason $terminalReason
            }
            else {
                $cancellation = Read-CancellationRequest
            }
            if (-not $terminationRequested -and $null -ne $cancellation) {
                $terminalStatus = if ($cancellation.Valid) { 'cancelled' } else { 'blocked' }
                $terminalReason = if ($cancellation.Valid) { $null } else { [string] $cancellation.Reason }
                $session.RequestTermination()
                $terminationRequested = $true
                Write-ControlStatus -Status 'stopping' -Cleanup 'pending' -TerminationVerified $false -ExitCode $null -Reason $terminalReason
            }
            elseif (-not $terminationRequested -and $session.ParentExited()) {
                $terminalStatus = 'blocked'
                $terminalReason = 'Control-plane parent exited before Windows Job completion.'
                $session.RequestTermination()
                $terminationRequested = $true
                Write-ControlStatus -Status 'stopping' -Cleanup 'pending' -TerminationVerified $false -ExitCode $null -Reason $terminalReason
            }
            elseif (-not $terminationRequested -and $session.RootExited()) {
                if ($null -eq $rootExitedAt) {
                    $rootExitedAt = [Diagnostics.Stopwatch]::GetTimestamp()
                    $rootExitCode = $session.RootExitCode()
                }
                if ($session.ActiveProcesses() -eq 0) {
                    $session.WaitForOutput()
                    if ($session.OutputLimitExceeded()) {
                        Write-ControlStatus -Status 'blocked' -Cleanup 'active_process_zero' -TerminationVerified $true -ExitCode $null -Reason 'Provider output exceeded the configured byte limit.'
                    }
                    elseif (-not [string]::IsNullOrWhiteSpace($session.OutputFailure())) {
                        Write-ControlStatus -Status 'blocked' -Cleanup 'active_process_zero' -TerminationVerified $true -ExitCode $null -Reason ([string] $session.OutputFailure())
                    }
                    else {
                        Write-ControlStatus -Status 'exited' -Cleanup 'active_process_zero' -TerminationVerified $true -ExitCode $rootExitCode -Reason $null
                    }
                    break
                }
                $elapsedMs = ([Diagnostics.Stopwatch]::GetTimestamp() - [long] $rootExitedAt) * 1000 / [Diagnostics.Stopwatch]::Frequency
                if ($elapsedMs -ge [Convert]::ToInt32($specification.descendantGraceMs)) {
                    $terminalStatus = 'blocked'
                    $terminalReason = 'Descendant processes remained after root process exit and were terminated.'
                    $session.RequestTermination()
                    $terminationRequested = $true
                    Write-ControlStatus -Status 'stopping' -Cleanup 'pending' -TerminationVerified $false -ExitCode $null -Reason $terminalReason
                }
            }
        }

        if ($terminationRequested -and $session.ActiveProcesses() -eq 0) {
            $session.WaitForOutput()
            if ($session.OutputLimitExceeded()) {
                $terminalStatus = 'blocked'
                $terminalReason = 'Provider output exceeded the configured byte limit.'
            }
            elseif (-not [string]::IsNullOrWhiteSpace($session.OutputFailure())) {
                $terminalStatus = 'blocked'
                $terminalReason = [string] $session.OutputFailure()
            }
            Write-ControlStatus -Status $terminalStatus -Cleanup 'active_process_zero' -TerminationVerified $true -ExitCode $null -Reason $terminalReason
            break
        }
        Start-Sleep -Milliseconds 25
    }
    exit 0
}
catch {
    $reason = $_.Exception.Message
    if ($null -ne $script:recoveryAuthenticationKey -and $null -ne $specification -and -not $claimAcquired -and [IO.File]::Exists([string] $specification.claimPath)) {
        exit 3
    }
    if ([Environment]::GetEnvironmentVariable('AGENT_OS_RECOVERY_HELPER') -ne '1') {
        try { [Console]::Error.WriteLine("AGENT_OS_WINDOWS_JOB_HELPER_ERROR: $reason") } catch { }
    }
    if ($null -ne $session) {
        try {
            $session.RequestTermination()
            Write-ControlStatus -Status 'stopping' -Cleanup 'pending' -TerminationVerified $false -ExitCode $null -Reason $reason
            while ($session.ActiveProcesses() -ne 0) { Start-Sleep -Milliseconds 1000 }
            $session.WaitForOutput()
            Write-ControlStatus -Status 'blocked' -Cleanup 'active_process_zero' -TerminationVerified $true -ExitCode $null -Reason $reason
        }
        catch {
            Write-ControlStatus -Status 'blocked' -Cleanup 'pending' -TerminationVerified $false -ExitCode $null -Reason $reason
            while ($true) { Start-Sleep -Seconds 1 }
        }
    }
    elseif ($null -ne $specification) {
        $cleanup = if ($nativeStartAttempted) { 'active_process_zero' } else { 'no_process_created' }
        try { Write-ControlStatus -Status 'blocked' -Cleanup $cleanup -TerminationVerified $true -ExitCode $null -Reason $reason } catch { }
    }
    exit 2
}
finally {
    if ($null -ne $session) {
        try { $session.Dispose() } catch { while ($true) { Start-Sleep -Seconds 1 } }
    }
}
