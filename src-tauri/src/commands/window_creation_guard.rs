//! Static guard: window creation must never be reachable from a synchronous
//! Tauri command on Windows (#4024).
//!
//! Tauri runs a synchronous `#[tauri::command]` on the main thread inside the
//! WebView2 IPC callback. Building a `WebviewWindow` there deadlocks WebView2 on
//! Windows: the new window never connects and the calling window hangs. The
//! nightly Windows lane is the only place that would notice, so this test
//! catches the regression on every platform's `cargo test`.
//!
//! The guard parses every source file under `src/` with `syn` (no text grep)
//! and checks three rules over the code that is compiled **for Windows** (code
//! gated by a `#[cfg(...)]` that excludes Windows, and `#[cfg(test)]` code, is
//! skipped):
//!
//! 1. A window builder (`WebviewWindowBuilder`, `WindowBuilder`,
//!    `WebviewBuilder`, `WebviewWindow::builder`) is only used inside the
//!    sanctioned helper [`build_app_window`](super::window::build_app_window).
//! 2. Every `#[tauri::command]` that can reach window creation — directly or
//!    through any chain of helper functions, resolved by function name to a
//!    fixpoint — is `async` (an `async fn` or `#[tauri::command(async)]`).
//! 3. Every non-command function that can reach window creation is called from
//!    somewhere. An uncalled one is an entry point the guard cannot see the
//!    caller of (an event-loop or menu handler in `run`/`setup`), which is
//!    equally unsafe on Windows.
//!
//! Name-based call resolution over-approximates: a name collision can only add
//! a false positive, never hide a real path. A sync command that deliberately
//! hands creation to a spawned thread would also be flagged; make it `async`
//! instead.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use syn::visit::Visit;

/// The one function allowed to construct a window builder directly.
const SANCTIONED_BUILDER: &str = "build_app_window";

/// Evaluate a `cfg` predicate for a non-test Windows build. Unknown predicates
/// (features, `debug_assertions`, …) evaluate to `true`, so the guard only
/// ever skips code that provably is not compiled for Windows.
fn cfg_holds_on_windows(meta: &syn::Meta) -> bool {
    match meta {
        syn::Meta::Path(path) => {
            if path.is_ident("unix") || path.is_ident("test") {
                false
            } else {
                // `windows`, `debug_assertions`, and anything unknown.
                true
            }
        }
        syn::Meta::NameValue(nv) => {
            let value = match &nv.value {
                syn::Expr::Lit(syn::ExprLit {
                    lit: syn::Lit::Str(s),
                    ..
                }) => s.value(),
                _ => return true,
            };
            if nv.path.is_ident("target_os") || nv.path.is_ident("target_family") {
                value == "windows"
            } else {
                true
            }
        }
        syn::Meta::List(list) => {
            let nested = list.parse_args_with(
                syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
            );
            let Ok(nested) = nested else { return true };
            if list.path.is_ident("not") {
                nested.first().is_none_or(|m| !cfg_holds_on_windows(m))
            } else if list.path.is_ident("all") {
                nested.iter().all(cfg_holds_on_windows)
            } else if list.path.is_ident("any") {
                nested.iter().any(cfg_holds_on_windows)
            } else {
                true
            }
        }
    }
}

/// Whether the item/statement carrying `attrs` is compiled for Windows.
fn compiled_on_windows(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().all(|attr| {
        if attr.path().is_ident("test") {
            return false;
        }
        if !attr.path().is_ident("cfg") {
            return true;
        }
        match attr.parse_args::<syn::Meta>() {
            Ok(meta) => cfg_holds_on_windows(&meta),
            Err(_) => true,
        }
    })
}

/// The outer attributes of the expression kinds that can carry a `#[cfg]` as
/// a statement. Anything else reports none (and is therefore kept).
fn expr_attrs(expr: &syn::Expr) -> &[syn::Attribute] {
    match expr {
        syn::Expr::If(e) => &e.attrs,
        syn::Expr::Block(e) => &e.attrs,
        syn::Expr::Call(e) => &e.attrs,
        syn::Expr::MethodCall(e) => &e.attrs,
        syn::Expr::Match(e) => &e.attrs,
        syn::Expr::Unsafe(e) => &e.attrs,
        syn::Expr::Assign(e) => &e.attrs,
        syn::Expr::Macro(e) => &e.attrs,
        syn::Expr::ForLoop(e) => &e.attrs,
        syn::Expr::While(e) => &e.attrs,
        syn::Expr::Loop(e) => &e.attrs,
        syn::Expr::Closure(e) => &e.attrs,
        syn::Expr::Path(e) => &e.attrs,
        _ => &[],
    }
}

