"""Plugin discovery over real HTTPS: Browse Plugins and Install from URL (#4961).

MT-APP-03, formerly a guided-manual check, now runs unattended in the nightly
integration lane (``integration`` marker; per-PR CI runs ``not integration``)
on every OS. It is the one suite that needs the internet: the app fetches the
real plugin index from GitHub and a pinned package from this repository.

Network outages: each test first probes the URL the app is about to fetch
(:mod:`termihub_harness.https_probe`). No answer or a 5xx/429 skips with the
``network unavailable: …`` reason that ``skip-allowlist.d/`` admits for this
module. A 404, or any other answer, is graded — a missing index or package
fails the lane.

The default index lives on ``main`` (``DEFAULT_PLUGIN_INDEX_URL``). Between a
feature landing on ``develop`` and its release, ``main`` does not ship plugin
discovery and has no index yet, so a develop or release-candidate grade would
otherwise wait on a release that waits on this grade. The test therefore asks
``main`` whether it ships plugin discovery (its ``plugin_index.rs``): if it
does, the default index must load from ``main``; if it does not, the same
index path is graded on ``develop`` through the custom index URL setting. The
404 a regression produces (a wrong path, a deleted index) fails either way.

The pinned package is ``tests/fixtures/plugins/clock-widget-1.0.0.termihub-plugin``
at the commit that added it, so its URL and SHA-256 never move. It installs
only into this instance's isolated config dir.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

from termihub_harness import SettingsUi, SystemTest
from termihub_harness.https_probe import ProbeResult, is_outage, outage_reason, probe

pytestmark = pytest.mark.integration

REPO_ROOT = Path(__file__).resolve().parents[3]
_RAW = "https://raw.githubusercontent.com/armaxri/termiHub"

#: Where ``main`` keeps plugin discovery; a 404 means main has not shipped it.
MAIN_DISCOVERY_SOURCE = f"{_RAW}/main/src-tauri/src/commands/plugin_index.rs"

#: The commit that added the fixture package (#4961); never rewrite it.
PINNED_PACKAGE_COMMIT = "2aeacf1ac9361ff13b2a2fbb5db753fff867c873"
PINNED_PACKAGE_PATH = "tests/fixtures/plugins/clock-widget-1.0.0.termihub-plugin"
PINNED_PACKAGE_URL = f"{_RAW}/{PINNED_PACKAGE_COMMIT}/{PINNED_PACKAGE_PATH}"
PINNED_PACKAGE_SHA256 = "8a49611bbed46cbaf0ec0ce534709b37b50157fbc157a0ff6b642a3ff354788e"
PINNED_PLUGIN_ID = "clock-widget"


def default_index_url() -> str:
    """The backend's ``DEFAULT_PLUGIN_INDEX_URL`` (the URL the app really fetches)."""
    source = (REPO_ROOT / "src-tauri/src/commands/plugin_index.rs").read_text(encoding="utf-8")
    match = re.search(r'DEFAULT_PLUGIN_INDEX_URL: &str =\s*"([^"]+)"', source)
    assert match, "DEFAULT_PLUGIN_INDEX_URL not found in plugin_index.rs"
    return match.group(1)


def _graded(result: ProbeResult) -> ProbeResult:
    """Skip on an outage (allowlisted); otherwise hand the answer back to grade."""
    if is_outage(result):
        pytest.skip(outage_reason(result))
    return result


