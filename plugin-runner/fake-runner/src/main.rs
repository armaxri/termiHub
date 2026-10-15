//! A test-only stand-in for `termihub-plugin-runner` (#4550).
//!
//! The core plugin tests spawn it through the real host spawn path in place of
//! the runner, to check what the host does to an untrusted runner *process*
//! (#4335): it gets the null device as stdout, a failed safety-thread start
//! ends it, and a forged `Loaded` gets it killed. It runs on every OS: on Unix
//! its channel is descriptor 3, on Windows the named-pipe handle named by
//! `--ipc-handle` (inside the plugin's AppContainer when the host requests the
//! OS sandbox).
//!
//! What it does, in order:
//!
//! 1. sends `Hello` (with its own pid);
//! 2. reads the host's `Configure`;
//! 3. writes two report files into its *output folder* — the sandbox policy's
//!    data folder when the host sent one that exists (the only folder a
//!    confined runner may write), else the folder holding this executable:
//!    * `stdout`: `null` when its standard output is the null device,
//!      `inherited` otherwise;
//!    * `pid`: its process id;
//! 4. sends a `SandboxReport` (every layer this platform requires as enforced
//!    when a sandbox was requested, empty otherwise) and a `Loaded` mirroring
//!    the configured plugin id;
//! 5. sleeps, so a test can tell "the host killed it" from "it exited".
//!
//! Its *mode* comes from its file name, which the tests choose when they copy
//! it into their own folder (no argument or file can reach it under the
//! AppContainer): a name containing [`FORGE_ABI_MARKER`] forges `Loaded` with
//! an ABI one major past this host's; any other name is honest.
//!
//! Never shipped: no packaging script or bundle names it.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use termihub_plugin_api::{AbiVersion, CURRENT_PLUGIN_ABI_VERSION};
use termihub_plugin_runner::ipc::{
    Configure, FrameReader, Hello, Loaded, Message, SandboxReport, PROTOCOL_VERSION,
};
use termihub_plugin_runner::sandbox::required_layers;

/// A file name containing this makes the fake forge `Loaded` with an ABI the
/// host cannot run.
const FORGE_ABI_MARKER: &str = "forge-abi";

/// How long the fake waits after its handshake before exiting by itself.
const LINGER: Duration = Duration::from_secs(30);

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("termihub-plugin-fake-runner: {error}");
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("locating myself: {e}"))?;
    let forge_abi = exe
        .file_stem()
        .is_some_and(|stem| stem.to_string_lossy().contains(FORGE_ABI_MARKER));
    let channel = platform::open_channel(std::env::args().skip(1))?;

    send(
        &channel,
        &Message::Hello(Hello {
            runner_version: "0.0.0-fake".into(),
            protocol_version: PROTOCOL_VERSION,
            pid: std::process::id(),
        }),
    )?;
    let configure = read_configure(&channel)?;

    let out = output_folder(&configure, &exe)?;
    let stdout = if platform::stdout_is_null() {
        "null"
    } else {
        "inherited"
    };
    write_report(&out, "stdout", stdout)?;
    write_report(&out, "pid", &std::process::id().to_string())?;

    let enforced = if configure.sandbox.is_some() {
        required_layers().iter().map(|l| (*l).to_owned()).collect()
    } else {
        Vec::new()
    };
    send(
        &channel,
        &Message::SandboxReport(SandboxReport {
            enforced,
            missing: Vec::new(),
            failed: None,
        }),
    )?;
    let abi = if forge_abi {
        AbiVersion::new(CURRENT_PLUGIN_ABI_VERSION.major + 1, 0)
    } else {
        CURRENT_PLUGIN_ABI_VERSION
    };
    send(
        &channel,
        &Message::Loaded(Loaded {
            id: configure.plugin_id.clone(),
            name: "Fake Runner".into(),
            version: "0.0.0".into(),
            abi_version: abi.to_packed(),
            toolchain: None,
        }),
    )?;

    std::thread::sleep(LINGER);
    drop(channel);
    Ok(())
}

fn send(channel: &platform::Channel, message: &Message) -> Result<(), String> {
    let frame = message
        .encode()
        .map_err(|e| format!("encoding {:?}: {e}", message.kind()))?;
    let mut writer = channel;
    writer
        .write_all(&frame)
        .and_then(|()| writer.flush())
        .map_err(|e| format!("sending {:?}: {e}", message.kind()))
}

