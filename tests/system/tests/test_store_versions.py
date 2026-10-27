"""Unit tests for the store-version reader (#5048).

Machinery group (no app): parses ``VersionedStore`` impls from synthetic Rust
source and from the real ``src-tauri/src`` tree. Runs anywhere.
"""

import pytest

from termihub_harness.store_versions import current_store_version, store_versions_in

_SOURCE = """
impl crate::utils::migrate::VersionedStore for ConnectionStore {
    const STORE_NAME: &'static str = "connections.json";
    /// docs mentioning const CURRENT_VERSION: u32 = 99; in prose are fine
    const CURRENT_VERSION: u32 = 6;
    fn salvage() {}
}

impl VersionedStore for Forwarding {
    const STORE_NAME: &'static str = "forwarding.json";
    const CURRENT_VERSION: u32 = Other::CURRENT_VERSION;
}

impl VersionedStore for AppSettings {
    const STORE_NAME: &'static str = "settings.json";
    const CURRENT_VERSION: u32 = 1_0;
}
"""


def test_reads_literal_versions_per_impl():
    versions = store_versions_in(_SOURCE)
    assert versions["settings.json"] == 10
    assert "forwarding.json" not in versions, "non-literal versions are not guessed"


def test_ignores_constants_quoted_in_comments():
    assert store_versions_in(_SOURCE)["connections.json"] == 6


def test_real_tree_declares_the_stores_system_tests_assert_on():
    for store in ("connections.json", "settings.json"):
        assert current_store_version(store) >= 1


def test_unknown_store_raises(tmp_path):
    with pytest.raises(LookupError):
        current_store_version("nope.json", src_root=tmp_path)
