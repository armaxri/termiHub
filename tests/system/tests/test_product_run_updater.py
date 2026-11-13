"""Product run: the Updates page offers the right update action (#5758).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The in-app updater installs a signed update in place only
where it applies: a release build that carries the updater public key
(``src-tauri/tauri.updater.conf.json``, merged by release.yml alone), installed
as a macOS ``.app``, a Windows MSI or a Linux AppImage. Every other build keeps
today's "Open downloads page".

The harness app is a test-bridge build without the release config, so it has
no updater key on any platform: the grade is that, with a newer release on the
(loopback) feed, the page offers "Open downloads page" as the primary action
and never "Download and install" — and that nothing is downloaded. The feed is
served in-process through ``TERMIHUB_TEST_HTTP_BASE`` like
``test_update_check_hermetic.py``; no request leaves the machine and no update
is ever performed.
"""

from __future__ import annotations

import json
import platform
import threading
from http.server import BaseHTTPRequestHandler

import pytest

from termihub_harness import LocalThreadingHTTPServer, SettingsUi, SystemTest
from termihub_harness.product_run import ProductRunUi

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

STABLE_PATH = "/api.github.com/repos/armaxri/termiHub/releases/latest"
FEED_VERSION = "99.0.0"
_RELEASE = {
    "tag_name": f"v{FEED_VERSION}",
    "prerelease": False,
    "body": "Product-run updater feed (#5758)",
    "html_url": f"https://github.com/armaxri/termiHub/releases/tag/v{FEED_VERSION}",
}

#: The in-app actions; none may appear in a build without the updater key.
IN_APP_ACTIONS = ("update-install-download", "update-install-restart", "update-install-progress")


class _Feed:
    """A loopback releases feed that records every request path."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        feed = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - http.server API
                feed.paths.append(self.path)
                found = self.path == STABLE_PATH
                body = json.dumps(_RELEASE if found else {"message": "Not Found"}).encode()
                self.send_response(200 if found else 404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args) -> None:
                pass

        self._server = LocalThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


class TestProductRunUpdater(ProductRunUi, SettingsUi, SystemTest):
    phase = "In-app updater actions"
    request_timeout = 90.0
    feed: _Feed

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        cls.feed = _Feed()
        request.addfinalizer(cls.feed.close)
        return {"TERMIHUB_TEST_HTTP_BASE": cls.feed.base}

    def _latest(self) -> str:
        if not self.driver.exists("update-latest-version"):
            return ""
        return self.driver.get_text("update-latest-version").strip()

    def test_10_updates_page_offers_the_downloads_page_without_an_updater_key(self):
        with self.step(
            "updater.no-key.actions",
            "Without the updater key, a newer release is offered through the downloads page "
            "only; nothing is downloaded (#5758)",
            expect="#5758: Settings ▸ Updates after Check now shows "
            f"v{FEED_VERSION} with 'Open downloads page' as the primary button and no "
            "'Download and install' / 'Restart to update' on "
            f"{platform.system()} {platform.machine()}",
        ):
            self.open_settings_category("updates")
            self.wait(lambda: self.driver.exists("update-check-now"), what="Check now")
            self.driver.click("update-check-now")
            self.wait(
                lambda: self._latest() not in ("", "—", "Checking…"),
                timeout=30,
                what="the update check to finish",
            )
            shown = self._latest()
            self.evidence(f"latest version row: {shown!r}; feed requests: {self.feed.paths}")
            offered = [t for t in IN_APP_ACTIONS if self.driver.exists(t)]
            assert not offered, f"in-app update offered by a build without a key: {offered}"
            # Only the release feed was read: no latest.json, no bundle download.
            assert all(p == STABLE_PATH for p in self.feed.paths), self.feed.paths
            if shown != f"v{FEED_VERSION}":
                # A develop or non-checking test build offers no stable update;
                # the absence of in-app actions above is the whole grade there.
                pytest.skip(f"this build does not read the stable feed ({shown!r})")
            self.wait(
                lambda: self.driver.exists("update-open-downloads"),
                what="the Open downloads page button",
            )
            assert "ui-btn--primary" in (
                self.driver.get_attribute("update-open-downloads", "class") or ""
            ), "the downloads page must be the primary action without an updater key"
            assert not self.driver.exists("update-install-hint"), (
                "no hint while the build simply has no updater key"
            )
