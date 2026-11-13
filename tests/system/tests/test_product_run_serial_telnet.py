"""Product run, phase: serial and telnet (#5536).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Every check is a recorded step with a window capture and an
``expect`` line for the UI review.

**Serial, unattended:** a ``socat`` pseudo-terminal pair at a fixed port path in
the run dir, with a small device on the far end that echoes, answers ``ID?``
and ``AT``, and can talk first (:mod:`termihub_harness.product_run.serial_device`).
"Unplug" kills the pair under the app, "replug" brings it back at the same path,
which grades the serial auto-reconnect without hardware.

**Serial, physical:** the adapter named in ``product-run.local.json``
(``serial.device``, optional ``baud``). The run connects to it, then asks the
operator on the progress page to unplug and replug it (the only human steps).
No input, or an unattended run, makes these *not tested* with the reason.

**Telnet:** the run's own unprivileged telnet server on loopback
(:mod:`termihub_harness.product_run.telnet_server`): option negotiation (NAWS,
terminal type), a manual login, auto-login, and a server-side drop with the
disconnect overlay and Reconnect.
"""

from __future__ import annotations

import sys
import time

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    ConnectionsUi,
    PasswordPromptUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.serial_device import (
    DEVICE_ID,
    SerialUnavailable,
    VirtualSerialDevice,
)
from termihub_harness.product_run.ssh_steps import SESSION_LIFECYCLE_REGION
from termihub_harness.product_run.telnet_server import (
    BANNER,
    OPT_NAWS,
    OPT_TTYPE,
    PROMPT,
    TelnetServer,
    TelnetUnavailable,
)

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="pseudo-terminals are POSIX-only"),
]

TELNET_USER = "product-run"
#: A test constant for the run's own server, not a real secret.
TELNET_PASSWORD = "pr-telnet-pw"
OVERLAY = "terminal-disconnect-overlay"
RECONNECT_BTN = "terminal-disconnect-reconnect-btn"
#: The serial reconnect loop backs off; allow a few rounds.
RECONNECT_TIMEOUT = 120.0


class _PhaseBase(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, PasswordPromptUi, SystemTest
):
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    @pytest.fixture(autouse=True)
    def _keep_config(self, request):
        type(self).pytest_config = request.config
        yield

    def status(self, tab_id: str):
        sessions = self.projection_region_cache(SESSION_LIFECYCLE_REGION).get("sessions")
        life = sessions.get(tab_id) if isinstance(sessions, dict) else None
        return life.get("status") if isinstance(life, dict) else None

    def tab_of(self, name: str) -> str:
        return self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")["id"]

    def wait_status(self, tab_id: str, want, *, timeout: float = 60.0) -> str:
        """Wait until the tab's status satisfies ``want`` (a predicate); return it."""
        seen: list[str] = []

        def check():
            s = self.status(tab_id)
            if s and (not seen or seen[-1] != s):
                seen.append(s)
            return s if want(s) else None

        try:
            return self.wait(check, timeout=timeout, interval=0.5, what=f"tab {tab_id} status")
        finally:
            self.evidence(f"statuses seen: {' -> '.join(seen) or '(none)'}")

    def tail(self, tab_id: str, lines: int = 4) -> str:
        text = self.driver.read_terminal(tab_id).strip().splitlines()
        return " | ".join(ln.rstrip() for ln in text[-lines:])

    def open_serial(self, name: str, port: str, baud: str) -> str:
        self.switch_to_connections_sidebar()
        self.open_serial_editor()
        self.driver.type("connection-editor-name-input", name)
        self.driver.type("field-port", port)
        self.driver.select("field-baudRate", baud)
        self._click_editor_save(True)
        return self.tab_of(name)


