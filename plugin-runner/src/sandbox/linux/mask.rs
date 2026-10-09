//! The home-folder mask of the namespace layer (#4342; audit SEC2-003 and
//! SEC2-006).
//!
//! landlock decides who may *open* a path, but not who may `stat`,
//! `readlink` or `access` it, so a confined plugin could still probe which
//! files exist under the user's home folder, how large they are and when they
//! changed (`~/.ssh/id_ed25519`, termiHub's own configuration). Without
//! landlock (reduced isolation) it could even read and write them.
//!
//! Where the runner enters its user namespace it also enters a private mount
//! namespace and, before landlock and seccomp, replaces each denied folder of
//! the policy (the home folder) with an empty, read-only `tmpfs`. The
//! plugin's install and data folders, which usually live inside the home
//! folder, are bind-mounted back at their own paths, so every path the plugin
//! is given keeps working. Lookups of anything else under the home folder fail
//! with `ENOENT`, whatever landlock does or does not mediate.
//!
//! A [`Plan`] is built in full before the runner forks or unshares — every
//! path a ready `CString` — so [`Plan::run`] allocates nothing and makes only
//! async-signal-safe system calls, and can run in the throw-away child that
//! tests whether the namespace layer is available. The folders to keep are
//! opened (as `O_PATH` descriptors) by [`Plan::run`] itself, inside the new
//! mount namespace and before the `tmpfs` hides their paths, then bound
//! through `/proc/self/fd/<n>`: a bind mount's source must be a mount of the
//! caller's own namespace, so a descriptor opened before `unshare` would be
//! refused with `EINVAL`.
//!
//! The process's working directory is moved to the data folder (or `/`) at
//! the end: a working directory inside the masked folder would keep a
//! reference to the original tree below the mount, and relative paths would
//! reach it.

use std::ffi::{CStr, CString};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use super::super::SandboxPolicy;

/// Mount options of the masking `tmpfs`: owned by the runner's (mapped) uid,
/// readable to it, never writable once remounted read-only.
const TMPFS_OPTIONS: &CStr = c"mode=0755";

/// How many folders one plan can keep (the install and the data folder need
/// two; the descriptors live in a fixed array on [`Plan::run`]'s stack).
const MAX_KEPT: usize = 8;

/// One mount-namespace operation.
#[derive(Debug)]
enum Step {
    /// Make every mount private, so nothing propagates back to the host.
    Private,
    /// Mount an empty `tmpfs` over the folder.
    Tmpfs(CString),
    /// Open a kept folder (`O_PATH`) into descriptor slot `slot`.
    Open { path: CString, slot: usize },
    /// Create a folder inside the `tmpfs` (an existing one is fine).
    MkDir(CString),
    /// Bind-mount the folder held in slot `slot` at `target`, then close it.
    Bind { slot: usize, target: CString },
    /// Make the `tmpfs` at the folder read-only.
    ReadOnly(CString),
    /// Change the working directory.
    Chdir(CString),
}

