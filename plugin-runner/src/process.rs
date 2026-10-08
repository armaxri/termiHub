//! Windows: start a runner inside a kill-on-close job object, inheriting
//! exactly the handles it needs (#4201).
//!
//! `std::process::Command` cannot be used: on Windows it calls `CreateProcessW`
//! with `bInheritHandles = TRUE` and no handle list, so the child inherits
//! *every* inheritable handle the host holds. [`RunnerCommand::spawn`] instead
//! hand-writes the call with a `STARTUPINFOEXW` whose
//! `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` names only the runner's channel end and
//! its three standard handles. The channel's handle value is passed on the
//! command line as `--ipc-handle <value>` ([`IPC_HANDLE_ARG`]) — an inherited
//! handle keeps its value in the child — never as a name or a path.
//!
//! The process starts suspended, is assigned to a fresh job object, and only
//! then resumed, so not one instruction of it runs outside the job:
//!
//! * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — the job handle lives in
//!   [`JobChild`]; when the host process exits (cleanly or not) the system
//!   closes it and kills the runner, and so does dropping the [`JobChild`].
//! * `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION` — a crashing plugin ends
//!   the runner at once instead of waiting on the error-reporting dialog.
//! * The [`ResourceLimits`] (#4184): `address_space_bytes` becomes the job's
//!   per-process committed-memory limit (allocations past it fail, which a
//!   Rust plugin reports as `memory allocation of N bytes failed`);
//!   `forbid_child_processes` becomes an active-process limit of 1 (the
//!   runner itself). Windows has no per-process open-handle cap, so
//!   `max_open_files` does not apply here.
//!
//! [`ResourceLimits`]: crate::ipc::ResourceLimits

use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io::{self, Read};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;

use windows_sys::Win32::Foundation::{
    DuplicateHandle, SetHandleInformation, DUPLICATE_SAME_ACCESS, ERROR_BROKEN_PIPE, GENERIC_READ,
    GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, TRUE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use crate::ipc::pipe::handle_value;
use crate::ipc::{ResourceLimits, IPC_HANDLE_ARG};
use crate::win::{is_os_error, owned, to_wide};

/// The exit code a killed runner reports (what `std`'s `Child::kill` uses).
pub const KILLED_EXIT_CODE: u32 = 1;

/// Where one of the runner's standard handles goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildStdio {
    /// The `NUL` device.
    Null,
    /// The host's own standard handle (`NUL` when the host has none, e.g. a
    /// GUI process).
    Inherit,
    /// A new anonymous pipe; the host reads it through [`JobChild::stderr`].
    /// Only meaningful for stderr.
    Piped,
}

/// A runner process to start (see the module docs).
#[derive(Debug, Clone)]
pub struct RunnerCommand {
    program: PathBuf,
    args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
    stdout: ChildStdio,
    stderr: ChildStdio,
    limits: ResourceLimits,
}

