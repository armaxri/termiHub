"""Product run, phase 3b: RDP / VNC, host monitoring, settings and themes (#5537).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Every check is a recorded step with a window capture and an
``expect`` line for the UI review
(:class:`~termihub_harness.product_run.ProductRunUi`).

* **RDP / VNC.** Unattended legs against servers the run starts itself on
  loopback: the scripted VNC server
  (:mod:`termihub_harness.product_run.vnc_server`; direct and through an SSH
  tunnel over the run's native sshd, i.e. port forwarding) and the RDP
  sidecar's scripted server (``rdp_test_server``, built next to the sidecar by
  ``build-system-test-app.sh``). Real hosts come from ``product-run.local.json``
  (``rdp`` / ``vnc``); without them those legs are *not tested*. Their passwords
  are typed by the operator (human step), never stored in the input file.
* **Monitoring.** An SSH tab on the run's native sshd (this machine: macOS host
  monitoring, #5471) shows stats that update; a second sshd whose exec sessions
  find no ``sh`` shows the "not supported on this host" state.
* **Settings and themes.** Every settings category opens without a JavaScript
  error; the numeric settings show the value in effect (#5554); every built-in
  theme is applied once, with captures of the main surfaces for the UI review
  and a text-contrast grade.
"""

from __future__ import annotations

import socket
import subprocess
import sys
import time
from typing import Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    RDP_HELPER_ENV,
    SETTINGS_REGION,
    SSH_HOST,
    ConnectionsUi,
    MonitoringUi,
    PasswordPromptUi,
    RdpTestServer,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    find_rdp_helper,
    unique_name,
)
from termihub_harness.colors import contrast
from termihub_harness.native_ssh import fixture_argv
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi
from termihub_harness.product_run.vnc_server import QUADRANTS, ScriptedVncServer
from termihub_harness.rdp_test_server import find_rdp_test_server
from termihub_harness.ui.theme import BUILTIN_THEMES, ThemeUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only"),
]

CONNECT_TIMEOUT = 60.0
RDP_USER = "product-run"
RDP_PASSWORD = "product-run-rdp-pw"
#: The settings categories (``settingsRegistry.ts`` CATEGORIES).
SETTINGS_CATEGORIES = (
    "general", "appearance", "accessibility", "keyboard", "updates", "terminal",
    "shell-integration", "sessions", "editor", "serial", "external-files", "security",
    "safety-prompts", "backup", "plugins", "import", "schedules", "portable", "x-server",
)
#: Numeric settings and where they live: (category, testid, key, label); ids from #5573.
NUMERIC_SETTINGS = (
    ("appearance", "settings-font-size", "fontSize", "Font size"),
    ("appearance", "settings-line-height", "lineHeight", "Line height"),
    ("terminal", "settings-scrollback-buffer", "scrollbackBuffer", "Scrollback buffer"),
)


