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
auto-reconnect note, the clear overlay (no scrim, pointer events reach the
scrollback) and, after Reconnect, the marker.

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
    "Session disconnected The server closed the connection. Scrollback is kept. "
    "Auto-reconnect is off for this connection: telnet connections start with it off. "
    "Turn it on with “Auto-reconnect” in the connection's settings. Reconnect View scrollback"
)


# ── app-free grade tests ──────────────────────────────────────────────────
def _overlay(**overrides):
    args = {
        "variant": "disconnected",
        "text": TELNET_CLOSED,
        "cause": "server",
        "expected_cause": "server",
        "transport": "telnet",
        "auto_reconnect_off": True,
        "background": "rgba(0, 0, 0, 0)",
        "pointer_events": "none",
    }
    args.update(overrides)
    return notice_problems(**args)


def test_grade_a_telnet_server_close_with_its_cause_passes():
    assert _overlay() == []


def test_grade_the_old_telnet_overlay_fails():
    # The R-062 shape: "lost" for a server close, no word on auto-reconnect.
    old = (
        "Session disconnected The connection was lost. Your scrollback is kept — "
        "choose View scrollback to read it. Reconnect View scrollback"
    )
    problems = _overlay(text=old, cause=None)
    assert any("classifies the end as None" in p for p in problems)
    assert any("no cause line" in p for p in problems)
    assert any("connection was lost although" in p for p in problems)
    assert any("choose View scrollback" in p for p in problems)
    assert any("auto-reconnect is off" in p for p in problems)
    assert any("why telnet did not retry" in p for p in problems)


def test_grade_a_scrim_over_the_scrollback_fails():
    problems = _overlay(background="rgba(0, 0, 0, 0.55)", pointer_events="auto")
    assert any("has a scrim" in p for p in problems)
    assert any("blocks the scrollback" in p for p in problems)


def test_grade_an_auto_reconnect_note_on_a_retrying_connection_fails():
    problems = _overlay(auto_reconnect_off=False)
    assert problems == ["the overlay says auto-reconnect is off although it is on"]


def test_grade_a_process_exit_needs_its_code():
    text = "Session disconnected The process exited with code 3. Scrollback is kept."
    assert (
        notice_problems(
            variant="disconnected", text=text, cause="exited", expected_cause="exited"
        )
        == []
    )
    assert notice_problems(
        variant="disconnected",
        text="Session disconnected The connection was lost.",
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
    text = "Connection lost — reconnecting… After attempt 10, retrying stops and the tab offers Reconnect."
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

    def _grade_overlay(self, *, expected_cause: str, transport: str, off: bool) -> None:
        self.wait(lambda: self.driver.exists(OVERLAY), timeout=30.0, what="the disconnect notice")
        text = self.driver.get_text(OVERLAY)
        variant = self.driver.get_attribute(OVERLAY, "data-variant")
        cause = self.driver.get_attribute(OVERLAY, "data-cause")
        background = self.driver.get_computed_style("background-color", OVERLAY)
        pointer = self.driver.get_computed_style("pointer-events", OVERLAY)
        self.shot(label=expected_cause)
        self.evidence(
            f"notice {variant!r} cause {cause!r}: {text!r}; background {background!r}; "
            f"pointer-events {pointer!r}"
        )
        problems = notice_problems(
            variant=variant or "",
            text=text,
            cause=cause,
            expected_cause=expected_cause,
            transport=transport,
            auto_reconnect_off=off,
            background=background,
            pointer_events=pointer,
        )
        assert not problems, problems

    def test_10_telnet_server_close_states_the_cause(self):
        name = unique_name("pr-reconnect-telnet")
        with self.step(
            "reconnect-model.telnet-closed",
            "The telnet server closing the connection says so, says why telnet did not retry, "
            "and keeps the scrollback readable (#5831)",
            expect="the telnet tab's login prompt readable around a card at the top: 'Session "
            "disconnected — The server closed the connection.' and 'Auto-reconnect is off for "
            "this connection: telnet connections start with it off.' with Reconnect",
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
            self._grade_overlay(expected_cause="server", transport="telnet", off=True)
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
            "A shell that exits with a code says so, not that a connection was lost (#5831)",
            expect="a local tab with a card at the top: 'The process exited with code 3.'",
        ):
            self.switch_to_connections_sidebar()
            self.create_local_connection(name, connect=True)
            tab = self.wait(lambda: self.find_tab(name), what="the local tab")["id"]
            self.switch_to_tab(tab)
            self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
            self.run_command("exit 3")
            self.wait(lambda: self.terminal_session_exited(tab), what="the shell to exit")
            self._grade_overlay(expected_cause="exited", transport="other", off=False)
        self.close_all_tabs()