impl RunnerCommand {
    /// Start `program` (a full path; no search) with no arguments, an empty
    /// environment, `NUL` standard handles and no resource limits.
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: Vec::new(),
            stdout: ChildStdio::Null,
            stderr: ChildStdio::Null,
            limits: ResourceLimits::default(),
        }
    }

    /// Append one argument.
    pub fn arg(&mut self, arg: impl Into<OsString>) -> &mut Self {
        self.args.push(arg.into());
        self
    }

    /// Set environment variables (the child gets these and nothing else).
    pub fn envs<K, V>(&mut self, vars: impl IntoIterator<Item = (K, V)>) -> &mut Self
    where
        K: Into<OsString>,
        V: Into<OsString>,
    {
        self.env
            .extend(vars.into_iter().map(|(k, v)| (k.into(), v.into())));
        self
    }

    /// Where the runner's stdout goes.
    pub fn stdout(&mut self, stdout: ChildStdio) -> &mut Self {
        self.stdout = stdout;
        self
    }

    /// Where the runner's stderr goes.
    pub fn stderr(&mut self, stderr: ChildStdio) -> &mut Self {
        self.stderr = stderr;
        self
    }

    /// The limits the job enforces.
    pub fn limits(&mut self, limits: ResourceLimits) -> &mut Self {
        self.limits = limits;
        self
    }

    /// Start the runner with `channel` as its only inherited handle besides
    /// its standard handles; `--ipc-handle <value>` is appended to the
    /// arguments. The caller should close its copy of `channel` afterwards, so
    /// the runner's exit surfaces as end of stream.
    pub fn spawn(&self, channel: BorrowedHandle<'_>) -> io::Result<JobChild> {
        let job = create_job(&self.limits)?;
        let stdin = null_device(GENERIC_READ)?;
        let (stdout, _) = child_stdio(self.stdout, STD_OUTPUT_HANDLE, GENERIC_WRITE)?;
        let (stderr, stderr_read) = child_stdio(self.stderr, STD_ERROR_HANDLE, GENERIC_WRITE)?;
        let channel = inheritable_copy(channel)?;

        let mut args = self.args.clone();
        args.push(IPC_HANDLE_ARG.into());
        args.push(handle_value(channel.as_handle()).to_string().into());
        let application = to_wide(self.program.as_os_str())?;
        let mut command_line = command_line(&self.program, &args)?;
        let environment = environment_block(&self.env)?;

        let mut inherited: Vec<HANDLE> = [&channel, &stdin, &stdout, &stderr]
            .iter()
            .map(|h| h.as_raw_handle())
            .collect();
        inherited.sort_unstable();
        inherited.dedup();
        let mut attributes = AttributeList::with_handle_list(inherited)?;

        // SAFETY: all-zero is a valid `STARTUPINFOEXW` to fill in.
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin.as_raw_handle();
        startup.StartupInfo.hStdOutput = stdout.as_raw_handle();
        startup.StartupInfo.hStdError = stderr.as_raw_handle();
        startup.lpAttributeList = attributes.as_mut_ptr();
        // SAFETY: all-zero is a valid `PROCESS_INFORMATION` to receive into.
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: every pointer is valid for the call: the NUL-terminated
        // application name, the mutable NUL-terminated command line, the
        // double-NUL-terminated UTF-16 environment block, and `startup`, whose
        // attribute list (and the handle array it points to) outlives it.
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                TRUE,
                CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_NO_WINDOW,
                environment.as_ptr().cast::<c_void>(),
                std::ptr::null(),
                &startup.StartupInfo,
                &mut info,
            )
        };
        if created == 0 {
            return Err(io::Error::last_os_error());
        }
        let process = owned(info.hProcess)?;
        let thread = owned(info.hThread)?;
        // SAFETY: both handles are valid and ours.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) } == 0 {
            let error = io::Error::last_os_error();
            // SAFETY: still suspended: it never ran; end it.
            unsafe { TerminateProcess(process.as_raw_handle(), KILLED_EXIT_CODE) };
            return Err(error);
        }
        // SAFETY: the primary thread we created suspended.
        if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
            let error = io::Error::last_os_error();
            // SAFETY: ends the (still suspended) process through its job.
            unsafe { TerminateJobObject(job.as_raw_handle(), KILLED_EXIT_CODE) };
            return Err(error);
        }
        // The child-side copies (channel, standard handles) close here: the
        // runner owns its own now.
        Ok(JobChild {
            process,
            job,
            pid: info.dwProcessId,
            stderr: stderr_read.map(ChildStderr::from),
        })
    }
}

/// A running runner and the job that bounds it. Dropping it closes the job,
/// which kills the runner (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
///
/// Mirrors the `std::process::Child` surface the host uses (`id`, `kill`,
/// `try_wait`, `wait`, the `stderr` field), so the host code is the same on
/// every platform.
#[derive(Debug)]
pub struct JobChild {
    process: OwnedHandle,
    job: OwnedHandle,
    pid: u32,
    /// The read end of the runner's stderr, when it was [`ChildStdio::Piped`].
    pub stderr: Option<ChildStderr>,
}

