"""The update check, graded against a loopback feed instead of GitHub (#5388).

The harness profile turns automatic update checks off for every test app
(:mod:`termihub_harness.profile_defaults`), and this suite points the app's
update client at an in-process feed with ``TERMIHUB_TEST_HTTP_BASE`` (a
test-bridge-only seam: ``https://api.github.com/<path>`` is fetched from
``<base>/api.github.com/<path>``). It grades both halves of TST-005:

* no automatic update request reaches the feed after launch, even past the
  frontend's 5-second startup check (the backend honours ``autoCheck=false``);
* "Check Now" does reach it, and the newer release it serves is shown. No
  request leaves the machine, so the egress probe has nothing to report.

The feed answers both channels: ``releases/latest`` (stable) and the rolling
``dev-develop-latest`` pre-release (develop builds). A build that does not
check at all says "Not checked for this build" and must not call the feed.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler

import pytest

from termihub_harness import LocalThreadingHTTPServer, SettingsUi, SystemTest

pytestmark = pytest.mark.integration

STABLE_PATH = "/api.github.com/repos/armaxri/termiHub/releases/latest"
DEVELOP_PATH = "/api.github.com/repos/armaxri/termiHub/releases/tags/dev-develop-latest"
FEED_VERSION = "99.0.0"
FEED_COMMIT = "f" * 40
#: Past the frontend's 5 s startup check, with margin for a slow runner.
STARTUP_QUIET_SECONDS = 9.0

_RELEASES = {
    STABLE_PATH: {
        "tag_name": f"v{FEED_VERSION}",
        "prerelease": False,
        "body": "Hermetic feed release (#5388)",
        "html_url": f"https://github.com/armaxri/termiHub/releases/tag/v{FEED_VERSION}",
    },
    DEVELOP_PATH: {
        "html_url": "https://github.com/armaxri/termiHub/releases/tag/dev-develop-latest",
        "target_commitish": FEED_COMMIT,
        "published_at": "2099-01-01T00:00:00Z",
    },
}


class _Feed:
    """A loopback GitHub-releases stand-in that records every request path."""

    def __init__(self) -> None:
        self.paths: list[str] = []
        feed = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - http.server API
                feed.paths.append(self.path)
                release = _RELEASES.get(self.path)
                body = json.dumps(release or {"message": "Not Found"}).encode()
                self.send_response(200 if release else 404)
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


class TestUpdateCheckAgainstALoopbackFeed(SettingsUi, SystemTest):
    feed: _Feed

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        cls.feed = _Feed()
        request.addfinalizer(cls.feed.close)
        return {"TERMIHUB_TEST_HTTP_BASE": cls.feed.base}

    def _latest_version_text(self) -> str:
        if not self.driver.exists("update-latest-version"):
            return ""
        return self.driver.get_text("update-latest-version").strip()

    def test_no_automatic_check_then_check_now_reads_the_feed(self):
        assert self.persisted_settings()["updates"]["autoCheck"] is False
        time.sleep(STARTUP_QUIET_SECONDS)
        assert self.feed.paths == [], (
            f"automatic update check reached the feed despite autoCheck=false: {self.feed.paths}"
        )

        self.open_settings_category("updates")
        self.wait(lambda: self.driver.exists("update-check-now"), what="the Check Now button")
        self.driver.click("update-check-now")
        self.wait(
            lambda: self._latest_version_text() not in ("", "—"),
            timeout=30,
            what="the update check to finish",
        )
        shown = self._latest_version_text()
        if shown == "Not checked for this build":
            assert self.feed.paths == [], "a build without a channel must not check"
            return
        assert self.feed.paths and set(self.feed.paths) <= {STABLE_PATH, DEVELOP_PATH}, (
            f"Check Now fetched {self.feed.paths} from the loopback feed"
        )
        if self.feed.paths[-1] == STABLE_PATH:
            assert shown == f"v{FEED_VERSION}", f"stable feed offered v{FEED_VERSION}, UI: {shown!r}"
        else:
            # A build without an embedded commit time cannot order itself
            # against the feed and stays "Up to date"; the request is the grade.
            assert FEED_COMMIT[:7] in shown or shown == "Up to date", (
                f"develop feed offered {FEED_COMMIT}, UI: {shown!r}"
            )
