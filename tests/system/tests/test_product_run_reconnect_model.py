"""Product run: one disconnect / reconnect model that states the cause (#5831).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw the disconnect overlay hide the scrollback behind a
dark scrim without saying why the session dropped (R-028), telnet say "The
connection was lost" when the server had closed it, with no word on why it did
not retry (R-062), and a reconnect marker that did not say running programs
were lost (R-101).

The live grade uses no containers: the run's own telnet server closes the
connection from the server side (telnet starts with auto-reconnect off), and a
local shell exits with code 3. Each notice is graded for its cause line, the
auto-reconnect note, the strip that pushes the terminal below it instead of
covering it (#5908), and, after Reconnect, the marker. A process exit reads
"Process exited (code N)", never "Session ended" (#5910).

The ``test_grade_*`` functions grade fixed notices without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import (
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.reconnect_model import (
    notice_problems,
    reconnected_marker_problems,
)
from termihub_harness.product_run.telnet_server import TelnetServer, TelnetUnavailable

OVERLAY = "terminal-disconnect-overlay"
RECONNECT_BTN = "terminal-disconnect-reconnect-btn"
TELNET_USER = "product-run"
#: A test constant for the run's own server, not a real secret.
TELNET_PASSWORD = "pr-telnet-pw"

TELNET_CLOSED = (
    "Session ended The server closed the connection. Scrollback is kept. "
    "Auto-reconnect is off for this connection: telnet connections start with it off. "
    "Turn it on with “Auto-reconnect” in the connection's settings. "
    "Press Enter to reconnect. Reconnect"
)


# ── app-free grade tests ──────────────────────────────────────────────────
PANE_BOX = {"x": 490, "y": 160, "width": 1500, "height": 1040}
STRIP_BOX = {"x": 490, "y": 160, "width": 1500, "height": 70}
PUSHED_TERMINAL = {"x": 490, "y": 230, "width": 1500, "height": 970}


def _overlay(**overrides):
    args = {
        "variant": "disconnected",
        "text": TELNET_CLOSED,
        "cause": "server",
        "expected_cause": "server",
        "transport": "telnet",
        "auto_reconnect_off": True,
        "layout": {"strip": STRIP_BOX, "pane": PANE_BOX, "terminal": PUSHED_TERMINAL},
    }
    args.update(overrides)
    return notice_problems(**args)


def test_grade_a_telnet_server_close_with_its_cause_passes():
    assert _overlay() == []


def test_grade_the_old_telnet_overlay_fails():
    # The R-062 shape: "lost" for a server close, no word on auto-reconnect.
    old = (
        "Session ended The connection was lost. Your scrollback is kept — "
        "choose View scrollback to read it. Reconnect View scrollback"
    )
    problems = _overlay(text=old, cause=None)
    assert any("classifies the end as None" in p for p in problems)
    assert any("no cause line" in p for p in problems)
    assert any("connection was lost although" in p for p in problems)
    assert any("choose View scrollback" in p for p in problems)
    assert any("auto-reconnect is off" in p for p in problems)
    assert any("why telnet did not retry" in p for p in problems)


def test_grade_a_card_over_the_output_fails():
    # The #5908 shape (R-005): a card near the pane top, the terminal under it.
    card = {"x": 995, "y": 172, "width": 500, "height": 290}
    problems = _overlay(layout={"strip": card, "pane": PANE_BOX, "terminal": PANE_BOX})
    assert any("does not span the pane" in p for p in problems)
    assert any("output are covered" in p for p in problems)


def test_grade_an_auto_reconnect_note_on_a_retrying_connection_fails():
    problems = _overlay(auto_reconnect_off=False)
    assert problems == ["the overlay says auto-reconnect is off although it is on"]


def test_grade_a_process_exit_needs_its_code():
    text = "Process exited (code 3) Scrollback is kept. Press Enter to restart. Restart"
    assert (
        notice_problems(
            variant="disconnected", text=text, cause="exited", expected_cause="exited"
        )
        == []
    )
    # The #5910 shape (R-004): a process exit titled as a lost connection.
    old = "Session ended Process exited (code 3). Scrollback is kept."
    assert notice_problems(
        variant="disconnected", text=old, cause="exited", expected_cause="exited"
    ) == ["a process end says 'Session ended' (#5910)"]
    assert notice_problems(
        variant="disconnected",
        text="Session ended The connection was lost.",
        cause="lost",
        expected_cause="exited",
    )


def test_grade_the_strip_needs_retry_now_and_the_last_attempt():
    text = (
        "Device disconnected — reconnecting… Retrying in 4s · Attempt 1 of 10 Scrollback is "
        "kept. Waiting for ttyPR0 to come back. After attempt 10, retrying stops and the tab "
        "offers Reconnect."
    )
    good = {
        "variant": "strip",
        "text": text,
        "cause": "device",
        "expected_cause": "device",
        "transport": "serial",
        "buttons": ["Cancel", "Retry now"],
        "waiting": True,
        "device_path": "/dev/serial/by-id/usb-Prolific-ttyPR0",
    }
    assert notice_problems(**good) == []
    old = {**good, "buttons": ["Cancel"], "text": text.split(" After attempt")[0]}
    problems = notice_problems(**old)
    assert any("Retry now" in p for p in problems)
    assert any("after the last attempt" in p for p in problems)
    long_path = {**good, "text": text.replace("ttyPR0 to", f"{good['device_path']} to")}
    assert any("full device path" in p for p in notice_problems(**long_path))


def test_grade_the_strip_names_a_server_close():
    text = "Reconnecting… After attempt 10, retrying stops and the tab offers Reconnect."
    problems = notice_problems(
        variant="strip", text=text, cause="server", expected_cause="server", buttons=["Cancel"]
    )
    assert any("Server closed the connection — reconnecting…" in p for p in problems)


def test_grade_the_reconnected_marker_says_what_was_lost():
    ssh = "$ \r\n— connection lost 09:05:07 —\r\n— reconnected 09:05:12 — new remote shell; running programs were lost\r\n$ "
    assert reconnected_marker_problems(ssh, "ssh") == []
    plain = "— reconnected 09:05:12 —\r\n$ "
    assert reconnected_marker_problems(plain, "ssh") == [
        "the marker does not say 'new remote shell; running programs were lost' (it reads '')"
    ]
    assert reconnected_marker_problems(plain, "serial") == []
    assert reconnected_marker_problems("$ ", "telnet") == [
        "no '— reconnected hh:mm:ss —' marker after the reconnect"
    ]
    telnet = "— reconnected 10:00:00 — new telnet session; the remote state was not restored\r\n"
    assert reconnected_marker_problems(telnet, "telnet") == []


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="pseudo-terminals are POSIX-only")
class TestProductRunReconnectModel(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Reconnect model"
    request_timeout = 90.0

    @pytest.fixture(autouse=True)
    def _keep_config(self, request):
        type(self).pytest_config = request.config
        yield

    def _grade_overlay(
        self, tab: str, *, expected_cause: str, transport: str, off: bool
    ) -> None:
        self.wait(lambda: self.driver.exists(OVERLAY), timeout=30.0, what="the disconnect notice")
        text = self.driver.get_text(OVERLAY)
        variant = self.driver.get_attribute(OVERLAY, "data-variant")
        cause = self.driver.get_attribute(OVERLAY, "data-cause")
        layout = {
            "strip": self.driver.measure_element(OVERLAY)["rect"],
            "pane": self.driver.measure_element(f"terminal-context-trigger-{tab}")["rect"],
            "terminal": self.driver.measure_element(f"terminal-renderer-{tab}")["rect"],
        }
        self.shot(label=expected_cause)
        self.evidence(f"notice {variant!r} cause {cause!r}: {text!r}; layout {layout}")
        problems = notice_problems(
            variant=variant or "",
            text=text,
            cause=cause,
            expected_cause=expected_cause,
            transport=transport,
            auto_reconnect_off=off,
            layout=layout,
        )
        assert not problems, problems

    def test_10_telnet_server_close_states_the_cause(self):
        name = unique_name("pr-reconnect-telnet")
        with self.step(
            "reconnect-model.telnet-closed",
            "The telnet server closing the connection says so, says why telnet did not retry, "
            "and keeps the scrollback readable (#5831)",
            expect="a full-width strip at the top of the telnet tab with the login prompt fully "
            "readable below it: 'Session ended — The server closed the connection.' and "
            "'Auto-reconnect is off for this connection: telnet connections start with it off.' "
            "with Reconnect",
        ):
            try:
                srv = TelnetServer(
                    self.recorder.run_dir / "reconnect-telnet-home",
                    username=TELNET_USER,
                    password=TELNET_PASSWORD,
                )
                srv.start()
            except TelnetUnavailable as exc:
                pytest.skip(str(exc))
            self.pytest_config.add_cleanup(srv.stop)
            self.switch_to_connections_sidebar()
            self.create_telnet_connection(name, host="127.0.0.1", port=srv.port, connect=True)
            tab = self.wait(lambda: self.find_tab(name), what="the telnet tab")["id"]
            self.wait_for_output("login:", tab_id=tab, timeout=30.0)
            self.evidence(f"server closed {srv.drop_all()} connection(s)")
            self._grade_overlay(tab, expected_cause="server", transport="telnet", off=True)
        with self.step(
            "reconnect-model.telnet-marker",
            "After Reconnect the marker says the telnet session is new (#5831)",
            expect="the telnet tab connected again; the scrollback reads '— reconnected hh:mm:ss "
            "— new telnet session; the remote state was not restored'",
        ):
            self.require("reconnect-model.telnet-closed")
            self.driver.click(RECONNECT_BTN)
            self.wait(
                lambda: not self.driver.exists(OVERLAY)
                and not reconnected_marker_problems(self.driver.read_terminal(tab), "telnet"),
                timeout=30.0,
                what="the reconnect marker",
            )
            self.evidence("marker: new telnet session")
        self.close_all_tabs()

    def test_20_process_exit_states_its_code(self):
        name = unique_name("pr-reconnect-exit")
        with self.step(
            "reconnect-model.exit-code",
            "A shell that exits with a code says so, not that a connection was lost (#5831, "
            "#5910)",
            expect="a local tab with a full-width strip above the output: a process icon, "
            "'Process exited (code 3)' and Restart; no wifi icon, no 'Session ended'",
        ):
            self.switch_to_connections_sidebar()
            self.create_local_connection(name, connect=True)
            tab = self.wait(lambda: self.find_tab(name), what="the local tab")["id"]
            self.switch_to_tab(tab)
            self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
            self.run_command("exit 3")
            self.wait(lambda: self.terminal_session_exited(tab), what="the shell to exit")
            self._grade_overlay(tab, expected_cause="exited", transport="other", off=False)
        self.close_all_tabs()