impl JobChild {
    /// The runner's process id.
    #[must_use]
    pub fn id(&self) -> u32 {
        self.pid
    }

    /// Kill the runner and anything it started (the whole job).
    pub fn kill(&mut self) -> io::Result<()> {
        // SAFETY: the job handle is ours.
        if unsafe { TerminateJobObject(self.job.as_raw_handle(), KILLED_EXIT_CODE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// The exit status, if the runner has exited.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_for(0)
    }

    /// Block until the runner exits.
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        match self.wait_for(INFINITE)? {
            Some(status) => Ok(status),
            None => Err(io::Error::other("waiting for the plugin runner failed")),
        }
    }

    fn wait_for(&self, millis: u32) -> io::Result<Option<ExitStatus>> {
        let process = self.process.as_raw_handle();
        // SAFETY: the process handle is ours.
        match unsafe { WaitForSingleObject(process, millis) } {
            WAIT_OBJECT_0 => {
                let mut code = 0u32;
                // SAFETY: the process handle is ours; `code` is writable.
                if unsafe { GetExitCodeProcess(process, &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(ExitStatus::from_raw(code)))
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

/// The host's read end of a runner's piped stderr. A closed write end (the
/// runner exited) reads as end of stream.
#[derive(Debug)]
pub struct ChildStderr(File);

impl From<OwnedHandle> for ChildStderr {
    fn from(handle: OwnedHandle) -> Self {
        Self(File::from(handle))
    }
}

impl Read for ChildStderr {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.0.read(buf) {
            Err(e) if is_os_error(&e, ERROR_BROKEN_PIPE) => Ok(0),
            other => other,
        }
    }
}

/// A job with kill-on-close, die-on-unhandled-exception and `limits`.
fn create_job(limits: &ResourceLimits) -> io::Result<OwnedHandle> {
    // SAFETY: an unnamed job with default security.
    let job = owned(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
    // SAFETY: all-zero is a valid "no limits" record to fill in.
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    let mut flags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    if let Some(bytes) = limits.address_space_bytes {
        flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        info.ProcessMemoryLimit = usize::try_from(bytes).unwrap_or(usize::MAX);
    }
    if limits.forbid_child_processes {
        flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.BasicLimitInformation.ActiveProcessLimit = 1;
    }
    info.BasicLimitInformation.LimitFlags = flags;
    // SAFETY: `info` is a complete record of the size passed.
    let ok = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&info).cast::<c_void>(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

/// Security attributes that make a new handle inheritable.
fn inheritable() -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: TRUE,
    }
}

/// An inheritable handle on the `NUL` device.
fn null_device(access: u32) -> io::Result<OwnedHandle> {
    let name = to_wide(OsStr::new("NUL"))?;
    let attributes = inheritable();
    // SAFETY: NUL-terminated name; `attributes` outlives the call.
    owned(unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    })
}

/// An inheritable duplicate of `handle` (same access).
fn inheritable_copy(handle: BorrowedHandle<'_>) -> io::Result<OwnedHandle> {
    let mut copy: HANDLE = std::ptr::null_mut();
    // SAFETY: duplicates within this process; `copy` receives a new handle
    // owned below.
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle.as_raw_handle(),
            GetCurrentProcess(),
            &mut copy,
            0,
            TRUE,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    owned(copy)
}

/// The child's end of one standard handle (inheritable), plus the host's read
/// end when it is piped.
fn child_stdio(
    how: ChildStdio,
    std_handle: u32,
    access: u32,
) -> io::Result<(OwnedHandle, Option<OwnedHandle>)> {
    match how {
        ChildStdio::Null => Ok((null_device(access)?, None)),
        ChildStdio::Inherit => {
            // SAFETY: returns this process's standard handle (not owned).
            let own = unsafe { GetStdHandle(std_handle) };
            if own.is_null() || own == INVALID_HANDLE_VALUE {
                return Ok((null_device(access)?, None));
            }
            // SAFETY: `own` is open for as long as this call runs.
            let borrowed = unsafe { BorrowedHandle::borrow_raw(own) };
            match inheritable_copy(borrowed) {
                Ok(copy) => Ok((copy, None)),
                Err(_) => Ok((null_device(access)?, None)),
            }
        }
        ChildStdio::Piped => {
            let mut read: HANDLE = std::ptr::null_mut();
            let mut write: HANDLE = std::ptr::null_mut();
            // SAFETY: both out-pointers are writable; the ends are owned below
            // and created non-inheritable.
            if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let read = owned(read)?;
            let write = owned(write)?;
            // Only the child's end is inheritable.
            // SAFETY: plain flag change on a handle we own.
            if unsafe {
                SetHandleInformation(
                    write.as_raw_handle(),
                    HANDLE_FLAG_INHERIT,
                    HANDLE_FLAG_INHERIT,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok((write, Some(read)))
        }
    }
}

/// `"<program>" <args…>` as a mutable NUL-terminated UTF-16 command line,
/// quoted so the MSVC runtime's argv parser gives back exactly `args`.
fn command_line(program: &Path, args: &[OsString]) -> io::Result<Vec<u16>> {
    let program: Vec<u16> = program.as_os_str().encode_wide().collect();
    if program.contains(&u16::from(b'"')) || program.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the runner path contains a quote or NUL",
        ));
    }
    // The program name is parsed without escapes: plain quotes suffice.
    let mut line = vec![u16::from(b'"')];
    line.extend(program);
    line.push(u16::from(b'"'));
    for arg in args {
        line.push(u16::from(b' '));
        push_quoted(&mut line, arg)?;
    }
    line.push(0);
    Ok(line)
}

/// Append `arg`, quoted per the MSVC argv rules when it needs quoting.
fn push_quoted(line: &mut Vec<u16>, arg: &OsStr) -> io::Result<()> {
    const QUOTE: u16 = b'"' as u16;
    const BACKSLASH: u16 = b'\\' as u16;
    let wide: Vec<u16> = arg.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "an argument contains a NUL",
        ));
    }
    let plain = !wide.is_empty()
        && !wide
            .iter()
            .any(|&c| matches!(c, 0x20 | 0x09 | 0x0A | 0x0B | QUOTE));
    if plain {
        line.extend(wide);
        return Ok(());
    }
    line.push(QUOTE);
    let mut backslashes = 0usize;
    for c in wide {
        if c == BACKSLASH {
            backslashes += 1;
        } else {
            if c == QUOTE {
                // n backslashes before a quote become 2n + 1, then the quote.
                line.extend(std::iter::repeat_n(BACKSLASH, backslashes + 1));
            }
            backslashes = 0;
        }
        line.push(c);
    }
    // Trailing backslashes are doubled so the closing quote stays a quote.
    line.extend(std::iter::repeat_n(BACKSLASH, backslashes));
    line.push(QUOTE);
    Ok(())
}

