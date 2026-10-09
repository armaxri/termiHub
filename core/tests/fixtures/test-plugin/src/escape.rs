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
//! | `sockets` | call `socket()` `<arg>` times (ALLOWED = any succeeded)   |
//! | `sigsys`  | replace the `SIGSYS` handler (Linux; #4236)             |
//! | `stat`    | read the metadata of `<arg>` (no open; #4342)            |
//! | `procmem` | open `/proc/<arg>/mem` for reading and writing (Linux)   |
//! | `inotify` | watch the path `<arg>` with inotify (Linux; #4342)       |
//! | `trust`   | verify a root of `/etc/ssl/cert.pem` with the platform   |
//! |           | verifier, `SecTrustEvaluateWithError` (macOS; #4342)     |
//! | `proclist`| size the process table, `sysctl(KERN_PROC_ALL)` (macOS)  |
//! | `procargs`| read `KERN_PROCARGS2` of the process `<arg>` (macOS)     |
//! | `pidpath` | `proc_pidpath` of the process `<arg>` (macOS)            |
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
        "sockets" => sockets(arg),
        "sigsys" => replace_sigsys_handler(),
        "stat" => std::fs::symlink_metadata(arg)
            .map(|m| format!("{} bytes", m.len()))
            .map_err(io),
        "procmem" => std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(format!("/proc/{arg}/mem"))
            .map(|_| "opened".to_owned())
            .map_err(io),
        "inotify" => inotify_watch(arg),
        "trust" => macos::verify_a_system_root(),
        "proclist" => macos::process_table_size(),
        "procargs" => macos::process_arguments(arg),
        "pidpath" => macos::process_path(arg),
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

/// Call `socket(AF_INET, SOCK_STREAM, 0)` `count` times (closing any socket
/// that is created): the burst the denial-report rate limit must coalesce.
#[cfg(unix)]
fn sockets(count: &str) -> Result<String, String> {
    extern "C" {
        fn socket(domain: i32, kind: i32, protocol: i32) -> i32;
        fn close(fd: i32) -> i32;
    }
    let count: u32 = count.parse().map_err(|e| format!("bad count: {e}"))?;
    let (mut created, mut last_error) = (0u32, None);
    for _ in 0..count {
        // SAFETY: plain `socket` / `close` calls with constant arguments.
        let fd = unsafe { socket(2, 1, 0) };
        if fd >= 0 {
            created += 1;
            // SAFETY: `fd` is the socket just created.
            unsafe { close(fd) };
        } else {
            last_error = Some(std::io::Error::last_os_error());
        }
    }
    match last_error {
        Some(error) if created == 0 => Err(format!("{count} of {count} refused: {error}")),
        _ => Ok(format!("{created} of {count} created")),
    }
}

#[cfg(not(unix))]
fn sockets(_count: &str) -> Result<String, String> {
    Err("no BSD socket probe on this platform".to_owned())
}

