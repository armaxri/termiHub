//! Escape probes for the OS-sandbox tests (#4186; shared with the Linux and
//! Windows sandbox phases #4185 / #4187).
//!
//! Input `?probe <op> [arg]` runs one operation inside the plugin, i.e. inside
//! the sandboxed runner, and answers one line:
//!
//! ```text
//! PROBE <op> ALLOWED <detail>
//! PROBE <op> DENIED <error>
//! ```
//!
//! The test decides which outcome each probe must have; the plugin only
//! reports. Operations (`<arg>` is everything after the op, verbatim):
//!
//! | op      | tries                                                     |
//! | ------- | --------------------------------------------------------- |
//! | `read`  | read the file `<arg>`                                     |
//! | `list`  | list the folder `<arg>`                                   |
//! | `write` | create/truncate the file `<arg>`                          |
//! | `tcp`   | open a new TCP connection to `<arg>` (`host:port`)        |
//! | `unix`  | connect a new Unix socket to the path `<arg>` (Unix)      |
//! | `bind`  | create a TCP socket and bind it to `127.0.0.1:0`          |
//! | `dns`   | resolve the host name `<arg>`                             |
//! | `spawn` | start `/bin/sh` (`cmd.exe` on Windows)                    |
//! | `fork`  | `fork()` (Unix; the child exits at once)                  |
//! | `env`   | read the environment variable `<arg>` (ALLOWED = set)     |
//! | `tmp`   | write a file in `std::env::temp_dir()`                    |
//! | `reg`   | open the registry key `HKCU\<arg>` for reading (Windows)  |
//! | `pipe`  | open the named pipe `<arg>` for reading and writing       |
//!
//! Under a Less-Privileged AppContainer Winsock cannot start, and `std::net`
//! panics on its first use (spike #4181): a panicking probe is caught and
//! reported as `DENIED panicked: …`, so the plugin keeps answering.

use std::io::Write;
use std::time::Duration;

/// Run a `?probe` command; `None` for any other input.
pub(crate) fn probe_command(data: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(data).ok()?;
    let rest = text.strip_prefix("?probe ")?;
    let (op, arg) = rest.split_once(' ').unwrap_or((rest, ""));
    let outcome = std::panic::catch_unwind(|| run(op, arg)).unwrap_or_else(|panic| {
        let message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap_or("unknown panic");
        Err(format!("panicked: {message}"))
    });
    Some(match outcome {
        Ok(detail) => format!("PROBE {op} ALLOWED {detail}"),
        Err(error) => format!("PROBE {op} DENIED {error}"),
    })
}

fn run(op: &str, arg: &str) -> Result<String, String> {
    let io = |e: std::io::Error| e.to_string();
    match op {
        "read" => std::fs::read(arg)
            .map(|bytes| format!("{} bytes", bytes.len()))
            .map_err(io),
        "list" => std::fs::read_dir(arg)
            .map(|entries| format!("{} entries", entries.count()))
            .map_err(io),
        "write" => std::fs::write(arg, b"escape-probe")
            .map(|()| "written".to_owned())
            .map_err(io),
        "tcp" => {
            let addr: std::net::SocketAddr = arg.parse().map_err(|e| format!("bad addr: {e}"))?;
            std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2))
                .map(|_| "connected".to_owned())
                .map_err(io)
        }
        "unix" => unix_connect(arg),
        "bind" => std::net::TcpListener::bind("127.0.0.1:0")
            .map(|l| format!("bound {:?}", l.local_addr().ok()))
            .map_err(io),
        "dns" => {
            use std::net::ToSocketAddrs;
            match (arg, 80).to_socket_addrs() {
                Ok(addrs) => match addrs.count() {
                    0 => Err("no addresses".to_owned()),
                    n => Ok(format!("{n} addresses")),
                },
                Err(e) => Err(e.to_string()),
            }
        }
        "spawn" => spawn_shell(),
        "fork" => fork_child(),
        "env" => std::env::var(arg).map_err(|e| e.to_string()),
        "tmp" => {
            let path = std::env::temp_dir().join("escape-probe.tmp");
            std::fs::File::create(&path)
                .and_then(|mut f| f.write_all(b"tmp"))
                .map(|()| path.display().to_string())
                .map_err(io)
        }
        "reg" => open_hkcu_key(arg),
        "pipe" => std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(arg)
            .map(|_| "opened".to_owned())
            .map_err(io),
        other => Err(format!("unknown probe `{other}`")),
    }
}

#[cfg(unix)]
fn unix_connect(path: &str) -> Result<String, String> {
    std::os::unix::net::UnixStream::connect(path)
        .map(|_| "connected".to_owned())
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn unix_connect(_path: &str) -> Result<String, String> {
    Err("no Unix sockets on this platform".to_owned())
}

#[cfg(windows)]
fn open_hkcu_key(subkey: &str) -> Result<String, String> {
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            key: isize,
            subkey: *const u16,
            options: u32,
            desired: u32,
            result: *mut isize,
        ) -> u32;
        fn RegCloseKey(key: isize) -> u32;
    }
    /// `HKEY_CURRENT_USER` (`0x80000001`, sign-extended).
    const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
    /// `KEY_READ`.
    const KEY_READ: u32 = 0x2_0019;
    let wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let mut key = 0isize;
    // SAFETY: a predefined root key, a NUL-terminated subkey, an out-pointer
    // for a key closed below.
    let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide.as_ptr(), 0, KEY_READ, &mut key) };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32).to_string());
    }
    // SAFETY: the key opened above, closed once.
    unsafe { RegCloseKey(key) };
    Ok("opened".to_owned())
}

#[cfg(not(windows))]
fn open_hkcu_key(_subkey: &str) -> Result<String, String> {
    Err("no registry on this platform".to_owned())
}

fn spawn_shell() -> Result<String, String> {
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd.exe");
        c.args(["/C", "exit 0"]);
        c
    } else {
        let mut c = std::process::Command::new("/bin/sh");
        c.args(["-c", "exit 0"]);
        c
    };
    command
        .status()
        .map(|status| format!("exited {status}"))
        .map_err(|e| e.to_string())
}

#[cfg(unix)]
fn fork_child() -> Result<String, String> {
    extern "C" {
        fn fork() -> i32;
        fn _exit(status: i32) -> !;
        fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    }
    // SAFETY: the child only calls the async-signal-safe `_exit`.
    let pid = unsafe { fork() };
    match pid {
        -1 => Err(std::io::Error::last_os_error().to_string()),
        // SAFETY: in the child: leave at once without running destructors.
        0 => unsafe { _exit(0) },
        child => {
            let mut status = 0;
            // SAFETY: `child` is our own child; `status` is writable.
            unsafe { waitpid(child, &mut status, 0) };
            Ok(format!("forked {child}"))
        }
    }
}

#[cfg(not(unix))]
fn fork_child() -> Result<String, String> {
    Err("no fork on this platform".to_owned())
}
