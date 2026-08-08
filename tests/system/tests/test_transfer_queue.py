"""Transfer Queue panel integration tests (issue #1532).

The Vitest suite from #1337 (PR #1530) covers the mapper, the store slice and
every row/control permutation in isolation. What it cannot cover is the wiring:
that a **real backend transfer** reaches the panel at all — the
``transfer-progress`` event → ``onTransferProgress`` ``listen`` subscription →
``useTransferEvents`` → ``applyTransferProgressToQueue`` → ``TransferQueue``
render chain, running inside the real app. That is what this suite adds.

Two suites, split by what each can assert *deterministically*:

``TestTransferQueueLiveTransfer``
    Drives a **real SFTP transfer** over the Docker ``ssh-password`` fixture and
    asserts the panel populates from it. The entry point is the file browser's
    **copy → paste**: since the SFTP convergence (#2421) an SSH session→session
    copy flows through ``useSessionFileSystem.pasteEntry``, which — when both
    endpoints are SFTP-backed — routes the copy as "download to a local temp
    file, re-upload to the destination" over the dedicated transfer channel
    (#2469). A single paste therefore drives two real ``session_download`` /
    ``session_upload`` transfers and emits real ``transfer-progress`` events —
    including the remote ``path`` added by #1531 (PR #1543), which this suite
    asserts reaches the row.

    Copy/paste is used deliberately: it is the **only** transfer entry point the
    bridge can drive. Every other one (file-browser Download/Upload, the
    editor's "Download a copy") opens a native OS file dialog first, which the
    in-webview bridge cannot reach — the same constraint documented in
    ``test_sftp_infra.py`` and handled as guided-manual in ``test_native_dialogs.py``.

``TestTransferQueuePanel``
    Drives the panel through ``emitEvent`` (#1545, PR #1556), injecting
    ``transfer-progress`` on the real Tauri event bus. The app's own ``listen``
    subscription and store fold run untouched — only the byte-moving backend is
    substituted. This buys **determinism** for the states a real localhost
    transfer cannot be held in long enough to assert: rising percent, ``paused``,
    ``failed``, and the exact control set per state. It needs no container.

Together: the live suite proves the real pipeline carries a real transfer to the
panel; the injected suite pins the per-state behaviour the issue enumerates.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    ProjectionHarness,
    SidebarUi,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration


# ── testids (tests/system/testid-catalog.md) ────────────────────────────────
QUEUE = "transfer-queue"
QUEUE_SUMMARY = "transfer-queue-summary"
QUEUE_INDICATOR = "transfer-queue-indicator"
ROW = "transfer-row"
ROW_NAME = "transfer-row-name"
ROW_STATUS = "transfer-row-status"
PAUSE = "transfer-pause"
RESUME = "transfer-resume"
CANCEL = "transfer-cancel"
RETRY = "transfer-retry"
REMOVE = "transfer-remove"
CLEAR_COMPLETED = "transfer-clear-completed"
CANCEL_ALL = "transfer-cancel-all"
MINIMIZE = "transfer-minimize"


def progress(**overrides) -> dict:
    """A ``transfer-progress`` payload, keyed as the backend serializes it.

    ``TransferProgress`` is ``#[serde(rename_all = "camelCase")]``
    (``src-tauri/src/files/transfer/mod.rs``), so every key here is camelCase —
    copied from the emitter, as ``docs/test-bridge.md`` requires for ``emitEvent``.
    """
    payload = {
        "transferId": "t-1",
        "sessionId": "s-1",
        "direction": "download",
        "fileName": "data.csv",
        "path": "/uploads/data.csv",
        "transferred": 0,
        "total": 1000,
        "phase": "transferring",
        "state": "active",
    }
    payload.update(overrides)
    return payload


class TransferQueueReads(ProjectionHarness):
    """Shared readers over the authoritative ``transfers`` projection region.

    Since #2229 the Transfer Queue panel is **region-authoritative**: the backend
    feeds the shared ``transfers`` region at the source (#2387) and ``appStore`` no
    longer holds the queue slice, so the panel state is read from the projection
    region (via a live ``ProjectionClient`` cache), not from ``get_state``.
    """

    _transfers_sub_id: str | None = None

    def _transfers_queue(self) -> dict:
        """The region's ``queue`` map, read live from the projection cache."""
        if self._transfers_sub_id is None:
            self._transfers_sub_id = self.projection_subscribe("transfers")["subscriptionId"]
        cache = self.driver.projection_state(self._transfers_sub_id).get("cache") or {}
        view = cache.get("view") or {}
        return view.get("queue") or {}

    def queue_entries(self) -> list[dict]:
        """The queue rows as a list (the panel renders its values)."""
        return list(self._transfers_queue().values())

    def entry_states(self) -> list[str]:
        return [e["state"] for e in self.queue_entries()]

    def wait_for_queue_size(self, size: int, *, timeout: float = 30.0) -> list[dict]:
        return self.wait(
            lambda: (
                self.queue_entries() if len(self.queue_entries()) == size else False
            ),
            what=f"the transfer queue to hold {size} row(s)",
            timeout=timeout,
        )


@pytest.mark.usefixtures("ssh_password_fixtures")
class TestTransferQueueLiveTransfer(
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    FilesUi,
    TransferQueueReads,
    SystemTest,
):
    """The panel populated by a **real** SFTP transfer over the SSH fixture.

    Password auth only (``ssh_password_fixtures``) — this suite never uses a key,
    so it does not pull in the ``ssh-keys`` image the broader ``ssh_fixtures``
    would build.
    """

    # Live SFTP connect + transfer: raise the command timeout so a WKWebView
    # JS thread starved by the always-on Docker/krunkit VMs still completes each
    # verb instead of tripping the default 10s mid-negotiation (#2460).
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    # A size that is big enough for the 256 KiB chunk loop to emit several
    # throttled (~10 Hz) progress updates, but small enough that the paste
    # settles well inside the wait budget on a localhost container.
    FILE_MB = 8

    def open_sftp_browser(self) -> str:
        """Show the Files sidebar, clear any password prompt, await the listing.

        Readiness is gated on the file-browser path bar rendering a path, not on a
        ``sftpStatus`` store read: that top-level slice was retired when SFTP UI
        state moved onto the projected file-browser region (the render-cut /
        ``fileBrowser.*`` migration), so ``get_state("sftpStatus")`` no longer
        resolves and the wait timed out immediately (#2398). The shared
        ``SftpUi.connect_sftp_browser`` already gates on the same DOM signal — a
        rendered path is the region-fed "SFTP connected and listing" signal — so
        this mirrors it rather than reading a slice that no longer exists.
        """
        self.switch_to_files_sidebar()
        self.wait(
            lambda: self.driver.exists("password-prompt-input")
            or self.driver.exists(self.CURRENT_PATH),
            what="the SFTP browser or its password prompt",
        )
        # The SFTP session can auto-resolve the prompt from a cached credential, and
        # ``handle_password_prompt`` then tolerates it closing under us (#1593).
        if self.password_prompt_open():
            self.handle_password_prompt()
        return self.wait(lambda: self.file_browser_path() or False, what="the remote path")

    def test_real_sftp_paste_populates_the_transfer_queue(self):
        """A real copy/paste drives rows to `completed`, carrying the remote path.

        The paste is one user action but two backend transfers — a download of
        the source to a local temp file and an upload to the destination — so the
        queue ends with two rows. Both must carry the remote path (#1531): the
        download's is the source path, the upload's is the destination path.
        Both must also be named for the file the user pasted, never for the
        internal temp copy the upload actually reads from (#1573).
        """
        name = f"payload-{unique_name('tq')}.bin"
        dest = f"destdir-{unique_name('tq')}"

        self.connect_ssh_password(unique_name("transfer-queue"))
        self.open_sftp_browser()

        # Seed a source file and an empty destination directory.
        self.run_command(f"dd if=/dev/zero of={name} bs=1M count={self.FILE_MB} 2>/dev/null")
        self.run_command(f"mkdir -p {dest}")
        self.run_command("sync")
        self.wait_for_file_row(name)

        # Read the settled remote working directory only now, not from
        # open_sftp_browser's return: a freshly-connected SFTP browser first
        # renders the transient pre-cwd-follow root ("/") before it follows the
        # terminal into the login directory, so capturing the path up front yielded
        # "/" and every "<base>/<dest>" comparison below was built on the wrong base
        # (#2398). Listing `name` proves the browser has settled on the directory
        # that actually holds it, so the breadcrumb path is now the real base.
        source_dir = self.file_browser_path()

        # Copy the source file, then paste it inside the destination directory.
        # Paste is driven from the toolbar button rather than the row context
        # menu, so the destination does not need an entry to right-click.
        self.open_file_menu(name)
        self.driver.click("context-file-copy")

        self.wait_for_file_row(dest)
        self.driver.double_click(f"file-row-{dest}")
        self.wait(
            lambda: self.file_browser_path() == f"{source_dir.rstrip('/')}/{dest}",
            what=f"the browser to enter {dest!r}",
        )

        self.wait(
            lambda: self.driver.get_attribute("file-browser-paste", "disabled") is None,
            what="Paste to enable once the clipboard holds the copied file",
        )
        self.driver.click("file-browser-paste")

        # Synchronise on the store slice — the authoritative readiness signal —
        # not the panel DOM. `applyTransferProgressToQueue` folds the first
        # `transfer-progress` event into the `transferQueue` slice synchronously
        # in the event callback (`useTransferEvents`), and the panel is mounted
        # unconditionally, gated only by that slice being non-empty
        # (`TransferQueue` returns `null` while `entries.length === 0`). So "a
        # transfer has registered" is the real readiness condition; the panel's
        # `data-testid` only paints on the following React commit, which trails
        # the store, so waiting on the DOM here raced (#1619). The panel's own
        # rendering is still asserted below (the `transfer-row` / summary reads
        # after the two-row wait), so this only moves the *synchronisation* onto
        # the earlier, render-independent signal — it does not drop coverage.
        self.wait(
            lambda: self.queue_entries() or False,
            what="the transfer queue to register the first transfer",
        )

        # Download + upload = two rows, both settling at `completed`.
        entries = self.wait(
            lambda: (
                self.queue_entries()
                if len(self.queue_entries()) == 2
                and all(e["state"] == "completed" for e in self.queue_entries())
                else False
            ),
            what="both paste transfers to complete",
            timeout=120.0,
        )

        by_direction = {e["direction"]: e for e in entries}
        assert set(by_direction) == {"download", "upload"}, entries

        # Every row reaches 100%.
        assert [e["percent"] for e in entries] == [100, 100]

        # Both rows name the file the user knows (#1573). The backend derives
        # `file_name` from the remote path in both directions
        # (`commands/files.rs::file_name_of`), so the name always agrees with
        # the `path` cell in the same row. A paste uploads from a local temp
        # copy (`/tmp/termihub-paste-<ts>-<name>`), and that internal name must
        # never surface.
        assert by_direction["download"]["name"] == name
        assert by_direction["upload"]["name"] == name
        assert not by_direction["upload"]["name"].startswith("termihub-paste-")

        # The remote path from #1531 (PR #1543) reaches both rows: the download
        # reports the source path, the upload the destination path. Without the
        # backend emitting `path`, the entries carry no path at all and this
        # fails (`.get` so that reads as an assertion, not a KeyError).
        base = source_dir.rstrip("/")
        assert by_direction["download"].get("path") == f"{base}/{name}"
        assert by_direction["upload"].get("path") == f"{base}/{dest}/{name}"

        # The panel renders the completed rows and summarises them.
        assert self.driver.exists(ROW)
        assert self.driver.get_text(ROW_STATUS) == "done"
        assert "2 done" in self.driver.get_text(QUEUE_SUMMARY)

        # A completed row offers Remove only — no pause/cancel/retry.
        assert self.driver.exists(REMOVE)
        assert not self.driver.exists(PAUSE)
        assert not self.driver.exists(CANCEL)

        # The pasted file really landed in the destination directory at full
        # size: the transfer moved bytes, it did not merely emit events. Read the
        # session file browser's slice (`sessionFileEntries`), not the SFTP-only
        # `fileEntries`: since the SFTP convergence (#2421) an SSH file browser is
        # a *session* browser, so its listing lives on the session slice — the
        # same mode split `FileBrowserPathReads` documents for `currentPath`.
        self.wait_for_file_row(name)
        entry = self.wait(
            lambda: next(
                (
                    f
                    for f in (self.driver.get_state("sessionFileEntries") or [])
                    if f["name"] == name
                ),
                False,
            ),
            what="the pasted file to list in the destination",
        )
        assert entry["size"] == self.FILE_MB * 1024 * 1024

    def test_clear_completed_empties_the_panel_after_a_real_transfer(self):
        """Clear Completed drops the settled rows, and the panel unmounts."""
        # Runs after the paste test in the same suite (one app per class), so the
        # queue still holds its two completed rows.
        self.wait_for_queue_size(2)

        self.driver.click(CLEAR_COMPLETED)

        self.wait(
            lambda: self.queue_entries() == [],
            what="the queue to be cleared of completed rows",
        )
        # Empty queue ⇒ the panel renders nothing at all.
        self.wait(lambda: not self.driver.exists(QUEUE), what="the panel to unmount")


class TestTransferQueuePanel(TransferQueueReads, SystemTest):
    """Per-state panel behaviour, driven deterministically through ``emitEvent``.

    Every event here goes over the **real** Tauri bus, so the app's real
    ``listen`` subscription, ``useTransferEvents`` hook and store fold run — only
    the byte-moving backend is substituted (see the module docstring).
    """

    @pytest.fixture(autouse=True)
    def _clear_queue_between_tests(self):
        """Reset the panel to empty + expanded so each test starts clean.

        The suite shares one app across its tests, and the Transfer Queue
        deliberately *retains* terminal rows, so leftovers would leak between
        tests. `clearCompleted` only drops `completed` rows, so drive every
        leftover row to `completed` first, then clear them in one click.
        """
        yield
        self.restore_panel()
        for entry in self.queue_entries():
            self.emit_progress(
                transferId=entry["id"], phase="done", state="completed", transferred=1000
            )
        if self.queue_entries():
            self.wait(
                lambda: all(e["state"] == "completed" for e in self.queue_entries()),
                what="leftover rows to settle as completed",
            )
            self.driver.click(CLEAR_COMPLETED)
            self.wait(lambda: self.queue_entries() == [], what="the queue to empty")

    # -- helpers ---------------------------------------------------------------
    def emit_progress(self, **overrides) -> None:
        """Fold one ``transfer-progress`` sample into the authoritative region.

        Since #2229 the Transfer Queue is region-authoritative and the backend
        folds the live progress stream at the source (#2387); a frontend
        ``emit_event`` no longer reaches the queue. To drive the panel states this
        suite pins, dispatch the ``transfer.progress`` intent (the same
        ``TransferProgress`` payload the backend fold parses) straight into the
        shared ``transfers`` region, which the region-authoritative panel renders.
        """
        self.projection_dispatch_intent("transfer.progress", {"progress": progress(**overrides)})

    def restore_panel(self) -> None:
        """Un-minimize the panel via its indicator (the store has no direct setter)."""
        if self.driver.exists(QUEUE_INDICATOR):
            self.driver.click(QUEUE_INDICATOR)
            self.wait(
                lambda: not self.driver.exists(QUEUE_INDICATOR),
                what="the panel to restore",
            )

    def wait_for_row_state(self, state: str, *, transfer_id: str = "t-1") -> dict:
        return self.wait(
            lambda: next(
                (
                    e
                    for e in self.queue_entries()
                    if e["id"] == transfer_id and e["state"] == state
                ),
                False,
            ),
            what=f"transfer {transfer_id} to be {state}",
        )

    # -- tests -----------------------------------------------------------------
    def test_active_row_shows_rising_percent_and_active_controls(self):
        """A row appears with rising percent and offers Pause + Cancel."""
        assert not self.driver.exists(QUEUE), "suite must start with an empty queue"

        self.emit_progress(transferred=100)  # 10%
        self.wait(lambda: self.driver.exists(ROW), what="the transfer row")

        assert self.driver.exists(QUEUE)
        assert self.driver.get_text(ROW_NAME) == "data.csv"
        assert self.wait_for_row_state("active")["percent"] == 10

        # An active row offers Pause and Cancel — not Resume/Retry/Remove.
        assert self.driver.exists(PAUSE)
        assert self.driver.exists(CANCEL)
        assert not self.driver.exists(RESUME)
        assert not self.driver.exists(RETRY)
        assert not self.driver.exists(REMOVE)

        # Percent rises as the backend reports more bytes.
        self.emit_progress(transferred=550)
        assert self.wait_for_row_state("active")["percent"] == 55
        self.emit_progress(transferred=900)
        self.wait(
            lambda: self.queue_entries()[0]["percent"] == 90,
            what="the row to reach 90%",
        )
        assert "1 active" in self.driver.get_text(QUEUE_SUMMARY)

    def test_paused_row_swaps_pause_for_resume(self):
        """`paused` swaps Pause → Resume, keeps Cancel, and Resume goes back."""
        self.emit_progress(transferred=300)
        self.wait_for_row_state("active")

        self.emit_progress(transferred=300, state="paused")
        self.wait_for_row_state("paused")

        assert self.driver.exists(RESUME)
        assert self.driver.exists(CANCEL)
        assert not self.driver.exists(PAUSE)
        assert self.driver.get_text(ROW_STATUS) == "paused"

        # Resume clicks through to the backend (`transfer_resume`), which no-ops
        # for an id it never registered; the row follows the next event.
        self.driver.click(RESUME)
        self.emit_progress(transferred=400, state="active")
        self.wait_for_row_state("active")
        assert self.driver.exists(PAUSE)

    def test_failed_row_offers_retry_and_remove(self):
        """A `failed` row surfaces its attempt counter, Retry and Remove."""
        self.emit_progress(
            phase="error",
            state="failed",
            message="connection reset",
            attempt=2,
            maxAttempts=3,
        )
        entry = self.wait_for_row_state("failed")

        assert entry["error"] == "connection reset"
        assert self.driver.get_text(ROW_STATUS) == "failed (2/3)"
        assert self.driver.exists(RETRY)
        assert self.driver.exists(REMOVE)
        assert not self.driver.exists(PAUSE)
        assert not self.driver.exists(CANCEL)

    def test_cancel_removes_the_row_when_the_backend_confirms(self):
        """Cancel drives the backend; the row settles on the `cancelled` event."""
        self.emit_progress(transferred=200)
        self.wait_for_row_state("active")

        self.driver.click(CANCEL)

        # The click reaches `transfer_cancel`; the row's state change is owned by
        # the backend's terminal event, exactly as in a real transfer.
        self.emit_progress(transferred=200, phase="cancelled", state="cancelled")
        self.wait_for_row_state("cancelled")

        assert self.driver.get_text(ROW_STATUS) == "cancelled"
        assert self.driver.exists(RETRY)
        assert self.driver.exists(REMOVE)
        # A settled row is retained, not dropped — that is the panel's contract.
        assert self.driver.exists(QUEUE)

    def test_cancel_all_is_enabled_only_while_a_row_is_pending(self):
        """Cancel All targets every non-terminal row and disables when none are."""
        self.emit_progress(transferId="t-1", transferred=100)
        self.emit_progress(transferId="t-2", fileName="b.bin", transferred=200)
        self.wait_for_queue_size(2)

        # Two pending rows ⇒ Cancel All is enabled (no `disabled` attribute).
        assert self.driver.get_attribute(CANCEL_ALL, "disabled") is None

        self.driver.click(CANCEL_ALL)
        for tid in ("t-1", "t-2"):
            self.emit_progress(transferId=tid, phase="cancelled", state="cancelled")
        self.wait(
            lambda: self.entry_states() == ["cancelled", "cancelled"],
            what="both rows to be cancelled",
        )

        # Nothing pending ⇒ Cancel All disables itself.
        self.wait(
            lambda: self.driver.get_attribute(CANCEL_ALL, "disabled") is not None,
            what="Cancel All to disable",
        )

    def test_clear_completed_keeps_unfinished_rows(self):
        """Clear Completed drops only `completed` rows, keeping an active one."""
        self.emit_progress(transferId="t-1", phase="done", state="completed", transferred=1000)
        self.emit_progress(transferId="t-2", fileName="b.bin", transferred=100)
        self.wait_for_queue_size(2)

        self.driver.click(CLEAR_COMPLETED)

        remaining = self.wait(
            lambda: self.queue_entries() if len(self.queue_entries()) == 1 else False,
            what="the completed row to be cleared",
        )
        assert remaining[0]["id"] == "t-2"
        assert remaining[0]["state"] == "active"
        assert self.driver.exists(QUEUE)

    def test_minimize_collapses_to_the_indicator_and_restores(self):
        """Minimize hides the panel behind the status-bar indicator, which restores it."""
        self.emit_progress(transferred=100)
        self.wait(lambda: self.driver.exists(QUEUE), what="the panel")
        assert not self.driver.exists(QUEUE_INDICATOR)

        self.driver.click(MINIMIZE)

        # Panel gone, indicator up and counting the in-progress transfer.
        self.wait(lambda: self.driver.exists(QUEUE_INDICATOR), what="the minimized indicator")
        assert not self.driver.exists(QUEUE)
        assert "1 transferring" in self.driver.get_text(QUEUE_INDICATOR)

        # The queue keeps folding events while minimized.
        self.emit_progress(phase="done", state="completed", transferred=1000)
        self.wait(
            lambda: "1 finished" in self.driver.get_text(QUEUE_INDICATOR),
            what="the indicator to report the finished transfer",
        )

        # Clicking the indicator restores the panel.
        self.driver.click(QUEUE_INDICATOR)
        self.wait(lambda: self.driver.exists(QUEUE), what="the panel to restore")
        assert not self.driver.exists(QUEUE_INDICATOR)
        assert self.driver.get_text(ROW_STATUS) == "done"
