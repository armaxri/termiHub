"""Content-Security-Policy guard (#2059, #4011).

CSP is only enforced in a **production** WebView build (never in ``dev``), so a
policy that blocks something the app needs — the class of regression that nearly
shipped in #2048 — is invisible until a real build is driven. This suite closes
that gap: it launches the built app under the enforced CSP, confirms the app
boots and a terminal actually renders (output flows back), and asserts the
frontend saw **zero** CSP violations.

Beyond boot, it drives the three surfaces that load code or media the default
policy could block (WA-CI-035, #3627, #4011), asserting zero violations after
each:

- the **editor**: a ``.toml`` file opens in Monaco, whose highlighting comes from
  Shiki's TextMate engine (Oniguruma WASM, needs ``'wasm-unsafe-eval'``) and whose
  language services run in bundled Monaco workers (``worker-src``);
- a **SIXEL** inline image printed in a terminal (decoded to a canvas through
  ``createImageBitmap``), twice: a **local shell** ``cat``-s the bytes from a
  file, and a loopback TCP server sends them over a **Telnet** session (the
  remote path, which bypasses the PTY but feeds the same xterm image addon,
  #4076). On Windows the local shell is PowerShell on the sideloaded ConPTY host
  (``conpty.dll`` + ``OpenConsole.exe`` next to ``termihub.exe``, #4121): the
  inbox host drops a SIXEL DCS string before it reaches the app, so the local
  variant fails up front when the app under test was built without that host
  (#4129);
- the **clock-widget** example JavaScript plugin (``examples/plugins``), whose
  code the frontend-plugin sandbox worker loads from the ``plugin://`` origin;
- the tab **color picker**: a Radix modal (``react-remove-scroll`` injects a
  ``<style>`` when it opens) around a ``react-colorful`` picker (which injects
  its own ``<style>``).

``style-src`` has no ``'unsafe-inline'`` (#3115): every runtime ``<style>`` —
xterm's (the terminal tests), Monaco's (the editor test), sonner's (at boot) and
the two above — is allowed only by the per-load nonce Tauri appends, which
``src/security/styleNonce.ts`` stamps onto script-created ``<style>`` elements.
A broken nonce hand-off shows up here as a ``style-src`` violation.

Runs on every non-macOS integration leg (Linux/Windows). The bridge itself needs
a loopback ``ws://`` that the production CSP forbids; the test-bridge build
re-adds only that one allowance to ``connect-src`` at startup
(``relax_csp_if_test_bridge`` in ``src-tauri/src/utils/test_bridge.rs``, #3628).
Every other directive, including this platform's IPC origin, is identical to
production, so a broken shipped CSP still fails here.
"""

import json
import shutil
import socket
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import pytest

