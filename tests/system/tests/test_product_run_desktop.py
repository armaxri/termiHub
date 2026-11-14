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
  error; the Updates build info shows the build date (#5652); the numeric
  settings show the value in effect (#5554) as full-contrast text (#5632); every built-in
  theme is applied once, with captures of the main surfaces for the UI review
  and a text-contrast grade.
"""

from __future__ import annotations

import re
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
from termihub_harness.product_run.editor_layout import measure_editor_layout
from termihub_harness.product_run.grades import editor_layout_problems
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
#: The status-bar host-stats chips (``monitoring-<name>``) that must all go on a stop (#5628).
_METRIC_CHIPS = ("cpu", "mem", "disk", "swap", "net")
RDP_USER = "product-run"
RDP_PASSWORD = "product-run-rdp-pw"
#: The settings categories (``settingsRegistry.ts`` CATEGORIES).
SETTINGS_CATEGORIES = (
    "general", "appearance", "accessibility", "keyboard", "updates", "terminal",
    "shell-integration", "sessions", "monitoring", "editor", "serial", "external-files",
    "security", "safety-prompts", "backup", "plugins", "import", "schedules", "portable",
    "x-server",
)
#: Numeric settings and where they live: (category, testid, key, label); ids from #5573.
NUMERIC_SETTINGS = (
    ("appearance", "settings-font-size", "fontSize", "Font size"),
    ("appearance", "settings-line-height", "lineHeight", "Line height"),
    ("terminal", "settings-scrollback-buffer", "scrollbackBuffer", "Scrollback buffer"),
)
#: The backup export dialog's password fields and their visible labels (#5613).
#: The master password shows only in master-password mode.
BACKUP_PASSWORD_LABELS = (
    ("backup-export-passphrase", "Backup passphrase"),
    ("backup-export-confirm", "Repeat backup passphrase"),
    ("backup-export-master-password", "Current master password"),
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
            # #5626: the SSH tunnel section sits right below Host / Port, above
            # the display options, so it is visible without scrolling.
            tunnel_y = self.driver.measure_element("field-useSshTunnel")["rect"]["y"]
            display_y = self.driver.measure_element("field-scaleMode")["rect"]["y"]
            self.evidence(f"tunnel toggle y={tunnel_y}, scale mode y={display_y}")
            assert tunnel_y < display_y, "the SSH tunnel section is below the display options"
            # #5641: the ${VAR} note is the section's description, not Host's
            # label; hints sit under their fields; the form width is capped.
            layout = editor_layout_problems(measure_editor_layout(self.driver))
            assert not layout, layout
            self.driver.click("field-useSshTunnel")
            self.wait(lambda: self.driver.exists("field-sshHost"), what="the SSH tunnel fields")
            self.driver.type("field-sshHost", SSH_HOST)
            self.driver.type("field-sshPort", str(native.target.port))
            self.driver.type("field-sshUsername", native.target.username)
            self._select_when_available("field-sshAuthMethod", "key", what="key auth")
            self.wait(lambda: self.driver.exists("field-sshKeyPath"), what="the SSH key field")
            self.driver.type("field-sshKeyPath", str(native.client_key))
            self.shot(label="editor", expect="connection-editor-name-input")
            self._click_editor_save(True)
            if self._prompt_within(10.0):
                self.handle_password_prompt(RDP_PASSWORD)
            self.evidence(f"host-key prompts accepted: {self.accept_all_hostkeys(timeout=15.0)}")
            self._wait_active()
            self._vnc_quadrants()
            assert self.vnc.connections() > before, "the tunnel reached no VNC server"
            # #5626: the status bar says the session goes through the SSH tunnel.
            status = self.driver.get_text(self.STATUS_SEGMENT)
            self.evidence(f"status bar: {status!r}")
            assert f"via SSH {native.target.username}@{SSH_HOST}" in status, status
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

    def test_05_vnc_first_frame_state(self):
        with self.step(
            "vnc.first-frame",
            "A VNC session that is up but has painted nothing shows its stage, not a blank pane, "
            "and the status bar claims no resolution until the first frame",
            expect="a VNC tab with the 'Connected, waiting for the first frame…' overlay, "
            "then the four-quadrant desktop",
        ):
            self._open()
            self.vnc.hold_frames()
            try:
                self.create_vnc_connection(
                    unique_name("pr-vnc-held"), host=SSH_HOST, port=self.vnc.port, scale_mode="fit"
                )
                self._wait_active()
                self.wait(lambda: self.driver.exists(self.OVERLAY_FIRST_FRAME),
                          what="the waiting-for-the-first-frame overlay")
                status = self.driver.get_text(self.STATUS_SEGMENT)
                self.evidence(f"status bar before the first frame: {status!r}")
                assert f"{SSH_HOST}:{self.vnc.port}" in status, status
                assert "×" not in status and "-bit" not in status, (
                    f"the status bar claims a live session before any frame: {status!r}"
                )
                self.shot(label="waiting")
            finally:
                self.vnc.release_frames()
            self._vnc_quadrants()
            self.wait(lambda: not self.driver.exists(self.OVERLAY_FIRST_FRAME),
                      what="the waiting overlay to go once the frame painted")
            status = self.driver.get_text(self.STATUS_SEGMENT)
            self.evidence(f"status bar after the first frame: {status!r}")
            assert f"{self.vnc.width}×{self.vnc.height}" in status, status
        self.close_all_tabs()


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
            "The host chip opens a compact menu that fits 800x600; Stop monitoring stops it",
            expect="the status bar after Stop monitoring: no metric chip, only 'Monitoring off · Start monitoring'",
        ):
            self.require("monitoring.stats")
            # The menu must fit the 800x600 minimum window (#5628, R-042).
            self.driver.resize_window(800, 600)
            try:
                self.open_monitoring_dropdown()
                self.shot(label="dropdown")
                menu = self.driver.measure_element("monitoring-menu")["rect"]
                bar = self.driver.measure_element("status-bar")["rect"]
                self.evidence(f"menu height {menu['height']:.0f}px, status bar {bar['height']:.0f}px")
                assert menu["height"] <= 600 - bar["height"], f"menu {menu} does not fit 800x600"
                assert menu["top"] >= 0, f"menu clipped at the top: {menu}"
                stop = self.driver.get_text("monitoring-stop").strip()
                self.evidence(f"menu item {stop!r}")
                assert stop == "Stop monitoring", stop
                self.driver.click("monitoring-stop")
            finally:
                self.driver.resize_window(1280, 800)
            self.wait(lambda: self.driver.exists("monitoring-stopped"), what="the stopped state")
            # Monitoring used to restart from the cached sample, leaving Mem / Disk /
            # Swap / Net behind (R-040). Hold a few samples to prove it stays off.
            time.sleep(6.0)
            left = [c for c in _METRIC_CHIPS if self.driver.exists(f"monitoring-{c}")]
            self.evidence(f"metric chips after Stop monitoring: {left}")
            assert not left, f"metric chips survived Stop monitoring: {left}"
        self.close_all_tabs()

    def test_02_unsupported_host(self):
        with self.step(
            "monitoring.unsupported",
            "A host whose exec sessions cannot run sh shows muted 'Monitoring unavailable'",
            expect="the SSH tab with muted 'Monitoring unavailable' (info icon, no Retry)",
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
                lambda: self.driver.exists("monitoring-unsupported"),
                timeout=90.0, what="the unsupported-host state",
            )
            label = self.driver.get_text("monitoring-unsupported")
            reason = self.driver.get_attribute("monitoring-unsupported", "title") or ""
            self.evidence(f"status bar: {label!r}; tooltip {reason!r}")
            assert "Monitoring unavailable" in label, label
            assert "sh" in reason, reason
            # A capability state, not an error (#5628, R-043): muted, no Retry.
            assert not self.driver.exists("monitoring-retry-btn"), "Retry on an unsupported host"
            color = self.driver.get_computed_style("color", "monitoring-unsupported")
            error = self.driver.get_computed_style("--color-error")
            self.evidence(f"text colour {color}; error token {error}")
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
                self.shot(label=category, expect="settings-panel-content")
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
        return self._update_failure_claims(latest, last_checked)

    def _update_failure_claims(self, latest: str, last_checked: str) -> list[str]:
        """A failed check states why and was recorded (#5651).

        The backend stamps the last check time even when the feed fetch fails and
        reports the reason, so "Check failed" never pairs with "Never" and always
        carries the reason as its tooltip.
        """
        if latest != "Check failed":
            return []
        reason = (self.driver.get_attribute("update-latest-version", "title") or "").strip()
        self.evidence(f"updates: check failed, reason {reason!r}")
        claims = []
        if last_checked == "Never":
            claims.append("a failed check left last checked at 'Never'")
        if not reason:
            claims.append("a failed check shows no reason")
        return claims

    def test_02_build_date(self):
        with self.step(
            "settings.build_date",
            "Settings ▸ Updates build info shows the build (commit) date (#5652)",
            expect="Settings ▸ Updates with a Build date row: date, time and time zone",
        ):
            self.open_settings_category("updates")
            self.wait(lambda: self.driver.exists("update-build-hash"), what="the build info")
            self.wait(lambda: self.driver.exists("update-build-date"), timeout=10.0,
                      what="the build date row (the product run builds from git)")
            text = self.driver.get_text("update-build-date").strip()
            self.evidence(f"build date {text!r}")
            assert "Invalid" not in text, f"build date renders an invalid date: {text!r}"
            assert re.search(r"\b20\d\d\b", text), f"build date has no year: {text!r}"
            assert re.search(r"\d{1,2}[:.]\d{2}", text), f"build date has no time: {text!r}"

    def test_03_numeric_values(self):
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
        # Both surfaces are lazy-loaded: wait for the rendered form, not the
        # Suspense spinner (#5643).
        self.open_new_connection_editor()
        self.shot(label="editor", expect="connection-editor-name-input")
        self.open_settings_category("appearance")
        self.shot(label="settings", expect="settings-panel-content", scope="settings-panel-content")

    def test_04_themes(self):
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

    def test_04_backup_labels(self):
        with self.step(
            "settings.backup.labels",
            "Back up everything: every password field has a visible label; Credentials is "
            "visible without scrolling (#5613)",
            expect="the Back up dialog with labelled passphrase fields and Credentials in view",
        ):
            self.open_settings_category("backup")
            self.wait(lambda: self.driver.exists("backup-export-btn"), what="the Back up button")
            self.driver.click("backup-export-btn")
            self.wait(
                lambda: self.driver.exists("backup-export-section-connections"),
                what="the backup sections to load",
            )
            problems = []
            for field, text in BACKUP_PASSWORD_LABELS:
                if not self.driver.exists(field):
                    if field == "backup-export-master-password":
                        continue
                    problems.append(f"{field}: missing")
                    continue
                label = f"{field}-label"
                if not self.driver.exists(label):
                    problems.append(f"{field}: no visible label")
                    continue
                shown = self.driver.get_text(label).strip()
                linked = self.driver.get_attribute(label, "for")
                field_id = self.driver.get_attribute(field, "id")
                box = self.driver.measure_element(label)["rect"]
                self.evidence(f"{field}: label {shown!r} for={linked!r} id={field_id!r}")
                if shown != text:
                    problems.append(f"{field}: label {shown!r}, expected {text!r}")
                if not field_id or linked != field_id:
                    problems.append(f"{field}: label not associated (for={linked!r})")
                if box["width"] <= 2 or box["height"] <= 2:
                    problems.append(f"{field}: label not visible")
            box = self.driver.measure_element("backup-export-sections")["rect"]
            row = self.driver.measure_element("backup-export-credentials")["rect"]
            self.evidence(f"sections box {box}; credentials checkbox {row}")
            if row["y"] < box["y"] or row["y"] + row["height"] > box["y"] + box["height"]:
                problems.append("the Credentials row is outside the visible list area")
            self.driver.click("modal-close")
            assert not problems, "; ".join(problems)

    def test_05_file_manager_integration_actions(self):
        """Settings ▸ File manager integration: the actions follow the state (#5616).

        Read-only: it never installs or removes the integration.
        """
        with self.step(
            "settings.file-manager-integration.actions",
            "File manager integration offers Install when not registered and Reinstall / "
            "update + Uninstall only when registered (#5616)",
            expect="Settings ▸ File manager integration with a status matching its buttons",
        ):
            self.open_settings_category("shell-integration")
            self.wait(
                lambda: self.driver.exists("shell-integration-reinstall"),
                what="the file manager integration actions",
            )
            time.sleep(0.5)  # let the registration status load
            title = self.driver.get_text("settings-nav-shell-integration").strip()
            state = self.driver.get_text("shell-integration-status-text").strip()
            primary = self.driver.get_text("shell-integration-reinstall").strip()
            has_uninstall = self.driver.exists("shell-integration-uninstall")
            self.evidence(
                f"nav {title!r}; status {state!r}; primary {primary!r}; uninstall shown "
                f"{has_uninstall}"
            )
            problems = []
            if title != "File manager integration":
                problems.append(f"category reads {title!r}, want 'File manager integration'")
            if state == "Not registered":
                if primary != "Install":
                    problems.append(f"not registered but the primary button reads {primary!r}")
                if has_uninstall:
                    problems.append("not registered but Uninstall is offered")
            elif state == "Registered":
                if primary != "Reinstall / update":
                    problems.append(f"registered but the primary button reads {primary!r}")
                if not has_uninstall:
                    problems.append("registered but Uninstall is missing")
            else:
                problems.append(f"unexpected status {state!r}")
            assert not problems, "; ".join(problems)

    def test_06_numeric_effective_value_contrast(self):
        """The numeric settings' value in effect reads as real text (#5632).

        The value is the input's own text at >= 4.5:1 against the field, never
        placeholder grey; "Default" is only a tag on the label row, and an
        overridden value offers a real "Reset to default" button instead.
        """
        for category, testid, key, label in NUMERIC_SETTINGS:
            with self.step(
                f"settings.numeric.{key}.contrast",
                f"{label}: the value in effect is full-contrast text; Default is a tag, "
                "Reset is a button (#5632)",
                expect=f"Settings ▸ {category} with {label} showing its value in normal text "
                "and a Default tag or a Reset to default button on the label row",
            ):
                self.open_settings_category(category)
                field = f"{testid}-input"
                self.wait(lambda: self.driver.exists(field), what=f"the {label} input")
                time.sleep(0.5)
                value = str(self.driver.get_value(field) or "").strip()
                placeholder = self.driver.get_attribute(field, "placeholder") or ""
                fg = self.style_color("color", field)
                bg = self.opaque_background(field, self.root_color("--bg-primary"))
                ratio = contrast(fg, bg)
                has_tag = self.driver.exists(f"{testid}-default")
                has_reset = self.driver.exists(f"{testid}-reset")
                reset_type = (
                    self.driver.get_attribute(f"{testid}-reset", "type") if has_reset else None
                )
                self.evidence(
                    f"value {value!r}, placeholder {placeholder!r}, text contrast {ratio:.2f}:1, "
                    f"Default tag {has_tag}, Reset button {has_reset} (type {reset_type!r})"
                )
                problems = []
                if not value:
                    problems.append("the field is empty — the value in effect is not its text")
                if placeholder:
                    problems.append(f"the field still carries a placeholder {placeholder!r}")
                if ratio < 4.5:
                    problems.append(f"value text contrast {ratio:.2f}:1 < 4.5:1")
                if has_tag == has_reset:
                    problems.append("want exactly one of the Default tag and the Reset button")
                if has_reset and reset_type != "button":
                    problems.append(f"the reset marker is not a button (type {reset_type!r})")
                assert not problems, "; ".join(problems)

    def _nav_item_in_view(self, category: str) -> list[str]:
        """Problems if ``settings-nav-<category>`` is outside the nav's visible box."""
        nav = self.driver.measure_element("settings-category-nav")["rect"]
        item = self.driver.measure_element(f"settings-nav-{category}")["rect"]
        selected = self.driver.get_attribute(f"settings-nav-{category}", "aria-selected")
        self.evidence(f"{category}: nav box {nav}; item {item}; aria-selected {selected!r}")
        problems = []
        if selected != "true":
            problems.append(f"{category} is not the selected nav item")
        if item["y"] < nav["y"] - 1 or item["y"] + item["height"] > nav["y"] + nav["height"] + 1:
            problems.append(f"the active {category} nav item is scrolled out of the nav")
        return problems

    def test_07_settings_nav_and_groups(self):
        """Advanced categories stay visible when active; command marks and Schedules (#5633)."""
        with self.step(
            "settings.nav.active-in-view",
            "Opening a category under Advanced keeps its highlighted nav item in view (#5633)",
            expect="Settings ▸ Schedules with Schedules highlighted and visible in the nav",
        ):
            problems = []
            for category in ("import", "schedules"):
                self.open_settings_category(category)
                time.sleep(0.4)
                problems += self._nav_item_in_view(category)
            assert not problems, "; ".join(problems)

        with self.step(
            "settings.schedules.empty-create",
            "Settings ▸ Schedules has no repeated SCHEDULES header and offers New schedule (#5633)",
            expect="Settings ▸ Schedules: one title, a Pause all switch, and a New schedule button",
        ):
            self.open_settings_category("schedules")
            self.wait(lambda: self.driver.exists("schedules-section"), what="the schedules list")
            empty = self.driver.exists("schedules-empty")
            create = "schedules-empty-new-btn" if empty else "schedules-new-btn"
            has_create = self.driver.exists(create)
            has_header = self.driver.exists("schedules-header")
            self.evidence(f"empty {empty}; {create} shown {has_create}; header shown {has_header}")
            problems = []
            if not has_create:
                problems.append(f"no New schedule button ({create})")
            elif self.driver.get_text(create).strip() != "New schedule":
                problems.append(f"{create} reads {self.driver.get_text(create).strip()!r}")
            if has_header:
                problems.append("the page repeats its title as a SCHEDULES section header")
            if not self.driver.exists("schedules-pause-toggle"):
                problems.append("the Pause all switch is missing")
            assert not problems, "; ".join(problems)

        with self.step(
            "settings.command-marks.grouped",
            "Both command-mark toggles live together under Terminal ▸ Command marks (#5633)",
            expect="Settings ▸ Terminal with a Command marks group: Show command marks and, "
            "nested under it, Add shell hook to new sessions automatically",
        ):
            self.open_settings_category("terminal")
            self.wait(lambda: self.driver.exists("settings-command-marks"),
                      what="the Command marks group")
            text = self.driver.get_text("settings-command-marks")
            self.evidence(f"group text {text[:200]!r}")
            problems = [
                f"missing {label!r}"
                for label in ("Show command marks", "Add shell hook to new sessions automatically")
                if label not in text
            ]
            self.open_settings_category("general")
            if self.driver.exists("settings-default-shell-integration"):
                problems.append("the shell-hook toggle still shows under General")
            assert not problems, "; ".join(problems)

    #: Computed properties every settings section heading shares (#5634).
    _HEADING_STYLE = (
        "font-size", "font-weight", "letter-spacing", "line-height", "font-style",
        "text-transform", "color", "margin-top", "padding-bottom",
        "border-bottom-width", "border-bottom-style",
    )

    def test_08_section_heading_style(self):
        """Every settings category's section headings share one style (#5634)."""
        with self.step(
            "settings.section-headings",
            "Every settings category uses the shared section heading: same size, weight, "
            "colour and divider spacing on every page (#5634)",
            expect="Settings ▸ X server with a sentence-case heading over a thin divider, "
            "styled like every other category's headings",
        ):
            styles: dict[str, tuple[str, ...]] = {}
            missing = []
            for category in SETTINGS_CATEGORIES:
                if not self.driver.exists(f"settings-nav-{category}"):
                    continue
                self.open_settings_category(category)
                time.sleep(0.4)  # let the previous category's headings unmount
                try:
                    self.wait(
                        lambda: self.driver.exists("settings-section-heading"),
                        timeout=5.0, what=f"a section heading under {category}",
                    )
                except AssertionError:
                    missing.append(category)
                    continue
                styles[category] = tuple(
                    self.driver.get_computed_style(prop, "settings-section-heading")
                    for prop in self._HEADING_STYLE
                )
            variants: dict[tuple[str, ...], list[str]] = {}
            for category, style in styles.items():
                variants.setdefault(style, []).append(category)
            for style, categories in variants.items():
                self.evidence(f"{dict(zip(self._HEADING_STYLE, style))}: {categories}")
            problems = []
            if missing:
                problems.append(f"no shared section heading in {missing}")
            if len(variants) > 1:
                problems.append(f"{len(variants)} different heading styles across categories")
            for style in variants:
                props = dict(zip(self._HEADING_STYLE, style))
                if props["text-transform"] not in ("none", ""):
                    problems.append(f"heading text-transform {props['text-transform']!r}")
                if props["font-style"] == "italic":
                    problems.append("italic heading")
                if props["border-bottom-style"] == "none":
                    problems.append("heading without a divider")
            assert not problems, "; ".join(problems)

    #: Built-in mappings the defaults-table grade samples (``languageMapping.ts``).
    _BUILTIN_SAMPLE = (".babelrc", ".bashrc", "Dockerfile", "Makefile")

    def test_09_editor_builtin_defaults_table(self):
        """Settings ▸ Editor shows the built-in defaults as a dense table (#5713).

        At the 800x600 minimum window: the defaults are a table whose pattern and
        language columns line up row to row, the content column does not scroll
        sideways, and the mapped language reads at >= 4.5:1.
        """
        with self.step(
            "settings.editor.builtin-defaults",
            "Settings ▸ Editor lists the built-in file type defaults as a compact, aligned "
            "pattern → language table that fits 800x600 without sideways scrolling (#5713)",
            expect="Settings ▸ Editor at 800x600 with a dense two-column Built-in defaults "
            "table and readable language names",
        ):
            self.driver.resize_window(800, 600)
            try:
                self.open_settings_category("editor")
                self.wait(lambda: self.driver.exists("file-type-builtin-table"),
                          what="the built-in defaults table")
                time.sleep(0.4)
                self.shot(label="builtin-defaults-800x600")
                problems = []
                content = self.driver.measure_element("settings-panel-content")
                table = self.driver.measure_element("file-type-builtin-table")
                self.evidence(
                    f"content scrollWidth {content['scrollWidth']} / clientWidth "
                    f"{content['clientWidth']}; table {table['rect']}"
                )
                if content["scrollWidth"] > content["clientWidth"] + 1:
                    problems.append("the settings content scrolls horizontally at 800x600")
                if table["scrollWidth"] > table["clientWidth"] + 1:
                    problems.append("the defaults table is wider than its box")
                lefts: dict[str, set[int]] = {"pattern": set(), "language": set()}
                heights = []
                for pattern in self._BUILTIN_SAMPLE:
                    row = f"file-type-builtin-row-{pattern}"
                    if not self.driver.exists(row):
                        problems.append(f"no table row for {pattern}")
                        continue
                    heights.append(self.driver.measure_element(row)["rect"]["height"])
                    for column in lefts:
                        rect = self.driver.measure_element(
                            f"file-type-builtin-{column}-{pattern}"
                        )["rect"]
                        lefts[column].add(round(rect["x"]))
                self.evidence(f"column lefts {lefts}; row heights {heights}")
                for column, xs in lefts.items():
                    if len(xs) > 1:
                        problems.append(f"the {column} column is not aligned: x {sorted(xs)}")
                if heights and max(heights) > 36:
                    problems.append(f"rows are not dense: up to {max(heights):.0f}px tall")
                language = "file-type-builtin-language-.babelrc"
                if self.driver.exists(language):
                    fg = self.style_color("color", language)
                    bg = self.opaque_background(
                        "settings-panel-content", self.root_color("--bg-primary")
                    )
                    ratio = contrast(fg, bg)
                    self.evidence(f"mapped language contrast {ratio:.2f}:1")
                    if ratio < 4.5:
                        problems.append(f"mapped language contrast {ratio:.2f}:1 < 4.5:1")
                assert not problems, "; ".join(problems)
            finally:
                self.driver.resize_window(1280, 800)

    def test_10_serial_prefix_layout(self):
        """Settings ▸ Serial folds the Linux /dev prefixes off Linux, chips on Linux (#5712)."""
        linux = sys.platform.startswith("linux")
        with self.step(
            "settings.serial-prefixes",
            "Settings ▸ Serial shows the /dev scan prefixes as a compact chip grid on Linux "
            "and folds them behind a one-line note elsewhere (#5712)",
            expect=(
                "Settings ▸ Serial with the built-in prefixes as a grid of small switches"
                if linux else
                "Settings ▸ Serial with a one-line note that prefix scanning only runs on "
                "Linux and a Show Linux prefixes button — no per-prefix rows"
            ),
        ):
            self.open_settings_category("serial")
            self.wait(lambda: self.driver.exists("settings-serial-port-prefixes"),
                      what="the serial prefix section")
            problems = []
            if linux:
                if not self.driver.exists("settings-serial-prefix-grid"):
                    problems.append("no prefix chip grid")
                elif self.driver.get_computed_style(
                        "display", "settings-serial-prefix-grid") != "grid":
                    problems.append("the prefix list is not laid out as a grid")
                if self.driver.exists("settings-serial-prefixes-note"):
                    problems.append("the off-Linux note shows on Linux")
            else:
                if not self.driver.exists("settings-serial-prefixes-note"):
                    problems.append("no one-line off-Linux note")
                else:
                    self.evidence(
                        f"note {self.driver.get_text('settings-serial-prefixes-note')[:160]!r}")
                if self.driver.exists("settings-serial-prefixes-list"):
                    problems.append("the per-prefix rows show without being expanded")
                if self.driver.get_attribute(
                        "settings-serial-prefixes-disclosure", "aria-expanded") != "false":
                    problems.append("no collapsed Show Linux prefixes disclosure")
            assert not problems, "; ".join(problems)

    def test_11_editor_custom_mapping_contrast(self):
        """Settings ▸ Editor custom mappings show their language readably (#5722).

        Adds a custom mapping through the form, then measures the mapped language
        against its row: it must read at >= 4.5:1 instead of the disabled grey.
        The mapping is removed again afterwards.
        """
        pattern = "pr5722.tf"
        with self.step(
            "settings.editor.custom-mapping-contrast",
            "Settings ▸ Editor shows a custom file type mapping's language as readable "
            "secondary text, not faint disabled grey (#5722)",
            expect="A custom mapping row whose language reads at >= 4.5:1 on the row",
        ):
            self.open_settings_category("editor")
            self.driver.type("file-type-pattern-input", pattern)
            self.driver.type("file-type-language-input", "hcl")
            self.driver.click("file-type-add-btn")
            row = f"file-type-custom-row-{pattern}"
            language = f"file-type-custom-language-{pattern}"
            try:
                self.wait(lambda: self.driver.exists(language), what="the custom mapping row")
                time.sleep(0.4)
                self.shot(label="custom-mapping")
                fg = self.style_color("color", language)
                bg = self.opaque_background(row, self.root_color("--bg-tertiary"))
                ratio = contrast(fg, bg)
                self.evidence(f"custom mapping language contrast {ratio:.2f}:1")
                assert ratio >= 4.5, f"custom mapping language contrast {ratio:.2f}:1 < 4.5:1"
            finally:
                if self.driver.exists(f"file-type-remove-{pattern}"):
                    self.driver.click(f"file-type-remove-{pattern}")
