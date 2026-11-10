"""An SFTP transfer survives an app crash: kill mid-transfer, relaunch, resume (#5204).

The Rust unit tests from #5161 (``src-tauri/src/files/transfer/relaunch_session_tests.rs``)
cover how a rehydrated session transfer resolves its session and credentials.
This suite is the harness half: it drives the real app end to end.

For an upload and for a download over the Docker ``ssh-password`` fixture:

1. connect through a :class:`~termihub_harness.throttle_proxy.ThrottleProxy`
   and start the transfer from the file browser (native dialog stubbed);
2. with the proxy capping the rate, wait until ``transfers.json`` holds a
   checkpoint of at least ``CHECKPOINT_BYTES`` (8 MiB, mirrored from
   ``persist_manager.rs``). That is the progress signal the kill waits for, not
   a sleep, and it guarantees there is a non-zero offset to resume from;
3. ``kill -9`` the app (:meth:`~termihub_harness.orchestrator.AppInstance.kill_hard`),
   lift the cap and relaunch against the same config dir;
4. the row comes back **paused** (rehydrated rows never auto-resume). Reopen the
   saved connection, click **Resume**, and wait for the row to complete;
5. the proxy's byte counters show the relaunch moved only the rest of the file,
   not all of it again, and the SHA-256 of the destination matches the source.

The hash compare goes through :func:`assert_same_sha256`, whose mismatch case is
pinned by the app-independent tests at the bottom of this file.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    SSH_HOST,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    ProjectionHarness,
    SidebarUi,
    SshServerControl,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.throttle_proxy import ThrottleProxy

#: Mirrors ``CHECKPOINT_BYTES`` in ``src-tauri/src/files/transfer/persist_manager.rs``:
#: the app persists an in-flight transfer's offset every this-many bytes.
CHECKPOINT_BYTES = 8 * 1024 * 1024
#: Three checkpoints' worth, so the kill always lands mid-transfer.
FILE_SIZE = 24 * 1024 * 1024
#: Per-direction cap while the transfer runs: the first checkpoint arrives after
#: ~8 s and the file would take ~24 s, a wide window for the kill.
THROTTLE_BYTES_PER_SEC = 1024 * 1024
TRANSFERS_FILE = "transfers.json"

RESUME = "transfer-resume"
CTX_FILE_DOWNLOAD = "context-file-download"
FILE_BROWSER_UPLOAD = "file-browser-upload"


# ── helpers (also used by the app-independent tests below) ──────────────────
def sha256_of(path: Path) -> str:
    """SHA-256 hex digest of a local file."""
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def assert_same_sha256(source: str, destination: str, what: str) -> None:
    """Fail unless the two digests match: the transfer delivered the exact bytes."""
    assert source == destination, (
        f"{what}: destination SHA-256 {destination} does not match source {source}"
    )


def write_random_file(path: Path, size: int) -> None:
    """``size`` random (incompressible) bytes at ``path``."""
    with open(path, "wb") as fh:
        remaining = size
        while remaining:
            block = min(remaining, 1024 * 1024)
            fh.write(os.urandom(block))
            remaining -= block


def persisted_record(config_dir: Path, file_name: str) -> Optional[dict[str, Any]]:
    """The ``transfers.json`` record for ``file_name``, or ``None``.

    Tolerates a missing file and a read that races the app's atomic write.
    """
    try:
        data = json.loads((Path(config_dir) / TRANSFERS_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    for record in data.get("transfers") or []:
        if record.get("fileName") == file_name:
            return record
    return None


# ── live suite ──────────────────────────────────────────────────────────────
@pytest.mark.integration
@pytest.mark.category("sftp")
@pytest.mark.usefixtures("ssh_password_fixtures")
class TestTransferRelaunch(
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    FilesUi,
    ProjectionHarness,
    SystemTest,
):
    """Kill the app mid-transfer, relaunch, and finish the transfer from its offset."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    proxy: ThrottleProxy
    server: SshServerControl

    @pytest.fixture(scope="class", autouse=True)
    @classmethod
    def _throttle_proxy(cls, request: pytest.FixtureRequest):
        server = SshServerControl()
        if not server.available:
            pytest.skip("SSH container fixtures unavailable: no container runtime available")
        request.cls.server = server
        with ThrottleProxy(SSH_HOST, SSH_PASSWORD_PORT) as proxy:
            request.cls.proxy = proxy
            yield

    # -- region reads ------------------------------------------------------------
    def _queue_entry(self, name: str) -> Optional[dict[str, Any]]:
        if getattr(self, "_transfers_sub", None) is None:
            self._transfers_sub = self.projection_subscribe("transfers")["subscriptionId"]
        cache = self.driver.projection_state(self._transfers_sub).get("cache") or {}
        queue = (cache.get("view") or {}).get("queue") or {}
        return next((e for e in queue.values() if e.get("name") == name), None)

    def _wait_entry_state(self, name: str, state: str, *, timeout: float) -> dict[str, Any]:
        def reached():
            entry = self._queue_entry(name)
            return entry if entry and entry.get("state") == state else False

        return self.wait(reached, what=f"the {name!r} row to be {state}", timeout=timeout)

    # -- flow --------------------------------------------------------------------
    def _connect_and_open_files(self, conn: str) -> str:
        """Connect through the proxy and return the SFTP browser's settled path."""
        self.connect_ssh_password(conn, port=self.proxy.port)
        self.switch_to_files_sidebar()
        self.wait(
            lambda: self.driver.exists("password-prompt-input")
            or self.driver.exists(self.CURRENT_PATH),
            what="the SFTP browser or its password prompt",
        )
        if self.password_prompt_open():
            self.handle_password_prompt()
        return self.wait_file_browser_settled()

    def _reconnect(self, conn: str) -> None:
        """Reopen the saved connection after the relaunch (a live session for it)."""
        self.switch_to_connections_sidebar()
        self.connect_connection(conn)
        self.handle_password_prompt()
        self.accept_host_key_prompt()
        self.wait(self.has_terminal, what="the reopened SSH session")

    def _resume_until_completed(self, name: str) -> dict[str, Any]:
        """Click Resume on the paused row, again if it pauses once more, until done.

        A relaunch that cannot find its session yet pauses the row again with a
        reason, so a single click could race the reopened session registering.
        """
        last_click = [0.0]

        def done():
            entry = self._queue_entry(name)
            if entry is None:
                return False
            if entry.get("state") == "completed":
                return entry
            assert entry.get("state") != "failed", f"the relaunched transfer failed: {entry}"
            if (
                entry.get("state") == "paused"
                and time.monotonic() - last_click[0] > 5.0
                and self.driver.exists(RESUME)
            ):
                self.driver.click(RESUME)
                last_click[0] = time.monotonic()
            return False

        return self.wait(done, what=f"the relaunched {name!r} transfer to complete", timeout=180.0)

    def _crash_mid_transfer_and_resume(
        self, conn: str, name: str, start: Callable[[], None], *, upload: bool
    ) -> None:
        """Run ``start`` throttled, kill at a checkpoint, relaunch, resume to completion."""
        self.proxy.set_rate(THROTTLE_BYTES_PER_SEC)
        try:
            start()
            self._wait_entry_state(name, "active", timeout=60.0)
            self.wait(
                lambda: (persisted_record(self.config_dir, name) or {}).get("resumeOffset", 0)
                >= CHECKPOINT_BYTES,
                what=f"a persisted checkpoint of {name!r}",
                timeout=120.0,
            )
            self.app.kill_hard()
        finally:
            self.proxy.set_rate(None)

        record = persisted_record(self.config_dir, name)
        assert record is not None, "the killed app must leave the transfer persisted"
        offset = record["resumeOffset"]
        assert CHECKPOINT_BYTES <= offset < FILE_SIZE, record
        assert record["status"] == "active", record

        sent_before = self.proxy.upstream_bytes if upload else self.proxy.downstream_bytes
        self.restart_app()
        self._transfers_sub = None

        # The row reappears paused, at the persisted offset, under its old id.
        entry = self._wait_entry_state(name, "paused", timeout=60.0)
        assert entry["id"] == record["transferId"], entry
        assert entry.get("transferred") == offset, entry

        self._reconnect(conn)
        self._resume_until_completed(name)
        assert persisted_record(self.config_dir, name) is None, (
            "a completed transfer is pruned from transfers.json"
        )

        # Resumed, not restarted: the relaunch moved roughly the rest of the file
        # (plus SSH overhead). Restarting from zero would move all of it again.
        moved = (self.proxy.upstream_bytes if upload else self.proxy.downstream_bytes) - sent_before
        assert moved < FILE_SIZE - offset // 2, (
            f"the relaunch moved {moved} bytes for a {FILE_SIZE}-byte file resumed at "
            f"{offset}: it restarted from zero instead of resuming"
        )

    # -- tests -------------------------------------------------------------------
    def test_upload_resumes_after_a_crash_and_the_hash_matches(self):
        conn = unique_name("relaunch-upload")
        name = f"{unique_name('up')}.bin"
        workdir = Path(tempfile.mkdtemp(prefix="thub-relaunch-up-"))
        source = workdir / name
        write_random_file(source, FILE_SIZE)
        remote = None
        try:
            home = self._connect_and_open_files(conn)
            remote = f"{home.rstrip('/')}/{name}"

            def start() -> None:
                self.driver.stub_native_dialog("open", source)
                self.driver.click(FILE_BROWSER_UPLOAD)

            self._crash_mid_transfer_and_resume(conn, name, start, upload=True)
            assert self.server.file_size(remote) == FILE_SIZE
            assert_same_sha256(sha256_of(source), self.server.sha256(remote), "upload")
        finally:
            if remote is not None:
                self.server.remove_path(remote)
            shutil.rmtree(workdir, ignore_errors=True)

    def test_download_resumes_after_a_crash_and_the_hash_matches(self):
        conn = unique_name("relaunch-download")
        name = f"{unique_name('down')}.bin"
        workdir = Path(tempfile.mkdtemp(prefix="thub-relaunch-down-"))
        target = workdir / name
        remote = None
        try:
            home = self._connect_and_open_files(conn)
            remote = f"{home.rstrip('/')}/{name}"
            self.server.write_random_file(remote, FILE_SIZE, user=SSH_USERNAME)
            self.wait_for_file_row(name)

            def start() -> None:
                self.open_file_menu(name)
                self.wait(
                    lambda: self.driver.exists(CTX_FILE_DOWNLOAD), what="the Download menu item"
                )
                self.driver.stub_native_dialog("save", target)
                self.driver.click(CTX_FILE_DOWNLOAD)

            self._crash_mid_transfer_and_resume(conn, name, start, upload=False)
            assert target.stat().st_size == FILE_SIZE
            assert_same_sha256(self.server.sha256(remote), sha256_of(target), "download")
        finally:
            if remote is not None:
                self.server.remove_path(remote)
            shutil.rmtree(workdir, ignore_errors=True)