from termihub_harness import orchestrator
from termihub_harness import (
    ConnectionsUi,
    EditorUi,
    FilesUi,
    PluginsUi,
    ShellFsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

# Must match CSP_VIOLATION_SINK_TESTID in src/security/cspViolationReporter.ts.
CSP_SINK = "csp-violations"

#: How long a surface must stay violation-free after it rendered. A violation is
#: reported asynchronously (``securitypolicyviolation`` fires after the blocked
#: load), so a single read straight after the render could miss it.
SETTLE_SECONDS = 3.0

#: A 4x6 px red SIXEL image (DCS q … ST) — the same bytes as
#: ``test_terminal_inline_images.py``.
SIXEL = b"\x1bPq#0;2;100;0;0#0~~~~-\x1b\\"

#: The example JavaScript status-bar plugin shipped in the repo.
REPO_ROOT = Path(__file__).resolve().parents[3]
CLOCK_PLUGIN_SRC = REPO_ROOT / "examples" / "plugins" / "clock-widget"
CLOCK_PLUGIN_ID = "clock-widget"
#: ``PluginStatusBarWidgets.tsx`` mounts a widget as ``plugin-widget-<widget id>``.
CLOCK_WIDGET_TESTID = "plugin-widget-clock-widget"

#: The SIXEL test's frame: text before and after the image, so the test can wait
#: for the whole payload to have been written to the terminal.
SIXEL_BEFORE = b"TH_CSP_SIXEL_BEFORE"
SIXEL_AFTER = b"TH_CSP_SIXEL_AFTER"


@contextmanager
def _sixel_telnet_server() -> Iterator[int]:
    """A loopback TCP server that writes the SIXEL frame to its first client.

    Yields the port. The connection stays open (and inbound bytes, e.g. the
    client's Telnet option negotiation, are read and dropped) until the block
    exits, so the session does not end while the test inspects it. The frame
    holds no ``0xFF`` byte, so the client's Telnet filter passes it unchanged.
    """
    server = socket.create_server(("127.0.0.1", 0))
    server.settimeout(0.5)
    stop = threading.Event()
    payload = SIXEL_BEFORE + b"\r\n" + SIXEL + SIXEL_AFTER + b"\r\n"

    def serve() -> None:
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with conn:
                conn.sendall(payload)
                conn.settimeout(0.5)
                while not stop.is_set():
                    try:
                        if not conn.recv(4096):
                            break
                    except socket.timeout:
                        continue
                    except OSError:
                        break
            return

    thread = threading.Thread(target=serve, name="csp-sixel-telnet", daemon=True)
    thread.start()
    try:
        yield server.getsockname()[1]
    finally:
        stop.set()
        server.close()
        thread.join(timeout=5)


class TestContentSecurityPolicy(
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    FilesUi,
    EditorUi,
    ShellFsUi,
    PluginsUi,
    SystemTest,
):
    # -- helpers ---------------------------------------------------------------
    def _violations(self) -> tuple[str, str]:
        """The sink's violation count and its details text."""
        assert self.driver.exists(CSP_SINK), (
            "CSP violation sink missing — the frontend did not boot, or the "
            "reporter was removed from main.tsx"
        )
        return (
            self.driver.get_attribute(CSP_SINK, "data-count"),
            self.driver.get_text(CSP_SINK),
        )

    def _assert_no_violations(self, surface: str) -> None:
        """Zero violations now and for :data:`SETTLE_SECONDS` afterwards."""
        deadline = time.monotonic() + SETTLE_SECONDS
        while True:
            count, details = self._violations()
            assert count == "0", (
                f"the shipped CSP blocked {count} resource(s) with {surface}:\n{details}"
            )
            if time.monotonic() >= deadline:
                return
            time.sleep(0.5)

    def _seed_clock_plugin(self) -> None:
        """Install the clock-widget example as an enabled plugin, gate on.

        Runs while the app is down (the restart's ``between`` hook), exactly like
        :meth:`PluginsUi.write_sandbox_plugin`, so the relaunch scans it, promotes
        it to ``active`` and — with the frontend-plugin gate persisted on — loads
        its JS into the sandbox worker at startup.
        """
        dest = self.plugins_root() / CLOCK_PLUGIN_ID
        shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(CLOCK_PLUGIN_SRC, dest, ignore=shutil.ignore_patterns("*.md"))
        state = {"plugins": {CLOCK_PLUGIN_ID: {"enabled": True, "installedAt": 1_700_000_000_000}}}
        (self.plugins_root() / "plugin-state.json").write_text(
            json.dumps(state, indent=2), encoding="utf-8"
        )
        self.write_gate_setting(True)

    # -- tests -------------------------------------------------------------------
    def test_app_boots_and_terminal_renders_under_csp(self):
        # A terminal that opens, runs a command, and echoes output back proves
        # scripts executed and IPC worked under the enforced CSP — i.e. the
        # policy did not block the app's own bundle, xterm, or the IPC transport.
        self.ensure_terminal()
        self.run_command("echo csp-render-marker")
        assert "csp-render-marker" in self.wait_for_output("csp-render-marker")

    def test_no_csp_violations_were_reported(self):
        # The reporter installs its sink before React mounts, so its presence
        # confirms the frontend booted far enough to run main.tsx.
        count, details = self._violations()
        assert count == "0", f"the shipped CSP blocked {count} resource(s):\n{details}"

    def test_editor_with_a_shiki_grammar_reports_no_violations(self):
        # TOML is one of the built-in Shiki-backed languages
        # (monacoCustomLanguages.ts), so the open file is tokenised by the
        # TextMate/Oniguruma WASM engine and Monaco starts its bundled workers.
        self.ensure_terminal()
        self.remove_home_glob("e2e_csp_*")
        name = f"e2e_csp_{unique_name('f')}.toml"
        self.write_home_file(name, '[package]\nname = "csp"\nversion = "1.0.0"\n')
        try:
            self.open_file_browser()
            self.open_file_in_editor(name)
            self.wait(
                lambda: (self.editor_status() or {}).get("language") == "toml",
                what="the editor to open the file as TOML",
            )
            self._assert_no_violations("the editor open on a Shiki-highlighted file")
        finally:
            self.remove_home(name)

    def _wait_for_stored_sixel(self) -> None:
        """Wait until the SIXEL frame was printed and the image decoded."""
        self.wait_for_output(SIXEL_AFTER.decode())
        self.wait(
            lambda: (self.driver.inspect_terminal()["inlineImages"] or {}).get(
                "storageUsage", 0
            )
            > 0,
            what="the SIXEL image to be decoded and stored",
        )

    def test_sixel_inline_image_reports_no_violations(self):
        # On Windows only the sideloaded ConPTY host carries the DCS string from
        # a local shell (#4121); without it, fail with the reason, not on a
        # missing image.
        missing_host = orchestrator.missing_sideloaded_conpty_message()
        if missing_host:
            pytest.fail(missing_host)
        # A restart gives the image a fresh, empty terminal to be stored in.
        self.restart_app()
        # The image bytes are a file on disk that `cat` prints (PowerShell's
        # Get-Content alias on Windows), so no escape sequence is typed into the
        # shell (#4025).
        image = f"th_csp_sixel_{unique_name('i')}.txt"
        self.write_home_bytes(image, SIXEL_BEFORE + b"\n" + SIXEL + SIXEL_AFTER + b"\n")
        try:
            self.ensure_terminal()
            self.run_command(f"cat ~/{image}")
            self._wait_for_stored_sixel()
            self._assert_no_violations("a SIXEL image in a local shell")
        finally:
            self.remove_home(image)

    def test_sixel_over_telnet_reports_no_violations(self):
        # The remote path: the bytes arrive over a Telnet session to a loopback
        # server, with no PTY in between (#4076).
        self.restart_app()
        with _sixel_telnet_server() as port:
            self.create_telnet_connection(
                unique_name("csp-sixel"), host="127.0.0.1", port=port, connect=True
            )
            self.wait(self.has_terminal, what="the Telnet terminal session")
            self._wait_for_stored_sixel()
            self._assert_no_violations("a SIXEL image in a Telnet session")

    def test_color_picker_modal_reports_no_violations(self):
        # Opening the modal makes react-remove-scroll and react-colorful create
        # their <style> elements, which need the CSP nonce (#3115).
        self.ensure_terminal()
        tab = self.tab_ids()[0]
        self.driver.context_menu(f"tab-{tab}")
        self.wait(lambda: self.driver.exists("tab-context-set-color"), what="the set-color item")
        self.driver.click("tab-context-set-color")
        self.wait(lambda: self.driver.exists("color-picker-apply"), what="the color picker")
        try:
            self._assert_no_violations("the color-picker modal open")
        finally:
            self.driver.press_key("Escape")
            self.wait(
                lambda: not self.driver.exists("color-picker-apply"),
                what="the color picker to close",
            )

    def test_clock_widget_plugin_reports_no_violations(self):
        assert CLOCK_PLUGIN_SRC.is_dir(), f"example plugin missing at {CLOCK_PLUGIN_SRC}"
        self.restart_app(between=self._seed_clock_plugin)
        # A rendered widget proves the plugin's JS ran in the sandbox worker.
        self.wait(
            lambda: self.driver.exists(CLOCK_WIDGET_TESTID),
            what="the clock-widget plugin's status-bar widget to render",
        )
        self._assert_no_violations("the clock-widget JavaScript plugin loaded")