/// A failed step: what it did, and the `errno`.
pub type StepError = (&'static str, i32);

/// The mount-namespace operations of the namespace layer, prepared before
/// `fork` / `unshare`.
#[derive(Debug, Default)]
pub struct Plan {
    steps: Vec<Step>,
}

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

fn is_dir(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

/// `paths` without any path that lies inside another one of them (or
/// repeats it).
fn outermost(mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.sort();
    paths.dedup();
    let all = paths.clone();
    paths.retain(|p| !all.iter().any(|q| q != p && p.starts_with(q)));
    paths
}

impl Plan {
    /// The plan for `policy`: mask its denied folders (the home folder),
    /// keeping its install folder and, when it exists, its data folder.
    pub fn for_policy(policy: &SandboxPolicy) -> io::Result<Self> {
        let mut keep = vec![PathBuf::from(&policy.install_dir)];
        let data = policy
            .data_dir
            .as_deref()
            .map(PathBuf::from)
            .filter(|d| is_dir(d));
        keep.extend(data.clone());
        let denied: Vec<PathBuf> = policy.denied_dirs.iter().map(PathBuf::from).collect();
        let workdir = data.unwrap_or_else(|| PathBuf::from("/"));
        Self::mask(&denied, &keep, &workdir)
    }

    /// The plan the availability probe runs without a policy: the same
    /// operations as a real plan, on the temporary folder and inside the
    /// probe's own throw-away namespace — keep the folder itself, mask it with
    /// a `tmpfs`, bind the kept folder back below the mask, make the mask
    /// read-only.
    #[must_use]
    pub fn probe() -> Self {
        let temp = std::env::temp_dir();
        let mut plan = Self::default();
        plan.steps.push(Step::Private);
        let paths = c_path(&temp).and_then(|t| Ok((t, c_path(&temp.join("termihub-probe"))?)));
        if let (true, Ok((temp, inner))) = (is_dir(&temp), paths) {
            plan.steps.extend([
                Step::Open {
                    path: temp.clone(),
                    slot: 0,
                },
                Step::Tmpfs(temp.clone()),
                Step::MkDir(inner.clone()),
                Step::Bind {
                    slot: 0,
                    target: inner,
                },
                Step::ReadOnly(temp),
            ]);
        }
        plan.steps.push(Step::Chdir(c"/".to_owned()));
        plan
    }

    /// Mask each folder of `denied` that exists, keep the folders of `keep`
    /// (absolute, canonical) reachable at their paths, then make `workdir`
    /// the working directory. A denied folder inside another one, or one that
    /// is (or lies inside) a kept folder, is not masked separately.
    pub fn mask(denied: &[PathBuf], keep: &[PathBuf], workdir: &Path) -> io::Result<Self> {
        let keep = outermost(keep.to_vec());
        let denied: Vec<PathBuf> =
            outermost(denied.iter().filter(|d| is_dir(d)).cloned().collect())
                .into_iter()
                .filter(|d| !keep.iter().any(|k| d.starts_with(k)))
                .collect();
        if keep.len() > MAX_KEPT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "too many folders to keep",
            ));
        }
        let mut plan = Self::default();
        plan.steps.push(Step::Private);
        for dir in &denied {
            let kept: Vec<(usize, &PathBuf)> = keep
                .iter()
                .enumerate()
                .filter(|(_, k)| k.starts_with(dir))
                .collect();
            // Open them first: once the tmpfs is mounted their paths name the
            // empty mask, while the descriptors still name the folders.
            for (slot, path) in &kept {
                plan.steps.push(Step::Open {
                    path: c_path(path)?,
                    slot: *slot,
                });
            }
            plan.steps.push(Step::Tmpfs(c_path(dir)?));
            for (slot, path) in kept {
                let mut parent = dir.clone();
                for part in path.strip_prefix(dir).unwrap_or(Path::new("")) {
                    parent.push(part);
                    plan.steps.push(Step::MkDir(c_path(&parent)?));
                }
                plan.steps.push(Step::Bind {
                    slot,
                    target: c_path(path)?,
                });
            }
            plan.steps.push(Step::ReadOnly(c_path(dir)?));
        }
        plan.steps.push(Step::Chdir(c_path(workdir)?));
        Ok(plan)
    }

    /// The folders this plan masks.
    #[must_use]
    pub fn masked(&self) -> Vec<&CStr> {
        self.steps
            .iter()
            .filter_map(|s| match s {
                Step::Tmpfs(dir) => Some(dir.as_c_str()),
                _ => None,
            })
            .collect()
    }

    /// Run the steps in the calling process's (new) mount namespace. Needs
    /// `CAP_SYS_ADMIN` in the user namespace that owns it. Async-signal-safe:
    /// only system calls on memory prepared by the constructor.
    pub fn run(&self) -> Result<(), StepError> {
        let mut fds: [libc::c_int; MAX_KEPT] = [-1; MAX_KEPT];
        let result = self.run_steps(&mut fds);
        for fd in fds.into_iter().filter(|fd| *fd >= 0) {
            // SAFETY: a descriptor `run_steps` opened and did not close.
            unsafe { libc::close(fd) };
        }
        result
    }

    fn run_steps(&self, fds: &mut [libc::c_int; MAX_KEPT]) -> Result<(), StepError> {
        let check = |what: &'static str, rc: libc::c_int| {
            if rc == 0 {
                Ok(())
            } else {
                Err((what, super::namespaces::errno()))
            }
        };
        let null = std::ptr::null::<libc::c_char>();
        for step in &self.steps {
            // SAFETY (every call below): the strings are NUL-terminated and
            // live as long as `self`; NULL is passed where the call allows it.
            match step {
                Step::Private => check("make the mounts private", unsafe {
                    libc::mount(
                        null,
                        c"/".as_ptr(),
                        null,
                        libc::MS_REC | libc::MS_PRIVATE,
                        std::ptr::null(),
                    )
                })?,
                Step::Tmpfs(dir) => check("mount the masking tmpfs", unsafe {
                    libc::mount(
                        c"tmpfs".as_ptr(),
                        dir.as_ptr(),
                        c"tmpfs".as_ptr(),
                        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
                        TMPFS_OPTIONS.as_ptr().cast(),
                    )
                })?,
                Step::Open { path, slot } => {
                    // SAFETY: as above.
                    let fd = unsafe {
                        libc::open(
                            path.as_ptr(),
                            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
                        )
                    };
                    if fd < 0 {
                        return Err(("open a kept folder", super::namespaces::errno()));
                    }
                    fds[*slot] = fd;
                }
                Step::MkDir(dir) => {
                    // SAFETY: as above.
                    let rc = unsafe { libc::mkdir(dir.as_ptr(), 0o755) };
                    if rc != 0 && super::namespaces::errno() != libc::EEXIST {
                        return Err(("create a mount point", super::namespaces::errno()));
                    }
                }
                Step::Bind { slot, target } => {
                    let source = FdPath::new(fds[*slot]);
                    // SAFETY: as above; `source` is NUL-terminated.
                    let rc = unsafe {
                        libc::mount(
                            source.as_ptr(),
                            target.as_ptr(),
                            null,
                            libc::MS_BIND | libc::MS_REC,
                            std::ptr::null(),
                        )
                    };
                    check("bind a kept folder", rc)?;
                    // SAFETY: the descriptor opened by `Step::Open`.
                    unsafe { libc::close(fds[*slot]) };
                    fds[*slot] = -1;
                }
                Step::ReadOnly(dir) => check("make the masking tmpfs read-only", unsafe {
                    libc::mount(
                        null,
                        dir.as_ptr(),
                        null,
                        libc::MS_REMOUNT
                            | libc::MS_BIND
                            | libc::MS_RDONLY
                            | libc::MS_NOSUID
                            | libc::MS_NODEV
                            | libc::MS_NOEXEC,
                        std::ptr::null(),
                    )
                })?,
                Step::Chdir(dir) => check("change the working directory", unsafe {
                    libc::chdir(dir.as_ptr())
                })?,
            }
        }
        Ok(())
    }
}