/// What the guard learned about one function.
#[derive(Debug, Default, Clone)]
struct FnFacts {
    /// `file:line`-ish location for messages.
    location: String,
    is_command: bool,
    is_async: bool,
    /// Uses a window builder directly.
    builds_directly: bool,
    /// Function / method names referenced in the body.
    references: BTreeSet<String>,
}

/// Collects the references and direct builder use inside one function body.
#[derive(Default)]
struct BodyScan {
    builds_directly: bool,
    references: BTreeSet<String>,
}

impl BodyScan {
    fn note_path(&mut self, path: &syn::Path) {
        let segs: Vec<String> = path.segments.iter().map(|s| s.ident.to_string()).collect();
        for (i, seg) in segs.iter().enumerate() {
            match seg.as_str() {
                "WebviewWindowBuilder" | "WindowBuilder" | "WebviewBuilder" => {
                    self.builds_directly = true;
                }
                "builder" if i > 0 && segs[i - 1] == "WebviewWindow" => {
                    self.builds_directly = true;
                }
                _ => {}
            }
        }
        if let Some(last) = segs.last() {
            self.references.insert(last.clone());
        }
    }
}

impl<'ast> Visit<'ast> for BodyScan {
    fn visit_path(&mut self, path: &'ast syn::Path) {
        self.note_path(path);
        syn::visit::visit_path(self, path);
    }

    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        if compiled_on_windows(&call.attrs) {
            self.references.insert(call.method.to_string());
            syn::visit::visit_expr_method_call(self, call);
        }
    }

    fn visit_stmt(&mut self, stmt: &'ast syn::Stmt) {
        let attrs: &[syn::Attribute] = match stmt {
            syn::Stmt::Local(local) => &local.attrs,
            syn::Stmt::Item(_) => &[], // checked by visit_item
            syn::Stmt::Expr(expr, _) => expr_attrs(expr),
            syn::Stmt::Macro(m) => &m.attrs,
        };
        if compiled_on_windows(attrs) {
            syn::visit::visit_stmt(self, stmt);
        }
    }

    fn visit_item(&mut self, item: &'ast syn::Item) {
        if item_compiled_on_windows(item) {
            syn::visit::visit_item(self, item);
        }
    }
}

fn item_compiled_on_windows(item: &syn::Item) -> bool {
    let attrs: &[syn::Attribute] = match item {
        syn::Item::Fn(i) => &i.attrs,
        syn::Item::Mod(i) => &i.attrs,
        syn::Item::Impl(i) => &i.attrs,
        syn::Item::Const(i) => &i.attrs,
        syn::Item::Static(i) => &i.attrs,
        syn::Item::Trait(i) => &i.attrs,
        _ => &[],
    };
    compiled_on_windows(attrs)
}

/// `#[tauri::command]` / `#[command]` → `Some(runs_async_by_attr)`.
fn command_attr(attrs: &[syn::Attribute]) -> Option<bool> {
    attrs.iter().find_map(|attr| {
        let path = attr.path();
        let last = path.segments.last()?;
        if last.ident != "command" {
            return None;
        }
        if path.segments.len() == 2 && path.segments[0].ident != "tauri" {
            return None;
        }
        let async_flag = match &attr.meta {
            syn::Meta::List(list) => list
                .tokens
                .clone()
                .into_iter()
                .any(|t| t.to_string() == "async"),
            _ => false,
        };
        Some(async_flag)
    })
}

/// Walks a file collecting every Windows-compiled function.
struct FileScan<'a> {
    file: &'a str,
    fns: &'a mut Vec<(String, FnFacts)>,
}

impl FileScan<'_> {
    fn record(
        &mut self,
        attrs: &[syn::Attribute],
        sig: &syn::Signature,
        body: &syn::Block,
        container: &str,
    ) {
        let mut scan = BodyScan::default();
        scan.visit_block(body);
        let command = command_attr(attrs);
        let name = sig.ident.to_string();
        self.fns.push((
            name.clone(),
            FnFacts {
                location: format!("{}: {container}{name}", self.file),
                is_command: command.is_some(),
                is_async: sig.asyncness.is_some() || command == Some(true),
                builds_directly: scan.builds_directly,
                references: scan.references,
            },
        ));
    }
}

