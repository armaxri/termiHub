//! Process resource limits (#4184): applied by the runner to itself after the
//! handshake and before the plugin library is mapped, so every byte of plugin
//! code runs under them. Best effort: a limit the system refuses is reported on
//! stderr and the load continues (the OS sandbox phases add the hard layers).

use termihub_plugin_runner::ipc::ResourceLimits;

/// Apply `limits` to the current process. Returns the limits that could not be
/// applied, as `(name, error)` pairs.
#[cfg(unix)]
pub(crate) fn apply(limits: &ResourceLimits) -> Vec<(&'static str, std::io::Error)> {
    let mut failed = Vec::new();
    if let Some(files) = limits.max_open_files {
        if let Err(e) = lower(libc::RLIMIT_NOFILE, files) {
            failed.push(("RLIMIT_NOFILE", e));
        }
    }
    // macOS accepts `RLIMIT_AS` but does not enforce it; the host polls the
    // runner's resident size there instead.
    #[cfg(target_os = "linux")]
    if let Some(bytes) = limits.address_space_bytes {
        // glibc reserves 64 MiB of address space per malloc arena and grows
        // one arena per thread; under an address-space cap that spends the
        // budget on reservations, not memory. Two arenas are plenty here.
        #[cfg(target_env = "gnu")]
        // SAFETY: `mallopt` only tunes the allocator; called before any
        // plugin code runs.
        unsafe {
            libc::mallopt(libc::M_ARENA_MAX, 2);
        }
        if let Err(e) = lower(libc::RLIMIT_AS, bytes) {
            failed.push(("RLIMIT_AS", e));
        }
    }
    // On macOS `RLIMIT_NPROC` counts processes only, so 0 forbids `fork` /
    // `posix_spawn` without touching threads. Linux counts threads too; there
    // the seccomp filter of the Linux sandbox phase (#4185) takes this over.
    #[cfg(target_os = "macos")]
    if limits.forbid_child_processes {
        if let Err(e) = lower(libc::RLIMIT_NPROC, 0) {
            failed.push(("RLIMIT_NPROC", e));
        }
    }
    failed
}

#[cfg(not(unix))]
pub(crate) fn apply(_limits: &ResourceLimits) -> Vec<(&'static str, std::io::Error)> {
    // TODO(#4187): the Windows sandbox puts the runner in a job object; its
    // memory and active-process limits belong there.
    Vec::new()
}

/// The resource type `setrlimit` takes on this platform.
#[cfg(all(unix, target_os = "linux", target_env = "gnu"))]
type Resource = libc::__rlimit_resource_t;
#[cfg(all(unix, not(all(target_os = "linux", target_env = "gnu"))))]
type Resource = libc::c_int;

/// Lower both the soft and the hard limit of `resource` to `value` (never
/// raise either): lowering the hard limit too keeps the plugin from lifting
/// the soft one back up.
#[cfg(unix)]
fn lower(resource: Resource, value: u64) -> std::io::Result<()> {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `current` is a valid, writable `rlimit`.
    if unsafe { libc::getrlimit(resource, &mut current) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let wanted = libc::rlim_t::try_from(value).unwrap_or(libc::RLIM_INFINITY);
    let cap = |limit: libc::rlim_t| {
        if limit == libc::RLIM_INFINITY {
            wanted
        } else {
            limit.min(wanted)
        }
    };
    let next = libc::rlimit {
        rlim_cur: cap(current.rlim_cur),
        rlim_max: cap(current.rlim_max),
    };
    // SAFETY: `next` is a valid `rlimit` that only lowers the current one.
    if unsafe { libc::setrlimit(resource, &next) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn no_limits_apply_nothing() {
        assert!(apply(&ResourceLimits::default()).is_empty());
    }
}
