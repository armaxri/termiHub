//! Host-expanded placeholders in a manifest's `filesystemPaths` (#4533).
//!
//! A `filesystemPaths` entry is normally an absolute path, which cannot name a
//! folder below the user's home portably (`/home/alice/.kube`,
//! `/Users/alice/.kube` and `C:\Users\alice\.kube` are three different
//! manifests). An entry may therefore **start** with one of a small, fixed set
//! of placeholders, which the host replaces with the matching folder of the
//! user running termiHub when the plugin is loaded — never when it is packed:
//!
//! | Placeholder | Resolves to                                                        |
//! | ----------- | ------------------------------------------------------------------ |
//! | `${home}`   | the home folder (`$HOME`; `%USERPROFILE%` on Windows)              |
//! | `${config}` | the user config folder: `$XDG_CONFIG_HOME` or `~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows |
//!
//! # Security rules
//!
//! The expansion is part of the plugin sandbox's policy, so it is strict:
//!
//! * **Only the documented placeholders are recognised.** `${HOME}`, `${env}`,
//!   `${home` and every other `${…}` form is rejected, never passed through
//!   as a literal folder name, and a placeholder may only be the first
//!   segment (`/data/${home}` is rejected).
//! * **The rest of the entry is plain relative segments** separated by `/`:
//!   no `.`/`..`, no `\`, no `:`, no NUL, and no segment ending in `.` or a
//!   space (Windows strips those, which would turn `.. ` into `..`).
//! * **A bare placeholder is refused** — `${home}` is the whole home folder
//!   and `${config}` contains termiHub's own settings, both over-broad.
//! * **The resolved path goes through every existing check**: it must be an
//!   absolute, normalised path below a filesystem root
//!   ([`check_declared_filesystem_path`](super::check_declared_filesystem_path)),
//!   and at load the home/termiHub-folder deny list
//!   ([`PermissionSet::check_protected_folders`](super::PermissionSet::check_protected_folders))
//!   applies to it, compared both lexically and canonically. That check also
//!   refuses a resolved root whose symlink-resolved form leaves the
//!   placeholder's folder.
//!
//! The pure functions here take the folders as [`PlaceholderBases`], so every
//! OS's path style is unit-testable on any host.

/// The `${home}` placeholder: the user's home folder.
pub const HOME_PLACEHOLDER: &str = "${home}";

/// The `${config}` placeholder: the user's per-user config folder.
pub const CONFIG_PLACEHOLDER: &str = "${config}";

/// Why an entry that uses a placeholder is invalid: an unknown placeholder.
pub(crate) const UNKNOWN_PLACEHOLDER: &str =
    "uses an unknown placeholder (only `${home}` and `${config}` are supported)";

/// One of the recognised `filesystemPaths` placeholders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathPlaceholder {
    /// [`HOME_PLACEHOLDER`].
    Home,
    /// [`CONFIG_PLACEHOLDER`].
    Config,
}

impl PathPlaceholder {
    /// The placeholder as written in a manifest (`${home}`, `${config}`).
    #[must_use]
    pub fn token(self) -> &'static str {
        match self {
            Self::Home => HOME_PLACEHOLDER,
            Self::Config => CONFIG_PLACEHOLDER,
        }
    }
}

/// The folders the placeholders resolve to on one host.
///
/// [`host`](Self::host) reads them from the running user's environment;
/// tests build them explicitly with [`new`](Self::new). A `None` folder (or one
/// that is not valid UTF-8) makes every entry using that placeholder fail to
/// resolve, so the plugin is refused rather than granted a guess.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlaceholderBases {
    home: Option<String>,
    config: Option<String>,
}

impl PlaceholderBases {
    /// Explicit folders for `${home}` and `${config}`.
    #[must_use]
    pub fn new(home: Option<&str>, config: Option<&str>) -> Self {
        Self {
            home: home.map(str::to_owned),
            config: config.map(str::to_owned),
        }
    }

    /// The folders of the user running termiHub.
    #[must_use]
    pub fn host() -> Self {
        Self::from_env(&|name| std::env::var(name).ok())
    }

