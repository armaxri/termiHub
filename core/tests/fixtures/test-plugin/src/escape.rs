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

use std::io::Write;
use std::time::Duration;

/// Run a `?probe` command; `None` for any other input.
pub(crate) fn probe_command(data: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(data).ok()?;
    let rest = text.strip_prefix("?probe ")?;
    let (op, arg) = rest.split_once(' ').unwrap_or((rest, ""));
    let outcome = run(op, arg);
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
