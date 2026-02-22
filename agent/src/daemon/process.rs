//! Session daemon process — manages a single PTY + ring buffer.
//!
//! Invoked as `termihub-agent --daemon <session-id>` by the agent.
//! Communicates with the agent via a Unix domain socket using the
//! length-prefixed binary frame protocol defined in `protocol.rs`.
//!
//! The daemon is intentionally single-threaded and does NOT use tokio.
//! It uses `nix::poll::poll()` to multiplex between the PTY master,
//! the Unix socket listener, and the agent connection. This keeps the
//! daemon lightweight and simple.

use std::collections::HashMap;
use std::io::Write;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use nix::libc;
use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
use nix::pty::{openpty, OpenptyResult, Winsize};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::{close, setsid, Pid};
use tracing::{debug, error, info, warn};

use crate::daemon::protocol::{self, *};
use termihub_core::buffer::RingBuffer;

/// Default ring buffer size: 1 MiB.
const DEFAULT_BUFFER_SIZE: usize = 1_048_576;

/// PTY read buffer size.
const PTY_READ_BUF: usize = 4096;

/// Poll timeout in milliseconds.
const POLL_TIMEOUT_MS: u16 = 100;

/// Configuration for the session daemon, read from environment variables.
struct DaemonConfig {
    session_id: String,
    socket_path: PathBuf,
    shell: String,
    cols: u16,
    rows: u16,
    buffer_size: usize,
    env: HashMap<String, String>,
    /// When set, run this command instead of a login shell.
    /// Read from `TERMIHUB_COMMAND`.
    command: Option<String>,
    /// Arguments for the command. Read from `TERMIHUB_COMMAND_ARGS` (JSON array).
    command_args: Vec<String>,
}