    /// The folders, reading environment variables through `lookup` (the pure
    /// core of [`host`](Self::host)).
    fn from_env(lookup: &dyn Fn(&str) -> Option<String>) -> Self {
        let home = crate::config::home_directory()
            .and_then(|p| p.to_str().map(str::to_owned))
            .filter(|s| !s.is_empty());
        let config = user_config_dir(home.as_deref(), lookup);
        Self { home, config }
    }

    /// The folder `placeholder` resolves to on this host, if any.
    #[must_use]
    pub fn base(&self, placeholder: PathPlaceholder) -> Option<&str> {
        match placeholder {
            PathPlaceholder::Home => self.home.as_deref(),
            PathPlaceholder::Config => self.config.as_deref(),
        }
    }
}

/// The per-user config folder, matching the `dirs` crate's `config_dir`.
fn user_config_dir(home: Option<&str>, lookup: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    if cfg!(windows) {
        lookup("APPDATA").filter(|s| !s.is_empty())
    } else if cfg!(target_os = "macos") {
        home.map(|h| join(h, &["Library", "Application Support"]))
    } else {
        lookup("XDG_CONFIG_HOME")
            .filter(|s| s.starts_with('/'))
            .or_else(|| home.map(|h| join(h, &[".config"])))
    }
}

/// An entry split into its leading placeholder and the relative segments after
/// it. `None` from [`parse`] means the entry uses no placeholder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlaceholderPath<'a> {
    pub(crate) placeholder: PathPlaceholder,
    pub(crate) segments: Vec<&'a str>,
}

/// Parse an entry that may start with a placeholder.
///
/// * `Ok(None)` — the entry contains no `${`, so it is an ordinary path for
///   [`check_declared_filesystem_path`](super::check_declared_filesystem_path).
/// * `Ok(Some(_))` — a recognised placeholder followed by valid segments.
/// * `Err(reason)` — anything else that contains `${`.
pub(crate) fn parse(raw: &str) -> Result<Option<PlaceholderPath<'_>>, &'static str> {
    if !raw.contains("${") {
        return Ok(None);
    }
    let Some(rest) = raw.strip_prefix("${") else {
        return Err("uses a placeholder that is not the first segment");
    };
    let Some(end) = rest.find('}') else {
        return Err(UNKNOWN_PLACEHOLDER);
    };
    let placeholder = match &rest[..end] {
        "home" => PathPlaceholder::Home,
        "config" => PathPlaceholder::Config,
        _ => return Err(UNKNOWN_PLACEHOLDER),
    };
    let tail = &rest[end + 1..];
    if tail.split('/').all(str::is_empty) {
        return Err(match placeholder {
            PathPlaceholder::Home => "is your whole home folder, which is too broad",
            PathPlaceholder::Config => {
                "is your whole config folder, which contains termiHub's own settings"
            }
        });
    }
    let Some(tail) = tail.strip_prefix('/') else {
        return Err("must separate a placeholder from the rest of the path with `/`");
    };
    if tail.contains("${") {
        return Err("uses a placeholder that is not the first segment");
    }
    let segments: Vec<&str> = tail.split('/').filter(|s| !s.is_empty()).collect();
    for segment in &segments {
        check_segment(segment)?;
    }
    Ok(Some(PlaceholderPath {
        placeholder,
        segments,
    }))
}

/// Reject a segment after a placeholder that could change the path's meaning
/// on some OS once joined to the base folder.
fn check_segment(segment: &str) -> Result<(), &'static str> {
    if segment == "." || segment == ".." {
        return Err("contains a `.` or `..` segment");
    }
    if segment.contains('\0') {
        return Err("contains a NUL byte");
    }
    if segment.contains('\\') {
        return Err("uses `\\` after a placeholder; separate folders with `/`");
    }
    if segment.contains(':') {
        return Err("contains `:` after a placeholder");
    }
    if segment.ends_with('.') || segment.ends_with(' ') {
        return Err("has a folder name after a placeholder that ends in `.` or a space");
    }
    Ok(())
}