impl<'ast> Visit<'ast> for FileScan<'_> {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        if item_compiled_on_windows(item) {
            syn::visit::visit_item(self, item);
        }
    }

    fn visit_item_fn(&mut self, f: &'ast syn::ItemFn) {
        // Nested fns are folded into their parent's body scan.
        self.record(&f.attrs, &f.sig, &f.block, "");
    }

    fn visit_item_impl(&mut self, imp: &'ast syn::ItemImpl) {
        for item in &imp.items {
            if let syn::ImplItem::Fn(f) = item {
                if compiled_on_windows(&f.attrs) {
                    self.record(&f.attrs, &f.sig, &f.block, "impl ");
                }
            }
        }
    }

    fn visit_trait_item_fn(&mut self, f: &'ast syn::TraitItemFn) {
        if let (Some(body), true) = (&f.default, compiled_on_windows(&f.attrs)) {
            self.record(&f.attrs, &f.sig, body, "trait ");
        }
    }
}

/// Apply the three rules to parsed sources; returns human-readable violations.
fn violations(files: &[(String, syn::File)]) -> Vec<String> {
    let mut fns: Vec<(String, FnFacts)> = Vec::new();
    for (path, file) in files {
        let mut scan = FileScan {
            file: path,
            fns: &mut fns,
        };
        scan.visit_file(file);
    }

    let mut out = Vec::new();

    // Rule 1: direct builder use only in the sanctioned helper.
    for (name, facts) in &fns {
        if facts.builds_directly && name != SANCTIONED_BUILDER {
            out.push(format!(
                "{}: builds a window directly; call `{SANCTIONED_BUILDER}` from an async \
                 command instead (#4024)",
                facts.location
            ));
        }
    }

    // Fixpoint: names of functions that can reach window creation.
    let mut creating: BTreeSet<String> = fns
        .iter()
        .filter(|(_, f)| f.builds_directly)
        .map(|(n, _)| n.clone())
        .collect();
    loop {
        let before = creating.len();
        for (name, facts) in &fns {
            if !creating.contains(name) && facts.references.iter().any(|r| creating.contains(r)) {
                creating.insert(name.clone());
            }
        }
        if creating.len() == before {
            break;
        }
    }

    // Which names are referenced by some other function at all.
    let mut callers: BTreeMap<&str, usize> = BTreeMap::new();
    for (name, facts) in &fns {
        for r in &facts.references {
            if r != name {
                *callers.entry(r.as_str()).or_default() += 1;
            }
        }
    }

    for (name, facts) in &fns {
        if !creating.contains(name) {
            continue;
        }
        if facts.is_command {
            // Rule 2.
            if !facts.is_async {
                out.push(format!(
                    "{}: synchronous #[tauri::command] reaches window creation; make it \
                     `async` — a sync command builds the window inside the WebView2 IPC \
                     callback and deadlocks on Windows (#4024)",
                    facts.location
                ));
            }
        } else if !callers.contains_key(name.as_str()) {
            // Rule 3.
            out.push(format!(
                "{}: creates a window from an entry point with no visible caller (an event, \
                 menu or setup handler?); on Windows that deadlocks WebView2 — route it \
                 through an async command (#4024)",
                facts.location
            ));
        }
    }
    out
}

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read {dir:?}: {e}"));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn parse(src: &str) -> syn::File {
    syn::parse_file(src).expect("fixture parses")
}

fn check(src: &str) -> Vec<String> {
    violations(&[("fixture.rs".to_string(), parse(src))])
}