def _free_port(start: int, span: int = 30) -> int:
    for port in range(start, start + span):
        with socket.socket() as sock:
            try:
                sock.bind((SSH_HOST, port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"no free port in {start}..{start + span}")


# ── RDP / VNC ────────────────────────────────────────────────────────────────
class TestProductRunRemoteDesktop(
    ProductRunUi,
    SshPhaseUi,
    RemoteDesktopUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "RDP / VNC"
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT
    vnc: Optional[ScriptedVncServer] = None
    rdp: Optional[RdpTestServer] = None
    rdp_reason: Optional[str] = None

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        env = super().extra_app_env(request)
        cls.vnc = ScriptedVncServer()
        request.addfinalizer(cls.vnc.close)
        helper, server = find_rdp_helper(), find_rdp_test_server()
        if helper is None or server is None:
            cls.rdp_reason = (
                "the RDP sidecar or its rdp_test_server example is not built "
                "(scripts/internal/build-system-test-app.sh without TERMIHUB_SKIP_RDP_HELPER)"
            )
            return env
        cls.rdp = RdpTestServer.for_binary(server)
        cls.rdp.start()
        request.addfinalizer(cls.rdp.stop)
        return {**env, RDP_HELPER_ENV: str(helper)}

    def _open(self) -> None:
        self.enable_experimental_features()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def _wait_active(self) -> None:
        if self._prompt_within(10.0):
            self.handle_password_prompt(RDP_PASSWORD)
        self.wait(
            lambda: self.remote_desktop_phase() == "active",
            timeout=CONNECT_TIMEOUT, what="the remote desktop session to become active",
        )

    def _prompt_within(self, seconds: float) -> bool:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.password_prompt_open():
                return True
            time.sleep(0.5)
        return False

    def _vnc_quadrants(self) -> None:
        self.wait_for_quadrants(
            QUADRANTS, (self.vnc.width, self.vnc.height), "fit", timeout=CONNECT_TIMEOUT
        )

    def test_01_vnc_local(self):
        with self.step(
            "vnc.local.connect",
            "VNC to the run's scripted server: the session goes active and paints the desktop",
            expect="a VNC tab with a red / green / blue / white four-quadrant desktop",
        ):
            self._open()
            before = self.vnc.connections()
            self.create_vnc_connection(
                unique_name("pr-vnc"), host=SSH_HOST, port=self.vnc.port, scale_mode="fit"
            )
            self._wait_active()
            self._vnc_quadrants()
            assert self.vnc.connections() > before, "the server saw no connection"
            self.evidence(f"server: {[e for e in self.vnc.events() if 'version' in e or 'pixel' in e][-2:]}")
        with self.step(
            "vnc.local.input",
            "A click and a key typed into the canvas reach the VNC server",
            expect="the VNC tab with the desktop, focused",
        ):
            self.require("vnc.local.connect")
            seen = len(self.vnc.events())

            def reached(prefix: str) -> bool:
                return any(e.startswith(prefix) for e in self.vnc.events()[seen:])

            self.wait(lambda: (self.driver.click(self.CANVAS), reached("pointer"))[1],
                      timeout=30.0, interval=1.0, what="a pointer event at the server")
            self.wait(lambda: (self.driver.press_key("a", self.CANVAS), reached("key"))[1],
                      timeout=30.0, interval=1.0, what="a key event at the server")
            keys = [e for e in self.vnc.events()[seen:] if e.startswith("key")]
            self.evidence(f"keys at the server: {keys[:4]}")
            assert any(" 0x61 down" in e for e in keys), f"no 'a' keysym down: {keys}"
        self.close_all_tabs()

    def test_02_vnc_tunnel(self):
        with self.step(
            "vnc.tunnel",
            "VNC through an SSH tunnel (port forwarding over the run's sshd) paints the desktop",
            expect="a VNC tab, tunnelled over SSH, with the four-quadrant desktop",
        ):
            native = self.need_native()
            self._open()
            before = self.vnc.connections()
            self.open_new_connection_editor()
            self.driver.type("connection-editor-name-input", unique_name("pr-vnc-tunnel"))
            self.select_connection_type("vnc")
            self.wait(lambda: self.driver.exists("field-host"), what="the VNC fields")
            self.driver.type("field-host", SSH_HOST)
            self.driver.type("field-port", str(self.vnc.port))
            self.driver.click("field-useSshTunnel")
            self.wait(lambda: self.driver.exists("field-sshHost"), what="the SSH tunnel fields")
            self.driver.type("field-sshHost", SSH_HOST)
            self.driver.type("field-sshPort", str(native.target.port))
            self.driver.type("field-sshUsername", native.target.username)
            self._select_when_available("field-sshAuthMethod", "key", what="key auth")
            self.wait(lambda: self.driver.exists("field-sshKeyPath"), what="the SSH key field")
            self.driver.type("field-sshKeyPath", str(native.client_key))
            self.shot(label="editor")
            self._click_editor_save(True)
            if self._prompt_within(10.0):
                self.handle_password_prompt(RDP_PASSWORD)
            self.evidence(f"host-key prompts accepted: {self.accept_all_hostkeys(timeout=15.0)}")
            self._wait_active()
            self._vnc_quadrants()
            assert self.vnc.connections() > before, "the tunnel reached no VNC server"
        self.close_all_tabs()

    def test_03_rdp_scripted(self):
        if self.rdp is None:
            self.not_tested("rdp.scripted", "RDP to the sidecar's scripted server", self.rdp_reason or "")
            return
        with self.step(
            "rdp.scripted",
            "RDP through the sidecar to the scripted server: active, painted, logon user seen",
            expect="an RDP tab showing the scripted server's solid-colour desktop",
        ):
            self._open()
            before = len(self.rdp.client_infos())
            self.create_rdp_connection(
                unique_name("pr-rdp"), host=SSH_HOST, port=self.rdp.port, username=RDP_USER
            )
            self._wait_active()
            size, color = self.rdp.desktop()
            self.evidence(f"scripted desktop {size} #{bytes(color).hex()}")
            self.wait_for_solid_desktop(color, "fit", fb_size=size, timeout=CONNECT_TIMEOUT)
            assert self.rdp.client_infos()[before:] == [RDP_USER], self.rdp.client_infos()
        with self.step(
            "rdp.scripted.input",
            "A click and a key typed into the RDP canvas reach the server",
            expect="the RDP tab with its desktop",
        ):
            self.require("rdp.scripted")
            seen = len(self.rdp.inputs())
            self.wait(lambda: (self.driver.click(self.CANVAS),
                               any("button left down" in e for e in self.rdp.inputs()[seen:]))[1],
                      timeout=30.0, interval=1.0, what="a click at the server")
            self.wait(lambda: (self.driver.press_key("a", self.CANVAS),
                               "key 0x1e down" in self.rdp.inputs()[seen:])[1],
                      timeout=30.0, interval=1.0, what="the 'a' key at the server")
            self.evidence(f"inputs: {self.rdp.inputs()[seen:][:4]}")
        self.close_all_tabs()

    def _real_host(self, kind: str) -> None:
        values = self.inputs.get(kind)
        if values is None:
            self.not_tested(f"{kind}.real", f"{kind.upper()} to a real host",
                            self.inputs.missing(kind) or "no input")
            return
        with self.step(
            f"{kind}.real",
            f"{kind.upper()} to the real host from product-run.local.json (operator types the password)",
            expect=f"a {kind.upper()} tab showing the real host's desktop",
        ):
            self._open()
            host, port = str(values["host"]), int(values.get("port") or (3389 if kind == "rdp" else 5900))
            name = unique_name(f"pr-{kind}-real")
            if kind == "rdp":
                self.create_rdp_connection(name, host=host, port=port,
                                           username=str(values.get("user") or ""))
            else:
                self.create_vnc_connection(name, host=host, port=port, scale_mode="fit")
            self.human_step(
                f"Type the {kind.upper()} password for {host} into the test window's prompt and "
                "accept its certificate if asked.",
                "the remote desktop shows in the tab",
            )
            self.wait(lambda: self.remote_desktop_phase() == "active", timeout=120.0,
                      what="the real session to become active")
        self.close_all_tabs()

    def test_04_real_hosts(self):
        self._real_host("vnc")
        self._real_host("rdp")


# ── Monitoring ───────────────────────────────────────────────────────────────
class TestProductRunMonitoring(
    ProductRunUi,
    SshPhaseUi,
    MonitoringUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SettingsUi,
    SystemTest,
):
    phase = "Monitoring"
    request_timeout = 90.0

    def _ssh_tab(self, label: str, port: int) -> str:
        native = self.need_native()
        name = unique_name(label)
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.create_ssh_connection(
            name, host=SSH_HOST, port=port, username=native.target.username,
            auth_method="key", key_path=str(native.client_key), connect=True,
        )
        self.accept_all_hostkeys(timeout=10.0)
        tab_id = self.tab_id_of(name)
        self.wait_connected(tab_id)
        return tab_id

    def _numbers(self) -> dict[str, Optional[str]]:
        return {k: self.driver.get_attribute(f"monitoring-{k}", "title") for k in ("cpu", "mem", "disk")}

    def test_01_stats(self):
        with self.step(
            "monitoring.stats",
            "An SSH tab on this Mac's sshd shows CPU, memory and disk in the status bar",
            expect="the SSH tab with CPU / memory / disk chips in the status bar",
        ):
            tab_id = self._ssh_tab("pr-mon", self.need_native().target.port)
            self.evidence(self.echo_round_trip(tab_id, "PR_MON_OK"))
            stats = self.wait_for_monitoring_stats(timeout=60.0)
            self.wait(lambda: "—" not in self.driver.get_text("monitoring-cpu"),
                      timeout=30.0, what="CPU past priming")
            self.evidence(f"stats: {self.monitoring_stats()}; host chip {self.driver.get_text('monitoring-host')!r}")
            assert stats["mem"] and stats["disk"], stats
        with self.step(
            "monitoring.updates",
            "The numbers update while the tab stays open",
            expect="the status bar with refreshed monitoring numbers",
        ):
            self.require("monitoring.stats")
            first = self._numbers()
            changed = self.wait(lambda: (lambda now: now if now != first else None)(self._numbers()),
                                timeout=60.0, interval=2.0, what="a monitoring sample to change")
            self.evidence(f"before {first}; after {changed}")
        with self.step(
            "monitoring.dropdown",
            "The host chip opens Refresh / Disconnect; Disconnect stops monitoring",
            expect="the status bar after Disconnect, with no monitoring numbers",
        ):
            self.require("monitoring.stats")
            self.open_monitoring_dropdown()
            self.shot(label="dropdown")
            self.driver.click("monitoring-disconnect")
            self.wait(lambda: not self.driver.exists("monitoring-cpu"), what="the stats to go")
            self.evidence(f"monitoring visible after Disconnect: {self.monitoring_visible()}")
        self.close_all_tabs()

    def test_02_unsupported_host(self):
        with self.step(
            "monitoring.unsupported",
            "A host whose exec sessions cannot run sh shows 'Monitoring not supported on this host'",
            expect="the SSH tab with 'Monitoring not supported on this host · Retry' in the status bar",
        ):
            native = self.need_native()
            port = _free_port(native.target.port + 20)
            out = subprocess.run(
                fixture_argv("variant-up", native.target.state_dir, "--variant", "pr-nosh",
                             "--port", str(port), "--setenv", "PATH=/nonexistent"),
                capture_output=True, text=True, timeout=120,
            )
            assert out.returncode == 0, out.stderr[-400:]
            self.evidence(f"variant sshd :{port}, exec PATH=/nonexistent (login shells reset PATH)")
            tab_id = self._ssh_tab("pr-mon-nosh", port)
            self.evidence(self.echo_round_trip(tab_id, "PR_MON_NOSH_SHELL"))
            self.wait(
                lambda: self.driver.exists("monitoring-retry-btn")
                and self.driver.get_attribute("monitoring-retry-btn", "data-reason") == "unsupported",
                timeout=90.0, what="the unsupported-host state",
            )
            label = self.driver.get_text("monitoring-retry-btn")
            self.evidence(f"status bar: {label!r}")
            assert "not supported on this host" in label, label
            assert not self.driver.exists("monitoring-cpu"), "stats on an unsupported host"
        self.close_all_tabs()


# ── Settings + themes ────────────────────────────────────────────────────────
class TestProductRunSettingsThemes(
    ProductRunUi, ThemeUi, SettingsUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Settings & themes"

    def _js_errors(self, since: Optional[int]) -> tuple[int, list[dict]]:
        doc = self.driver.get_js_errors(since)
        return int(doc.get("cursor") or 0), list(doc.get("errors") or [])

    def test_01_categories(self):
        with self.step(
            "settings.categories",
            "Every settings category opens and renders without a JavaScript error",
            expect="Settings on its last category (X server, under Advanced)",
            screenshot=False,
        ):
            cursor, _ = self._js_errors(None)
            self.open_settings_tab()
            missing, empty, errors, false_claims = [], [], [], []
            for category in SETTINGS_CATEGORIES:
                nav = f"settings-nav-{category}"
                if not self.driver.exists(nav):
                    missing.append(category)
                    continue
                self.reveal_settings_nav(category)
                self.driver.click(nav)
                time.sleep(0.4)
                text = self.driver.get_text("settings-panel-content").strip()
                if not text:
                    empty.append(category)
                cursor, new = self._js_errors(cursor)
                errors += [f"{category}: {e.get('message', '')[:160]}" for e in new]
                if category == "updates":
                    false_claims += self._update_currency_claims()
                self.shot(label=category)
            self.evidence(f"opened {len(SETTINGS_CATEGORIES) - len(missing)} categories")
            if missing:
                self.evidence(f"not in the nav (hidden here): {missing}")
            assert not empty, f"categories with an empty panel: {empty}"
            assert not errors, f"JavaScript errors: {errors}"
            assert not false_claims, f"Updates page claims currency without a check: {false_claims}"

    def _update_currency_claims(self) -> list[str]:
        """Settings ▸ Updates must not say "Up to date" before any check (#5615)."""
        if not (self.driver.exists("update-latest-version")
                and self.driver.exists("update-last-checked")):
            return []
        latest = self.driver.get_text("update-latest-version").strip()
        last_checked = self.driver.get_text("update-last-checked").strip()
        self.evidence(f"updates: latest {latest!r}, last checked {last_checked!r}")
        if last_checked == "Never" and latest == "Up to date":
            return [f"latest {latest!r} while last checked {last_checked!r}"]
        return []

    def test_02_numeric_values(self):
        for category, testid, key, label in NUMERIC_SETTINGS:
            with self.step(
                f"settings.numeric.{key}",
                f"{label} shows the value in effect (#5554)",
                expect=f"Settings ▸ {category} with {label} showing a number or its default",
            ):
                self.open_settings_category(category)
                time.sleep(0.5)
                stored = self.projection_region_cache(SETTINGS_REGION).get(key)
                self.evidence(f"settings.{key} = {stored!r}")
                self.wait(lambda: self.driver.exists(f"{testid}-input"), what=f"the {label} input")
                value = str(self.driver.get_value(f"{testid}-input") or "").strip()
                default = (
                    self.driver.get_text(f"{testid}-default").strip()
                    if self.driver.exists(f"{testid}-default") else ""
                )
                self.evidence(f"input {value!r}, default marker {default!r}")
                assert value or default, f"{label} shows neither a value nor its default (#5554)"

    def _surfaces(self, theme: str) -> None:
        self.switch_to_connections_sidebar()
        if not self.has_terminal():
            self.ensure_terminal()
        self.switch_to_terminal_tab()
        self.driver.terminal_input(f"echo product-run theme {theme}")
        time.sleep(0.8)
        self.shot(label="terminal")
        self.open_new_connection_editor()
        self.shot(label="editor")
        self.open_settings_category("appearance")
        self.shot(label="settings")

    def test_03_themes(self):
        for theme in BUILTIN_THEMES:
            with self.step(
                f"themes.{theme}",
                f"Theme {theme}: applied; main surfaces captured; body text contrast ≥ 4.5:1",
                expect=f"the {theme} theme on the sidebar, a terminal, the connection editor and Settings",
                screenshot=False,
            ):
                self.set_theme(theme)
                primary = contrast(self.root_color("--text-primary"), self.root_color("--bg-primary"))
                secondary = contrast(self.root_color("--text-secondary"), self.root_color("--bg-primary"))
                self.evidence(f"--text-primary on --bg-primary {primary:.2f}:1; secondary {secondary:.2f}:1")
                self._surfaces(theme)
                assert primary >= 4.5, f"primary text contrast {primary:.2f}:1"
                assert secondary >= 3.0, f"secondary text contrast {secondary:.2f}:1"
            self.close_all_tabs()
