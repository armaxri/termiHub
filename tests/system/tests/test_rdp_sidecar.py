"""The RDP sidecar graded on every OS: Test connection and helper integrity (#5175).

``test_rdp.py`` drives the real app against the Linux xrdp container, so on
macOS and Windows — WKWebView and WebView2, where renderer, clipboard and focus
bugs live — the RDP sidecar never ran. These suites need no container: the
``rdp_test_server`` fixture serves the sidecar's own scripted RDP server
(``rdp-sidecar/examples/rdp_test_server.rs``, from #5271's redirection tests)
on a loopback port. It answers X.224 selecting TLS, completes the handshake
with a throwaway self-signed certificate, runs the MCS connect sequence and
licensing, and activates a session. It reports every connection it accepted
and every Client Info PDU (the username) it received, so a grade can check what
reached the server, not just what the app showed.

* **Test connection (#4320, #4510).** The connection editor's **Test** spawns
  the sidecar, which connects and stops at the untrusted certificate. The
  editor asks the user to review it; accepting carries the probe through the
  logon to an established session, rejecting ends it before any credential
  leaves the client, and an unreachable port fails without a review.
* **Helper integrity (#1762, #5098).** ``build-system-test-app.sh`` embeds the
  built sidecar's SHA-256 into the test app, as a release build embeds the
  bundled one's. Without the ``$TERMIHUB_RDP_HELPER`` override the app resolves
  the helper through ``PATH`` and must verify it before spawning: a genuine
  copy runs, a tampered copy is refused before it can dial the server.

The outcome of a Test is read from the Test button's ``data-test-outcome``
(toasts carry no test id).
"""

from __future__ import annotations

import hashlib
import mmap
import os
import shutil
import socket
import tempfile
from pathlib import Path
from typing import Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    RDP_HELPER_ENV,
    ConnectionsUi,
    PasswordPromptUi,
    RdpTestServer,
    RemoteDesktopUi,
    SettingsUi,
    SystemTest,
    TabsUi,
    find_rdp_helper,
    unique_name,
)
from termihub_harness.fixtures import RDP_HELPER_NAME
from termihub_harness.orchestrator import app_binary_path

pytestmark = pytest.mark.integration

#: The scripted server listens on IPv4 loopback.
HOST = "127.0.0.1"
USERNAME = "sidecar-user"
PASSWORD = "sidecar-pass"
#: Budget for the sidecar to spawn, connect and stop at the certificate, and for
#: a Test to reach its verdict.
PROBE_TIMEOUT = 60.0
TEST_BUTTON = "connection-editor-test"
OUTCOME = "data-test-outcome"


def _unused_local_port() -> int:
    """A loopback TCP port nothing listens on (bound once, then released)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


class _ProbeSuite(
    RemoteDesktopUi, PasswordPromptUi, SettingsUi, TabsUi, ConnectionsUi, SystemTest
):
    """Shared flow: Test an unsaved RDP form against the scripted server."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def run_test_connection(self, port: int, *, cert: Optional[str]) -> str:
        """Fill an unsaved RDP form for ``HOST:port``, click **Test**, answer
        the password prompt and — when ``cert`` is ``"accept"``/``"reject"`` —
        the certificate review; return the Test's outcome."""
        self.enable_experimental_features()
        self.close_all_tabs()
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", unique_name("rdp-sidecar"))
        self.select_connection_type("rdp")
        self.wait(lambda: self.driver.exists("field-host"), what="the RDP connection fields")
        self.driver.type("field-host", HOST)
        self.driver.type("field-port", str(port))
        self.driver.type("field-username", USERNAME)
        self.wait(
            lambda: self.driver.get_attribute(TEST_BUTTON, "data-invalid") is None,
            what="the RDP form to report itself valid",
        )
        assert self.driver.get_attribute(TEST_BUTTON, OUTCOME) is None
        self.driver.click(TEST_BUTTON)
        self.handle_password_prompt(PASSWORD)
        if cert is not None:
            self.wait(
                lambda: self.driver.exists(self.CERT_PROMPT),
                timeout=PROBE_TIMEOUT,
                what="the Test's certificate review",
            )
            self.driver.click(self.CERT_ACCEPT_ONCE if cert == "accept" else self.CERT_REJECT)
        return self.wait(
            lambda: self.driver.get_attribute(TEST_BUTTON, OUTCOME),
            timeout=PROBE_TIMEOUT,
            what="the connection test to finish",
        )