#[test]
fn window_creation_is_only_reachable_from_async_commands() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut paths = Vec::new();
    rust_sources(&root, &mut paths);
    paths.sort();
    assert!(
        paths.len() > 50,
        "scanned suspiciously few files: {}",
        paths.len()
    );

    let files: Vec<(String, syn::File)> = paths
        .iter()
        .map(|p| {
            let src = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {p:?}: {e}"));
            let file = syn::parse_file(&src).unwrap_or_else(|e| panic!("parse {p:?}: {e}"));
            let rel = p.strip_prefix(&root).unwrap_or(p).display().to_string();
            (rel, file)
        })
        .collect();

    // The guard must actually see the real window path, or it is vacuous.
    let all = violations(&files);
    assert!(
        all.is_empty(),
        "window-creation guard (#4024):\n{}",
        all.join("\n")
    );

    let mut fns = Vec::new();
    for (path, file) in &files {
        FileScan {
            file: path,
            fns: &mut fns,
        }
        .visit_file(file);
    }
    let open_window = fns
        .iter()
        .find(|(n, f)| n == "open_window" && f.is_command)
        .expect("guard sees the open_window command");
    assert!(open_window.1.references.contains(SANCTIONED_BUILDER));
    assert!(fns
        .iter()
        .any(|(n, f)| n == SANCTIONED_BUILDER && f.builds_directly));
}

#[test]
fn flags_a_sync_command_that_reaches_a_builder_through_helpers() {
    let v = check(
        r#"
        pub(crate) fn build_app_window(app: &AppHandle, l: &str) {
            WebviewWindowBuilder::new(app, l, url).build();
        }
        fn helper(app: &AppHandle) { build_app_window(app, "x"); }
        #[tauri::command]
        pub fn open_it(app: AppHandle) { helper(&app); }
        "#,
    );
    assert_eq!(v.len(), 1, "{v:?}");
    assert!(v[0].contains("open_it") && v[0].contains("synchronous"));
}

#[test]
fn accepts_async_fn_and_async_attribute_commands() {
    let v = check(
        r#"
        pub(crate) fn build_app_window(app: &AppHandle, l: &str) {
            tauri::WebviewWindowBuilder::new(app, l, url).build();
        }
        #[tauri::command]
        pub async fn a(app: AppHandle) { build_app_window(&app, "a"); }
        #[tauri::command(async)]
        pub fn b(app: AppHandle) { build_app_window(&app, "b"); }
        "#,
    );
    assert!(v.is_empty(), "{v:?}");
}

#[test]
fn flags_direct_builder_use_outside_the_helper() {
    let v = check(
        r#"
        #[tauri::command]
        pub async fn rogue(app: AppHandle) {
            WebviewWindow::builder(&app, "x", url).build();
        }
        "#,
    );
    assert_eq!(v.len(), 1, "{v:?}");
    assert!(v[0].contains("rogue") && v[0].contains("directly"));
}

#[test]
fn flags_window_creation_from_an_uncalled_entry_point() {
    let v = check(
        r#"
        pub(crate) fn build_app_window(app: &AppHandle, l: &str) {
            WebviewWindowBuilder::new(app, l, url).build();
        }
        pub fn run() {
            builder.on_menu_event(|app, _| { build_app_window(app, "m"); });
        }
        "#,
    );
    assert_eq!(v.len(), 1, "{v:?}");
    assert!(v[0].contains("run") && v[0].contains("entry point"));
}

#[test]
fn skips_code_not_compiled_for_windows_or_only_for_tests() {
    let v = check(
        r#"
        pub(crate) fn build_app_window(app: &AppHandle, l: &str) {
            WebviewWindowBuilder::new(app, l, url).build();
        }
        pub fn run() {
            #[cfg(target_os = "macos")]
            if reopen { build_app_window(app, "r"); }
        }
        #[cfg(not(windows))]
        #[tauri::command]
        pub fn unix_only(app: AppHandle) { build_app_window(&app, "u"); }
        #[cfg(test)]
        mod tests {
            #[tauri::command]
            pub fn fake(app: AppHandle) { build_app_window(&app, "t"); }
        }
        "#,
    );
    // `build_app_window` itself has no caller left → it is reported as an
    // uncalled entry point, which is correct for this fixture.
    assert!(v.iter().all(|m| m.contains("build_app_window")), "{v:?}");
}

#[test]
fn windows_specific_cfg_is_kept() {
    let v = check(
        r#"
        pub(crate) fn build_app_window(app: &AppHandle, l: &str) {
            WebviewWindowBuilder::new(app, l, url).build();
        }
        #[cfg(any(windows, target_os = "linux"))]
        #[tauri::command]
        pub fn win(app: AppHandle) { build_app_window(&app, "w"); }
        "#,
    );
    assert_eq!(v.len(), 1, "{v:?}");
    assert!(v[0].contains("win"));
}