/// Replace the `SIGSYS` handler with `SIG_IGN`. Under the Linux sandbox the
/// runner's handler turns trapped denials into `EPERM` reports (#4236); a
/// plugin must not be able to replace it.
#[cfg(target_os = "linux")]
fn replace_sigsys_handler() -> Result<String, String> {
    extern "C" {
        fn signal(signum: i32, handler: usize) -> usize;
    }
    const SIGSYS: i32 = 31;
    const SIG_IGN: usize = 1;
    const SIG_ERR: usize = usize::MAX;
    // SAFETY: `signal` with a constant signal number and `SIG_IGN`.
    let previous = unsafe { signal(SIGSYS, SIG_IGN) };
    if previous == SIG_ERR {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // Put the previous handler back so the escape does not linger.
    // SAFETY: restores the value `signal` just returned.
    unsafe { signal(SIGSYS, previous) };
    Ok("replaced".to_owned())
}

#[cfg(not(target_os = "linux"))]
fn replace_sigsys_handler() -> Result<String, String> {
    Err("no seccomp trap on this platform".to_owned())
}

/// Watch `path` with inotify (#4342, SEC2-006): a sandboxed plugin must not
/// learn the names of files the user creates or opens outside its folders.
#[cfg(target_os = "linux")]
fn inotify_watch(path: &str) -> Result<String, String> {
    extern "C" {
        fn inotify_init1(flags: i32) -> i32;
        fn inotify_add_watch(fd: i32, path: *const std::ffi::c_char, mask: u32) -> i32;
        fn close(fd: i32) -> i32;
    }
    const IN_CLOEXEC: i32 = 0o2_000_000;
    const IN_ALL_EVENTS: u32 = 0xfff;
    let path = std::ffi::CString::new(path).map_err(|e| e.to_string())?;
    // SAFETY: a plain `inotify_init1` call with constant flags.
    let fd = unsafe { inotify_init1(IN_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // SAFETY: `fd` is the inotify instance above; `path` is NUL-terminated.
    let watch = unsafe { inotify_add_watch(fd, path.as_ptr(), IN_ALL_EVENTS) };
    let error = std::io::Error::last_os_error();
    // SAFETY: `fd` was opened above and is not used again.
    unsafe { close(fd) };
    if watch < 0 {
        Err(error.to_string())
    } else {
        Ok(format!("watch {watch}"))
    }
}

#[cfg(not(target_os = "linux"))]
fn inotify_watch(_path: &str) -> Result<String, String> {
    Err("no inotify on this platform".to_owned())
}

/// macOS probes: the platform certificate verifier (must work, #4342
/// PLG2-004) and other processes' information (must not, SEC2-008).
#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_int, c_long, c_uint, c_void};

    type CFTypeRef = *const c_void;
    type OSStatus = i32;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDataCreate(alloc: CFTypeRef, bytes: *const u8, length: c_long) -> CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecCertificateCreateWithData(alloc: CFTypeRef, data: CFTypeRef) -> CFTypeRef;
        fn SecPolicyCreateBasicX509() -> CFTypeRef;
        fn SecTrustCreateWithCertificates(
            certificates: CFTypeRef,
            policies: CFTypeRef,
            trust: *mut CFTypeRef,
        ) -> OSStatus;
        fn SecTrustEvaluateWithError(trust: CFTypeRef, error: *mut CFTypeRef) -> bool;
    }

    extern "C" {
        fn sysctl(
            name: *const c_int,
            namelen: c_uint,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *const c_void,
            newlen: usize,
        ) -> c_int;
        fn proc_pidpath(pid: c_int, buffer: *mut c_char, size: u32) -> c_int;
    }

    const CTL_KERN: c_int = 1;
    const KERN_PROC: c_int = 14;
    const KERN_PROC_ALL: c_int = 0;
    const KERN_PROCARGS2: c_int = 49;

    /// Evaluate the roots of `/etc/ssl/cert.pem` one by one (basic X.509
    /// policy) until `trustd` accepts one: a system root evaluates as trusted
    /// exactly when the platform verifier works. Without the `trustd`
    /// allowance every evaluation fails.
    pub(super) fn verify_a_system_root() -> Result<String, String> {
        let pem = std::fs::read_to_string("/etc/ssl/cert.pem").map_err(|e| e.to_string())?;
        let mut last = "no certificate in /etc/ssl/cert.pem".to_owned();
        for (i, der) in super::pem_certificates(&pem).iter().enumerate() {
            match evaluate(der) {
                Ok(()) => return Ok(format!("root #{i} trusted")),
                Err(error) => last = error,
            }
        }
        Err(last)
    }

    fn evaluate(der: &[u8]) -> Result<(), String> {
        let len = c_long::try_from(der.len()).map_err(|e| e.to_string())?;
        // SAFETY: CoreFoundation / Security calls on valid buffers; every
        // created object is released once below, and `CFRelease` is never
        // passed NULL.
        unsafe {
            let data = CFDataCreate(std::ptr::null(), der.as_ptr(), len);
            if data.is_null() {
                return Err("CFDataCreate failed".to_owned());
            }
            let cert = SecCertificateCreateWithData(std::ptr::null(), data);
            CFRelease(data);
            if cert.is_null() {
                return Err("not a certificate".to_owned());
            }
            let policy = SecPolicyCreateBasicX509();
            let mut trust: CFTypeRef = std::ptr::null();
            let status = SecTrustCreateWithCertificates(cert, policy, &mut trust);
            CFRelease(cert);
            CFRelease(policy);
            if status != 0 || trust.is_null() {
                return Err(format!("SecTrustCreateWithCertificates: {status}"));
            }
            let mut error: CFTypeRef = std::ptr::null();
            let trusted = SecTrustEvaluateWithError(trust, &mut error);
            CFRelease(trust);
            if !error.is_null() {
                CFRelease(error);
            }
            if trusted {
                Ok(())
            } else {
                Err("not trusted (is trustd reachable?)".to_owned())
            }
        }
    }

    fn query(mib: &[c_int], buffer: Option<&mut [u8]>) -> Result<usize, String> {
        let (pointer, mut len) = match buffer {
            Some(buffer) => (buffer.as_mut_ptr().cast::<c_void>(), buffer.len()),
            None => (std::ptr::null_mut(), 0),
        };
        let count = c_uint::try_from(mib.len()).map_err(|e| e.to_string())?;
        // SAFETY: `mib` holds `count` names; `pointer` is NULL or valid for
        // `len` bytes, and `len` is a valid in/out pointer.
        let rc = unsafe { sysctl(mib.as_ptr(), count, pointer, &mut len, std::ptr::null(), 0) };
        if rc == 0 {
            Ok(len)
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }

    pub(super) fn process_table_size() -> Result<String, String> {
        query(&[CTL_KERN, KERN_PROC, KERN_PROC_ALL], None).map(|n| format!("{n} bytes"))
    }

    fn pid(arg: &str) -> Result<c_int, String> {
        arg.trim().parse().map_err(|e| format!("bad pid: {e}"))
    }

    pub(super) fn process_arguments(arg: &str) -> Result<String, String> {
        let mut buffer = vec![0u8; 256 * 1024];
        query(&[CTL_KERN, KERN_PROCARGS2, pid(arg)?], Some(&mut buffer))
            .map(|n| format!("{n} bytes"))
    }

    pub(super) fn process_path(arg: &str) -> Result<String, String> {
        let mut buffer = vec![0 as c_char; 4096];
        let size = u32::try_from(buffer.len()).map_err(|e| e.to_string())?;
        // SAFETY: `buffer` is valid for `size` bytes.
        let len = unsafe { proc_pidpath(pid(arg)?, buffer.as_mut_ptr(), size) };
        if len > 0 {
            Ok(format!("{len} bytes"))
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod macos {
    pub(super) fn verify_a_system_root() -> Result<String, String> {
        Err("no platform verifier probe on this platform".to_owned())
    }
    pub(super) fn process_table_size() -> Result<String, String> {
        Err("no KERN_PROC on this platform".to_owned())
    }
    pub(super) fn process_arguments(_arg: &str) -> Result<String, String> {
        Err("no KERN_PROCARGS2 on this platform".to_owned())
    }
    pub(super) fn process_path(_arg: &str) -> Result<String, String> {
        Err("no proc_pidpath on this platform".to_owned())
    }
}

/// The DER certificates of a PEM bundle (a minimal base64 decoder: the
/// fixture has no dependencies beyond the plugin API and serde).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pem_certificates(pem: &str) -> Vec<Vec<u8>> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let mut certificates = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find(BEGIN) {
        let body = &rest[start + BEGIN.len()..];
        let Some(end) = body.find(END) else { break };
        if let Some(der) = base64_decode(&body[..end]) {
            certificates.push(der);
        }
        rest = &body[end + END.len()..];
    }
    certificates
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
    {
        acc = (acc << 6) | u32::from(value(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}