/// The manifest-level check for one `filesystemPaths` entry: a valid
/// placeholder form, or an ordinary absolute path that passes
/// [`check_declared_filesystem_path`](super::check_declared_filesystem_path).
/// Host-independent, so a manifest validates the same everywhere.
pub fn check_manifest_filesystem_path(raw: &str) -> Result<(), &'static str> {
    match parse(raw)? {
        Some(_) => Ok(()),
        None => super::check_declared_filesystem_path(raw),
    }
}

/// An entry resolved against a host's [`PlaceholderBases`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Resolved {
    /// The path to use as the scope root (the entry itself when it has no
    /// placeholder).
    pub(crate) path: String,
    /// The placeholder's folder, when the entry used one: the resolved root
    /// must stay inside it once symlinks are resolved.
    pub(crate) anchor: Option<String>,
}

/// Resolve `raw` against `bases` and re-validate the result as an ordinary
/// absolute path. Never returns a path that still contains a placeholder.
pub(crate) fn resolve(raw: &str, bases: &PlaceholderBases) -> Result<Resolved, &'static str> {
    let Some(parsed) = parse(raw)? else {
        super::check_declared_filesystem_path(raw)?;
        return Ok(Resolved {
            path: raw.to_owned(),
            anchor: None,
        });
    };
    let base = bases
        .base(parsed.placeholder)
        .ok_or(match parsed.placeholder {
            PathPlaceholder::Home => "uses `${home}`, but this computer has no home folder",
            PathPlaceholder::Config => "uses `${config}`, but this computer has no config folder",
        })?;
    // The base comes from the environment, so it is checked like a declared
    // path: absolute, normalised, not a root, and free of `${`.
    if super::check_declared_filesystem_path(base).is_err() {
        return Err(
            "uses a placeholder whose folder on this computer is not a valid absolute path",
        );
    }
    let path = join(base, &parsed.segments);
    super::check_declared_filesystem_path(&path)?;
    Ok(Resolved {
        path,
        anchor: Some(base.to_owned()),
    })
}

/// Join relative `segments` onto `base` with the separator of `base`'s own
/// path style (`\` for a drive-letter or UNC base, `/` otherwise).
fn join(base: &str, segments: &[&str]) -> String {
    let bytes = base.as_bytes();
    let windows = base.starts_with("\\\\")
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':');
    let sep = if windows { '\\' } else { '/' };
    let mut out = base.trim_end_matches(['/', '\\']).to_owned();
    for segment in segments {
        out.push(sep);
        out.push_str(segment);
    }
    out
}

/// A `filesystemPaths` entry that uses a placeholder, with the folder it
/// resolves to on this computer — what the install dialog and the access
/// summary show next to the declared form, so consent names the real folder.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFilesystemPath {
    /// The entry as declared in the manifest (e.g. `${home}/.kube`).
    pub declared: String,
    /// The folder it resolves to on this computer, or `null` when it cannot be
    /// resolved here (the plugin is then refused at load).
    pub resolved: Option<String>,
}

/// The placeholder entries of `paths`, each with its resolved folder on the
/// host described by `bases`. Entries without a placeholder are omitted.
#[must_use]
pub fn resolve_filesystem_paths(
    paths: &[String],
    bases: &PlaceholderBases,
) -> Vec<ResolvedFilesystemPath> {
    paths
        .iter()
        .filter(|p| p.contains("${"))
        .map(|p| ResolvedFilesystemPath {
            declared: p.clone(),
            resolved: resolve(p, bases).ok().map(|r| r.path),
        })
        .collect()
}

/// [`resolve_filesystem_paths`] against this host's folders.
#[must_use]
pub fn resolve_filesystem_paths_for_host(paths: &[String]) -> Vec<ResolvedFilesystemPath> {
    if !paths.iter().any(|p| p.contains("${")) {
        return Vec::new();
    }
    resolve_filesystem_paths(paths, &PlaceholderBases::host())
}