class TestRdpSidecarTestConnection(_ProbeSuite):
    """RDP-SC-01: Test connection through the real sidecar, on every OS."""

    def test_accepted_certificate_logs_on(self, rdp_test_server: RdpTestServer):
        before = len(rdp_test_server.client_infos())
        outcome = self.run_test_connection(rdp_test_server.port, cert="accept")
        assert outcome == "success", rdp_test_server.output()
        # The sidecar's Client Info reached the server with the form's user.
        assert rdp_test_server.client_infos()[before:] == [USERNAME]
        # Nothing was saved and no tab opened for the session.
        assert self.find_tab_of_type("remote-desktop") is None

    def test_rejected_certificate_sends_no_credentials(self, rdp_test_server: RdpTestServer):
        before_dials = rdp_test_server.dials()
        before_infos = len(rdp_test_server.client_infos())
        outcome = self.run_test_connection(rdp_test_server.port, cert="reject")
        assert outcome == "failed"
        # The sidecar did connect (and stopped at the certificate) ...
        assert rdp_test_server.dials() > before_dials
        # ... but no logon (and so no credential) followed the rejection.
        assert len(rdp_test_server.client_infos()) == before_infos

    def test_unreachable_port_fails_without_a_review(self, rdp_test_server: RdpTestServer):
        outcome = self.run_test_connection(_unused_local_port(), cert=None)
        assert outcome == "failed"
        assert not self.driver.exists(self.CERT_PROMPT)

    def find_tab_of_type(self, content_type: str) -> Optional[dict]:
        tab = self.active_tab() or {}
        return tab if tab.get("contentType") == content_type else None


def _file_contains(path: Path, needle: bytes) -> bool:
    with path.open("rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
        return data.find(needle) != -1


class TestRdpSidecarIntegrity(_ProbeSuite):
    """RDP-SC-02: the app verifies the helper it resolves before spawning it.

    The app is launched without ``$TERMIHUB_RDP_HELPER`` (the override skips the
    check) and with a private directory first on its ``PATH``, where each test
    puts the helper it wants the app to find.
    """

    unset_app_env = (RDP_HELPER_ENV,)
    helper_dir: Path

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        request.getfixturevalue("rdp_test_server")
        helper = find_rdp_helper()
        assert helper is not None  # rdp_test_server skipped otherwise
        app = app_binary_path()
        if (app.parent / RDP_HELPER_NAME).exists():
            pytest.skip(
                f"a {RDP_HELPER_NAME} next to the app binary would win over PATH: "
                f"remove {app.parent / RDP_HELPER_NAME}"
            )
        digest = hashlib.sha256(helper.read_bytes()).hexdigest()
        if not _file_contains(app, digest.encode()):
            pytest.skip(
                "RDP sidecar digest not embedded in the app: build it with "
                "scripts/internal/build-system-test-app.sh"
            )
        cls.helper_dir = Path(tempfile.mkdtemp(prefix="termihub-rdp-helper-"))
        request.addfinalizer(lambda: shutil.rmtree(cls.helper_dir, ignore_errors=True))
        path = os.pathsep.join([str(cls.helper_dir), os.environ.get("PATH", "")])
        return {"PATH": path}

    def stage_helper(self, *, tamper: bool) -> None:
        """Put a copy of the built helper on the app's PATH, optionally with one
        extra byte appended (a different digest, still a runnable binary)."""
        helper = find_rdp_helper()
        assert helper is not None
        staged = self.helper_dir / RDP_HELPER_NAME
        shutil.copy2(helper, staged)
        if tamper:
            with staged.open("ab") as handle:
                handle.write(b"\0")

    def test_genuine_helper_is_verified_and_runs(self, rdp_test_server: RdpTestServer):
        self.stage_helper(tamper=False)
        before = len(rdp_test_server.client_infos())
        outcome = self.run_test_connection(rdp_test_server.port, cert="accept")
        assert outcome == "success", rdp_test_server.output()
        assert rdp_test_server.client_infos()[before:] == [USERNAME]

    def test_tampered_helper_is_refused_before_it_runs(self, rdp_test_server: RdpTestServer):
        self.stage_helper(tamper=True)
        before = rdp_test_server.dials()
        outcome = self.run_test_connection(rdp_test_server.port, cert=None)
        assert outcome == "failed"
        # Refused before spawn: the helper never dialled the server.
        assert rdp_test_server.dials() == before
        assert not self.driver.exists(self.CERT_PROMPT)