class TestProductRunSerial(_PhaseBase):
    phase = "Serial"
    device: VirtualSerialDevice | None = None
    tabs: dict[str, str] = {}

    def test_00_virtual_connect(self):
        name = unique_name("pr-serial-virtual")
        with self.step(
            "serial.virtual.connect",
            "A serial connection at 9600 baud opens the virtual port and shows what the device says",
            expect="a serial tab showing the device's 'PR-DEVICE READY' line",
        ):
            try:
                device = VirtualSerialDevice(self.recorder.run_dir / "serial").start()
            except SerialUnavailable as exc:
                pytest.skip(str(exc))
            type(self).device = device
            self.pytest_config.add_cleanup(device.stop)
            self.evidence(f"virtual port {self.device.app_port}")
            tab = self.open_serial(name, self.device.app_port, "9600")
            self.tabs["virtual"] = tab
            self.wait_status(tab, lambda s: s == "connected")
            time.sleep(0.5)
            self.device.say("PR-DEVICE READY")
            self.wait_for_output("PR-DEVICE READY", tab_id=tab, timeout=15.0)
            config = (self.require_connection(name).get("config") or {}).get("config") or {}
            self.evidence(f"saved config: port={config.get('port')} baud={config.get('baudRate')}")
            assert str(config.get("baudRate")) == "9600", config
            # The status bar names the port and line settings (#5628, R-143).
            chip = self.driver.get_text("status-bar-serial") if self.driver.exists("status-bar-serial") else ""
            self.evidence(f"serial chip: {chip!r}")
            assert "9600" in chip and "8N1" in chip, f"no port/baud chip: {chip!r}"
        with self.step(
            "serial.virtual.io",
            "Typed text goes over the port; the device's answer comes back",
            expect=f"the serial tab with 'ID?' echoed by the device and its answer {DEVICE_ID!r}",
        ):
            self.require("serial.virtual.connect")
            tab = self.tabs["virtual"]
            self.driver.terminal_input("ID?\r", tab_id=tab)
            self.wait_for_output(DEVICE_ID, tab_id=tab, timeout=15.0)
            self.evidence(f"device received lines: {self.device.lines}")
            self.evidence(f"terminal: {self.tail(tab)}")
            assert "ID?" in self.device.lines, "the device never received the line"

    def test_10_virtual_unplug_replug(self):
        with self.step(
            "serial.virtual.unplug",
            "Unplugging the device takes the tab out of 'connected'",
            expect="the serial tab after the port vanished: a disconnected or reconnecting state",
        ):
            self.require("serial.virtual.io")
            tab = self.tabs["virtual"]
            self.device.unplug()
            got = self.wait_status(tab, lambda s: s not in (None, "connected"), timeout=30.0)
            self.evidence(f"after unplug: {got}; overlay shown: {self.driver.exists(OVERLAY)}")
            # #5619: a serial notice speaks of the device, never a shell or agent,
            # and the scrollback says the device went away, not "[Process exited]".
            self.assert_reconnect_wording(serial=True)
            self.assert_drop_marked(tab, "serial", reconnected=False)
        with self.step(
            "serial.virtual.replug",
            "Plugging it back in at the same path reconnects the tab by itself",
            expect="the serial tab connected again, with the device's answer after the replug",
        ):
            self.require("serial.virtual.unplug")
            tab = self.tabs["virtual"]
            self.device.replug()
            self.wait_status(tab, lambda s: s == "connected", timeout=RECONNECT_TIMEOUT)
            before = self.driver.read_terminal(tab).count(DEVICE_ID)
            self.wait(
                lambda: (self.driver.terminal_input("ID?\r", tab_id=tab) or True)
                and self.driver.read_terminal(tab).count(DEVICE_ID) > before,
                timeout=30.0, interval=3.0, what="the device's answer after the replug",
            )
            self.evidence(f"terminal: {self.tail(tab)}")
            # #5620: the buffer held these lines while the pane painted blank —
            # grade what is rendered: the pre-unplug line and the device's answer.
            self.assert_terminal_painted(tab, "PR-DEVICE READY", DEVICE_ID)
            self.assert_drop_marked(tab, "serial")
        self.close_all_tabs()

    def test_20_physical_adapter(self):
        reason = self.inputs.missing("serial")
        if reason:
            for sid, title in (
                ("serial.physical.connect", "Physical adapter: connect"),
                ("serial.physical.unplug", "Physical adapter: unplug is noticed"),
                ("serial.physical.replug", "Physical adapter: replug auto-reconnects"),
            ):
                self.not_tested(sid, title, reason)
            return
        cfg = self.inputs.get("serial")
        device, baud = str(cfg["device"]), str(cfg.get("baud") or 115200)
        name = unique_name("pr-serial-physical")
        with self.step(
            "serial.physical.connect",
            f"The physical adapter {device} connects at {baud} baud",
            expect="a serial tab for the physical adapter, connected",
        ):
            tab = self.open_serial(name, device, baud)
            self.tabs["physical"] = tab
            self.wait_status(tab, lambda s: s == "connected", timeout=30.0)
        with self.step(
            "serial.physical.unplug",
            "Unplugging the adapter is noticed",
            expect="the serial tab disconnected or reconnecting after the adapter was pulled",
        ):
            self.require("serial.physical.connect")
            tab = self.tabs["physical"]
            self.human_step(
                f"Unplug the serial adapter {device} now, then click Done.",
                "the serial tab leaves the connected state",
            )
            self.wait_status(tab, lambda s: s not in (None, "connected"), timeout=30.0)
        with self.step(
            "serial.physical.replug",
            "Plugging the adapter back in reconnects the tab by itself",
            expect="the serial tab connected again after the adapter was plugged back in",
        ):
            self.require("serial.physical.unplug")
            tab = self.tabs["physical"]
            self.human_step(
                f"Plug the serial adapter {device} back in, then click Done.",
                "the serial tab reconnects without clicking anything in termiHub",
            )
            self.wait_status(tab, lambda s: s == "connected", timeout=RECONNECT_TIMEOUT)
        self.close_all_tabs()