#[cfg(test)]
mod tests {
    use super::*;

    const POSIX: (&str, &str) = ("/home/alice", "/home/alice/.config");
    const MACOS: (&str, &str) = ("/Users/alice", "/Users/alice/Library/Application Support");
    const WINDOWS: (&str, &str) = (r"C:\Users\alice", r"C:\Users\alice\AppData\Roaming");
    const UNC: (&str, &str) = (r"\\server\users\alice", r"\\server\users\alice\config");

    fn bases((home, config): (&str, &str)) -> PlaceholderBases {
        PlaceholderBases::new(Some(home), Some(config))
    }

    fn resolved(raw: &str, b: (&str, &str)) -> String {
        resolve(raw, &bases(b))
            .unwrap_or_else(|e| panic!("{raw:?} should resolve: {e}"))
            .path
    }

    #[test]
    fn home_resolves_in_every_path_style() {
        assert_eq!(resolved("${home}/.kube", POSIX), "/home/alice/.kube");
        assert_eq!(resolved("${home}/.kube", MACOS), "/Users/alice/.kube");
        assert_eq!(resolved("${home}/.kube", WINDOWS), r"C:\Users\alice\.kube");
        assert_eq!(
            resolved("${home}/.kube", UNC),
            r"\\server\users\alice\.kube"
        );
        assert_eq!(
            resolved("${home}//captures/app/", WINDOWS),
            r"C:\Users\alice\captures\app"
        );
    }

    #[test]
    fn config_resolves_in_every_path_style() {
        assert_eq!(resolved("${config}/k8s", POSIX), "/home/alice/.config/k8s");
        assert_eq!(
            resolved("${config}/k8s", MACOS),
            "/Users/alice/Library/Application Support/k8s"
        );
        assert_eq!(
            resolved("${config}/k8s/state", WINDOWS),
            r"C:\Users\alice\AppData\Roaming\k8s\state"
        );
        assert_eq!(
            resolved("${config}/k8s", UNC),
            r"\\server\users\alice\config\k8s"
        );
    }