/// `/proc/self/fd/<fd>` as a NUL-terminated string on the stack (no
/// allocation: [`Plan::run`] must stay async-signal-safe).
struct FdPath {
    bytes: [u8; 32],
}

impl FdPath {
    fn new(fd: libc::c_int) -> Self {
        const PREFIX: &[u8] = b"/proc/self/fd/";
        let mut bytes = [0u8; 32];
        bytes[..PREFIX.len()].copy_from_slice(PREFIX);
        let mut digits = [0u8; 10];
        let mut n = fd.unsigned_abs();
        let mut len = 0;
        loop {
            digits[len] = b'0' + (n % 10) as u8;
            len += 1;
            n /= 10;
            if n == 0 {
                break;
            }
        }
        for (i, digit) in digits[..len].iter().rev().enumerate() {
            bytes[PREFIX.len() + i] = *digit;
        }
        Self { bytes }
    }

    fn as_ptr(&self) -> *const libc::c_char {
        self.bytes.as_ptr().cast()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steps(plan: &Plan) -> Vec<String> {
        plan.steps
            .iter()
            .map(|s| match s {
                Step::Private => "private".to_owned(),
                Step::Tmpfs(d) => format!("tmpfs {}", d.to_string_lossy()),
                Step::Open { path, slot } => format!("open {slot} {}", path.to_string_lossy()),
                Step::MkDir(d) => format!("mkdir {}", d.to_string_lossy()),
                Step::Bind { slot, target } => {
                    format!("bind {slot} {}", target.to_string_lossy())
                }
                Step::ReadOnly(d) => format!("ro {}", d.to_string_lossy()),
                Step::Chdir(d) => format!("chdir {}", d.to_string_lossy()),
            })
            .collect()
    }

    /// The home folder is masked, the install and data folders inside it are
    /// bound back (their parents created in the tmpfs first), the mask is
    /// made read-only last, and the working directory leaves the mask.
    #[test]
    fn the_home_folder_is_masked_and_the_plugin_folders_are_kept() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let install = home.join("plugins/acme");
        let data = home.join("plugins/.data/acme");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let plan = Plan::mask(
            std::slice::from_ref(&home),
            &[install.clone(), data.clone()],
            &data,
        )
        .unwrap();
        let h = home.display();
        assert_eq!(
            steps(&plan),
            vec![
                "private".to_owned(),
                format!("open 0 {h}/plugins/.data/acme"),
                format!("open 1 {h}/plugins/acme"),
                format!("tmpfs {h}"),
                format!("mkdir {h}/plugins"),
                format!("mkdir {h}/plugins/.data"),
                format!("mkdir {h}/plugins/.data/acme"),
                format!("bind 0 {h}/plugins/.data/acme"),
                format!("mkdir {h}/plugins"),
                format!("mkdir {h}/plugins/acme"),
                format!("bind 1 {h}/plugins/acme"),
                format!("ro {h}"),
                format!("chdir {h}/plugins/.data/acme"),
            ]
        );
        assert_eq!(plan.masked(), vec![c_path(&home).unwrap().as_c_str()]);
    }

