//! Load-time integrity binding for signed native plugins (#2796).
//!
//! The install-time trust gate verifies a package's signature and consults the
//! publisher trust store. These tests prove the **load** path is anchored too,
//! so an attacker who rewrites the extracted plugin directory after install —
//! swapping the backend library and re-signing the tree — cannot get the swapped
//! library loaded:
//!
//! * the signing key must be trusted **at load** (a key revoked since install,
//!   or an attacker's key, is refused);
//! * the backend digest verified at install is persisted in `plugin-state.json`
//!   and the library must still match it, so even a re-sign with a trusted key
//!   is refused until the plugin is reinstalled through the manager.
//!
//! Every scenario installs a real signed package through [`PluginManager`] and
//! loads through the real [`PluginHost`], using the `tests/fixtures/test-plugin`
//! cdylib.
#![cfg(feature = "plugin")]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

mod plugin_fixture;
use plugin_fixture::{fixture_library, Variant};

use termihub_core::connection::ConnectionTypeRegistry;
use termihub_core::plugin::{
    generate_keypair, host_target_triple, native_library_hash, pack_plugin_signed, sha256_digest,
    sign_digests, signing_key_from_base64, HostError, InstallOptions, InstalledPlugin,
    NativeTrustStore, PluginHost, PluginManager, SigningKeyFile, TrustStore, SIGNATURE_FILE_NAME,
};

const PLUGIN_ID: &str = "integrity-echo";

const FIXTURE_MANIFEST: &str = r#"{
    "id": "integrity-echo",
    "name": "Integrity Echo",
    "version": "0.1.0",
    "author": "termiHub tests",
    "description": "Native echo fixture for the load-time integrity tests",
    "license": "MIT",
    "apiVersion": "1.1",
    "platforms": ["windows", "linux", "macos"],
    "permissions": ["terminal"],
    "extensions": {
        "terminalBackend": {
            "connectionType": "echo",
            "displayName": "Integrity Echo",
            "configSchema": { "type": "object", "properties": {} }
        }
    }
}"#;

/// A packaged, signed fixture plus the working directory that owns it.
struct Fixture {
    work: tempfile::TempDir,
    package: PathBuf,
}

impl Fixture {
    /// Pack the fixture library for this host and sign it with `key`.
    fn signed_by(key: &SigningKeyFile) -> Self {
        let work = tempfile::TempDir::new().unwrap();
        let lib = fixture_library(Variant::Default, work.path());
        let src = work.path().join("src");
        let host_dir = src.join("backend").join(host_target_triple());
        std::fs::create_dir_all(&host_dir).unwrap();
        std::fs::copy(&lib, host_dir.join(lib.file_name().unwrap())).unwrap();
        std::fs::write(src.join("manifest.json"), FIXTURE_MANIFEST).unwrap();
        let package = pack_plugin_signed(&src, &work.path().join("dist"), Some(key))
            .expect("packing + signing the fixture succeeds");
        Self { work, package }
    }

    fn root(&self) -> PathBuf {
        self.work.path().join("plugins")
    }

    fn plugin_dir(&self) -> PathBuf {
        self.root().join(PLUGIN_ID)
    }

    /// Install through the real manager. `pin` trusts the (unknown) signing key
    /// on first use; without it the plugin is installed once, key untrusted.
    fn install(&self, pin: bool) -> InstalledPlugin {
        let manager = PluginManager::new(self.root());
        manager
            .install_with(
                &self.package,
                InstallOptions {
                    accept_untrusted: false,
                    trust_publisher: pin,
                    ..InstallOptions::default()
                },
            )
            .expect("the signed package installs")
    }

    /// Enable native plugins and acknowledge the library currently on disk —
    /// the consent the user gives in the native-trust dialog.
    fn acknowledge_current_library(&self) {
        let hash = native_library_hash(&self.root(), PLUGIN_ID).expect("library resolves");
        let mut trust = NativeTrustStore::load(&self.root());
        trust.set_native_enabled(true).unwrap();
        trust.acknowledge(PLUGIN_ID, hash).unwrap();
    }

    fn load(&self, plugin: &InstalledPlugin) -> Result<(), HostError> {
        let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
        let host = PluginHost::new(self.root(), registry);
        let result = host.load(plugin);
        host.unload(PLUGIN_ID);
        result
    }

    /// The attacker's move: replace the extracted backend library with other
    /// bytes, then rewrite `signature.json` over the whole extracted tree with
    /// `key`, so the co-located signature verifies. The user then re-acknowledges
    /// the "changed" native library (the realistic worst case — the native-trust
    /// hash binding alone does not stop a user who clicks through).
    fn swap_library_and_resign(&self, key: &SigningKeyFile) {
        let dir = self.plugin_dir();
        let lib = library_in(&dir);
        let mut bytes = std::fs::read(&lib).unwrap();
        bytes.extend_from_slice(b"\0attacker payload");
        std::fs::write(&lib, &bytes).unwrap();

        let files = digest_tree(&dir);
        let signing_key = signing_key_from_base64(&key.private_key).unwrap();
        let sig = sign_digests(&signing_key, files, key.label.clone());
        std::fs::write(
            dir.join(SIGNATURE_FILE_NAME),
            serde_json::to_vec_pretty(&sig).unwrap(),
        )
        .unwrap();
        self.acknowledge_current_library();
    }
}

