//! Programs that run whatever they are told to (#6019).
//!
//! "Always allow" allows a program with any arguments. For the programs here that
//! means allowing anything, so the window says it before it is chosen. The rule is
//! only a warning: an entry of the list allows them like any other program.
//!
//! What is here: a program whose ordinary arguments or input files name another
//! program or a script to run. Looked up by the name of the resolved file, and by
//! the name of the file a symbolic link leads to (`/usr/bin/python` →
//! `python3.12`), without case, `.exe` and a version (`python3.12`, `bash-5.2`).
//! What is not: programs that can only be made to run something through an obscure
//! option, and scripts of the user's own.

use std::path::Path;

/// File names without a version, in lower case.
const INTERPRETERS: &[&str] = &[
    // Shells.
    "sh",
    "bash",
    "rbash",
    "zsh",
    "dash",
    "ash",
    "ksh",
    "mksh",
    "pdksh",
    "fish",
    "csh",
    "tcsh",
    "nu",
    "xonsh",
    "elvish",
    "busybox",
    "toybox",
    "cmd",
    "powershell",
    "pwsh",
    "powershell_ise",
    "wsl",
    "wslhost",
    "git-bash",
    "git-cmd",
    "mintty",
    "conhost",
    "wt",
    // Script languages.
    "python",
    "pythonw",
    "py",
    "pyw",
    "pypy",
    "ipython",
    "perl",
    "wperl",
    "ruby",
    "rubyw",
    "irb",
    "node",
    "nodejs",
    "deno",
    "bun",
    "tsx",
    "ts-node",
    "php",
    "lua",
    "luajit",
    "tclsh",
    "wish",
    "expect",
    "osascript",
    "awk",
    "gawk",
    "mawk",
    "nawk",
    "groovy",
    "scala",
    "kotlin",
    "java",
    "javaw",
    "jshell",
    "julia",
    "rscript",
    "guile",
    "racket",
    "sbcl",
    "erl",
    "elixir",
    "swift",
    "dotnet",
    "csi",
    "fsi",
    "autohotkey",
    "wscript",
    "cscript",
    "mshta",
    // Build tools and package managers: their files and packages hold commands.
    "make",
    "gmake",
    "nmake",
    "mingw32-make",
    "cmake",
    "ninja",
    "just",
    "task",
    "rake",
    "ant",
    "mvn",
    "gradle",
    "gradlew",
    "bazel",
    "scons",
    "meson",
    "msbuild",
    "cargo",
    "go",
    "npm",
    "npx",
    "pnpm",
    "pnpx",
    "yarn",
    "bunx",
    "corepack",
    "pip",
    "pipx",
    "uv",
    "uvx",
    "poetry",
    "gem",
    "bundle",
    "composer",
    "conda",
    "nix",
    "nix-shell",
    "brew",
    "git",
    "hg",
    "svn",
    // Programs that start other programs.
    "env",
    "xargs",
    "find",
    "parallel",
    "nohup",
    "nice",
    "ionice",
    "time",
    "timeout",
    "gtimeout",
    "setsid",
    "stdbuf",
    "script",
    "watch",
    "entr",
    "tmux",
    "screen",
    "sudo",
    "doas",
    "su",
    "runuser",
    "pkexec",
    "chroot",
    "unshare",
    "nsenter",
    "launchctl",
    "systemd-run",
    "at",
    "batch",
    "crontab",
    "open",
    "xdg-open",
    "ssh",
    "docker",
    "podman",
    "kubectl",
    "vagrant",
    "ansible",
    "ansible-playbook",
    "rundll32",
    "regsvr32",
    "wmic",
    "schtasks",
    "forfiles",
    "start",
    "explorer",
    "installutil",
    "regasm",
    "regsvcs",
    "msiexec",
    "hh",
    "bash_launcher",
    // Editors and debuggers with a command line of their own.
    "vi",
    "vim",
    "nvim",
    "ex",
    "ed",
    "emacs",
    "gdb",
    "lldb",
];

/// Whether the resolved file `path` runs whatever it is told to.
pub fn is_interpreter(path: &Path) -> bool {
    let named = |path: &Path| {
        path.file_name()
            .is_some_and(|n| is_name(&n.to_string_lossy()))
    };
    named(path) || path.canonicalize().is_ok_and(|target| named(&target))
}

/// Whether a file name is one of [`INTERPRETERS`], with or without a version.
fn is_name(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    let name = lower.strip_suffix(".exe").unwrap_or(&lower);
    // `python3.12`, `bash-5.2`, `pwsh-preview`; "7z" has no letters to leave.
    let version = |c: char| c.is_ascii_digit() || c == '.';
    let bare = name
        .strip_suffix("-preview")
        .unwrap_or(name)
        .trim_end_matches(version)
        .trim_end_matches(['-', '_']);
    INTERPRETERS.contains(&name) || (!bare.is_empty() && INTERPRETERS.contains(&bare))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_interpreters_are_found_under_every_usual_name() {
        for name in [
            "sh",
            "bash",
            "zsh",
            "python",
            "python3",
            "python3.12",
            "Python",
            "perl5.34",
            "node",
            "node20",
            "ruby2.7",
            "lua5.4",
            "bash-5.2",
            "make",
            "git",
            "env",
            "xargs",
            "osascript",
            "cmd.exe",
            "CMD.EXE",
            "powershell.exe",
            "pwsh.exe",
            "pwsh-preview",
            "rundll32.exe",
            "wscript.exe",
            "cscript.exe",
            "mshta.exe",
            "python.exe",
            "py.exe",
            "git.exe",
            "wsl.exe",
            "busybox",
        ] {
            assert!(is_name(name), "{name}");
        }
    }

    #[test]
    fn other_programs_are_not() {
        for name in [
            "notify-send",
            "touch",
            "true",
            "curl",
            "rsync",
            "ping",
            "7z",
            "7z.exe",
            "shasum",
            "python-config-helper",
            "backup.sh",
            "bashful",
            "makeinfo",
            "gitk-viewer",
            "1.2",
            "",
            "open-terminal",
        ] {
            assert!(!is_name(name), "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_what_it_leads_to() {
        let dir = tempfile::TempDir::new().unwrap();
        let shell = dir.path().join("dash");
        std::fs::write(&shell, "").unwrap();
        let link = dir.path().join("my-tool");
        std::os::unix::fs::symlink(&shell, &link).unwrap();
        assert!(is_interpreter(&link));
        // And the other way: a link named like one.
        let tool = dir.path().join("tool");
        std::fs::write(&tool, "").unwrap();
        let named = dir.path().join("sh");
        std::os::unix::fs::symlink(&tool, &named).unwrap();
        assert!(is_interpreter(&named));
        assert!(!is_interpreter(&tool));
        assert!(is_interpreter(Path::new("/nowhere/python3.12")));
    }
}
