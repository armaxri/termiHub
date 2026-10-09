//! Backend Tauri event-name inventory for the IPC event contract (TFE2-006,
//! #4344).
//!
//! `invoke` names are cross-checked by `scripts/internal/check-invoke-contract.mjs`,
//! but event channels are plain strings on both sides: a frontend `listen("x")`
//! whose backend `emit("x", ..)` was renamed or removed never fires, and an
//! `emit` nothing listens to is dead traffic (the 1 Hz legacy tunnel-stats event,
//! DEAD2-004 / PERF2-007). This module statically scans the production sources
//! under `src-tauri/src/` for every `emit` / `emit_to` / `emit_filter` /
//! `emit_str` call and resolves its event-name argument — a string literal, or a
//! `&str` constant declared in `src-tauri/src/` or `core/src/` — into the set of
//! event names the backend can emit. [`super::write_ipc_wire_fixtures`] writes
//! that set to `src/test/fixtures/wire/events.json`, and the frontend suite
//! `src/services/eventContract.test.ts` checks every production `listen()` name
//! against it (and the reverse).
//!
//! An emit whose event argument is a variable forwarded from a helper must be
//! listed in [`FORWARDING_SITES`] with the names it carries, so a new dynamic
//! emit fails loudly here instead of silently dropping out of the contract.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Where a forwarding emit site's event names come from.
enum Forwarded {
    /// The string-literal / const argument at `arg` of every call to `helper`
    /// in the same file (e.g. `emit_owner_scoped(app, "x", ..)`).
    HelperArg { helper: &'static str, arg: usize },
    /// Every `&str` constant declared in this file (relative to `src-tauri/src`).
    ConstsInFile(&'static str),
    /// These named constants.
    Consts(&'static [&'static str]),
}

/// Emit sites whose event argument is not a literal or a constant: (file
/// relative to `src-tauri/src`, the argument expression verbatim, its source).
const FORWARDING_SITES: &[(&str, &str, Forwarded)] = &[
    (
        "session/graphical_manager.rs",
        "event",
        Forwarded::HelperArg {
            helper: "emit_owner_scoped",
            arg: 1,
        },
    ),
    (
        "commands/network.rs",
        "name",
        Forwarded::ConstsInFile("network/events.rs"),
    ),
    (
        "spawn/handler.rs",
        "spawn_event_for(req)",
        Forwarded::Consts(&["SPAWN_REQUEST_EVENT", "SPAWN_PICKER_REQUESTED_EVENT"]),
    ),
];

/// Emitter methods whose event name is the first argument.
const EMIT_FIRST_ARG: &[&str] = &["emit", "emit_filter", "emit_str", "emit_str_filter"];
/// Emitter methods whose event name is the second argument (after the target).
const EMIT_SECOND_ARG: &[&str] = &["emit_to", "emit_str_to"];

/// Replace comments with spaces (string and char literals are kept verbatim).
fn strip_comments(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                out.push(' ');
                i += 1;
            }
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            let mut depth = 0;
            loop {
                if i >= b.len() {
                    break;
                }
                if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                    depth += 1;
                    out.push_str("  ");
                    i += 2;
                } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                    depth -= 1;
                    out.push_str("  ");
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    out.push(if b[i] == b'\n' { '\n' } else { ' ' });
                    i += 1;
                }
            }
        } else if c == b'r'
            && matches!(b.get(i + 1), Some(b'"') | Some(b'#'))
            && !(i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_'))
        {
            // A raw string r"…" / r#"…"#: copy it verbatim up to its terminator.
            let start = i;
            let hashes = b[i + 1..].iter().take_while(|&&h| h == b'#').count();
            if b.get(i + 1 + hashes) != Some(&b'"') {
                out.push('r');
                i += 1;
                continue;
            }
            let close = format!("\"{}", "#".repeat(hashes));
            let body = i + 2 + hashes;
            i = src[body..]
                .find(&close)
                .map_or(b.len(), |p| body + p + close.len());
            out.push_str(&src[start..i]);
        } else if c == b'"' {
            // Copy a string literal verbatim (escapes included).
            let start = i;
            i += 1;
            while i < b.len() && b[i] != b'"' {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(b.len());
            out.push_str(&src[start..i]);
        } else if c == b'\'' && i + 2 < b.len() && (b[i + 2] == b'\'' || b[i + 1] == b'\\') {
            // A char literal such as '"' or '\n' (lifetimes have no closing quote).
            let start = i;
            i += 1;
            if b[i] == b'\\' {
                i += 1;
            }
            while i < b.len() && b[i] != b'\'' {
                i += 1;
            }
            i = (i + 1).min(b.len());
            out.push_str(&src[start..i]);
        } else {
            // Push the whole UTF-8 character.
            let ch = src[i..].chars().next().expect("in-bounds char");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Drop the trailing `#[cfg(test)] mod …` block(s): test-only emits are not
/// part of the production contract. (`#[cfg(test)] mod tests;` declarations
/// point at test files, which [`is_test_file`] already skips.)
fn production_part(src: &str) -> String {
    const ATTR: &str = "#[cfg(test)]";
    let mut out = String::with_capacity(src.len());
    let mut rest = src;
    while let Some(pos) = rest.find(ATTR) {
        let after = rest[pos + ATTR.len()..].trim_start();
        let header = after.strip_prefix("pub ").unwrap_or(after);
        let inline_mod = header.strip_prefix("mod ").and_then(|m| {
            let brace = m.find(['{', ';'])?;
            (m.as_bytes()[brace] == b'{').then_some(brace)
        });
        let Some(brace) = inline_mod else {
            out.push_str(&rest[..pos + ATTR.len()]);
            rest = &rest[pos + ATTR.len()..];
            continue;
        };
        out.push_str(&rest[..pos]);
        let open = rest.len() - header.len() + "mod ".len() + brace;
        rest = &rest[block_end(rest, open)..];
    }
    out.push_str(rest);
    out
}

/// Byte offset just past the `}` matching the `{` at `open`, skipping braces
/// inside string and char literals.
fn block_end(src: &str, open: usize) -> usize {
    let b = src.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'\'' if b.get(i + 2) == Some(&b'\'') => i += 2,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    b.len()
}

/// Split the top-level, comma-separated arguments of the call whose `(` is at
/// `open` in `src`.
fn call_args(src: &str, open: usize) -> Vec<String> {
    let mut args = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    let mut in_str = false;
    let mut chars = src[open..].chars();
    while let Some(ch) = chars.next() {
        if in_str {
            cur.push(ch);
            if ch == '\\' {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_str = true;
                cur.push(ch);
            }
            '(' | '[' | '{' => {
                depth += 1;
                if depth > 1 {
                    cur.push(ch);
                }
            }
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
                cur.push(ch);
            }
            ',' if depth == 1 => args.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        args.push(cur);
    }
    args.into_iter()
        .map(|a| a.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect()
}

/// Every `name(` call in `src` (an identifier boundary before `name`), as the
/// byte offset of its `(` and the 1-based line.
fn calls_of<'a>(src: &'a str, name: &'a str) -> impl Iterator<Item = (usize, usize)> + 'a {
    src.match_indices(name).filter_map(move |(at, _)| {
        let before = src[..at].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            return None;
        }
        let after = &src[at + name.len()..];
        let open = at + name.len() + (after.len() - after.trim_start().len());
        if !src[open..].starts_with('(') {
            return None;
        }
        // `fn name(` is the helper's own definition, not a call.
        if src[..at].trim_end().ends_with("fn") {
            return None;
        }
        Some((open, src[..at].matches('\n').count() + 1))
    })
}

/// Parse a Rust string literal argument (`"x"`, `&"x"`), if it is one.
fn string_literal(arg: &str) -> Option<String> {
    let arg = arg.trim().trim_start_matches('&').trim();
    let inner = arg.strip_prefix('"')?.strip_suffix('"')?;
    (!inner.contains('"') && !inner.contains('\\')).then(|| inner.to_string())
}

/// The trailing identifier of a const path argument (`a::b::NAME`, `&NAME`).
fn const_ident(arg: &str) -> Option<&str> {
    let arg = arg.trim().trim_start_matches('&').trim();
    let last = arg.rsplit("::").next()?;
    let is_const = !last.is_empty()
        && last.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && last
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    (is_const
        && arg
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == ':'))
    .then_some(last)
}

/// `const NAME: &str = "value";` declarations in one (comment-stripped) file.
fn str_consts(src: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (at, _) in src.match_indices("const ") {
        if src[..at]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
        {
            continue;
        }
        let rest = &src[at + "const ".len()..];
        let Some(colon) = rest.find(':') else {
            continue;
        };
        let name = rest[..colon].trim();
        if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let rest = rest[colon + 1..].trim_start();
        let Some(rest) = rest
            .strip_prefix("&'static str")
            .or_else(|| rest.strip_prefix("&str"))
        else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let Some(end) = rest.find(';') else {
            continue;
        };
        if let Some(value) = string_literal(&rest[..end]) {
            out.push((name.to_string(), value));
        }
    }
    out
}

/// Recursively list the `.rs` files under `dir`.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Whether a file is a test-only module (by the repo's naming convention).
fn is_test_file(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name == "tests.rs" || name.ends_with("_tests.rs") || rel.contains("/tests/")
}

/// The result of scanning the backend for emitted event names.
pub(super) struct EventInventory {
    /// Every event name the production backend can emit.
    pub names: BTreeSet<String>,
    /// Emit sites whose event name could not be resolved (`file:line: arg`).
    pub unresolved: Vec<String>,
}

/// Scan `src-tauri/src` (with `core/src` consulted for constants).
pub(super) fn scan_backend_events() -> EventInventory {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let tauri_src = manifest.join("src");
    scan(&tauri_src, &manifest.join("..").join("core").join("src"))
}

fn scan(tauri_src: &Path, core_src: &Path) -> EventInventory {
    let rel_of = |root: &Path, p: &Path| {
        p.strip_prefix(root)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/")
    };
    // file (relative to src-tauri/src) → production, comment-free source.
    let mut files: BTreeMap<String, String> = BTreeMap::new();
    let mut paths = Vec::new();
    rust_files(tauri_src, &mut paths);
    for p in &paths {
        let rel = rel_of(tauri_src, p);
        if is_test_file(&rel) {
            continue;
        }
        let text = std::fs::read_to_string(p).unwrap_or_default();
        files.insert(rel, production_part(&strip_comments(&text)));
    }
    // Constants: per file, and globally by name (src-tauri + core).
    let mut consts_by_file: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut consts: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (rel, src) in &files {
        let found = str_consts(src);
        for (name, value) in &found {
            consts
                .entry(name.clone())
                .or_default()
                .insert(value.clone());
        }
        consts_by_file.insert(rel.clone(), found);
    }
    let mut core_paths = Vec::new();
    rust_files(core_src, &mut core_paths);
    for p in core_paths {
        let src = strip_comments(&std::fs::read_to_string(&p).unwrap_or_default());
        for (name, value) in str_consts(&src) {
            consts.entry(name).or_default().insert(value);
        }
    }
    let resolve_const = |file: &str, ident: &str| -> Option<String> {
        if let Some((_, v)) = consts_by_file
            .get(file)
            .and_then(|c| c.iter().find(|(n, _)| n == ident))
        {
            return Some(v.clone());
        }
        match consts.get(ident) {
            Some(values) if values.len() == 1 => values.iter().next().cloned(),
            _ => None,
        }
    };
    let resolve_arg = |file: &str, arg: &str| -> Option<String> {
        string_literal(arg).or_else(|| const_ident(arg).and_then(|id| resolve_const(file, id)))
    };

    let mut names = BTreeSet::new();
    let mut unresolved = Vec::new();
    let mut used_forwarding = BTreeSet::new();
    for (rel, src) in &files {
        let methods = EMIT_FIRST_ARG
            .iter()
            .map(|m| (*m, 0))
            .chain(EMIT_SECOND_ARG.iter().map(|m| (*m, 1)));
        for (method, idx) in methods {
            let dotted = format!(".{method}");
            for (at, _) in src.match_indices(&dotted) {
                let after = &src[at + dotted.len()..];
                // `.emit_to` also matches `.emit`; require the exact method name.
                if after.starts_with(|c: char| c.is_alphanumeric() || c == '_') {
                    continue;
                }
                let open = at + dotted.len() + (after.len() - after.trim_start().len());
                if !src[open..].starts_with('(') {
                    continue;
                }
                let line = src[..at].matches('\n').count() + 1;
                let args = call_args(src, open);
                let Some(arg) = args.get(idx) else {
                    unresolved.push(format!("{rel}:{line}: .{method}() with too few args"));
                    continue;
                };
                if let Some(name) = resolve_arg(rel, arg) {
                    names.insert(name);
                    continue;
                }
                let Some((_, _, source)) = FORWARDING_SITES
                    .iter()
                    .find(|(f, expr, _)| f == rel && expr == arg)
                else {
                    unresolved.push(format!("{rel}:{line}: .{method}({arg}, ..)"));
                    continue;
                };
                used_forwarding.insert((rel.clone(), arg.clone()));
                match source {
                    Forwarded::HelperArg { helper, arg: hidx } => {
                        for (hopen, hline) in calls_of(src, helper) {
                            let hargs = call_args(src, hopen);
                            match hargs.get(*hidx).and_then(|a| resolve_arg(rel, a)) {
                                Some(name) => {
                                    names.insert(name);
                                }
                                None => unresolved.push(format!(
                                    "{rel}:{hline}: {helper}() event arg unresolved"
                                )),
                            }
                        }
                    }
                    Forwarded::ConstsInFile(file) => {
                        let found = consts_by_file.get(*file).cloned().unwrap_or_default();
                        if found.is_empty() {
                            unresolved.push(format!("{rel}: no event consts in {file}"));
                        }
                        names.extend(found.into_iter().map(|(_, v)| v));
                    }
                    Forwarded::Consts(idents) => {
                        for id in *idents {
                            match resolve_const(rel, id) {
                                Some(name) => {
                                    names.insert(name);
                                }
                                None => unresolved.push(format!("{rel}: const {id} unresolved")),
                            }
                        }
                    }
                }
            }
        }
    }
    for (file, expr, _) in FORWARDING_SITES {
        if !used_forwarding.contains(&(file.to_string(), expr.to_string())) {
            unresolved.push(format!(
                "stale FORWARDING_SITES entry ({file}, {expr}): no such emit — remove it"
            ));
        }
    }
    EventInventory { names, unresolved }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_comments_keeps_strings_and_blanks_comments() {
        let src = "a.emit(\"x\", 1); // b.emit(\"gone\", 2)\n/* c.emit(\"no\") */ '\"'";
        let out = strip_comments(src);
        assert!(out.contains("\"x\""));
        assert!(!out.contains("gone"));
        assert!(!out.contains("no\""));
        assert!(out.contains("'\"'"));
    }

    #[test]
    fn call_args_splits_top_level_only() {
        let src = "f(EventTarget::labeled(&t), \"a,b\", Foo { x: 1, y: 2 })";
        let args = call_args(src, 1);
        assert_eq!(
            args,
            vec![
                "EventTarget::labeled(&t)".to_string(),
                "\"a,b\"".to_string(),
                "Foo { x: 1, y: 2 }".to_string()
            ]
        );
    }

    #[test]
    fn literal_and_const_args_are_recognised() {
        assert_eq!(string_literal(" \"tunnel-x\" "), Some("tunnel-x".into()));
        assert_eq!(string_literal("&\"a\""), Some("a".into()));
        assert_eq!(string_literal("name"), None);
        assert_eq!(const_ident("commands::plugin::EVENT_X"), Some("EVENT_X"));
        assert_eq!(const_ident("&EVENT_X"), Some("EVENT_X"));
        assert_eq!(const_ident("event"), None);
        assert_eq!(const_ident("spawn_event_for(req)"), None);
    }

    #[test]
    fn str_consts_finds_plain_and_static_consts() {
        let src =
            "pub const A_EVENT: &str = \"a\";\nconst B: &'static str = \"b\";\nconst N: u8 = 1;";
        assert_eq!(
            str_consts(src),
            vec![
                ("A_EVENT".to_string(), "a".to_string()),
                ("B".to_string(), "b".to_string())
            ]
        );
    }

    #[test]
    fn production_part_drops_inline_test_modules_only() {
        let src = "#[cfg(test)]\nmod tests;\nfn a() { x.emit(\"live\", ()); }\n\
                   #[cfg(test)]\nmod t { fn f() { y.emit(\"t}\", ()); } }\n\
                   fn b() { z.emit(\"after\", ()); }";
        let prod = production_part(src);
        assert!(prod.contains("live"), "{prod}");
        assert!(prod.contains("after"), "{prod}");
        assert!(!prod.contains("\"t}\""), "{prod}");
    }

    /// The real scan resolves every production emit site and finds the app's
    /// well-known events — and none of the legacy events #4344 removed.
    #[test]
    fn backend_scan_resolves_every_emit_site() {
        let inv = scan_backend_events();
        assert!(
            inv.unresolved.is_empty(),
            "unresolved emit sites (use a literal / &str const, or add a \
             FORWARDING_SITES entry): {:#?}",
            inv.unresolved
        );
        for expected in [
            "terminal-output",
            "terminal-exit",
            "agent-state-change",
            "remote-desktop-clipboard",
            "network-scan-result",
            "spawn-picker-requested",
        ] {
            assert!(inv.names.contains(expected), "missing {expected}");
        }
        for removed in [
            "tunnel-status-changed",
            "tunnel-stats-updated",
            "agent-deploy-progress",
        ] {
            assert!(!inv.names.contains(removed), "{removed} is emitted again");
        }
    }
}