/// The environment block: `NAME=value\0` entries sorted by name
/// (case-insensitively, as Windows expects), then a final `\0`.
fn environment_block(vars: &[(OsString, OsString)]) -> io::Result<Vec<u16>> {
    let mut entries: Vec<(Vec<u16>, Vec<u16>)> = Vec::with_capacity(vars.len());
    for (name, value) in vars {
        let name: Vec<u16> = name.encode_wide().collect();
        let value: Vec<u16> = value.encode_wide().collect();
        if name.is_empty()
            || name.contains(&u16::from(b'='))
            || name.contains(&0)
            || value.contains(&0)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid environment variable for the runner",
            ));
        }
        entries.push((name, value));
    }
    let upper = |name: &[u16]| -> Vec<u16> {
        String::from_utf16_lossy(name)
            .to_uppercase()
            .encode_utf16()
            .collect()
    };
    entries.sort_by_cached_key(|(name, _)| upper(name));
    let mut block = Vec::new();
    for (name, value) in entries {
        block.extend(name);
        block.push(u16::from(b'='));
        block.extend(value);
        block.push(0);
    }
    if block.is_empty() {
        // An empty block is still two NULs.
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

/// A `PROC_THREAD_ATTRIBUTE_LIST` carrying one `HANDLE_LIST`. The system keeps
/// a pointer to the handle array, so both live here until the spawn is done.
struct AttributeList {
    buffer: Vec<usize>,
    handles: Box<[HANDLE]>,
}

impl AttributeList {
    fn with_handle_list(handles: Vec<HANDLE>) -> io::Result<Self> {
        let mut size = 0usize;
        // Sizing call: expected to fail with the needed size.
        // SAFETY: a null list with a size out-pointer only queries the size.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        // `usize` storage keeps the opaque list pointer-aligned.
        let buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let mut list = Self {
            buffer,
            handles: handles.into_boxed_slice(),
        };
        let raw = list.buffer.as_mut_ptr().cast::<c_void>();
        // SAFETY: `raw` points at `size` writable bytes.
        if unsafe { InitializeProcThreadAttributeList(raw, 1, 0, &mut size) } == 0 {
            // Not initialised: nothing for `Drop` to delete.
            list.buffer = Vec::new();
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the list is initialised; `handles` is heap-stable and lives
        // as long as the list (the system stores the pointer, not a copy).
        let ok = unsafe {
            UpdateProcThreadAttribute(
                raw,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                list.handles.as_ptr().cast::<c_void>(),
                std::mem::size_of_val::<[HANDLE]>(&list.handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(list)
    }

    fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast::<c_void>()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            // SAFETY: an initialised list, deleted once.
            unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(program: &str, args: &[&str]) -> String {
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        let wide = command_line(Path::new(program), &args).unwrap();
        String::from_utf16(&wide[..wide.len() - 1]).unwrap()
    }

    #[test]
    fn the_command_line_quotes_only_what_needs_it() {
        assert_eq!(
            line(r"C:\Program Files\r.exe", &["--protocol", "2"]),
            r#""C:\Program Files\r.exe" --protocol 2"#
        );
        assert_eq!(line(r"C:\r.exe", &[""]), r#""C:\r.exe" """#);
        assert_eq!(line(r"C:\r.exe", &["a b"]), r#""C:\r.exe" "a b""#);
        assert_eq!(line(r"C:\r.exe", &[r#"a"b"#]), r#""C:\r.exe" "a\"b""#);
        assert_eq!(line(r"C:\r.exe", &[r"a\ b\"]), r#""C:\r.exe" "a\ b\\""#);
        assert_eq!(line(r"C:\r.exe", &[r#"a\"b"#]), r#""C:\r.exe" "a\\\"b""#);
        assert!(command_line(Path::new("C:\\\"x"), &[]).is_err());
    }

    #[test]
    fn the_environment_block_is_sorted_and_double_terminated() {
        let block = environment_block(&[
            ("TZ".into(), "UTC".into()),
            ("SystemRoot".into(), r"C:\Windows".into()),
            ("lang".into(), "C".into()),
        ])
        .unwrap();
        let text = String::from_utf16(&block).unwrap();
        assert_eq!(text, "lang=C\0SystemRoot=C:\\Windows\0TZ=UTC\0\0");
        assert_eq!(environment_block(&[]).unwrap(), vec![0, 0]);
        assert!(environment_block(&[("A=B".into(), "x".into())]).is_err());
        assert!(environment_block(&[("".into(), "x".into())]).is_err());
    }
}
