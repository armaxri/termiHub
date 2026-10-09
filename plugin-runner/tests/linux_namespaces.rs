//! The runner's optional namespace layer (#4237), entered for real.
//!
//! `unshare(CLONE_NEWUSER)` refuses a multi-threaded process, and libtest runs
//! every test on a thread of its own, so this target has no harness: `main`
//! runs single-threaded, like the runner at the point it confines itself.
//!
//! Where the system allows unprivileged user namespaces, it asserts that the
//! process ends up in a fresh network namespace (no interface up,
//! no route to a listener of the original namespace), with its own ids mapped
//! to themselves (a file it creates keeps its owner), no capabilities, its
//! parent-death signal intact, and every socket it opened before — the
//! stand-ins for the IPC channel and a passed bridge socket — still working.
//! It also asserts the home-folder mask of the mount namespace (#4342): a
//! stand-in home folder becomes an empty read-only `tmpfs` in which only the
//! kept install and data folders are reachable — the rest cannot even be
//! `stat`ed — and the working directory moves to the data folder.
//! Where they are not allowed (Docker's default seccomp profile, Ubuntu's
//! AppArmor restriction) it asserts that entering is skipped cleanly and
//! nothing changed.
//!
//! `TERMIHUB_EXPECT_USERNS=1` / `0` (set by the CI Docker legs) also asserts
//! which of the two cases this system is, so a leg cannot silently cover the
//! other one.

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

    use termihub_plugin_runner::sandbox::linux::{mask::Plan, namespaces};

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

    /// The interfaces of the current network namespace that are up.
    fn interfaces_up() -> Vec<String> {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        // SAFETY: `getifaddrs` fills `list`, freed below.
        assert_eq!(unsafe { libc::getifaddrs(&mut list) }, 0, "getifaddrs");
        let mut up = Vec::new();
        let mut entry = list;
        while !entry.is_null() {
            // SAFETY: `entry` is a node of the list `getifaddrs` returned.
            let ifa = unsafe { &*entry };
            if ifa.ifa_flags & libc::IFF_UP as libc::c_uint != 0 {
                // SAFETY: `ifa_name` is a NUL-terminated string in the list.
                let name = unsafe { std::ffi::CStr::from_ptr(ifa.ifa_name) };
                up.push(name.to_string_lossy().into_owned());
            }
            entry = ifa.ifa_next;
        }
        // SAFETY: `list` came from `getifaddrs` and is not used again.
        unsafe { libc::freeifaddrs(list) };
        up.sort();
        up.dedup();
        up
    }

    fn echo(client: &mut impl Write, server: &mut impl Read) {
        client.write_all(b"ping").unwrap();
        let mut buf = [0u8; 4];
        server.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ping");
    }

    pub fn run() {
        let available = namespaces::available();
        match std::env::var("TERMIHUB_EXPECT_USERNS").as_deref() {
            Ok("1") => assert!(available, "user namespaces expected to be available"),
            Ok("0") => assert!(!available, "user namespaces expected to be unavailable"),
            _ => {}
        }
        // A stand-in home folder: a secret, and the plugin's install and data
        // folders inside it.
        let home_dir = tempfile::TempDir::new().unwrap();
        let home = home_dir.path().canonicalize().unwrap();
        let secret = home.join("secret.txt");
        std::fs::write(&secret, b"secret").unwrap();
        let install = home.join("plugins/acme");
        let data = home.join("plugins/.data/acme");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(install.join("manifest.json"), b"{}").unwrap();
        let plan = Plan::mask(
            std::slice::from_ref(&home),
            &[install.clone(), data.clone()],
            &data,
        )
        .unwrap();
        // Opened before: an outside listener, a connected TCP pair (a bridge
        // socket the host would pass in) and a Unix pair (the IPC channel).
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut bridge = TcpStream::connect(address).unwrap();
        let (mut bridge_peer, _) = listener.accept().unwrap();
        let (mut ipc, mut ipc_peer) = UnixStream::pair().unwrap();
        let before = net_namespace();
        let before_up = interfaces_up();
        // SAFETY: `prctl(PR_SET_PDEATHSIG, sig)` takes no pointers.
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
        // SAFETY: neither call takes arguments or can fail.
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };

        let entered = namespaces::enter(&plan).expect("entering never fails half way here");
        assert_eq!(entered, available, "enter() must follow the probe");
        drop(plan);

        if !entered {
            assert_eq!(net_namespace(), before, "nothing may change when skipped");
            assert!(std::fs::metadata(&secret).is_ok(), "no mask when skipped");
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

        // The home folder is masked: nothing but the kept folders is visible,
        // not even as metadata, and the mask itself is read-only.
        let error = std::fs::metadata(&secret).expect_err("the secret must be hidden");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound, "{error}");
        let listed: Vec<_> = std::fs::read_dir(&home)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(listed, vec![std::ffi::OsString::from("plugins")]);
        let error = std::fs::write(home.join("dropped"), b"x").expect_err("read-only mask");
        assert_eq!(error.raw_os_error(), Some(libc::EROFS), "{error}");
        assert_eq!(
            std::fs::read(install.join("manifest.json")).unwrap(),
            b"{}",
            "the install folder is kept"
        );
        assert_eq!(std::env::current_dir().unwrap(), data, "cwd left the mask");

        // Files created in the data folder keep their owner.
        let file = data.join("written-inside");
        std::fs::write(&file, b"x").expect("create a file under the id map");
        assert_eq!(std::fs::metadata(&file).unwrap().uid(), uid);

        // No interface is up (a fresh namespace has a loopback that is down,
        // plus the kernel's fallback tunnel devices where those modules are
        // loaded): the outside listener is unreachable.
        assert!(
            !before_up.is_empty(),
            "the original namespace has a loopback"
        );
        assert_eq!(interfaces_up(), Vec::<String>::new());
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
        println!(
            "linux_namespaces: entered user + net + IPC + mount namespaces; all checks passed"
        );
    }
}