impl DaemonConfig {
    /// Read configuration from environment variables.
    fn from_env(session_id: &str) -> anyhow::Result<Self> {
        let socket_path = std::env::var("TERMIHUB_SOCKET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| socket_dir().join(format!("session-{session_id}.sock")));

        let shell = std::env::var("TERMIHUB_SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

        let cols = std::env::var("TERMIHUB_COLS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(80);

        let rows = std::env::var("TERMIHUB_ROWS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(24);

        let buffer_size = std::env::var("TERMIHUB_BUFFER_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_BUFFER_SIZE);

        let env: HashMap<String, String> = std::env::var("TERMIHUB_ENV")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let command = std::env::var("TERMIHUB_COMMAND").ok();

        let command_args: Vec<String> = std::env::var("TERMIHUB_COMMAND_ARGS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        Ok(Self {
            session_id: session_id.to_string(),
            socket_path,
            shell,
            cols,
            rows,
            buffer_size,
            env,
            command,
            command_args,
        })
    }
}

/// Get the socket directory for the current user.
pub fn socket_dir() -> PathBuf {
    let user = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
    PathBuf::from("/tmp/termihub").join(user)
}

/// Ensure the socket directory exists with mode 0700.
fn ensure_socket_dir(dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Entry point for the session daemon process.
pub fn run_daemon(session_id: &str) -> anyhow::Result<()> {
    let config = DaemonConfig::from_env(session_id)?;

    if let Some(ref command) = config.command {
        info!(
            "Session daemon starting: id={}, command={} {:?}, size={}x{}, buffer={}",
            config.session_id,
            command,
            config.command_args,
            config.cols,
            config.rows,
            config.buffer_size
        );
    } else {
        info!(
            "Session daemon starting: id={}, shell={}, size={}x{}, buffer={}",
            config.session_id, config.shell, config.cols, config.rows, config.buffer_size
        );
    }

    // Ensure socket directory exists
    if let Some(parent) = config.socket_path.parent() {
        ensure_socket_dir(parent)?;
    }

    // Remove stale socket file if it exists
    let _ = std::fs::remove_file(&config.socket_path);

    // Bind the Unix listener
    let listener = UnixListener::bind(&config.socket_path)?;
    listener.set_nonblocking(true)?;

    // Set socket file permissions to 0700
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&config.socket_path, std::fs::Permissions::from_mode(0o700))?;

    info!("Listening on socket: {}", config.socket_path.display());

    // Allocate PTY
    let winsize = Winsize {
        ws_row: config.rows,
        ws_col: config.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let OpenptyResult { master, slave } = openpty(&winsize, None)?;

    // Spawn the child process (shell or arbitrary command)
    let child_pid = if let Some(ref command) = config.command {
        spawn_command(command, &config.command_args, &slave, &config.env)?
    } else {
        spawn_shell(&config.shell, &slave, &config.env)?
    };

    // Close slave in the daemon — the child process owns it now
    drop(slave);

    if config.command.is_some() {
        info!(
            "Command spawned: pid={}, command={} {:?}",
            child_pid,
            config.command.as_deref().unwrap_or(""),
            config.command_args
        );
    } else {
        info!("Shell spawned: pid={}, shell={}", child_pid, config.shell);
    }

    // Run the main event loop
    let result = daemon_loop(&master, &listener, child_pid, config.buffer_size);

    // Cleanup socket file
    let _ = std::fs::remove_file(&config.socket_path);

    info!("Session daemon exiting: {}", config.session_id);
    result
}

/// Spawn the shell as a child process attached to the PTY slave.
fn spawn_shell(shell: &str, slave: &OwnedFd, env: &HashMap<String, String>) -> anyhow::Result<Pid> {
    let slave_fd = slave.as_raw_fd();

    // Use fork + exec pattern for proper PTY setup
    match unsafe { nix::unistd::fork()? } {
        nix::unistd::ForkResult::Child => {
            // Create new session and set controlling terminal
            setsid().expect("setsid failed");

            // Set controlling terminal
            unsafe {
                libc::ioctl(slave_fd, libc::TIOCSCTTY as libc::c_ulong, 0);
            }

            // Redirect stdio to PTY slave
            unsafe {
                libc::dup2(slave_fd, 0);
                libc::dup2(slave_fd, 1);
                libc::dup2(slave_fd, 2);
            }

            if slave_fd > 2 {
                close(slave_fd).expect("close slave_fd failed");
            }

            // Set environment
            std::env::set_var("TERM", "xterm-256color");
            std::env::set_var("COLORTERM", "truecolor");
            for (key, value) in env {
                std::env::set_var(key, value);
            }

            // Determine home directory for working directory
            if let Ok(home) = std::env::var("HOME") {
                let _ = std::env::set_current_dir(&home);
            }

            // Execute the shell as a login shell
            let shell_name = Path::new(shell)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("sh");
            let login_name = format!("-{shell_name}");

            // exec replaces this process
            let c_shell = std::ffi::CString::new(shell).expect("Invalid shell path");
            let c_arg0 = std::ffi::CString::new(login_name).expect("Invalid shell name");

            match nix::unistd::execvp(&c_shell, &[c_arg0]) {
                Ok(infallible) => match infallible {},
                Err(e) => panic!("execvp failed: {e}"),
            }
        }
        nix::unistd::ForkResult::Parent { child } => Ok(child),
    }
}

/// Spawn an arbitrary command as a child process attached to the PTY slave.
///
/// Used for Docker sessions where the daemon runs `docker exec -it` instead
/// of a login shell.
fn spawn_command(
    command: &str,
    args: &[String],
    slave: &OwnedFd,
    env: &HashMap<String, String>,
) -> anyhow::Result<Pid> {
    let slave_fd = slave.as_raw_fd();

    match unsafe { nix::unistd::fork()? } {
        nix::unistd::ForkResult::Child => {
            // Create new session and set controlling terminal
            setsid().expect("setsid failed");

            unsafe {
                libc::ioctl(slave_fd, libc::TIOCSCTTY as libc::c_ulong, 0);
            }

            // Redirect stdio to PTY slave
            unsafe {
                libc::dup2(slave_fd, 0);
                libc::dup2(slave_fd, 1);
                libc::dup2(slave_fd, 2);
            }

            if slave_fd > 2 {
                close(slave_fd).expect("close slave_fd failed");
            }

            // Set environment
            std::env::set_var("TERM", "xterm-256color");
            std::env::set_var("COLORTERM", "truecolor");
            for (key, value) in env {
                std::env::set_var(key, value);
            }

            // Build CString args: [command, arg1, arg2, ...]
            let c_command = std::ffi::CString::new(command).expect("Invalid command");
            let mut c_args = vec![c_command.clone()];
            for arg in args {
                c_args.push(std::ffi::CString::new(arg.as_str()).expect("Invalid arg"));
            }

            match nix::unistd::execvp(&c_command, &c_args) {
                Ok(infallible) => match infallible {},
                Err(e) => panic!("execvp failed: {e}"),
            }
        }
        nix::unistd::ForkResult::Parent { child } => Ok(child),
    }
}

/// Resize the PTY master.
fn resize_pty(master_fd: i32, cols: u16, rows: u16) {
    let winsize = Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(
            master_fd,
            libc::TIOCSWINSZ as libc::c_ulong,
            &winsize as *const Winsize,
        );
    }
}

/// Main daemon event loop.
///
/// Multiplexes between PTY output, socket listener, and agent connection
/// using `poll()`.
fn daemon_loop(
    master: &OwnedFd,
    listener: &UnixListener,
    child_pid: Pid,
    buffer_size: usize,
) -> anyhow::Result<()> {
    let master_fd = master.as_raw_fd();

    let mut ring_buffer = RingBuffer::new(buffer_size);
    let mut agent_conn: Option<UnixStream> = None;
    let mut pty_buf = [0u8; PTY_READ_BUF];

    // Make PTY master non-blocking for poll
    set_nonblocking(master_fd)?;

    let timeout = PollTimeout::from(POLL_TIMEOUT_MS);

    loop {
        // Check if child has exited (non-blocking)
        match waitpid(child_pid, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(_, code)) => {
                info!("Shell exited with code {code}");
                send_exited(&mut agent_conn, code);
                return Ok(());
            }
            Ok(WaitStatus::Signaled(_, signal, _)) => {
                info!("Shell killed by signal {signal}");
                send_exited(&mut agent_conn, 128 + signal as i32);
                return Ok(());
            }
            Ok(_) => {} // still running
            Err(nix::errno::Errno::ECHILD) => {
                // Child already reaped
                info!("Shell process no longer exists");
                send_exited(&mut agent_conn, -1);
                return Ok(());
            }
            Err(e) => {
                warn!("waitpid error: {e}");
            }
        }

        // Build poll fds using BorrowedFd
        let master_bfd = unsafe { BorrowedFd::borrow_raw(master_fd) };
        let listener_bfd = listener.as_fd();

        let mut poll_fds = vec![
            PollFd::new(master_bfd, PollFlags::POLLIN),
            PollFd::new(listener_bfd, PollFlags::POLLIN),
        ];

        if let Some(ref conn) = agent_conn {
            let conn_bfd = unsafe { BorrowedFd::borrow_raw(conn.as_raw_fd()) };
            poll_fds.push(PollFd::new(conn_bfd, PollFlags::POLLIN));
        }

        // Poll with timeout
        match poll(&mut poll_fds, timeout) {
            Ok(0) => continue, // timeout
            Ok(_) => {}
            Err(nix::errno::Errno::EINTR) => continue,
            Err(e) => {
                error!("poll error: {e}");
                return Err(e.into());
            }
        }

        // Check PTY master for output
        if let Some(revents) = poll_fds[0].revents() {
            if revents.contains(PollFlags::POLLIN) {
                match nix::unistd::read(master_fd, &mut pty_buf) {
                    Ok(0) => {
                        debug!("PTY master EOF");
                        let code = wait_for_child(child_pid);
                        send_exited(&mut agent_conn, code);
                        return Ok(());
                    }
                    Ok(n) => {
                        let data = &pty_buf[..n];
                        ring_buffer.write(data);

                        // Forward to agent if connected
                        if let Some(ref mut conn) = agent_conn {
                            if let Err(e) = protocol::write_frame(conn, MSG_OUTPUT, data) {
                                debug!("Agent connection lost on write: {e}");
                                agent_conn = None;
                            }
                        }
                    }
                    Err(nix::errno::Errno::EAGAIN) => {}
                    Err(nix::errno::Errno::EIO) => {
                        debug!("PTY master EIO — shell likely exited");
                        let code = wait_for_child(child_pid);
                        send_exited(&mut agent_conn, code);
                        return Ok(());
                    }
                    Err(e) => {
                        warn!("PTY read error: {e}");
                    }
                }
            }
            if revents.contains(PollFlags::POLLHUP) || revents.contains(PollFlags::POLLERR) {
                debug!("PTY master HUP/ERR");
                let code = wait_for_child(child_pid);
                send_exited(&mut agent_conn, code);
                return Ok(());
            }
        }

        // Check listener for new agent connections
        if let Some(revents) = poll_fds[1].revents() {
            if revents.contains(PollFlags::POLLIN) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        info!("Agent connected");
                        // Replace any existing connection
                        agent_conn = None;

                        // Send buffer replay
                        let buffered = ring_buffer.read_all();
                        if protocol::write_frame(&mut stream, MSG_BUFFER_REPLAY, &buffered).is_err()
                        {
                            warn!("Failed to send buffer replay");
                            continue;
                        }

                        // Send ready signal
                        if protocol::write_frame(&mut stream, MSG_READY, &[]).is_err() {
                            warn!("Failed to send ready");
                            continue;
                        }

                        stream.set_nonblocking(true)?;
                        agent_conn = Some(stream);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => {
                        warn!("Listener accept error: {e}");
                    }
                }
            }
        }

        // Check agent connection for incoming frames
        if agent_conn.is_some() && poll_fds.len() > 2 {
            if let Some(revents) = poll_fds[2].revents() {
                if revents.contains(PollFlags::POLLIN) {
                    let should_disconnect =
                        handle_agent_input(agent_conn.as_mut().unwrap(), master_fd, child_pid);
                    if let Some(should_exit) = should_disconnect {
                        if should_exit {
                            // Kill was requested
                            let _ = nix::sys::signal::kill(
                                child_pid,
                                nix::sys::signal::Signal::SIGTERM,
                            );
                            let code = wait_for_child(child_pid);
                            send_exited(&mut agent_conn, code);
                            return Ok(());
                        }
                        // Agent disconnected
                        info!("Agent disconnected");
                        agent_conn = None;
                    }
                }
                if revents.contains(PollFlags::POLLHUP) || revents.contains(PollFlags::POLLERR) {
                    info!("Agent connection HUP/ERR");
                    agent_conn = None;
                }
            }
        }
    }
}

/// Handle a readable event on the agent connection.
///
/// Returns:
/// - `None` — frame processed normally
/// - `Some(false)` — agent disconnected (EOF or error)
/// - `Some(true)` — kill requested, daemon should exit
fn handle_agent_input(conn: &mut UnixStream, master_fd: i32, child_pid: Pid) -> Option<bool> {
    // Temporarily set blocking for frame read with a short timeout
    let _ = conn.set_nonblocking(false);
    let _ = conn.set_read_timeout(Some(std::time::Duration::from_millis(100)));

    let frame = match protocol::read_frame(conn) {
        Ok(Some(f)) => f,
        Ok(None) => {
            let _ = conn.set_nonblocking(true);
            return Some(false); // EOF
        }
        Err(ref e)
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut =>
        {
            let _ = conn.set_nonblocking(true);
            return None; // no data yet
        }
        Err(e) => {
            debug!("Agent frame read error: {e}");
            let _ = conn.set_nonblocking(true);
            return Some(false);
        }
    };

    let _ = conn.set_nonblocking(true);

    match frame.msg_type {
        MSG_INPUT => {
            if let Err(e) = write_to_pty(master_fd, &frame.payload) {
                warn!("PTY write error: {e}");
            }
            None
        }
        MSG_RESIZE => {
            if let Some((cols, rows)) = protocol::decode_resize(&frame.payload) {
                resize_pty(master_fd, cols, rows);
                debug!("PTY resized to {cols}x{rows}");
            }
            None
        }
        MSG_DETACH => {
            info!("Agent requested detach");
            Some(false)
        }
        MSG_KILL => {
            info!("Agent requested kill");
            let _ = nix::sys::signal::kill(child_pid, nix::sys::signal::Signal::SIGTERM);
            Some(true)
        }
        other => {
            debug!("Unknown frame type from agent: 0x{other:02x}");
            None
        }
    }
}

/// Write data to the PTY master fd.
fn write_to_pty(master_fd: i32, data: &[u8]) -> anyhow::Result<()> {
    let master_file = unsafe { std::fs::File::from_raw_fd(master_fd) };
    let result = (&master_file).write_all(data);
    // Don't drop — we don't own this fd
    std::mem::forget(master_file);
    result.map_err(|e| anyhow::anyhow!("PTY write failed: {e}"))
}

/// Set a file descriptor to non-blocking mode.
fn set_nonblocking(fd: i32) -> anyhow::Result<()> {
    let flags = nix::fcntl::fcntl(fd, nix::fcntl::FcntlArg::F_GETFL)?;
    let mut oflags = nix::fcntl::OFlag::from_bits_truncate(flags);
    oflags |= nix::fcntl::OFlag::O_NONBLOCK;
    nix::fcntl::fcntl(fd, nix::fcntl::FcntlArg::F_SETFL(oflags))?;
    Ok(())
}

/// Wait for the child process to exit and return its exit code.
fn wait_for_child(pid: Pid) -> i32 {
    match waitpid(pid, None) {
        Ok(WaitStatus::Exited(_, code)) => code,
        Ok(WaitStatus::Signaled(_, signal, _)) => 128 + signal as i32,
        _ => -1,
    }
}

/// Send an Exited frame to the agent if connected.
fn send_exited(conn: &mut Option<UnixStream>, code: i32) {
    if let Some(ref mut stream) = conn {
        let payload = protocol::encode_exit_code(code);
        let _ = protocol::write_frame(stream, MSG_EXITED, &payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_dir_contains_user() {
        let dir = socket_dir();
        let dir_str = dir.to_string_lossy();
        assert!(dir_str.starts_with("/tmp/termihub/"));
    }

    /// Test both defaults and env-var overrides sequentially to avoid
    /// race conditions from parallel tests sharing the process environment.
    #[test]
    fn daemon_config_defaults_and_env_overrides() {
        // --- Part 1: test defaults ---
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_SHELL");
        std::env::remove_var("TERMIHUB_COLS");
        std::env::remove_var("TERMIHUB_ROWS");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");
        std::env::remove_var("TERMIHUB_ENV");
        std::env::remove_var("TERMIHUB_COMMAND");
        std::env::remove_var("TERMIHUB_COMMAND_ARGS");

        let config = DaemonConfig::from_env("test-123").unwrap();
        assert_eq!(config.session_id, "test-123");
        assert_eq!(config.shell, "/bin/sh");
        assert_eq!(config.cols, 80);
        assert_eq!(config.rows, 24);
        assert_eq!(config.buffer_size, DEFAULT_BUFFER_SIZE);
        assert!(config.env.is_empty());
        assert!(config.command.is_none());
        assert!(config.command_args.is_empty());
        assert!(config
            .socket_path
            .to_string_lossy()
            .contains("session-test-123.sock"));

        // --- Part 2: test env var overrides ---
        std::env::set_var("TERMIHUB_SOCKET_PATH", "/tmp/test.sock");
        std::env::set_var("TERMIHUB_SHELL", "/bin/zsh");
        std::env::set_var("TERMIHUB_COLS", "120");
        std::env::set_var("TERMIHUB_ROWS", "40");
        std::env::set_var("TERMIHUB_BUFFER_SIZE", "2097152");
        std::env::set_var("TERMIHUB_ENV", r#"{"FOO":"bar","BAZ":"qux"}"#);

        let config = DaemonConfig::from_env("test-456").unwrap();
        assert_eq!(config.socket_path, PathBuf::from("/tmp/test.sock"));
        assert_eq!(config.shell, "/bin/zsh");
        assert_eq!(config.cols, 120);
        assert_eq!(config.rows, 40);
        assert_eq!(config.buffer_size, 2097152);
        assert_eq!(config.env.get("FOO").unwrap(), "bar");
        assert_eq!(config.env.get("BAZ").unwrap(), "qux");

        // --- Part 3: test command env vars ---
        std::env::set_var("TERMIHUB_COMMAND", "docker");
        std::env::set_var(
            "TERMIHUB_COMMAND_ARGS",
            r#"["exec","-it","termihub-abc","/bin/sh"]"#,
        );

        let config = DaemonConfig::from_env("test-789").unwrap();
        assert_eq!(config.command, Some("docker".to_string()));
        assert_eq!(
            config.command_args,
            vec!["exec", "-it", "termihub-abc", "/bin/sh"]
        );

        // Clean up
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_SHELL");
        std::env::remove_var("TERMIHUB_COLS");
        std::env::remove_var("TERMIHUB_ROWS");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");
        std::env::remove_var("TERMIHUB_ENV");
        std::env::remove_var("TERMIHUB_COMMAND");
        std::env::remove_var("TERMIHUB_COMMAND_ARGS");
    }
}