fn read_configure(channel: &platform::Channel) -> Result<Configure, String> {
    let frame = FrameReader::new(channel)
        .read_frame()
        .map_err(|e| format!("reading Configure: {e}"))?
        .ok_or("the host closed the channel before Configure")?;
    match Message::decode(frame) {
        Ok(Message::Configure(configure)) => Ok(configure),
        Ok(other) => Err(format!("expected Configure, got {:?}", other.kind())),
        Err(e) => Err(format!("decoding Configure: {e}")),
    }
}

/// The policy's data folder when there is one, else the executable's folder.
fn output_folder(configure: &Configure, exe: &Path) -> Result<PathBuf, String> {
    let data = configure
        .sandbox
        .as_ref()
        .and_then(|policy| policy.data_dir.as_deref())
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir());
    data.or_else(|| exe.parent().map(Path::to_path_buf))
        .ok_or_else(|| "no output folder".to_owned())
}

/// Write `<out>/<name>` as one line, complete once the newline is there.
fn write_report(out: &Path, name: &str, value: &str) -> Result<(), String> {
    let path = out.join(name);
    std::fs::write(&path, format!("{value}\n"))
        .map_err(|e| format!("writing {}: {e}", path.display()))
}

#[cfg(unix)]
mod platform {
    use std::os::fd::FromRawFd;
    use std::os::unix::net::UnixStream;

    use termihub_plugin_runner::ipc::IPC_FD;

    pub(crate) type Channel = UnixStream;

    /// Descriptor 3, as the host passes it (the arguments are not needed).
    pub(crate) fn open_channel(_args: impl Iterator<Item = String>) -> Result<Channel, String> {
        // SAFETY: descriptor 3 is the channel end the host passed us; nothing
        // else in this process owns it. A missing descriptor fails the first
        // write.
        Ok(unsafe { UnixStream::from_raw_fd(IPC_FD) })
    }

    /// Whether descriptor 1 is the same file as `/dev/null` (`test -ef`).
    pub(crate) fn stdout_is_null() -> bool {
        use std::os::fd::AsFd;
        use std::os::unix::fs::MetadataExt;

        let Ok(null) = std::fs::metadata("/dev/null") else {
            return false;
        };
        // A copy of descriptor 1, so its metadata can be read through `File`;
        // a closed descriptor 1 fails the copy.
        let Ok(stdout) = std::io::stdout().as_fd().try_clone_to_owned() else {
            return false;
        };
        std::fs::File::from(stdout)
            .metadata()
            .is_ok_and(|out| out.dev() == null.dev() && out.ino() == null.ino())
    }
}

#[cfg(windows)]
mod platform {
    use termihub_plugin_runner::ipc::pipe::PipeStream;
    use termihub_plugin_runner::ipc::IPC_HANDLE_ARG;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_CHAR};
    use windows_sys::Win32::System::Console::{GetConsoleMode, GetStdHandle, STD_OUTPUT_HANDLE};

    pub(crate) type Channel = PipeStream;

    /// The inherited pipe handle named by `--ipc-handle <value>`.
    pub(crate) fn open_channel(
        mut args: impl Iterator<Item = String>,
    ) -> Result<Channel, String> {
        let value = args
            .by_ref()
            .skip_while(|arg| arg != IPC_HANDLE_ARG)
            .nth(1)
            .ok_or("no --ipc-handle argument")?;
        let value: usize = value
            .parse()
            .map_err(|e| format!("bad --ipc-handle value {value:?}: {e}"))?;
        // SAFETY: the value names the pipe end the host passed us through the
        // handle list; nothing else in this process owns it. A value that is
        // not a pipe is refused without being touched.
        unsafe { PipeStream::from_inherited(value) }
            .map_err(|e| format!("the inherited channel is unusable: {e}"))
    }

    /// Whether the standard output handle is the `NUL` device: a character
    /// device that is not a console (an inherited console or pipe is not).
    pub(crate) fn stdout_is_null() -> bool {
        // SAFETY: reads this process's standard handle; no ownership taken.
        let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return false;
        }
        // SAFETY: `GetFileType` only inspects the handle.
        if unsafe { GetFileType(handle) } != FILE_TYPE_CHAR {
            return false;
        }
        let mut mode = 0;
        // SAFETY: `mode` is a valid out-pointer; fails on a non-console handle.
        unsafe { GetConsoleMode(handle, &mut mode) == 0 }
    }
}
