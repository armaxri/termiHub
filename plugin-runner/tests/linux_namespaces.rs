//! The runner's optional namespace layer (#4237), entered for real.
//!
//! `unshare(CLONE_NEWUSER)` refuses a multi-threaded process, and libtest runs
//! every test on a thread of its own, so this target has no harness: `main`
//! runs single-threaded, like the runner at the point it confines itself.
//!
//! Where the system allows unprivileged user namespaces, it asserts that the
//! process ends up in a fresh network namespace (only a loopback that is down,
//! no route to a listener of the original namespace), with its own ids mapped
//! to themselves (a file it creates keeps its owner), no capabilities, its
//! parent-death signal intact, and every socket it opened before — the
//! stand-ins for the IPC channel and a passed bridge socket — still working.
//! Where they are not allowed (Docker's default seccomp profile, Ubuntu's
//! AppArmor restriction) it asserts that entering is skipped cleanly and
//! nothing changed.

#[cfg(not(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
)))]
fn main() {}

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
fn main() {
    linux::run();
}

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
mod linux {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    use termihub_plugin_runner::sandbox::linux::namespaces;

    fn net_namespace() -> std::path::PathBuf {
        std::fs::read_link("/proc/self/ns/net").expect("readlink /proc/self/ns/net")
    }

    fn parent_death_signal() -> libc::c_int {
        let mut signal: libc::c_int = 0;
        // SAFETY: `prctl(PR_GET_PDEATHSIG, &int)` writes one `int`.
        unsafe { libc::prctl(libc::PR_GET_PDEATHSIG, &mut signal) };
        signal
    }

    /// `CapPrm` / `CapEff` / `CapInh` / `CapAmb` from `/proc/self/status`.
    fn capability_sets() -> Vec<(String, u64)> {
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .filter_map(|line| {
                let (key, value) = line.split_once(':')?;
                ["CapInh", "CapPrm", "CapEff", "CapAmb"]
                    .contains(&key)
                    .then(|| {
                        (
                            key.to_owned(),
                            u64::from_str_radix(value.trim(), 16).unwrap(),
                        )
                    })
            })
            .collect()
    }

    /// The interface names of the current network namespace.
    fn interfaces() -> Vec<String> {
        std::fs::read_to_string("/proc/net/dev")
            .unwrap()
            .lines()
            .skip(2)
            .filter_map(|line| line.split_once(':').map(|(name, _)| name.trim().to_owned()))
            .collect()
    }

    fn echo(client: &mut impl Write, server: &mut impl Read) {
        client.write_all(b"ping").unwrap();
        let mut buf = [0u8; 4];
        server.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ping");
    }

    pub fn run() {
        let available = namespaces::available();
        let data = tempfile::TempDir::new().unwrap();
        // Opened before: an outside listener, a connected TCP pair (a bridge
        // socket the host would pass in) and a Unix pair (the IPC channel).
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut bridge = TcpStream::connect(address).unwrap();
        let (mut bridge_peer, _) = listener.accept().unwrap();
        let (mut ipc, mut ipc_peer) = UnixStream::pair().unwrap();
        let before = net_namespace();
        // SAFETY: `prctl(PR_SET_PDEATHSIG, sig)` takes no pointers.
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
        // SAFETY: neither call takes arguments or can fail.
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };

        let entered = namespaces::enter().expect("entering never fails half way here");
        assert_eq!(entered, available, "enter() must follow the probe");

        if !entered {
            assert_eq!(net_namespace(), before, "nothing may change when skipped");
            println!("linux_namespaces: unprivileged user namespaces unavailable; skipped cleanly");
            return;
        }

        assert_ne!(net_namespace(), before, "a fresh network namespace");
        // SAFETY: as above.
        let (new_uid, new_gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        assert_eq!((new_uid, new_gid), (uid, gid), "ids mapped to themselves");
        for (set, value) in capability_sets() {
            assert_eq!(value, 0, "{set} must be empty");
        }
        assert_eq!(
            parent_death_signal(),
            libc::SIGKILL,
            "parent-death signal kept"
        );

        // Files created in the data folder keep their owner.
        let file = data.path().join("written-inside");
        std::fs::write(&file, b"x").expect("create a file under the id map");
        assert_eq!(std::fs::metadata(&file).unwrap().uid(), uid);

        // Only a loopback, and it is down: the outside listener is unreachable.
        assert_eq!(interfaces(), vec!["lo".to_owned()]);
        let fresh = TcpStream::connect_timeout(&address, Duration::from_secs(2));
        assert!(
            fresh.is_err(),
            "a new connection must not leave the namespace"
        );

        // What was opened before keeps working, both ways.
        echo(&mut bridge, &mut bridge_peer);
        echo(&mut bridge_peer, &mut bridge);
        echo(&mut ipc, &mut ipc_peer);
        echo(&mut ipc_peer, &mut ipc);
        println!("linux_namespaces: entered user + net + IPC namespaces; all checks passed");
    }
}