    #[test]
    fn a_trailing_separator_on_the_base_is_not_doubled() {
        let b = PlaceholderBases::new(Some("/home/alice/"), Some(r"C:\cfg\"));
        assert_eq!(resolve("${home}/x", &b).unwrap().path, "/home/alice/x");
        assert_eq!(resolve("${config}/x", &b).unwrap().path, r"C:\cfg\x");
    }

    #[test]
    fn resolution_records_the_anchor() {
        let r = resolve("${home}/.kube", &bases(POSIX)).unwrap();
        assert_eq!(r.anchor.as_deref(), Some("/home/alice"));
        let plain = resolve("/var/log/app", &bases(POSIX)).unwrap();
        assert_eq!(plain.anchor, None);
        assert_eq!(plain.path, "/var/log/app");
    }

    #[test]
    fn unknown_placeholders_are_rejected() {
        for bad in [
            "${HOME}/.kube",
            "${Home}/.kube",
            "${env}/x",
            "${data}/x",
            "${}/x",
            "${home/x",
            "${ home}/x",
            "${home:-/tmp}/x",
        ] {
            assert_eq!(
                check_manifest_filesystem_path(bad),
                Err(UNKNOWN_PLACEHOLDER),
                "{bad:?} must be rejected as unknown"
            );
            assert!(resolve(bad, &bases(POSIX)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn placeholders_outside_the_first_segment_are_rejected() {
        for bad in [
            "/data/${home}",
            "/data/${home}/x",
            "C:\\${home}\\x",
            "${home}/${config}",
            "${home}/a${home}",
            "~/${home}",
        ] {
            assert!(
                check_manifest_filesystem_path(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn bare_placeholders_are_refused_as_over_broad() {
        for bad in [
            "${home}",
            "${home}/",
            "${home}//",
            "${config}",
            "${config}/",
        ] {
            let reason = check_manifest_filesystem_path(bad).unwrap_err();
            assert!(
                reason.contains("whole"),
                "{bad:?} must be refused as over-broad, got {reason:?}"
            );
        }
    }

    #[test]
    fn traversal_and_ambiguous_segments_are_rejected() {
        for bad in [
            "${home}/..",
            "${home}/../etc",
            "${home}/.kube/../../etc",
            "${home}/./x",
            "${home}x",
            "${home}\\x",
            "${home}/a\\..\\..\\etc",
            "${home}/C:/Windows",
            "${home}/x:stream",
            "${home}/.. ",
            "${home}/... ",
            "${home}/x.",
            "${home}/x\0y",
        ] {
            assert!(
                check_manifest_filesystem_path(bad).is_err(),
                "{bad:?} must be rejected"
            );
            assert!(resolve(bad, &bases(WINDOWS)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn an_unavailable_or_invalid_base_fails_closed() {
        let none = PlaceholderBases::new(None, None);
        assert!(resolve("${home}/x", &none).is_err());
        assert!(resolve("${config}/x", &none).is_err());
        for bad_base in ["", "relative/home", "/", r"C:\", "/home/../root", "${home}"] {
            let b = PlaceholderBases::new(Some(bad_base), Some(bad_base));
            assert!(
                resolve("${home}/x", &b).is_err(),
                "base {bad_base:?} must not resolve"
            );
        }
    }

    #[test]
    fn ordinary_paths_keep_the_existing_rules() {
        assert_eq!(check_manifest_filesystem_path("/var/log/app"), Ok(()));
        assert_eq!(check_manifest_filesystem_path(r"C:\Logs\app"), Ok(()));
        assert!(check_manifest_filesystem_path("/").is_err());
        assert!(check_manifest_filesystem_path("~/captures").is_err());
        assert!(check_manifest_filesystem_path("/var/../etc").is_err());
    }

    #[test]
    fn resolve_filesystem_paths_lists_only_placeholder_entries() {
        let paths = vec![
            "/var/log/app".to_owned(),
            "${home}/.kube".to_owned(),
            "${config}/k8s".to_owned(),
        ];
        let b = PlaceholderBases::new(Some("/home/alice"), None);
        assert_eq!(
            resolve_filesystem_paths(&paths, &b),
            vec![
                ResolvedFilesystemPath {
                    declared: "${home}/.kube".to_owned(),
                    resolved: Some("/home/alice/.kube".to_owned()),
                },
                ResolvedFilesystemPath {
                    declared: "${config}/k8s".to_owned(),
                    resolved: None,
                },
            ]
        );
    }

    #[test]
    fn config_dir_follows_the_platform_convention() {
        let env = |name: &str| match name {
            "XDG_CONFIG_HOME" => Some("/xdg".to_owned()),
            "APPDATA" => Some(r"C:\Users\alice\AppData\Roaming".to_owned()),
            _ => None,
        };
        let got = user_config_dir(Some("/home/alice"), &env);
        if cfg!(windows) {
            assert_eq!(got.as_deref(), Some(r"C:\Users\alice\AppData\Roaming"));
        } else if cfg!(target_os = "macos") {
            assert_eq!(
                got.as_deref(),
                Some("/home/alice/Library/Application Support")
            );
        } else {
            assert_eq!(got.as_deref(), Some("/xdg"));
            // A relative XDG_CONFIG_HOME is ignored, per the XDG spec.
            let rel = |name: &str| (name == "XDG_CONFIG_HOME").then(|| "rel".to_owned());
            assert_eq!(
                user_config_dir(Some("/home/alice"), &rel).as_deref(),
                Some("/home/alice/.config")
            );
        }
    }

    #[test]
    fn host_bases_resolve_home() {
        // The test process has a home folder; `${home}/x` resolves below it.
        let b = PlaceholderBases::host();
        let home = b.base(PathPlaceholder::Home).expect("a home folder");
        let r = resolve("${home}/x", &b).expect("resolves on the host");
        assert!(r.path.starts_with(home));
        assert!(std::path::Path::new(&r.path).is_absolute());
    }
}