# ── app-independent checks of the helpers (per-PR machinery lane) ───────────
def test_assert_same_sha256_fails_on_a_mismatched_hash(tmp_path: Path):
    """A destination that differs by one byte must fail the hash check."""
    source = tmp_path / "source.bin"
    write_random_file(source, 64 * 1024)
    damaged = tmp_path / "damaged.bin"
    data = bytearray(source.read_bytes())
    data[len(data) // 2] ^= 0xFF
    damaged.write_bytes(bytes(data))

    assert_same_sha256(sha256_of(source), sha256_of(source), "identical")
    with pytest.raises(AssertionError, match="does not match"):
        assert_same_sha256(sha256_of(source), sha256_of(damaged), "damaged")


def test_assert_same_sha256_fails_on_a_truncated_copy(tmp_path: Path):
    """A partial destination (the state a kill leaves) fails the hash check."""
    source = tmp_path / "source.bin"
    write_random_file(source, 64 * 1024)
    partial = tmp_path / "partial.bin"
    partial.write_bytes(source.read_bytes()[: 32 * 1024])
    with pytest.raises(AssertionError):
        assert_same_sha256(sha256_of(source), sha256_of(partial), "partial")


def test_persisted_record_reads_the_transfer_by_file_name(tmp_path: Path):
    assert persisted_record(tmp_path, "a.bin") is None  # no file yet
    (tmp_path / TRANSFERS_FILE).write_text("{not json", "utf-8")
    assert persisted_record(tmp_path, "a.bin") is None  # a torn read
    (tmp_path / TRANSFERS_FILE).write_text(
        json.dumps(
            {
                "version": "1",
                "transfers": [
                    {"transferId": "t-1", "fileName": "a.bin", "resumeOffset": 9},
                    {"transferId": "t-2", "fileName": "b.bin", "resumeOffset": 3},
                ],
            }
        ),
        "utf-8",
    )
    assert persisted_record(tmp_path, "b.bin")["transferId"] == "t-2"
    assert persisted_record(tmp_path, "c.bin") is None