class TestPluginDiscoveryOverHttps(SettingsUi, SystemTest):
    def _set_custom_index_url(self, url: str) -> None:
        self.driver.type("plugin-catalog-url", url)
        self.driver.press_key("Enter", "plugin-catalog-url")
        self.wait(
            lambda: self.persisted_settings().get("pluginIndexUrl") == url,
            what=f"the custom plugin index URL {url} to be saved",
        )

    def _index_to_grade(self) -> tuple[str, ProbeResult, bool]:
        """``(url, probe, is_default)`` of the index this run grades."""
        default_url = default_index_url()
        default = _graded(probe(default_url))
        if default.status != 404:
            return default_url, default, True
        shipped = _graded(probe(MAIN_DISCOVERY_SOURCE))
        assert shipped.status == 404, (
            f"main ships plugin discovery (HTTP {shipped.status} for its plugin_index.rs) "
            f"but its default plugin index {default_url} is HTTP 404"
        )
        develop_url = default_url.replace("/main/", "/develop/")
        return develop_url, _graded(probe(develop_url)), False

    def test_browse_plugins_loads_the_plugin_index_and_lists_its_entries(self):
        """MT-APP-03: Browse Plugins loads the default index (no HTTP 404) and lists it."""
        url, index, is_default = self._index_to_grade()
        assert index.status == 200, f"plugin index {url} answered HTTP {index.status}"
        entry_ids = [entry["id"] for entry in json.loads(index.body)["plugins"]]

        self.open_settings_category("plugins")
        self.wait(lambda: self.driver.exists("plugin-catalog-load"), what="Browse Plugins")
        if not is_default:
            self._set_custom_index_url(url)
        self.driver.click("plugin-catalog-load")
        self.wait(
            lambda: self.driver.exists("plugin-catalog-signature")
            or self.driver.exists("plugin-catalog-error"),
            timeout=60,
            what=f"the plugin index {url} to load",
        )
        assert not self.driver.exists("plugin-catalog-error"), (
            f"loading the plugin index {url} failed in the app: "
            f"{self.driver.get_text('plugin-catalog-error')}"
        )
        if entry_ids:
            for entry_id in entry_ids:
                assert self.driver.exists(f"plugin-catalog-entry-{entry_id}"), (
                    f"the loaded index lists {entry_id} but Browse Plugins does not show it"
                )
        else:
            assert self.driver.exists("plugin-catalog-empty"), "no empty-index state shown"

    def test_install_from_url_reviews_the_pinned_package_before_installing(self):
        """MT-APP-03: Install from URL with a pinned SHA-256 asks before installing."""
        local = hashlib.sha256((REPO_ROOT / PINNED_PACKAGE_PATH).read_bytes()).hexdigest()
        assert local == PINNED_PACKAGE_SHA256, "the committed fixture package changed"
        package = _graded(probe(PINNED_PACKAGE_URL))
        assert package.status == 200, f"{PINNED_PACKAGE_URL} answered HTTP {package.status}"

        installed = self.config_dir / "plugins" / PINNED_PLUGIN_ID / "manifest.json"
        assert not installed.exists()
        self.open_settings_category("plugins")
        self.wait(lambda: self.driver.exists("plugin-url-install-url"), what="Install from URL")
        self.driver.type("plugin-url-install-url", PINNED_PACKAGE_URL)
        self.driver.type("plugin-url-install-sha", PINNED_PACKAGE_SHA256)
        self.driver.click("plugin-url-install-download")
        self.wait(self._install_dialog_or_failure, timeout=120, what="the plugin install dialog")

        # Unsigned package: the untrusted banner shows and nothing is on disk yet.
        assert self.driver.exists("plugin-install-trust-untrusted"), (
            "the unsigned package did not show the untrusted-source banner"
        )
        assert not installed.exists(), "the plugin was installed before confirming"

        self.driver.click("plugin-install-confirm")
        self.wait(installed.exists, timeout=60, what=f"{PINNED_PLUGIN_ID} to be installed")
        manifest = json.loads(installed.read_text(encoding="utf-8"))
        assert (manifest["id"], manifest["version"]) == (PINNED_PLUGIN_ID, "1.0.0")

    def _install_dialog_or_failure(self) -> bool:
        if self.driver.exists("plugin-install-dialog"):
            return True
        failed = self.driver.read_frontend_log(contains="Install from URL failed")
        assert not failed, f"Install from URL failed in the app: {failed[-1]}"
        return False