class TestProductRunTelnet(_PhaseBase):
    phase = "Telnet"
    server: TelnetServer | None = None
    tabs: dict[str, str] = {}

    def _need_server(self) -> TelnetServer:
        if self.server is None:
            pytest.skip("the run's telnet server did not start")
        return self.server

    def test_00_server_and_manual_login(self):
        name = unique_name("pr-telnet")
        with self.step(
            "telnet.connect",
            "Connect shows the server's banner and login prompt; NAWS and terminal type are negotiated",
            expect="a telnet tab with the server banner and a 'login:' prompt",
        ):
            try:
                srv = TelnetServer(self.recorder.run_dir / "telnet-home", username=TELNET_USER,
                                   password=TELNET_PASSWORD)
                srv.start()
            except TelnetUnavailable as exc:
                pytest.skip(str(exc))
            type(self).server = srv
            self.pytest_config.add_cleanup(srv.stop)
            self.evidence(f"run's telnet server on 127.0.0.1:{srv.port}")
            self.switch_to_connections_sidebar()
            self.create_telnet_connection(name, host="127.0.0.1", port=srv.port, connect=True)
            tab = self.tabs["manual"] = self.tab_of(name)
            self.wait_for_output("login:", tab_id=tab, timeout=30.0)
            assert BANNER in self.driver.read_terminal(tab), "no server banner"
            session = self.wait(lambda: srv.latest() if srv.latest() and srv.latest().naws else None,
                                timeout=10.0, what="a NAWS report")
            self.wait(lambda: session.ttype, timeout=10.0, what="the terminal type")
            self.evidence(f"client WILL NAWS={session.client_will(OPT_NAWS)} "
                          f"WILL TTYPE={session.client_will(OPT_TTYPE)}; NAWS {session.naws}; "
                          f"TTYPE {session.ttype!r}")
            cols, rows = session.naws[-1]
            assert cols >= 40 and rows >= 10, f"implausible window size {cols}x{rows}"
        with self.step(
            "telnet.login",
            "Typing the username and password logs in; the password is never shown",
            expect="the telnet tab at the server's shell prompt after login",
        ):
            self.require("telnet.connect")
            tab = self.tabs["manual"]
            self.driver.terminal_input(f"{TELNET_USER}\r", tab_id=tab)
            self.wait_for_output("Password:", tab_id=tab, timeout=15.0)
            self.driver.terminal_input(f"{TELNET_PASSWORD}\r", tab_id=tab)
            self.wait_for_output(PROMPT.strip(), tab_id=tab, timeout=15.0)
            text = self.driver.read_terminal(tab)
            self.evidence(f"terminal: {self.tail(tab)}")
            assert TELNET_PASSWORD not in text, "the password was echoed"
            assert self.server.latest().logged_in, "the server saw no successful login"
        with self.step(
            "telnet.shell",
            "The shell runs commands; its size and TERM are what termiHub negotiated",
            expect="the telnet tab showing 'stty size' and $TERM output",
        ):
            self.require("telnet.login")
            tab = self.tabs["manual"]
            self.driver.terminal_input(
                "echo PR_TEL''NET_$((6*7)); stty size; echo TERM=$TERM; echo PR_TEL''NET_END\r",
                tab_id=tab,
            )
            text = self.wait(
                lambda: (lambda t: t if "PR_TELNET_END" in t.splitlines() else None)(
                    "\n".join(ln.strip() for ln in self.driver.read_terminal(tab).splitlines())
                ),
                timeout=15.0, what="the commands' output",
            )
            lines = text.splitlines()
            session = self.server.latest()
            cols, rows = session.naws[-1]
            self.evidence(f"terminal: {self.tail(tab, 5)}; last NAWS {cols}x{rows}")
            assert "PR_TELNET_42" in lines, "the command did not run"
            assert f"{rows} {cols}" in lines, f"stty size is not the negotiated {rows} {cols}"
            assert f"TERM={session.ttype}" in lines, "TERM is not the negotiated type"

    def test_10_auto_login(self):
        name = unique_name("pr-telnet-auto")
        with self.step(
            "telnet.auto-login",
            "Auto-login answers the login and password prompts by itself",
            expect="a second telnet tab at the shell prompt without anything typed",
        ):
            srv = self._need_server()
            self.switch_to_connections_sidebar()
            self.open_new_connection_editor()
            self.driver.type("connection-editor-name-input", name)
            self.select_connection_type("telnet")
            self.wait(lambda: self.driver.exists("field-host"), what="the telnet fields")
            self.driver.type("field-host", "127.0.0.1")
            self.driver.type("field-port", str(srv.port))
            self.driver.select("field-authMethod", "password")
            self.wait(lambda: self.driver.exists("field-username"), what="the login fields")
            self.driver.type("field-username", TELNET_USER)
            # With no credential store chosen yet the form has no Password field
            # (filterCredentialFields): termiHub asks for it at connect instead.
            if self.driver.exists("field-password"):
                self._type_form_password(TELNET_PASSWORD)
            else:
                self.evidence("no Password field (no credential store yet): asked at connect")
            self.shot(label="editor", expect="connection-editor-name-input")
            before = len(srv.sessions)
            self._click_editor_save(True)
            # The tab opens once the connect has its password: with no stored
            # one, termiHub asks first.
            asked = self.wait(
                lambda: "asked" if self.password_prompt_open()
                else ("tab" if self.find_tab(name) else None),
                timeout=30.0, what="the password prompt or the tab",
            )
            if asked == "asked":
                self.shot(label="password-prompt")
                self.evidence("termiHub asked for the password at connect")
                # Telnet sends the password in clear text: the prompt must
                # never present it as an SSH one (#5617).
                title = self.password_prompt_title()
                self.evidence(f"prompt title: {title!r}")
                assert title.startswith("Telnet password"), (
                    f"the telnet password prompt is titled {title!r}, not 'Telnet password'"
                )
                assert "SSH" not in title, f"the telnet password prompt says SSH: {title!r}"
                self.handle_password_prompt(TELNET_PASSWORD)
            tab = self.tab_of(name)
            session = self.wait(
                lambda: (lambda f: f[-1] if f and f[-1].logged_in else None)(srv.sessions[before:]),
                timeout=30.0, what="the auto-login",
            )
            self.wait_for_output(PROMPT.strip(), tab_id=tab, timeout=15.0)
            self.evidence(f"server logins: {session.logins}; terminal: {self.tail(tab)}")
            assert TELNET_PASSWORD not in self.driver.read_terminal(tab), "the password was shown"

    def test_20_server_drop(self):
        with self.step(
            "telnet.drop",
            "The server closing the connection shows the disconnect overlay with Reconnect",
            expect="the telnet tab with the disconnect overlay and a Reconnect button",
        ):
            self.require("telnet.login")
            tab = self.tabs["manual"]
            self.switch_to_tab(tab)
            dropped = self.server.drop_all()
            self.evidence(f"server closed {dropped} connection(s)")
            try:
                self.wait_status(tab, lambda s: s not in (None, "connected"), timeout=30.0)
            except AssertionError:
                raise AssertionError(
                    "the tab stayed 'connected' after the server closed it (bug #5569)"
                ) from None
            self.wait(lambda: self.driver.exists(OVERLAY), timeout=20.0, what="the overlay")
            assert self.driver.exists(RECONNECT_BTN), "no Reconnect button"
            self.assert_reconnect_wording()
        with self.step(
            "telnet.reconnect",
            "Reconnect opens a fresh session at the login prompt",
            expect="the telnet tab connected again, showing a new 'login:' prompt",
        ):
            self.require("telnet.drop")
            tab = self.tabs["manual"]
            before = len(self.server.sessions)
            self.driver.click(RECONNECT_BTN)
            self.wait(lambda: len(self.server.sessions) > before, timeout=30.0,
                      what="a new server session")
            self.wait_status(tab, lambda s: s == "connected", timeout=30.0)
            self.wait(lambda: self.driver.read_terminal(tab).count("login:") >= 2
                      or not self.driver.exists(OVERLAY), timeout=15.0, what="the new session")
            self.evidence(f"terminal: {self.tail(tab)}")
            # #5619/#5660: the server's close reads as a lost connection, then a reconnect.
            self.assert_drop_marked(tab, "network")
        self.close_all_tabs()