    /// Nothing to mask when the denied folder does not exist or is itself a
    /// kept folder (or inside one); nested denied folders are masked once.
    #[test]
    fn degenerate_policies_mask_nothing_twice() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let install = root.join("install");
        std::fs::create_dir_all(install.join("inner")).unwrap();
        let missing = root.join("missing");
        let plan = Plan::mask(
            &[missing, install.clone(), install.join("inner")],
            std::slice::from_ref(&install),
            Path::new("/"),
        )
        .unwrap();
        assert_eq!(steps(&plan), vec!["private", "chdir /"]);

        let outer = root.join("outer");
        std::fs::create_dir_all(outer.join("nested")).unwrap();
        let plan = Plan::mask(&[outer.join("nested"), outer.clone()], &[], Path::new("/")).unwrap();
        assert_eq!(plan.masked(), vec![c_path(&outer).unwrap().as_c_str()]);
    }

    /// A policy without a data folder keeps only the install folder and
    /// leaves the working directory at `/`.
    #[test]
    fn a_policy_without_data_folder_works_from_the_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let install = home.join("acme");
        std::fs::create_dir_all(&install).unwrap();
        let policy = SandboxPolicy {
            install_dir: install.to_str().unwrap().to_owned(),
            data_dir: Some(home.join("absent").to_str().unwrap().to_owned()),
            denied_dirs: vec![home.to_str().unwrap().to_owned()],
            simulate_missing: Vec::new(),
        };
        let plan = Plan::for_policy(&policy).unwrap();
        let s = steps(&plan);
        assert_eq!(s.last().map(String::as_str), Some("chdir /"));
        assert!(s.contains(&format!("bind 0 {}", install.display())));
        assert!(!s.iter().any(|step| step.contains("absent")));
    }

    #[test]
    fn descriptor_paths_are_spelled_without_allocating() {
        let read = |fd| {
            let path = FdPath::new(fd);
            // SAFETY: `FdPath` is NUL-terminated.
            unsafe { CStr::from_ptr(path.as_ptr()) }
                .to_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(read(0), "/proc/self/fd/0");
        assert_eq!(read(7), "/proc/self/fd/7");
        assert_eq!(read(255), "/proc/self/fd/255");
        assert_eq!(read(i32::MAX), "/proc/self/fd/2147483647");
    }
}
