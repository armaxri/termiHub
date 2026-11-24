"""Product run: a finished download is reported once, and offers to be shown (#5834).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw one download reported in three places at once
(R-033): a "Downloaded copy-me.txt" toast, "3 transfers done" at the bottom
of the file sidebar and "3 finished ③" in the status bar, and none of them
offered "Show in Finder".

Now the file sidebar's transfer line is the one summary: while it is on screen
the "Downloaded …" toast stays away (#5859) and the status-bar count hides,
and the download that just finished offers the platform's file-manager action
("Reveal in Finder" / "Show in File Explorer" / "Open in File Manager")
beside it. A failure still toasts.

The grade opens the Files sidebar over SFTP on a scratch folder (the run's
native sshd), downloads a file to the run directory, samples the screen while
the transfer settles and counts the places that report it: exactly one, the
sidebar line, with the reveal action beside it. The reveal is not clicked: it
would open the operator's file manager. Its click is graded by the component
tests (``src/components/TransferQueue/revealDownload.test.tsx``).

The ``test_grade_*`` functions grade fixed captures without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import pytest

from termihub_harness import (
    SSH_HOST,
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    SftpUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi

TOAST_REGION = "toast-region"
SUMMARY = "file-browser-transfer-summary"
REVEAL = "file-browser-transfer-reveal"
INDICATOR = "transfer-queue-indicator"
PANEL = "transfer-queue"
CTX_DOWNLOAD = "context-file-download"
#: The seeded remote file the grade downloads.
FILE_NAME = "summary-me.txt"
FILE_TEXT = "one place for one download\n"
#: How long to sample once the file is on disk: past the toast's arrival and
#: the panel's auto-collapse, short of a toast's lifetime.
SAMPLE_SECONDS = 4.0
SAMPLE_EVERY = 0.25


# ── grading ───────────────────────────────────────────────────────────────
@dataclass
class Capture:
    """What reported the download while it settled."""

    #: Every toast text seen during the sample.
    toasts: list[str] = field(default_factory=list)
    #: The sidebar line's text at the end, or ``None`` when it was not shown.
    summary: Optional[str] = None
    #: The status-bar count's text at the end, or ``None`` when it was hidden.
    indicator: Optional[str] = None
    #: The reveal action's visible text at the end, or ``None``.
    reveal: Optional[str] = None


def expected_reveal_label(platform: str = sys.platform) -> str:
    """The file-manager wording the app uses on ``platform`` (``src/utils/platform.ts``)."""
    if platform == "darwin":
        return "Reveal in Finder"
    if platform.startswith("win"):
        return "Show in File Explorer"
    return "Open in File Manager"


def report_places(capture: Capture, file_name: str) -> list[str]:
    """The places that reported the finished download, in reading order."""
    places = []
    if any(t.startswith("Downloaded") and file_name in t for t in capture.toasts):
        places.append("toast")
    if capture.summary and "done" in capture.summary:
        places.append("sidebar")
    if capture.indicator and "finished" in capture.indicator:
        places.append("status bar")
    return places


def summary_problems(capture: Capture, file_name: str, platform: str = sys.platform) -> list[str]:
    """Why the finished download was not reported once with a reveal action."""
    problems = []
    places = report_places(capture, file_name)
    if places != ["sidebar"]:
        where = ", ".join(places) if places else "nowhere"
        problems.append(f"the finished download is reported in: {where} (want only the sidebar line)")
    label = expected_reveal_label(platform)
    if capture.reveal is None:
        problems.append(f"no '{label}' action beside the sidebar line")
    elif label not in capture.reveal:
        problems.append(f"the reveal action reads {capture.reveal!r}, not {label!r}")
    return problems


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_one_place_with_reveal_passes():
    capture = Capture(summary="1 transfer done", reveal="Reveal in Finder")
    assert summary_problems(capture, FILE_NAME, "darwin") == []


def test_grade_the_r033_shape_fails():
    # The review's capture: toast, sidebar and status bar all report it.
    capture = Capture(
        toasts=[f"Downloaded {FILE_NAME}"],
        summary="3 transfers done",
        indicator="3 finished 3",
    )
    assert report_places(capture, FILE_NAME) == ["toast", "sidebar", "status bar"]
    problems = summary_problems(capture, FILE_NAME, "darwin")
    assert "the finished download is reported in: toast, sidebar, status bar" in problems[0]
    assert any("no 'Reveal in Finder' action" in p for p in problems)


def test_grade_a_status_bar_duplicate_alone_fails():
    capture = Capture(summary="1 transfer done", indicator="1 finished 1", reveal="Reveal in Finder")
    assert summary_problems(capture, FILE_NAME, "darwin") == [
        "the finished download is reported in: sidebar, status bar (want only the sidebar line)"
    ]


def test_grade_nothing_reporting_it_fails():
    problems = summary_problems(Capture(), FILE_NAME, "linux")
    assert problems[0].endswith("reported in: nowhere (want only the sidebar line)")


def test_grade_other_toasts_do_not_count():
    # A failure of another file, or another file's download, is not this report.
    capture = Capture(
        toasts=["Download of other.txt failed: EIO", "Downloaded other.txt"],
        summary="1 transfer done",
        reveal="Open in File Manager",
    )
    assert summary_problems(capture, FILE_NAME, "linux") == []


def test_grade_reveal_wording_follows_the_platform():
    assert expected_reveal_label("darwin") == "Reveal in Finder"
    assert expected_reveal_label("win32") == "Show in File Explorer"
    assert expected_reveal_label("linux") == "Open in File Manager"
    capture = Capture(summary="1 transfer done", reveal="Reveal in Finder")
    assert summary_problems(capture, FILE_NAME, "win32") == [
        "the reveal action reads 'Reveal in Finder', not 'Show in File Explorer'"
    ]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunTransferSummary(
    ProductRunUi,
    SshPhaseUi,
    FilesUi,
    SftpUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "Transfer summary"
    request_timeout = 90.0

    def _toast_titles(self) -> list[str]:
        if not self.driver.exists(TOAST_REGION):
            return []
        items: list[dict[str, Any]] = self.driver.measure_element(TOAST_REGION, "text")["items"]
        return [i["text"] for i in items if i.get("visible", True) and i.get("text")]

    def _text(self, testid: str) -> Optional[str]:
        return self.driver.get_text(testid) if self.driver.exists(testid) else None

    def _open_browser(self) -> Path:
        native = self.need_native()
        root = (native.session_home or Path(native.target.state_dir)) / "pr-transfer-summary"
        root.mkdir(parents=True, exist_ok=True)
        (root / FILE_NAME).write_text(FILE_TEXT, encoding="utf-8")
        name = unique_name("pr-transfer")
        self.switch_to_connections_sidebar()
        self.create_ssh_connection(
            name, host=SSH_HOST, port=native.target.port, username=native.target.username,
            auth_method="key", key_path=str(native.client_key), connect=True,
        )
        self.accept_all_hostkeys(timeout=15.0)
        tab = self.tab_id_of(name)
        self.wait_connected(tab)
        # Into the scratch folder before the browser opens: never list the real home.
        self.run_command(f"cd '{root}'")
        self.echo_round_trip(tab, "PR_TRANSFER_CD_OK")
        self.connect_sftp_browser()
        self.wait_for_path_contains("pr-transfer-summary")
        self.wait_for_file_row(FILE_NAME, refresh_every=0)
        return root

    def test_10_one_report_with_reveal(self):
        with self.step(
            "transfers.summary.one-place",
            "A finished download is reported once, by the file sidebar's line, which "
            "offers the file-manager action (#5834)",
            expect="#5834: the Files sidebar's '1 transfer done' line with "
            f"'{expected_reveal_label()}' beside it; no 'Downloaded …' toast and no "
            "'finished' count in the status bar",
        ):
            self._open_browser()
            target = self.recorder.run_dir / "transfer-summary" / FILE_NAME
            target.parent.mkdir(parents=True, exist_ok=True)
            self.open_file_menu(FILE_NAME)
            self.driver.stub_native_dialog("save", target)
            self.driver.click(CTX_DOWNLOAD)
            self.wait(
                lambda: target.is_file() and target.read_text(encoding="utf-8") == FILE_TEXT,
                what="the downloaded file on disk",
            )

            capture = Capture()
            end = time.monotonic() + SAMPLE_SECONDS
            while time.monotonic() < end:
                for title in self._toast_titles():
                    if title not in capture.toasts:
                        capture.toasts.append(title)
                time.sleep(SAMPLE_EVERY)
            # The all-done Transfers panel collapses on its own (#5625); the
            # steady state is graded once it has.
            self.wait(lambda: not self.driver.exists(PANEL), what="the Transfers panel to collapse")
            capture.summary = self._text(SUMMARY)
            capture.indicator = self._text(INDICATOR)
            capture.reveal = self._text(REVEAL)
            self.evidence(
                f"toasts {capture.toasts}; sidebar {capture.summary!r}; status bar "
                f"{capture.indicator!r}; reveal {capture.reveal!r}"
            )
            self.shot(label="after-download")
            problems = summary_problems(capture, FILE_NAME)
            assert not problems, "; ".join(problems)
        self.close_all_tabs()