/// The single backend library under `plugin_dir/backend/<host-triple>/`.
fn library_in(plugin_dir: &Path) -> PathBuf {
    let dir = plugin_dir.join("backend").join(host_target_triple());
    std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.is_file())
        .expect("the host library was extracted")
}

/// Digest every extracted file except the signature, keyed by `/` path.
fn digest_tree(plugin_dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![plugin_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path.strip_prefix(plugin_dir).unwrap();
            let key = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if key == SIGNATURE_FILE_NAME {
                continue;
            }
            out.insert(key, sha256_digest(&std::fs::read(&path).unwrap()));
        }
    }
    out
}

#[test]
fn a_pinned_signed_plugin_loads() {
    let publisher = generate_keypair("publisher");
    let fx = Fixture::signed_by(&publisher);
    let plugin = fx.install(true);
    fx.acknowledge_current_library();
    fx.load(&plugin)
        .expect("a signed plugin from a trusted key loads");
}

#[test]
fn install_records_the_verified_backend_digest_in_plugin_state() {
    let publisher = generate_keypair("publisher");
    let fx = Fixture::signed_by(&publisher);
    fx.install(true);

    let raw = std::fs::read_to_string(fx.root().join("plugin-state.json")).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(doc["version"], 2, "the state store is version-gated: {doc}");
    let verified = &doc["plugins"][PLUGIN_ID]["verifiedBackend"];
    let lib = library_in(&fx.plugin_dir());
    assert_eq!(
        verified["sha256"].as_str().unwrap(),
        sha256_digest(&std::fs::read(&lib).unwrap()),
        "the install-verified library digest is persisted out of the plugin dir"
    );
    assert_eq!(verified["signerTrusted"], true);
}

#[test]
fn a_library_swapped_and_resigned_by_an_untrusted_key_is_refused_at_load() {
    let publisher = generate_keypair("publisher");
    let attacker = generate_keypair("attacker");
    let fx = Fixture::signed_by(&publisher);
    let plugin = fx.install(true);

    fx.swap_library_and_resign(&attacker);

    match fx.load(&plugin) {
        Err(HostError::SigningKeyNotTrusted { key_id, .. }) => {
            assert_eq!(key_id, attacker.key_id);
        }
        other => panic!("expected SigningKeyNotTrusted, got {other:?}"),
    }
}

#[test]
fn a_library_swapped_and_resigned_by_the_trusted_key_is_refused_by_the_install_record() {
    // Even a signature from a trusted key cannot re-point the load at bytes the
    // manager never installed: the library must match the digest persisted at
    // install time.
    let publisher = generate_keypair("publisher");
    let fx = Fixture::signed_by(&publisher);
    let plugin = fx.install(true);

    fx.swap_library_and_resign(&publisher);

    match fx.load(&plugin) {
        Err(HostError::InstallRecordMismatch { .. }) => {}
        other => panic!("expected InstallRecordMismatch, got {other:?}"),
    }
}

#[test]
fn a_signing_key_revoked_after_install_is_refused_at_load() {
    let publisher = generate_keypair("publisher");
    let fx = Fixture::signed_by(&publisher);
    let plugin = fx.install(true);
    fx.acknowledge_current_library();

    let mut store = TrustStore::load(&fx.root()).unwrap();
    store.revoke(&publisher.key_id).unwrap();

    match fx.load(&plugin) {
        Err(HostError::SigningKeyNotTrusted { key_id, .. }) => {
            assert_eq!(key_id, publisher.key_id);
        }
        other => panic!("expected SigningKeyNotTrusted, got {other:?}"),
    }
}

#[test]
fn an_install_once_signed_plugin_loads_bound_to_its_install_record() {
    // "Install once" (signed, key not pinned) is an accepted-risk install; it
    // still loads, bound to the signer and digest recorded at install.
    let publisher = generate_keypair("publisher");
    let fx = Fixture::signed_by(&publisher);
    let plugin = fx.install(false);
    fx.acknowledge_current_library();
    fx.load(&plugin)
        .expect("an install-once plugin loads unchanged");
}

#[test]
fn an_install_once_plugin_swapped_and_resigned_by_an_untrusted_key_is_refused() {
    let publisher = generate_keypair("publisher");
    let attacker = generate_keypair("attacker");
    let fx = Fixture::signed_by(&publisher);
    let plugin = fx.install(false);

    fx.swap_library_and_resign(&attacker);

    match fx.load(&plugin) {
        Err(HostError::SigningKeyNotTrusted { key_id, .. }) => {
            assert_eq!(key_id, attacker.key_id);
        }
        other => panic!("expected SigningKeyNotTrusted, got {other:?}"),
    }
}
